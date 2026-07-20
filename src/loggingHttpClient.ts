import type { AxiosError, AxiosRequestConfig, AxiosResponse } from "axios";
import { HttpClient, type ApiConfig } from "../generated/c64/index.js";
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

export function createLoggingHttpClient<SecurityDataType = unknown>(
  config?: ApiConfig<SecurityDataType>,
  logger: PrefixedLogger = loggerFor("c64u"),
): HttpClient<SecurityDataType> {
  const http = new HttpClient<SecurityDataType>(config);

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

  http.instance.interceptors.response.use(
    (response) => {
      handleResponse(response, logger);
      return response;
    },
    (error: AxiosError) => {
      handleError(error, logger);
      return Promise.reject(error);
    },
  );

  return http;
}

function handleResponse(response: AxiosResponse, logger: PrefixedLogger): void {
  const meta = extractMeta(response.config);
  const latency = meta ? Date.now() - meta.startedAt : 0;
  const method = meta?.method ?? (response.config.method ?? "get").toUpperCase();
  const path = meta?.path ?? resolvePath(response.config);
  const bytes = payloadByteLength(response.data);

  logger.info(`${method} ${path} status=${response.status} bytes=${bytes} latencyMs=${latency}`);

  if (logger.isDebugEnabled()) {
    logger.debug(`request ${method} ${path}`, {
      headers: meta?.headers,
      query: meta?.params,
      body: formatPayloadForDebug(meta?.body),
    });
    logger.debug(`response ${method} ${path}`, {
      status: response.status,
      headers: redactHeaders(response.headers),
      body: formatPayloadForDebug(response.data),
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
  const path = meta?.path ?? resolvePath(config);
  const response = error.response;
  const status = response?.status ?? "ERR";
  const bytes = response ? payloadByteLength(response.data) : 0;
  const message = formatErrorMessage(error);

  logger.warn(`${method} ${path} status=${status} bytes=${bytes} latencyMs=${latency} error=${message}`);

  if (logger.isDebugEnabled()) {
    logger.debug(`request ${method} ${path}`, {
      headers: meta?.headers,
      query: meta?.params,
      body: formatPayloadForDebug(meta?.body),
    });
    logger.debug(`error ${method} ${path}`, {
      status,
      headers: redactHeaders(response?.headers),
      body: response ? formatPayloadForDebug(response.data) : null,
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
