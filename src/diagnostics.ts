import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactValue } from "./redact.js";

export interface DiagnosticsSessionInfo {
  readonly component: string;
  readonly directory: string;
  readonly filePath: string;
  readonly sessionId: string;
}

export interface OutputTailSnapshot {
  readonly name: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

export interface OutputTailCapture {
  pushStdout(chunk: string | Uint8Array<ArrayBufferLike>): void;
  pushStderr(chunk: string | Uint8Array<ArrayBufferLike>): void;
  snapshot(): OutputTailSnapshot;
}

export interface DiagnosticRecord {
  readonly ts: string;
  readonly pid: number;
  readonly sessionId: string;
  readonly component: string;
  readonly event: string;
  readonly details?: unknown;
}

export interface DiagnosticSpan {
  readonly spanId: string;
  readonly category: string;
  readonly name: string;
  end(outcome?: "ok" | "error", details?: unknown): void;
}

export interface DiagnosticSummarySpan {
  readonly category: string;
  readonly name: string;
  readonly count: number;
  readonly totalDurationMs: number;
  readonly avgDurationMs: number;
  readonly maxDurationMs: number;
  readonly lastOutcome?: string;
}

export interface DiagnosticSummaryToolCall {
  readonly name: string;
  readonly count: number;
  readonly errorCount: number;
  readonly totalLatencyMs: number;
  readonly avgLatencyMs: number;
  readonly maxLatencyMs: number;
}

export interface DiagnosticTimelineEntry {
  readonly ts: string;
  readonly event: string;
  readonly details?: unknown;
}

export interface DiagnosticSessionSummary {
  readonly filePath: string;
  readonly sessionId: string | null;
  readonly component: string | null;
  readonly eventCount: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number;
  readonly topSpans: readonly DiagnosticSummarySpan[];
  readonly toolCalls: readonly DiagnosticSummaryToolCall[];
  readonly timeline?: readonly DiagnosticTimelineEntry[];
}

interface DiagnosticsState {
  readonly info: DiagnosticsSessionInfo;
}

let state: DiagnosticsState | null = null;
let handlersInstalled = false;
let spanCounter = 0;

const DEFAULT_OUTPUT_TAIL_CHARS = 4_096;

export function installProcessDiagnostics(component: string): DiagnosticsSessionInfo {
  const info = ensureState(component).info;
  writeDiagnosticEvent("session_start", {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    node: process.version,
    pid: process.pid,
    platform: process.platform,
  });
  installGlobalHandlers();
  return info;
}

export function getDiagnosticsSessionInfo(): DiagnosticsSessionInfo | null {
  return state?.info ?? null;
}

export function writeDiagnosticEvent(event: string, details?: unknown): void {
  if (!isDiagnosticsEnabled()) {
    return;
  }

  const current = ensureState("runtime");
  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    sessionId: current.info.sessionId,
    component: current.info.component,
    event,
    details: sanitize(details),
  };

  try {
    fs.appendFileSync(current.info.filePath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    safeStderrWrite(
      `[diagnostics] failed to append event ${event}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

export function createOutputTailCapture(name: string, maxChars = DEFAULT_OUTPUT_TAIL_CHARS): OutputTailCapture {
  let stdoutTail = "";
  let stderrTail = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;

  return {
    pushStdout(chunk) {
      const text = normalizeChunk(chunk);
      stdoutBytes += Buffer.byteLength(text, "utf8");
      stdoutTail = keepTail(stdoutTail, text, maxChars);
    },
    pushStderr(chunk) {
      const text = normalizeChunk(chunk);
      stderrBytes += Buffer.byteLength(text, "utf8");
      stderrTail = keepTail(stderrTail, text, maxChars);
    },
    snapshot() {
      return {
        name,
        stdoutBytes,
        stderrBytes,
        stdoutTail: stdoutTail.trim(),
        stderrTail: stderrTail.trim(),
      };
    },
  };
}

export function beginDiagnosticSpan(category: string, name: string, details?: unknown): DiagnosticSpan {
  const spanId = `${Date.now().toString(36)}-${process.pid}-${++spanCounter}`;
  const startedAt = process.hrtime.bigint();
  let closed = false;

  writeDiagnosticEvent("perf_span_start", {
    spanId,
    category,
    name,
    details,
  });

  return {
    spanId,
    category,
    name,
    end(outcome = "ok", details) {
      if (closed) {
        return;
      }
      closed = true;
      writeDiagnosticEvent("perf_span_end", {
        spanId,
        category,
        name,
        outcome,
        durationMs: roundDurationMs(startedAt),
        details,
      });
    },
  };
}

export async function withDiagnosticSpan<T>(
  category: string,
  name: string,
  details: unknown,
  fn: () => Promise<T> | T,
): Promise<T> {
  const span = beginDiagnosticSpan(category, name, details);
  try {
    const result = await fn();
    span.end("ok");
    return result;
  } catch (error) {
    span.end("error", { error });
    throw error;
  }
}

export function listDiagnosticSessionFiles(directory = resolveDiagnosticsDirectory()): readonly string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory)
    .filter((entry) => entry.endsWith(".ndjson"))
    .map((entry) => path.join(directory, entry))
    .sort((left, right) => right.localeCompare(left));
}

export function resolveDiagnosticSessionFile(scope: "current" | "latest" = "current"): string | null {
  if (scope === "current") {
    return getDiagnosticsSessionInfo()?.filePath ?? null;
  }

  const [latest] = listDiagnosticSessionFiles();
  return latest ?? null;
}

export function readDiagnosticRecords(filePath: string): readonly DiagnosticRecord[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) {
    return [];
  }

  // The file is appended while the server runs, so a crash or a concurrent
  // read can leave a partial last line; skip lines that are not whole records.
  return text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as DiagnosticRecord];
    } catch {
      return [];
    }
  });
}

export function summarizeDiagnosticsSession(
  filePath: string,
  options: { includeTimeline?: boolean; maxEntries?: number } = {},
): DiagnosticSessionSummary {
  const records = readDiagnosticRecords(filePath);
  const maxEntries = Math.max(1, Math.min(200, Math.trunc(options.maxEntries ?? 25)));
  const spanGroups = new Map<string, {
    category: string;
    name: string;
    count: number;
    totalDurationMs: number;
    maxDurationMs: number;
    lastOutcome?: string;
  }>();
  const toolCalls = new Map<string, {
    name: string;
    count: number;
    errorCount: number;
    totalLatencyMs: number;
    maxLatencyMs: number;
  }>();

  for (const record of records) {
    if (record.event === "perf_span_end") {
      const details = (record.details ?? {}) as Record<string, unknown>;
      const category = String(details.category ?? "unknown");
      const name = String(details.name ?? "unknown");
      const key = `${category}:${name}`;
      const existing = spanGroups.get(key) ?? {
        category,
        name,
        count: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        lastOutcome: undefined,
      };
      const durationMs = Number(details.durationMs ?? 0);
      existing.count += 1;
      existing.totalDurationMs += durationMs;
      existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
      existing.lastOutcome = typeof details.outcome === "string" ? details.outcome : existing.lastOutcome;
      spanGroups.set(key, existing);
      continue;
    }

    if (record.event === "mcp_call_tool_ok" || record.event === "mcp_call_tool_failed") {
      const details = (record.details ?? {}) as Record<string, unknown>;
      const name = String(details.name ?? "unknown");
      const existing = toolCalls.get(name) ?? {
        name,
        count: 0,
        errorCount: 0,
        totalLatencyMs: 0,
        maxLatencyMs: 0,
      };
      const latencyMs = Number(details.latencyMs ?? 0);
      existing.count += 1;
      existing.totalLatencyMs += latencyMs;
      existing.maxLatencyMs = Math.max(existing.maxLatencyMs, latencyMs);
      if (record.event === "mcp_call_tool_failed" || details.isError === true) {
        existing.errorCount += 1;
      }
      toolCalls.set(name, existing);
    }
  }

  const topSpans = Array.from(spanGroups.values())
    .map((entry) => ({
      category: entry.category,
      name: entry.name,
      count: entry.count,
      totalDurationMs: roundNumber(entry.totalDurationMs),
      avgDurationMs: roundNumber(entry.totalDurationMs / Math.max(1, entry.count)),
      maxDurationMs: roundNumber(entry.maxDurationMs),
      lastOutcome: entry.lastOutcome,
    }))
    .sort((left, right) => right.totalDurationMs - left.totalDurationMs)
    .slice(0, maxEntries);

  const summarizedToolCalls = Array.from(toolCalls.values())
    .map((entry) => ({
      name: entry.name,
      count: entry.count,
      errorCount: entry.errorCount,
      totalLatencyMs: roundNumber(entry.totalLatencyMs),
      avgLatencyMs: roundNumber(entry.totalLatencyMs / Math.max(1, entry.count)),
      maxLatencyMs: roundNumber(entry.maxLatencyMs),
    }))
    .sort((left, right) => right.totalLatencyMs - left.totalLatencyMs);

  const startedAt = records[0]?.ts ?? null;
  const endedAt = records.length > 0 ? (records[records.length - 1]?.ts ?? null) : null;
  const durationMs = startedAt && endedAt
    ? roundNumber(new Date(endedAt).getTime() - new Date(startedAt).getTime())
    : 0;

  const timeline = options.includeTimeline
    ? records.slice(-maxEntries).map((record) => ({
        ts: record.ts,
        event: record.event,
        details: record.details,
      }))
    : undefined;

  return {
    filePath,
    sessionId: records[0]?.sessionId ?? null,
    component: records[0]?.component ?? null,
    eventCount: records.length,
    startedAt,
    endedAt,
    durationMs,
    topSpans,
    toolCalls: summarizedToolCalls,
    ...(timeline ? { timeline } : {}),
  };
}

function ensureState(component: string): DiagnosticsState {
  if (state) {
    return state;
  }

  const info = createSessionInfo(component);
  state = { info };
  return state;
}

function createSessionInfo(component: string): DiagnosticsSessionInfo {
  const directory = resolveDiagnosticsDirectory();
  fs.mkdirSync(directory, { recursive: true });

  const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const safeComponent = component.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "runtime";
  const sessionId = `${startedAt}-${process.pid}`;
  const filePath = path.join(directory, `${sessionId}-${safeComponent}.ndjson`);
  return { component: safeComponent, directory, filePath, sessionId };
}

function resolveDiagnosticsDirectory(): string {
  const configured = process.env.C64BRIDGE_DIAGNOSTICS_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".c64bridge", "diagnostics");
}

function installGlobalHandlers(): void {
  if (!isDiagnosticsEnabled() || handlersInstalled) {
    return;
  }

  handlersInstalled = true;

  process.on("warning", (warning) => {
    writeDiagnosticEvent("process_warning", warning);
  });

  process.on("unhandledRejection", (reason, promise) => {
    writeDiagnosticEvent("unhandled_rejection", {
      reason,
      promise: Object.prototype.toString.call(promise),
    });
  });

  process.on("uncaughtExceptionMonitor", (error, origin) => {
    writeDiagnosticEvent("uncaught_exception", { error, origin });
  });

  process.on("beforeExit", (code) => {
    writeDiagnosticEvent("before_exit", { code });
  });

  process.on("exit", (code) => {
    writeDiagnosticEvent("process_exit", { code });
  });
}

function isDiagnosticsEnabled(): boolean {
  if (process.env.C64BRIDGE_DISABLE_DIAGNOSTICS === "1") {
    return false;
  }
  if (process.env.NODE_ENV === "test" && process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS !== "1") {
    return false;
  }
  return true;
}

function sanitize(value: unknown, depth = 0): unknown {
  return sanitizeUnredacted(redactValue(value), depth);
}

function sanitizeUnredacted(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    const extra = value as Error & { cause?: unknown; code?: unknown };
    return {
      name: value.name,
      message: value.message,
      stack: limitString(value.stack ?? "", 8_000),
      code: extra.code,
      cause: depth < 3 ? sanitize(extra.cause, depth + 1) : undefined,
    };
  }
  if (typeof value === "string") {
    return limitString(value, 8_000);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return {
      type: "Buffer",
      byteLength: value.length,
      previewHex: value.subarray(0, 64).toString("hex"),
    };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      type: value.constructor.name,
      byteLength: value.byteLength,
    };
  }
  if (Array.isArray(value)) {
    if (depth >= 3) {
      return `[Array(${value.length})]`;
    }
    return value.slice(0, 25).map((entry) => sanitize(entry, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 3) {
      return `[Object ${value?.constructor?.name ?? "Object"}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 25);
    return Object.fromEntries(entries.map(([key, entry]) => [key, sanitize(entry, depth + 1)]));
  }
  return String(value);
}

function normalizeChunk(chunk: string | Uint8Array<ArrayBufferLike>): string {
  return typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
}

function keepTail(existing: string, next: string, maxChars: number): string {
  const combined = `${existing}${next}`;
  if (combined.length <= maxChars) {
    return combined;
  }
  return combined.slice(combined.length - maxChars);
}

function limitString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

function roundDurationMs(startedAt: bigint): number {
  return roundNumber(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
}

function roundNumber(value: number): number {
  return Number(value.toFixed(3));
}

function safeStderrWrite(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // Ignore stderr write failures during crash handling.
  }
}
