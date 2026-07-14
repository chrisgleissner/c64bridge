import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export interface C64BridgeConfig {
  c64_host: string;
  baseUrl: string;
  c64_port: number;
  networkPassword?: string;
  vicePrewarm: boolean;
}

const DEFAULT_HOST = "c64u";
const DEFAULT_PORT = 80;

const DEFAULT_CONFIG: C64BridgeConfig = {
  c64_host: DEFAULT_HOST,
  baseUrl: buildBaseUrl(DEFAULT_HOST, DEFAULT_PORT),
  c64_port: DEFAULT_PORT,
  vicePrewarm: false,
};

let cachedConfig: C64BridgeConfig | null = null;

export function loadConfig(): C64BridgeConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = process.env.C64BRIDGE_CONFIG;
  const repoConfigPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".c64bridge.json");
  const homeConfigPath = process.env.HOME ? `${process.env.HOME}/.c64bridge.json` : null;
  const candidatePaths = [configPath, repoConfigPath, homeConfigPath];

  let rawConfig: any;
  for (const candidatePath of candidatePaths) {
    if (!candidatePath) {
      continue;
    }

    try {
      rawConfig = JSON.parse(readFileSync(candidatePath, "utf-8"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  rawConfig ??= {};

  // New schema: choose the configured Ultimate hardware profile; retain
  // c64u and legacy fields as the default when C64_MODE is not set to u2.
  const c64u = rawConfig?.c64u as {
    host?: string;
    hostname?: string;
    baseUrl?: string;
    port?: number | string;
    networkPassword?: string;
  } | undefined;
  const u2 = rawConfig?.u2 as typeof c64u;
  const useU2 = process.env.C64_MODE?.trim().toLowerCase() === "u2";
  const hardware = useU2 ? (u2 ?? c64u) : (c64u ?? u2);
  const vice = rawConfig?.vice as {
    prewarm?: boolean | string | number;
  } | undefined;

  const parsedC64uHost = parseEndpoint(configuredString(hardware?.host));
  const parsedC64uHostname = parseEndpoint(configuredString(hardware?.hostname));
  const parsedLegacyHost = parseEndpoint(configuredString(rawConfig?.c64_host));
  const parsedLegacyIp = parseEndpoint(configuredString(rawConfig?.c64_ip));
  const parsedEnvHost = parseEndpoint(configuredString(useU2 ? process.env.U2_HOST ?? process.env.C64U_HOST : process.env.C64U_HOST));
  const parsedBaseOverrides = [
    parseEndpoint(normaliseBaseUrl(hardware?.baseUrl)),
    parseEndpoint(normaliseBaseUrl(rawConfig?.baseUrl)),
  ];

  const hostCandidates = [
    parsedEnvHost.hostname,
    parsedC64uHost.hostname,
    parsedC64uHostname.hostname,
    parsedLegacyHost.hostname,
    parsedLegacyIp.hostname,
    ...parsedBaseOverrides.map((entry) => entry.hostname),
  ];

  const portCandidates = [
    configuredPort(useU2 ? process.env.U2_PORT ?? process.env.C64U_PORT : process.env.C64U_PORT),
    parsedEnvHost.port,
    configuredPort(hardware?.port),
    parsedC64uHost.port,
    parsedC64uHostname.port,
    configuredPort(rawConfig?.c64_port),
    parsedLegacyHost.port,
    parsedLegacyIp.port,
    ...parsedBaseOverrides.map((entry) => entry.port),
  ];

  const host = firstDefined(...hostCandidates) ?? DEFAULT_HOST;
  const port = firstDefined(...portCandidates) ?? DEFAULT_PORT;
  const baseUrl = buildBaseUrl(host, port);
  const hostLabel = formatHost(host);
  const hostWithPort = port === DEFAULT_PORT ? hostLabel : `${hostLabel}:${port}`;

  const config: C64BridgeConfig = {
    c64_host: hostWithPort,
    baseUrl,
    c64_port: port,
    networkPassword: firstDefined(
      configuredString(useU2 ? process.env.U2_PASSWORD ?? process.env.C64U_PASSWORD : process.env.C64U_PASSWORD),
      configuredString(hardware?.networkPassword),
      configuredString(rawConfig?.networkPassword),
    ),
    vicePrewarm: firstDefined(
      configuredBoolean(process.env.VICE_PREWARM),
      configuredBoolean(vice?.prewarm),
      configuredBoolean(rawConfig?.vicePrewarm),
    ) ?? false,
  };

  cachedConfig = config;
  return config;
}

function configuredString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function configuredPort(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
      return parsed;
    }
  }
  return undefined;
}

function configuredBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
}

function normaliseBaseUrl(value?: string): string | undefined {
  const input = configuredString(value);
  if (!input) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    return `http://${input}`;
  }
  return stripTrailingSlash(input);
}

function parseEndpoint(value?: string): { hostname?: string; port?: number; baseUrl?: string } {
  const input = configuredString(value);
  if (!input) return {};
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
    const url = new URL(hasScheme ? input : `http://${input}`);
    const hostname = url.hostname || undefined;
    const port = url.port ? configuredPort(url.port) : undefined;
    const baseUrl = stripTrailingSlash(`${url.protocol}//${url.host}`);
    return { hostname, port, baseUrl };
  } catch {
    return {};
  }
}

function stripTrailingSlash(input: string): string {
  return input.replace(/\/+$/, "");
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function buildBaseUrl(host: string, port: number): string {
  const normalizedPort = Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
  const hostPart = formatHost(host);
  const suffix = normalizedPort === DEFAULT_PORT ? "" : `:${normalizedPort}`;
  return `http://${hostPart}${suffix}`;
}

function formatHost(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
}

export function __resetConfigCacheForTests(): void {
  cachedConfig = null;
}
