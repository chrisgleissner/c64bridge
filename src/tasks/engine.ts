// Protocol-independent task engine (contract C1). No MCP imports: the legacy c64_system adapter
// (src/tools/meta/background.ts) and the native Tasks adapter sit on top of this module.
import { randomUUID } from "node:crypto";
import type { C64Facade } from "../device.js";
import type { ToolExecutionContext, ToolRunResult } from "../tools/types.js";
import { cancelledResult } from "../tools/types.js";
import { ToolExecutionError } from "../tools/errors.js";
import { lookupAllowlist, allowlistKey, type AllowlistEntry } from "./allowlist.js";
import { __resetLeasesForTests, acquireLease, releaseLease, type Lease } from "./resources.js";

export type TaskState = "working" | "completed" | "failed" | "cancelled";
export type TaskKind = "interval" | "call";
export type LegacyTaskStatus = "running" | "completed" | "stopped" | "error";

const LEGACY_STATUS: Record<TaskState, LegacyTaskStatus> = {
  working: "running", completed: "completed", cancelled: "stopped", failed: "error",
};

export function toLegacyStatus(state: TaskState): LegacyTaskStatus {
  return LEGACY_STATUS[state];
}

export function fromLegacyStatus(status: unknown): TaskState {
  switch (status) {
    case "completed": return "completed";
    case "stopped": return "cancelled";
    case "error": return "failed";
    default: return "working";
  }
}

export const MAX_WORKING_TASKS = 16;

export class WorkingTaskLimitError extends ToolExecutionError {
  constructor() {
    super(`Too many running background tasks (limit ${MAX_WORKING_TASKS}); stop one first.`, { code: "too_many_tasks" });
  }
}
export const MAX_FINISHED_CALL_TASKS = 64;
export const DEFAULT_TASK_TTL_MS = 600_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_INLINE_MS = 1_000;
export const MAX_INLINE_MS = 600_000;
export const INLINE_ENV_VAR = "C64BRIDGE_TASK_INLINE_MS";

// ---- clock ---------------------------------------------------------------------------------

export interface EngineClock {
  now(): number;
  monotonicNow(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: EngineClock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

let clock: EngineClock = realClock;

/** Replaces the clock and timers (fake-clock tests). Missing members keep the real implementation. */
export function setEngineClock(next: Partial<EngineClock> | null): void {
  clock = next ? { ...realClock, ...next } : realClock;
}

export function engineNow(): number {
  return clock.now();
}

/** A timer on the engine clock. It never keeps the process alive. */
export function startEngineTimer(callback: () => void, ms: number): unknown {
  const handle = clock.setTimeout(callback, ms);
  (handle as { unref?: () => void } | undefined)?.unref?.();
  return handle;
}

export function clearEngineTimer(handle: unknown): void {
  if (handle !== undefined && handle !== null) clock.clearTimeout(handle);
}

// ---- tasks ---------------------------------------------------------------------------------

/** What every task, of either kind, has in common; `transition` works on this. */
export interface TaskCore {
  readonly kind: TaskKind;
  state: TaskState;
  updatedAt: Date;
  finishedAt?: Date | null;
  statusMessage?: string;
  /** Aborted when the task is cancelled. The operation receives this signal, never the request signal. */
  readonly controller: AbortController;
  lease: Lease | null;
  /** Called once on the terminal transition, before the lease is released (clears timers). */
  cleanup?: () => void;
}

export interface TransitionPayload {
  readonly result?: ToolRunResult;
  readonly error?: string;
  readonly errorObject?: unknown;
  readonly statusMessage?: string;
}

export interface CallTask extends TaskCore {
  readonly kind: "call";
  readonly id: string;
  readonly name?: string;
  readonly tool: string;
  readonly op: string;
  readonly backendId: string;
  readonly createdAt: Date;
  readonly monotonicStart: number;
  readonly ttlMs: number;
  readonly pollIntervalMs: number;
  result?: ToolRunResult;
  error?: string;
  /** The original thrown value, so an adapter can rethrow it unchanged. Not part of the wire result. */
  errorObject?: unknown;
  /** True once the adapter has handed the task over; the request signal no longer cancels it. */
  handedOver: boolean;
  /** Keep the lease after a cancel until the underlying call has finished (operations that ignore the signal). */
  deferLeaseRelease: boolean;
  runSettled: boolean;
  expiryTimer?: unknown;
  unlinkRequestSignal?: () => void;
  waiters: Set<() => void>;
}

const callTasks = new Map<string, CallTask>();

export function isTerminal(state: TaskState): boolean {
  return state !== "working";
}

/**
 * The single place a task changes state. Returns false and changes nothing when the task is no
 * longer working (a late completion never overwrites a cancellation; a repeated cancel is a no-op).
 * On the terminal transition: records result/error, aborts the controller on cancel, runs the
 * task's cleanup, releases the lease, unlinks the request signal, wakes waiters and starts the
 * expiry of a call task.
 */
export function transition(task: TaskCore, to: TaskState, payload: TransitionPayload = {}): boolean {
  if (task.state !== "working" || to === "working") return false;
  task.state = to;
  const now = new Date(clock.now());
  task.updatedAt = now;
  task.finishedAt = now;
  if (payload.statusMessage !== undefined) task.statusMessage = payload.statusMessage;
  if (task.kind === "call") {
    const call = task as CallTask;
    if (payload.result !== undefined) call.result = payload.result;
    if (payload.error !== undefined) call.error = payload.error;
    if (payload.errorObject !== undefined) call.errorObject = payload.errorObject;
  }
  try { task.cleanup?.(); } catch { /* cleanup must not block the transition */ }
  if (to === "cancelled") task.controller.abort(new DOMException("The task was cancelled.", "AbortError"));
  if (task.kind === "call") {
    const call = task as CallTask;
    call.unlinkRequestSignal?.();
    call.unlinkRequestSignal = undefined;
    if (!(to === "cancelled" && call.deferLeaseRelease && !call.runSettled)) {
      releaseLease(call.lease);
      call.lease = null;
    }
    for (const wake of [...call.waiters]) wake();
    call.waiters.clear();
    scheduleExpiry(call);
    enforceRetention();
  } else {
    releaseLease(task.lease);
    task.lease = null;
  }
  return true;
}

function scheduleExpiry(task: CallTask): void {
  clearEngineTimer(task.expiryTimer);
  task.expiryTimer = startEngineTimer(() => {
    task.expiryTimer = undefined;
    removeTask(task);
  }, task.ttlMs);
}

function removeTask(task: CallTask): void {
  clearEngineTimer(task.expiryTimer);
  task.expiryTimer = undefined;
  if (callTasks.get(task.id) === task) callTasks.delete(task.id);
}

function enforceRetention(): void {
  const finished = [...callTasks.values()].filter((task) => isTerminal(task.state))
    .sort((a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0));
  for (const task of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_CALL_TASKS))) removeTask(task);
}

function expired(task: CallTask): boolean {
  return isTerminal(task.state) && task.finishedAt !== undefined && task.finishedAt !== null
    && clock.now() - task.finishedAt.getTime() >= task.ttlMs;
}

// ---- adapters for interval tasks -----------------------------------------------------------

export interface TaskSource {
  /** Number of working tasks this source owns. */
  countWorking(): number;
  hasWorkingName?(name: string): boolean;
  /** Cancels every working task this source owns and persists the result. */
  stopAll(): Promise<void> | void;
}

const sources = new Map<string, TaskSource>();

/** Registers (or replaces) the source of a task kind other than "call". */
export function registerTaskSource(kind: string, source: TaskSource): void {
  sources.set(kind, source);
}

/** The source registered for a kind, so a test that replaces it can put the original back. */
export function getTaskSource(kind: string): TaskSource | undefined {
  return sources.get(kind);
}

export function countWorkingTasks(): number {
  let count = 0;
  for (const task of callTasks.values()) if (task.state === "working") count += 1;
  for (const source of sources.values()) count += source.countWorking();
  return count;
}

// ---- call tasks ----------------------------------------------------------------------------

export type InvokeFn = (name: string, args: unknown, ctx: ToolExecutionContext) => Promise<ToolRunResult>;

export interface CallSpec {
  /** Allowlisted tool, for example "c64_memory". */
  readonly tool: string;
  /** Allowlisted operation, for example "wait_for_text". */
  readonly op: string;
  /** Arguments of the operation, without `op`. */
  readonly args?: Record<string, unknown>;
  /** Context of the submitting request. Its `signal` is ignored; the task gets its own. */
  readonly ctx: ToolExecutionContext;
  readonly name?: string;
  readonly ttlMs?: number;
  readonly pollIntervalMs?: number;
  /** Cancels the task until it is handed over. */
  readonly requestSignal?: AbortSignal;
  /** Backend id for the lease; resolved from the client when absent. */
  readonly backendId?: string;
  /** Test seam; defaults to toolRegistry.invoke (imported lazily to avoid an import cycle). */
  readonly invoke?: InvokeFn;
}

async function defaultInvoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  const { toolRegistry } = await import("../tools/registry/index.js");
  return toolRegistry.invoke(name, args, ctx);
}

async function resolveBackendId(client: CallSpec["ctx"]["client"]): Promise<string> {
  try {
    const type = await client?.getActiveBackendType?.();
    if (typeof type === "string" && type.length > 0) return type;
  } catch { /* fall through */ }
  return "unknown";
}

function checkOptionalInt(value: number | undefined, label: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ToolExecutionError(`${label} must be an integer from ${min} to ${max}`, { code: "invalid_task_option" });
  }
  return value;
}

function checkSubmission(name: string | undefined): CallTask | undefined {
  const existing = name === undefined ? undefined : findByName(name);
  if (name !== undefined && (existing?.state === "working" || [...sources.values()].some((source) => source.hasWorkingName?.(name)))) {
    throw new ToolExecutionError(`A background task named "${name}" is already running`, { code: "task_name_in_use" });
  }
  if (countWorkingTasks() >= MAX_WORKING_TASKS) throw new WorkingTaskLimitError();
  return existing;
}

/**
 * Starts one detached run of an allowlisted operation. Register the task only after verifying
 * its lease covers the selected backend and its name and working slot are still available.
 */
export async function submitCall(spec: CallSpec): Promise<CallTask> {
  const key = allowlistKey(spec.tool, spec.op);
  const entry: AllowlistEntry | undefined = lookupAllowlist(key);
  if (!entry) {
    throw new ToolExecutionError(`${key} is not an operation that can run as a background task`, { code: "task_not_allowed" });
  }
  const ttlMs = checkOptionalInt(spec.ttlMs, "ttlMs", 0, 86_400_000) ?? DEFAULT_TASK_TTL_MS;
  const pollIntervalMs = checkOptionalInt(spec.pollIntervalMs, "pollIntervalMs", 1, 3_600_000) ?? DEFAULT_POLL_INTERVAL_MS;
  const client = spec.ctx.client;
  const backendId = spec.backendId ?? await resolveBackendId(client);

  checkSubmission(spec.name);
  const id = randomUUID();
  const lease = acquireLease({ taskId: id, backendId, mode: entry.lease, tool: spec.tool, op: spec.op, pinned: entry.pinned });
  let taskFacade: C64Facade | undefined;
  try {
    if (entry.pinned && client?.pinFacade) taskFacade = await client.pinFacade();
    const active = client?.getSelectedBackendType?.() ?? await resolveBackendId(client);
    if (active !== backendId || (taskFacade && taskFacade.type !== backendId)) {
      throw new ToolExecutionError(
        `${key} cannot start: a backend switch changed the selection from ${backendId} to ${active} during submission.`,
        { code: "resource_conflict", details: { backend: backendId, activeBackend: active } },
      );
    }
    const previous = checkSubmission(spec.name);
    if (previous) removeTask(previous);
  } catch (error) {
    releaseLease(lease);
    throw error;
  }
  const now = clock.now();
  const task: CallTask = {
    kind: "call", id, name: spec.name, tool: spec.tool, op: spec.op, backendId,
    state: "working", createdAt: new Date(now), updatedAt: new Date(now), finishedAt: null,
    monotonicStart: clock.monotonicNow(), ttlMs, pollIntervalMs,
    controller: new AbortController(), lease, handedOver: false,
    deferLeaseRelease: entry.cancellation === "bounded", runSettled: false, waiters: new Set(),
  };
  callTasks.set(id, task);

  const requestSignal = spec.requestSignal;
  if (requestSignal) {
    const onAbort = (): void => { if (!task.handedOver) transition(task, "cancelled", { statusMessage: "Cancelled with the submitting request." }); };
    if (requestSignal.aborted) {
      onAbort();
    } else {
      requestSignal.addEventListener("abort", onAbort, { once: true });
      task.unlinkRequestSignal = () => requestSignal.removeEventListener("abort", onAbort);
    }
  }

  if (task.state === "working") {
    const invoke = spec.invoke ?? defaultInvoke;
    const ctx: ToolExecutionContext = {
      ...spec.ctx,
      signal: task.controller.signal,
      taskLease: id,
      ...(taskFacade ? { taskFacade } : {}),
      reportProgress: (completed, total, message) => {
        if (message !== undefined && task.state === "working") task.statusMessage = message;
        spec.ctx.reportProgress?.(completed, total, message);
      },
    };
    const running = run(task, invoke, { ...(spec.args ?? {}), op: spec.op }, ctx);
    runningCalls.add(running);
    void running.finally(() => runningCalls.delete(running));
  }
  return task;
}

async function run(task: CallTask, invoke: InvokeFn, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<void> {
  try {
    const result = await invoke(task.tool, args, ctx);
    if (result?.isError === true) {
      if (result.metadata?.cancelled === true) {
        transition(task, "cancelled", { result, statusMessage: "Cancelled." });
      } else {
        transition(task, "failed", { result, error: resultErrorText(result) });
      }
    } else {
      transition(task, "completed", { result });
    }
  } catch (error) {
    transition(task, "failed", { error: error instanceof Error ? error.message : String(error), errorObject: error });
  } finally {
    task.runSettled = true;
    if (isTerminal(task.state) && task.lease) {
      releaseLease(task.lease);
      task.lease = null;
    }
  }
}

function resultErrorText(result: ToolRunResult): string {
  const text = (result.content ?? []).find((block) => block.type === "text") as { text?: string } | undefined;
  return text?.text ?? "The operation reported an error.";
}

export function getTask(id: string): CallTask | undefined {
  const task = callTasks.get(id);
  if (task && expired(task)) {
    removeTask(task);
    return undefined;
  }
  return task;
}

export function findByName(name: string): CallTask | undefined {
  for (const task of callTasks.values()) {
    if (task.name === name && !expired(task)) return task;
  }
  return undefined;
}

export function listCallTasks(): CallTask[] {
  return [...callTasks.values()].filter((task) => !expired(task));
}

/** Cancels a working task; a finished task is returned unchanged (repeated cancel is a no-op). */
export function cancelTask(id: string): CallTask | undefined {
  const task = getTask(id);
  if (task) transition(task, "cancelled", { statusMessage: "Cancelled." });
  return task;
}

/** Marks the task as handed over to the client: the request signal no longer cancels it. */
export function handoverTask(id: string): void {
  const task = callTasks.get(id);
  if (!task) return;
  task.handedOver = true;
  task.unlinkRequestSignal?.();
  task.unlinkRequestSignal = undefined;
}

/** Removes a task record (any state). A working task is cancelled first. */
export function deleteTask(id: string): boolean {
  const task = callTasks.get(id);
  if (!task) return false;
  transition(task, "cancelled", { statusMessage: "Deleted." });
  removeTask(task);
  return true;
}

/**
 * Resolves with the task when it reaches a terminal state, or with its current (working) state
 * after timeoutMs or when `signal` aborts. Never rejects. Undefined when the task does not exist.
 */
export function waitForTask(id: string, timeoutMs: number, signal?: AbortSignal): Promise<CallTask | undefined> {
  const task = getTask(id);
  if (!task || isTerminal(task.state) || timeoutMs <= 0 || signal?.aborted) return Promise.resolve(task);
  return new Promise((resolve) => {
    let timer: unknown;
    const finish = (): void => {
      clearEngineTimer(timer);
      signal?.removeEventListener("abort", finish);
      task.waiters.delete(finish);
      resolve(getTask(id) ?? task);
    };
    task.waiters.add(finish);
    signal?.addEventListener("abort", finish, { once: true });
    timer = startEngineTimer(finish, timeoutMs);
  });
}

/** Shutdown: cancels every working task of every kind and clears every timer the engine holds. */
/** Runs of call tasks that have not settled yet, so shutdown can let their cleanup finish. */
const runningCalls = new Set<Promise<void>>();
const STOP_CLEANUP_GRACE_MS = 1000;

export async function stopAllTasks(): Promise<void> {
  for (const task of [...callTasks.values()]) {
    transition(task, "cancelled", { statusMessage: "Stopped at shutdown." });
    clearEngineTimer(task.expiryTimer);
    task.expiryTimer = undefined;
  }
  // A cancelled operation may still be cleaning up (for example removing a VICE checkpoint); wait at most 1 s.
  if (runningCalls.size > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_CLEANUP_GRACE_MS); });
    await Promise.race([Promise.allSettled([...runningCalls]), deadline]);
    clearTimeout(timer);
  }
  for (const source of sources.values()) await source.stopAll();
}

export function __resetForTests(): void {
  for (const task of [...callTasks.values()]) {
    transition(task, "cancelled", { statusMessage: "Reset." });
    task.handedOver = true;
    clearEngineTimer(task.expiryTimer);
  }
  callTasks.clear();
  __resetLeasesForTests();
  setEngineClock(null);
}

// ---- inline window (contract C2) -----------------------------------------------------------

/** Inline window in ms: C64BRIDGE_TASK_INLINE_MS (integer 0..600000), read on every call; invalid values use the default. */
export function inlineWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[INLINE_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_INLINE_MS;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0 && value <= MAX_INLINE_MS ? value : DEFAULT_INLINE_MS;
}

export type InlineOutcome =
  | { readonly kind: "result"; readonly result: ToolRunResult }
  | { readonly kind: "task"; readonly task: CallTask };

export interface InlineOptions {
  /** Overrides the environment variable (tests). */
  readonly inlineMs?: number;
  /** Keep a task that completed inside the window and return it as kind "task" (the legacy adapter reports it by name later). */
  readonly keepCompleted?: boolean;
}

/**
 * Submits a call and waits up to the inline window. A task that finishes inside the window is
 * dropped and its ordinary tool result is returned (or its original error rethrown), so every
 * client sees the same validation errors, denials, conflicts and fast results. A task still
 * working after the window is handed over and returned.
 */
export async function runWithInlineWindow(spec: CallSpec, options: InlineOptions = {}): Promise<InlineOutcome> {
  const inlineMs = options.inlineMs ?? inlineWindowMs();
  const task = await submitCall(spec);
  const settled = await waitForTask(task.id, inlineMs, spec.requestSignal) ?? task;
  if (settled.state === "working") {
    handoverTask(settled.id);
    return { kind: "task", task: settled };
  }
  if (settled.state === "completed" && options.keepCompleted) {
    handoverTask(settled.id);
    return { kind: "task", task: settled };
  }
  removeTask(settled);
  if (settled.state === "completed" && settled.result) return { kind: "result", result: settled.result };
  if (settled.state === "failed") {
    if (settled.result) return { kind: "result", result: settled.result };
    throw settled.errorObject ?? new ToolExecutionError(settled.error ?? "The task failed");
  }
  return { kind: "result", result: settled.result ?? cancelledResult() };
}
