import { readFileSync } from "fs";
import { dirname, join } from "path";
import os from "node:os";
import { fileURLToPath } from "url";

export interface C64BridgeConfig {
  c64_host: string;
  baseUrl: string;
  c64_port: number;
  networkPassword?: string;
  vicePrewarm: boolean;
  /** Resolved endpoint per Ultimate profile. The top-level host/port/password
   * fields above are the profile selected by C64_MODE. */
  ultimate: { c64u: ResolvedUltimateEndpoint; u2: ResolvedUltimateEndpoint };
  /** True when the config document uses the legacy top-level endpoint fields
   * (baseUrl, c64_host, c64_ip, c64_port) instead of a c64u section. */
  legacyUltimateEndpoint: boolean;
  /** Parsed selected config document, retained so all facade construction uses
   * the exact same authoritative source and precedence decision. */
  backendConfig: {
    c64u?: UltimateSectionConfig;
    u2?: UltimateSectionConfig;
    vice?: Record<string, unknown>;
  };
}

export interface UltimateSectionConfig {
  host?: string;
  hostname?: string;
  baseUrl?: string;
  port?: number | string;
  networkPassword?: string;
}

export interface ResolvedUltimateEndpoint {
  host: string;
  port: number;
  baseUrl: string;
  /** Host label with the port appended when it is not 80. */
  c64_host: string;
  networkPassword?: string;
}

const DEFAULT_HOST = "c64u";
const DEFAULT_PORT = 80;

export function loadConfig(): C64BridgeConfig {
  const configPath = process.env.C64BRIDGE_CONFIG;
  const cwdConfigPath = join(process.cwd(), ".c64bridge.json");
  const homeConfigPath = join(os.homedir(), ".c64bridge.json");
  // Legacy package-adjacent config is deliberately last: it is useful for
  // source checkouts but must never override a project or user config.
  const legacyPackageConfigPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".c64bridge.json");
  const candidatePaths = [configPath, cwdConfigPath, homeConfigPath, legacyPackageConfigPath];

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
        // Deliberately omit file contents/credentials. Configuration mistakes
        // should not prevent the MCP server from exposing a recoverable path.
        console.error(`[c64bridge] ignoring configuration '${candidatePath}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  rawConfig ??= {};

  // New schema: choose the configured Ultimate hardware profile; retain
  // c64u and legacy fields as the default when C64_MODE is not set to u2.
  const c64u = ultimateSection(rawConfig?.c64u);
  const u2 = ultimateSection(rawConfig?.u2);
  const useU2 = process.env.C64_MODE?.trim().toLowerCase() === "u2";
  const ultimate = {
    c64u: resolveUltimateEndpoint("c64u", c64u ?? u2, rawConfig),
    u2: resolveUltimateEndpoint("u2", u2 ?? c64u, rawConfig),
  };
  const selected = useU2 ? ultimate.u2 : ultimate.c64u;
  const vice = rawConfig?.vice as {
    prewarm?: boolean | string | number;
  } | undefined;

  const config: C64BridgeConfig = {
    c64_host: selected.c64_host,
    baseUrl: selected.baseUrl,
    c64_port: selected.port,
    networkPassword: selected.networkPassword,
    vicePrewarm: firstDefined(
      configuredBoolean(process.env.VICE_PREWARM),
      configuredBoolean(vice?.prewarm),
      configuredBoolean(rawConfig?.vicePrewarm),
    ) ?? false,
    ultimate,
    legacyUltimateEndpoint: LEGACY_ENDPOINT_KEYS.some((key) => rawConfig?.[key] !== undefined && rawConfig?.[key] !== null),
    backendConfig: {
      ...(c64u ? { c64u } : {}),
      ...(u2 ? { u2 } : {}),
      ...(rawConfig?.vice && typeof rawConfig.vice === "object" && !Array.isArray(rawConfig.vice) ? { vice: rawConfig.vice } : {}),
    },
  };

  return config;
}

/** Top-level fields from the pre-profile config schema that name an endpoint. */
const LEGACY_ENDPOINT_KEYS = ["baseUrl", "c64_host", "c64_ip", "c64_port"] as const;

function ultimateSection(value: unknown): UltimateSectionConfig | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UltimateSectionConfig : undefined;
}

/**
 * The single host/port/password precedence for an Ultimate profile, used by
 * loadConfig() and by every C64U/U2 backend construction:
 * env > section host/hostname/port > legacy top-level c64_host/c64_ip/c64_port
 * > section baseUrl > legacy top-level baseUrl > defaults. Passwords: env >
 * section > legacy top-level networkPassword.
 */
export function resolveUltimateEndpoint(
  profile: "c64u" | "u2",
  section?: UltimateSectionConfig,
  legacy?: Record<string, unknown>,
): ResolvedUltimateEndpoint {
  const envHost = profile === "u2" ? process.env.U2_HOST ?? process.env.C64U_HOST : process.env.C64U_HOST;
  const envPort = profile === "u2" ? process.env.U2_PORT ?? process.env.C64U_PORT : process.env.C64U_PORT;
  const envPassword = profile === "u2" ? process.env.U2_PASSWORD ?? process.env.C64U_PASSWORD : process.env.C64U_PASSWORD;

  const parsedSectionHost = parseEndpoint(configuredString(section?.host));
  const parsedSectionHostname = parseEndpoint(configuredString(section?.hostname));
  const parsedLegacyHost = parseEndpoint(configuredString(legacy?.c64_host));
  const parsedLegacyIp = parseEndpoint(configuredString(legacy?.c64_ip));
  const parsedEnvHost = parseEndpoint(configuredString(envHost));
  const parsedBaseOverrides = [
    parseEndpoint(normaliseBaseUrl(configuredString(section?.baseUrl))),
    parseEndpoint(normaliseBaseUrl(configuredString(legacy?.baseUrl))),
  ];

  const hostCandidates = [
    parsedEnvHost.hostname,
    parsedSectionHost.hostname,
    parsedSectionHostname.hostname,
    parsedLegacyHost.hostname,
    parsedLegacyIp.hostname,
    ...parsedBaseOverrides.map((entry) => entry.hostname),
  ];

  const portCandidates = [
    configuredPort(envPort),
    parsedEnvHost.port,
    configuredPort(section?.port),
    parsedSectionHost.port,
    parsedSectionHostname.port,
    configuredPort(legacy?.c64_port),
    parsedLegacyHost.port,
    parsedLegacyIp.port,
    ...parsedBaseOverrides.map((entry) => entry.port),
  ];

  const host = firstDefined(...hostCandidates) ?? DEFAULT_HOST;
  const port = firstDefined(...portCandidates) ?? DEFAULT_PORT;
  const hostLabel = formatHost(host);
  return {
    host,
    port,
    baseUrl: buildBaseUrl(host, port),
    c64_host: port === DEFAULT_PORT ? hostLabel : `${hostLabel}:${port}`,
    networkPassword: firstDefined(
      nonEmptyString(envPassword),
      nonEmptyString(section?.networkPassword),
      nonEmptyString(legacy?.networkPassword),
    ),
  };
}

function configuredString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  const trimmed = configuredString(value);
  return trimmed ? trimmed : undefined;
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
  // Kept as a no-op compatibility hook: config is intentionally reloaded for
  // each construction so startup and facade creation cannot disagree.
}
