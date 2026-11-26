/**
 * MCP Tasks extension (`io.modelcontextprotocol/tasks`, spec 2026-07-28): thin mapping of the task engine
 * (`src/tasks/engine.ts`) onto `tools/call` task handles and `tasks/get`, `tasks/update`, `tasks/cancel`.
 *
 * A task handle is returned only to a request whose per-request envelope declares the extension and only for an
 * allowlisted `(tool, op)`. Every other request keeps the ordinary `tools/call` path. The decision never looks
 * at the client name. Task state is process-global (the engine), so it survives stateless HTTP requests.
 */
import { z } from "zod";
import { MissingRequiredClientCapabilityError, ProtocolError, ProtocolErrorCode, type Server } from "@modelcontextprotocol/server";
import { allowlistKey, lookupAllowlist, type AllowlistEntry } from "../tasks/allowlist.js";
import { cancelTask, getTask, runWithInlineWindow, type CallTask } from "../tasks/engine.js";
import { assertAccess } from "../tools/access.js";
import { ToolError, unknownErrorResult } from "../tools/errors.js";
import type { ToolExecutionContext, ToolRunResult } from "../tools/types.js";
import { toCallToolResult } from "./callToolResult.js";

export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
/** Retention after a task finished, in ms (integer 0..86400000). Default: the engine default (10 minutes). */
export const TASK_TTL_ENV = "C64BRIDGE_TASK_TTL_MS";

type RequestContext = { mcpReq: { envelope?: unknown } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when this request's own envelope declares the extension. A pre-2026 request has no envelope. */
export function requestDeclaresExtension(ctx: RequestContext, id: string): boolean {
  const envelope = ctx.mcpReq.envelope;
  if (!isRecord(envelope)) return false;
  // Capabilities count only on a request that also names the protocol revision that defines them.
  if (envelope[PROTOCOL_VERSION_KEY] !== MODERN_PROTOCOL_VERSION) return false;
  const capabilities = envelope[CLIENT_CAPABILITIES_KEY];
  if (!isRecord(capabilities) || !isRecord(capabilities.extensions)) return false;
  return isRecord(capabilities.extensions[id]);
}

function taskTtlMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[TASK_TTL_ENV]?.trim();
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 86_400_000 ? value : undefined;
}

// ---- tools/call ------------------------------------------------------------------------------------------------

export interface NativeCandidate {
  readonly entry: AllowlistEntry;
  readonly op: string;
  /** Arguments without `op`. */
  readonly rest: Record<string, unknown>;
}

/** The allowlist entry when this `tools/call` may become a task for this request; otherwise undefined. */
export function nativeTaskCandidate(ctx: RequestContext, name: string, args: unknown): NativeCandidate | undefined {
  if (!requestDeclaresExtension(ctx, TASKS_EXTENSION_ID)) return undefined;
  if (!isRecord(args) || typeof args.op !== "string") return undefined;
  const entry = lookupAllowlist(allowlistKey(name, args.op));
  if (!entry) return undefined;
  const { op, ...rest } = args;
  return { entry, op: op as string, rest };
}

export type NativeOutcome =
  | { readonly kind: "result"; readonly result: ToolRunResult }
  | { readonly kind: "task"; readonly handle: Record<string, unknown> };

/**
 * Runs the call through the engine. A call that finishes inside the inline window returns its ordinary result
 * (errors thrown by validation, access checks or the resource gate propagate exactly as for a direct call).
 * Otherwise the flat task handle is returned and the request is over: the caller stops its progress reporter.
 */
export async function runNativeCall(
  candidate: NativeCandidate,
  tool: string,
  toolCtx: ToolExecutionContext,
  requestSignal: AbortSignal | undefined,
): Promise<NativeOutcome> {
  // The same check toolRegistry.invoke makes, first, so an access denial wins over a lease conflict as for a direct call.
  assertAccess(tool, candidate.op, candidate.entry.effect);
  const ttlMs = taskTtlMs();
  const outcome = await runWithInlineWindow({
    tool,
    op: candidate.op,
    args: candidate.rest,
    ctx: toolCtx,
    ...(requestSignal ? { requestSignal } : {}),
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
  if (outcome.kind === "result") return outcome;
  return { kind: "task", handle: { resultType: "task", ...taskFields(outcome.task) } };
}

// ---- Task wire shapes ------------------------------------------------------------------------------------------

type ExtensionStatus = "working" | "completed" | "failed" | "cancelled";

/** A thrown ToolError is an ordinary (error) tool result, as in a direct call; any other thrown value is a JSON-RPC failure. */
function failedAsResult(task: CallTask): ToolRunResult | undefined {
  if (task.result) return task.result;
  if (task.errorObject instanceof ToolError) return unknownErrorResult(task.errorObject);
  return undefined;
}

function extensionStatus(task: CallTask): ExtensionStatus {
  if (task.state === "failed") return failedAsResult(task) ? "completed" : "failed";
  return task.state;
}

function ttlFor(task: CallTask): number | null {
  if (task.state === "working" || !task.finishedAt) return null;
  return task.finishedAt.getTime() - task.createdAt.getTime() + task.ttlMs;
}

function taskFields(task: CallTask): Record<string, unknown> {
  return {
    taskId: task.id,
    status: extensionStatus(task),
    ...(task.statusMessage !== undefined ? { statusMessage: task.statusMessage } : {}),
    createdAt: task.createdAt.toISOString(),
    lastUpdatedAt: task.updatedAt.toISOString(),
    ttlMs: ttlFor(task),
    pollIntervalMs: task.pollIntervalMs,
  };
}

function jsonRpcError(task: CallTask): { code: number; message: string; data?: unknown } {
  const thrown = task.errorObject as { code?: unknown; data?: unknown } | undefined;
  const code = typeof thrown?.code === "number" && Number.isSafeInteger(thrown.code) ? thrown.code : ProtocolErrorCode.InternalError;
  return { code, message: task.error ?? "The task failed", ...(thrown?.data !== undefined ? { data: thrown.data } : {}) };
}

function detailedTask(task: CallTask): Record<string, unknown> {
  const base = { resultType: "complete", ...taskFields(task) };
  const status = extensionStatus(task);
  if (status === "completed") {
    const result = failedAsResult(task) ?? task.result;
    return { ...base, ...(result ? { result: toCallToolResult(result) } : {}) };
  }
  if (status === "failed") return { ...base, error: jsonRpcError(task) };
  return base;
}

// ---- tasks/get, tasks/update, tasks/cancel ---------------------------------------------------------------------

function requireTasksExtension(ctx: RequestContext): void {
  if (!requestDeclaresExtension(ctx, TASKS_EXTENSION_ID)) {
    throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } });
  }
}

function lookupTask(taskId: string): CallTask {
  const task = getTask(taskId);
  if (!task) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Task not found");
  return task;
}

const taskIdParams = z.looseObject({ taskId: z.string() });
const updateParams = z.looseObject({ taskId: z.string(), inputResponses: z.record(z.string(), z.unknown()).optional() });

export function registerTaskHandlers(server: Server): void {
  server.setRequestHandler("tasks/get", { params: taskIdParams }, async (params, ctx) => {
    requireTasksExtension(ctx);
    return detailedTask(lookupTask(params.taskId));
  });
  // No task ever asks for input, so there is nothing to apply; the call is acknowledged once the task is known.
  server.setRequestHandler("tasks/update", { params: updateParams }, async (params, ctx) => {
    requireTasksExtension(ctx);
    lookupTask(params.taskId);
    return { resultType: "complete" };
  });
  server.setRequestHandler("tasks/cancel", { params: taskIdParams }, async (params, ctx) => {
    requireTasksExtension(ctx);
    lookupTask(params.taskId);
    cancelTask(params.taskId);
    return { resultType: "complete" };
  });
}
