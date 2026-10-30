import { Buffer } from "node:buffer";
import { redactText, redactValue } from "./redact.js";
import type { ToolLogger } from "./tools/types.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_LEVEL: LogLevel = "info";
const ACTIVE_LEVEL = normaliseLevel(process.env.LOG_LEVEL) ?? DEFAULT_LEVEL;
const ACTIVE_THRESHOLD = LEVEL_ORDER[ACTIVE_LEVEL];
const IS_TEST_ENV = process.env.NODE_ENV === "test";

const LOGGER_CACHE = new Map<string, PrefixedLogger>();

type ConsoleMethod = (...args: unknown[]) => void;

type LogLevel = "debug" | "info" | "warn" | "error";

export interface PrefixedLogger extends ToolLogger {
  readonly prefix: string;
  isDebugEnabled(): boolean;
}

export function loggerFor(prefix: string): PrefixedLogger {
  if (LOGGER_CACHE.has(prefix)) {
    return LOGGER_CACHE.get(prefix)!;
  }

  const prefixed = createPrefixedLogger(prefix);
  LOGGER_CACHE.set(prefix, prefixed);
  return prefixed;
}

function createPrefixedLogger(prefix: string): PrefixedLogger {
  const render = (level: LogLevel, message: string, details?: Record<string, unknown>) => {
    if (shouldSkip(level)) {
      return;
    }
    const consoleMethod = selectConsole(level);
    const label = `[${prefix}] ${redactText(message)}`;
    if (details && Object.keys(details).length > 0) {
      consoleMethod(label, redactValue(details));
    } else {
      consoleMethod(label);
    }
  };

  return {
    prefix,
    debug(message, details) {
      render("debug", message, details);
    },
    info(message, details) {
      render("info", message, details);
    },
    warn(message, details) {
      render("warn", message, details);
    },
    error(message, details) {
      render("error", message, details);
    },
    isDebugEnabled() {
      return !shouldSkip("debug");
    },
  };
}

function shouldSkip(level: LogLevel): boolean {
  if (IS_TEST_ENV) {
    return true;
  }
  const order = LEVEL_ORDER[level];
  return order < ACTIVE_THRESHOLD;
}

function selectConsole(level: LogLevel): ConsoleMethod {
  if (level === "debug" && typeof console.debug === "function") {
    return console.debug.bind(console);
  }
  if (level === "info" && typeof console.info === "function") {
    return console.info.bind(console);
  }
  if (level === "warn" && typeof console.warn === "function") {
    return console.warn.bind(console);
  }
  if (level === "error" && typeof console.error === "function") {
    return console.error.bind(console);
  }
  return console.log.bind(console);
}

function normaliseLevel(raw?: string): LogLevel | undefined {
  if (!raw) return undefined;
  const lowered = raw.trim().toLowerCase();
  if (lowered === "debug" || lowered === "info" || lowered === "warn" || lowered === "error") {
    return lowered;
  }
  return undefined;
}

export function payloadByteLength(payload: unknown): number {
  if (payload === null || payload === undefined) {
    return 0;
  }
  const buf = asBuffer(payload);
  if (buf) {
    return buf.byteLength;
  }
  if (typeof payload === "string") {
    return Buffer.byteLength(payload, "utf8");
  }
  if (payload instanceof URLSearchParams) {
    return Buffer.byteLength(payload.toString(), "utf8");
  }
  if (isPlainObject(payload) || Array.isArray(payload)) {
    try {
      return Buffer.byteLength(JSON.stringify(payload));
    } catch {
      return Buffer.byteLength(String(payload));
    }
  }
  if (typeof payload === "number" || typeof payload === "boolean" || typeof payload === "bigint") {
    return Buffer.byteLength(String(payload));
  }
  return 0;
}

export function formatPayloadForDebug(payload: unknown): unknown {
  if (payload === null || payload === undefined) {
    return payload;
  }
  const buf = asBuffer(payload);
  if (buf) {
    return buf.toString("hex");
  }
  if (payload instanceof URLSearchParams) {
    return payload.toString();
  }
  if (isFormData(payload)) {
    const entries: Record<string, unknown[]> = {};
    payload.forEach((value, key) => {
      if (!entries[key]) entries[key] = [];
      if (isBlob(value)) {
        entries[key].push(`[Blob size=${value.size}]`);
      } else {
        entries[key].push(value);
      }
    });
    return entries;
  }
  if (typeof payload === "object") {
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch {
      return payload;
    }
  }
  return payload;
}

function asBuffer(payload: unknown): Buffer | null {
  if (Buffer.isBuffer(payload)) {
    return payload;
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload);
  }
  if (ArrayBuffer.isView(payload)) {
    const arrayView = payload as ArrayBufferView;
    return Buffer.from(arrayView.buffer, arrayView.byteOffset, arrayView.byteLength);
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && value.constructor === Object;
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

function isBlob(value: unknown): value is Blob {
  const ctor = (globalThis as any).Blob;
  return typeof ctor === "function" && value instanceof ctor;
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message || error.name || "Error";
    return collapseWhitespace(message);
  }
  if (error === null || error === undefined) {
    return "unknown error";
  }
  return collapseWhitespace(String(error));
}

function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}
