import type { ToolRunResult } from "./types.js";
import { textResult } from "./responses.js";
import type { PlatformId } from "../platform.js";

export type ToolErrorKind = "validation" | "execution" | "unknown";

export interface ToolErrorMetadata {
  readonly kind: ToolErrorKind;
  readonly path?: string;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
}

export class ToolError extends Error {
  readonly kind: ToolErrorKind;
  readonly path?: string;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    kind: ToolErrorKind,
    options?: { path?: string; code?: string; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message);
    this.name = this.constructor.name;
    this.kind = kind;
    this.path = options?.path;
    this.code = options?.code;
    this.details = options?.details;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class ToolValidationError extends ToolError {
  constructor(
    message: string,
    options?: { path?: string; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, "validation", options);
  }
}

export class ToolExecutionError extends ToolError {
  constructor(
    message: string,
    options?: { code?: string; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, "execution", options);
  }
}

export interface UnsupportedPlatformOptions {
  /** Public (grouped) tool name, for example c64_disk. */
  readonly toolName?: string;
  /** Selected operation of the grouped tool. */
  readonly op?: string;
  /** Backends that are configured in this server, when known. */
  readonly configured?: readonly PlatformId[];
}

function joinBackends(backends: readonly string[]): string {
  return backends.join(" or ");
}

export function describeUnsupportedPlatform(
  subject: string,
  platform: PlatformId,
  supported: readonly PlatformId[],
  configured?: readonly PlatformId[],
): string {
  const base = supported.length > 0
    ? `${subject} requires backend ${joinBackends(supported)} (active: ${platform}).`
    : `${subject} is not available on backend ${platform}.`;
  if (supported.length === 0) {
    return base;
  }
  if (configured === undefined) {
    return base;
  }
  const switchable = supported.filter((id) => id !== platform && configured.includes(id));
  if (switchable.length > 0) {
    return `${base} Use \`c64_select_backend\` to switch to ${joinBackends(switchable)}.`;
  }
  return `${base} None of these backends is configured on this server.`;
}

export class ToolUnsupportedPlatformError extends ToolExecutionError {
  readonly tool: string;
  readonly platform: PlatformId;
  readonly supported: readonly PlatformId[];

  constructor(
    tool: string,
    platform: PlatformId,
    supported: readonly PlatformId[],
    options?: UnsupportedPlatformOptions,
  ) {
    const subject = options?.toolName
      ? options.op
        ? `\`${options.toolName}\` op \`${options.op}\``
        : `\`${options.toolName}\``
      : tool;
    super(
      describeUnsupportedPlatform(subject, platform, supported, options?.configured),
      {
        code: "unsupported_platform",
        details: {
          tool,
          platform,
          supported,
          ...(options?.configured ? { configured: options.configured } : {}),
        },
      },
    );
    this.tool = tool;
    this.platform = platform;
    this.supported = supported;
  }
}

export function toolErrorResult(error: ToolError): ToolRunResult {
  const metadata: ToolErrorMetadata = {
    kind: error.kind,
    ...(error.path !== undefined ? { path: error.path } : {}),
    ...(error.code !== undefined ? { code: error.code } : {}),
    ...(error.details !== undefined ? { details: error.details } : {}),
  };

  const located = error.path ? `${error.message} (at ${error.path})` : error.message;
  // Clients often show only the text content, so surface the underlying cause
  // (for example a range check or firmware error string) next to the summary.
  const detailMessage = describeDetailMessage(error.details);
  const withDetail = detailMessage && !located.includes(detailMessage) ? `${located}: ${detailMessage}` : located;
  const limits = describeLimits(error.details);
  const message = limits ? `${withDetail} [${limits}]` : withDetail;

  const base = textResult(message, { error: metadata });
  return { ...base, isError: true };
}

function describeDetailMessage(details: unknown): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const message = (details as { message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : undefined;
}

const MAX_LISTED_VALUES = 40;

// Valid values and bounds recorded by validators, so a client sees them without reading the schema.
function describeLimits(details: unknown): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(record.allowed) && record.allowed.length > 0) {
    const values = record.allowed.map((value) => String(value));
    const shown = values.slice(0, MAX_LISTED_VALUES).join(", ");
    parts.push(values.length > MAX_LISTED_VALUES ? `allowed: ${shown}, ... (${values.length} total)` : `allowed: ${shown}`);
  }
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) {
    const value = record[key];
    if (typeof value === "number" || typeof value === "string") {
      parts.push(`${key}: ${value}`);
    }
  }
  if (parts.length > 0 && record.received !== undefined && typeof record.received !== "object") {
    parts.push(`received: ${JSON.stringify(record.received)}`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

export function unknownErrorResult(error: unknown): ToolRunResult {
  if (error instanceof ToolError) {
    return toolErrorResult(error);
  }
  // Input documents such as SIDWAVE scores are checked outside the tool schemas;
  // their errors carry a path and are input errors, not internal failures.
  if (error instanceof Error && error.name === "SidwaveValidationError") {
    const path = (error as Error & { path?: unknown }).path;
    const metadata: ToolErrorMetadata = { kind: "validation", ...(typeof path === "string" ? { path } : {}) };
    return { ...textResult(error.message, { error: metadata }), isError: true };
  }

  const metadata: ToolErrorMetadata = { kind: "unknown" };

  const message = error instanceof Error ? error.message : String(error);

  const base = textResult(message, { error: metadata });
  return { ...base, isError: true };
}
