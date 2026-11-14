import axios, { type AxiosError, type AxiosRequestConfig, type AxiosResponse } from "axios";
import { HttpClient, type ApiConfig } from "../generated/c64/index.js";
import { isSensitiveConfigItem, REDACTED_PLACEHOLDER, redactConfigValue, registerSecret, scrubRequestError } from "./redact.js";
import { formatErrorMessage, formatPayloadForDebug, loggerFor, payloadByteLength, type PrefixedLogger } from "./logger.js";

type RequestMeta = {
  startedAt: number;
  method: string;
  path: string;
  headers?: AxiosRequestConfig["headers"];
  params?: AxiosRequestConfig["params"];
  body?: unknown;
};

/** Headers are useful in diagnostics, but credentials must never leave the
 * transport layer.  Axios normalises some keys and preserves others, so do a
 * case-insensitive pass instead of relying on one spelling. */
function redactHeaders(headers: AxiosRequestConfig["headers"] | undefined): AxiosRequestConfig["headers"] | undefined {
  if (!headers) return headers;
  const sensitive = /^(x-password|authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;
  return Object.fromEntries(Object.entries(headers as Record<string, unknown>).map(([key, value]) => [
    key,
    sensitive.test(key) ? "***" : value,
  ])) as AxiosRequestConfig["headers"];
}

/** Category and item named by a configuration endpoint path, or undefined for any other path. */
function configRoute(path: string): { category?: string; item?: string } | undefined {
  const match = /\/configs(?:\/([^/?#]*))?(?:\/([^/?#]*))?(?:[?#]|$)/.exec(path);
  if (!match) return undefined;
  const decode = (segment: string | undefined): string | undefined => {
    if (segment === undefined) return undefined;
    try { return decodeURIComponent(segment); } catch { return segment; }
  };
  return { category: decode(match[1]), item: decode(match[2]) };
}

/** A payload that came from or goes to a configuration endpoint, with credential item values replaced. */
function redactConfigPayload(path: string, payload: unknown): unknown {
  const route = configRoute(path);
  if (!route || payload === null || payload === undefined) return payload;
  if (typeof payload === "string") {
    try {
      return redactConfigValue(JSON.parse(payload), route.category, route.item);
    } catch {
      return payload;
    }
  }
  if (typeof payload === "object") return redactConfigValue(payload, route.category, route.item);
  return payload;
}

function isConfigWrite(method: string | undefined, path: string): boolean {
  return configRoute(path) !== undefined && method !== undefined && method !== "GET" && method !== "HEAD";
}

/** The leaves of a configuration write body ({ category: { item: value } }) are replaced; names stay. */
function redactConfigWriteBody(body: unknown): unknown {
  if (typeof body === "string") {
    try {
      return redactConfigWriteBody(JSON.parse(body));
    } catch {
      return REDACTED_PLACEHOLDER;
    }
  }
  if (Array.isArray(body)) return body.map((entry) => redactConfigWriteBody(entry));
  if (body !== null && typeof body === "object") {
    return Object.fromEntries(Object.entries(body).map(([key, entry]) => [key, redactConfigWriteBody(entry)]));
  }
  return body === null || body === undefined ? body : REDACTED_PLACEHOLDER;
}

/** A request body as logged: configuration write values are always replaced, other payloads follow the item rules. */
function redactRequestBody(method: string | undefined, path: string, body: unknown): unknown {
  return isConfigWrite(method, path) ? redactConfigWriteBody(body) : redactConfigPayload(path, body);
}

/**
 * Query parameters of a configuration write: every value is replaced. The firmware matches item names
 * with wildcards, so the name cannot tell whether the item holds a credential.
 */
function redactConfigParams(method: string | undefined, path: string, params: unknown): unknown {
  const route = configRoute(path);
  if (!route) return params;
  const sensitiveItem = route.item !== undefined && isSensitiveConfigItem(route.category, route.item);
  if (!sensitiveItem && !isConfigWrite(method, path)) return params;
  if (params === null || typeof params !== "object") return params;
  return Object.fromEntries(Object.keys(params).map((key) => [key, REDACTED_PLACEHOLDER]));
}

/** The path as logged: the query string of a configuration write or credential item request is dropped. */
function redactConfigPath(method: string | undefined, path: string): string {
  const route = configRoute(path);
  const sensitiveItem = route?.item !== undefined && isSensitiveConfigItem(route.category, route.item);
  if (route && (sensitiveItem || isConfigWrite(method, path)) && path.includes("?")) {
    return `${path.split("?")[0]}?${REDACTED_PLACEHOLDER}`;
  }
  return path;
}

/** How long requests fail immediately after a transport-level failure before the next one probes the device again. */
export const DEVICE_DOWN_BACKOFF_MS = 3_000;

/** Raised without sending a request while a device is marked down after a transport failure. */
export class DeviceUnreachableError extends Error {
  readonly retryInMs: number;
  constructor(baseUrl: string | undefined, retryInMs: number) {
    super(`Device unreachable${baseUrl ? ` at ${baseUrl}` : ""}: the previous request got no response; not sending more requests for ${Math.max(1, Math.ceil(retryInMs / 1000))} s`);
    this.name = "DeviceUnreachableError";
    this.retryInMs = retryInMs;
  }
}

const TRANSPORT_FAILURE_CODES = new Set([
  "ECONNABORTED", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH",
  "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ERR_NETWORK", "UND_ERR_CONNECT_TIMEOUT",
]);

/** True for a failure where the device sent no HTTP response (timeout, refused, reset). HTTP error statuses are not transport failures. */
export function isTransportFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response) return false;
  return typeof error.code === "string" && TRANSPORT_FAILURE_CODES.has(error.code);
}

/**
 * First-in first-out gate that lets one operation run at a time. The Ultimate
 * firmware serves REST requests on a single thread, so every request to one
 * device goes through one queue. A failed operation releases the gate like a
 * successful one, so the queue cannot deadlock.
 */
export class RequestQueue {
  private static readonly byDevice = new Map<string, RequestQueue>();

  /** The shared queue for one device base URL, so every client of that device (backends, fallback clients) waits in the same line. */
  static forDevice(baseUrl: string): RequestQueue {
    const key = baseUrl.replace(/\/+$/, "").toLowerCase();
    let queue = RequestQueue.byDevice.get(key);
    if (!queue) {
      queue = new RequestQueue();
      RequestQueue.byDevice.set(key, queue);
    }
    return queue;
  }

  private tail: Promise<void> = Promise.resolve();
  private downUntil = 0;
  private downBaseUrl: string | undefined;

  /** Mark the device down for the back-off period after a transport-level failure. */
  markDown(baseUrl?: string, backoffMs = DEVICE_DOWN_BACKOFF_MS): void {
    this.downUntil = Date.now() + backoffMs;
    this.downBaseUrl = baseUrl;
  }

  /** Clear the down state after a response or a successful probe. */
  markUp(): void {
    this.downUntil = 0;
  }

  /** Throws DeviceUnreachableError while the back-off period lasts. */
  assertUp(): void {
    const remaining = this.downUntil - Date.now();
    if (remaining > 0) throw new DeviceUnreachableError(this.downBaseUrl, remaining);
  }

  /** Resolves when all earlier holders have released; call the returned function exactly once. */
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => held);
    await previous;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        release();
      }
    };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function isPauseControlRequest(requestConfig: AxiosRequestConfig): boolean {
  const url = typeof requestConfig.url === "string" ? requestConfig.url : "";
  return /machine:(pause|resume)(\?|$)/.test(url);
}

export function createLoggingHttpClient<SecurityDataType = unknown>(
  config?: ApiConfig<SecurityDataType>,
  logger: PrefixedLogger = loggerFor("c64u"),
  queue?: RequestQueue,
): HttpClient<SecurityDataType> {
  // Device requests go straight to the LAN address; HTTP_PROXY must not apply.
  const http = new HttpClient<SecurityDataType>({ proxy: false, ...config } as ApiConfig<SecurityDataType>);
  registerSecret(readPasswordHeader(config?.headers));

  http.instance.interceptors.request.use((request) => {
    const method = (request.method ?? "get").toUpperCase();
    const path = resolvePath(request);

    const meta: RequestMeta = {
      startedAt: Date.now(),
      method,
      path,
      headers: redactHeaders(request.headers),
      params: request.params ? { ...request.params } : undefined,
      body: request.data,
    };

    (request as AxiosRequestConfig & { __c64Meta?: RequestMeta }).__c64Meta = meta;
    return request;
  });

  if (queue) {
    // The generated client sends every request through `instance.request`, so
    // the gate is taken around that call. Interceptors, request transforms and
    // the adapter all run inside it: the start time is recorded after the wait,
    // the request timeout (started by the adapter) does not include the wait,
    // and the gate is released however the request settles, including a
    // failure before the adapter is called (for example a body that cannot be
    // serialised).
    const instance = http.instance;
    const sendRequest = instance.request.bind(instance);
    //
    // After a transport failure the device is marked down for a short back-off
    // period. Requests that reach the front of the queue in that period fail at
    // once instead of each waiting for its own timeout. A response of any HTTP
    // status shows the device is up.
    const baseUrl = typeof config?.baseURL === "string" ? config.baseURL : undefined;
    instance.request = ((requestConfig: AxiosRequestConfig) =>
      queue.run(async () => {
        // Pause and resume bypass the down state. A resume is the recovery action for a machine an
        // owned pause froze, and a pause that is refused would leave its paired resume unmatched.
        if (!isPauseControlRequest(requestConfig)) queue.assertUp();
        try {
          const response = await sendRequest(requestConfig);
          queue.markUp();
          return response;
        } catch (error) {
          if (isTransportFailure(error)) queue.markDown(baseUrl);
          else if (axios.isAxiosError(error) && error.response) queue.markUp();
          throw error;
        }
      })) as typeof instance.request;
  }

  http.instance.interceptors.response.use(
    (response) => {
      handleResponse(response, logger);
      return response;
    },
    (error: AxiosError) => {
      handleError(error, logger);
      return Promise.reject(scrubRequestError(error));
    },
  );

  return http;
}

function readPasswordHeader(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (/^x-password$/i.test(key) && typeof value === "string") return value;
  }
  return undefined;
}

function handleResponse(response: AxiosResponse, logger: PrefixedLogger): void {
  const meta = extractMeta(response.config);
  const latency = meta ? Date.now() - meta.startedAt : 0;
  const method = meta?.method ?? (response.config.method ?? "get").toUpperCase();
  const path = redactConfigPath(method, meta?.path ?? resolvePath(response.config));
  const bytes = payloadByteLength(response.data);

  logger.info(`${method} ${path} status=${response.status} bytes=${bytes} latencyMs=${latency}`);

  if (logger.isDebugEnabled()) {
    logger.debug(`request ${method} ${path}`, {
      headers: meta?.headers,
      query: redactConfigParams(method, path, meta?.params),
      body: formatPayloadForDebug(redactRequestBody(method, path, meta?.body)),
    });
    logger.debug(`response ${method} ${path}`, {
      status: response.status,
      headers: redactHeaders(response.headers),
      body: formatPayloadForDebug(redactConfigPayload(path, response.data)),
    });
  }
}

function handleError(error: AxiosError, logger: PrefixedLogger): void {
  const config = error.config;
  if (!config) {
    logger.error(`UNKNOWN UNKNOWN status=ERR bytes=0 latencyMs=0 error=${formatErrorMessage(error)}`);
    return;
  }

  const meta = extractMeta(config);
  const latency = meta ? Date.now() - meta.startedAt : 0;
  const method = meta?.method ?? (config.method ?? "get").toUpperCase();
  const path = redactConfigPath(method, meta?.path ?? resolvePath(config));
  const response = error.response;
  const status = response?.status ?? "ERR";
  const bytes = response ? payloadByteLength(response.data) : 0;
  const message = formatErrorMessage(error);

  logger.warn(`${method} ${path} status=${status} bytes=${bytes} latencyMs=${latency} error=${message}`);

  if (logger.isDebugEnabled()) {
    logger.debug(`request ${method} ${path}`, {
      headers: meta?.headers,
      query: redactConfigParams(method, path, meta?.params),
      body: formatPayloadForDebug(redactRequestBody(method, path, meta?.body)),
    });
    logger.debug(`error ${method} ${path}`, {
      status,
      headers: redactHeaders(response?.headers),
      body: response ? formatPayloadForDebug(redactConfigPayload(path, response.data)) : null,
      message,
    });
  }
}

function extractMeta(config: AxiosRequestConfig & { __c64Meta?: RequestMeta }): RequestMeta | undefined {
  const meta = config.__c64Meta;
  delete config.__c64Meta;
  return meta;
}

function resolvePath(config: AxiosRequestConfig): string {
  if (config.url) return config.url;
  if (config.baseURL) return config.baseURL;
  return "UNKNOWN";
}
