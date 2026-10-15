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

export class ToolUnsupportedPlatformError extends ToolExecutionError {
  readonly tool: string;
  readonly platform: PlatformId;
  readonly supported: readonly PlatformId[];

  constructor(tool: string, platform: PlatformId, supported: readonly PlatformId[]) {
    super(
      `Tool ${tool} is not available on platform ${platform}`,
      {
        code: "unsupported_platform",
        details: {
          tool,
          platform,
          supported,
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
  const message = detailMessage && !located.includes(detailMessage) ? `${located}: ${detailMessage}` : located;

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
