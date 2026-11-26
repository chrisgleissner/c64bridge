// Background task management meta tools
import { assertAccess, taskOperationEffect } from "../access.js";
import type { ToolDefinition } from "../types.js";
import { objectSchema, stringSchema, numberSchema, optionalSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolValidationError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { promises as fs } from "node:fs";
import { dirname, resolve as resolvePath, join as joinPath, sep } from "node:path";
import type { C64Facade } from "../../device.js";
import { readScreenThroughFacade } from "../../monitor/screenRead.js";
import { resolveAddressSymbol } from "../../knowledge.js";
import { assertAddressRange, assertNotBareHex, parseNumericLiteral } from "../../numericArg.js";
import { stripHexByteSeparators } from "../hex.js";
import { loggerFor } from "../../logger.js";
import { formatTimestampSpec, parseTimestampSpec } from "./util.js";
import { stateRootDir } from "../../hostPaths.js";

import { randomUUID } from "node:crypto";
import { processIsAlive, withTaskStateLock } from "../../taskStateLock.js";
import {
  MAX_WORKING_TASKS, type CallTask, type LegacyTaskStatus, type TaskCore, cancelTask as cancelCallTask, clearEngineTimer,
  countWorkingTasks, deleteTask as deleteCallTask, engineNow, findByName as findCallTask, fromLegacyStatus,
  listCallTasks, registerTaskSource, runWithInlineWindow, startEngineTimer, stopAllTasks, toLegacyStatus,
  transition, waitForTask,
} from "../../tasks/engine.js";
import { allowlistKey, listAllowlistKeys, lookupAllowlist, looksLikeAllowlistKey } from "../../tasks/allowlist.js";

const SESSION_ID = randomUUID();
let nextTaskId = 0;
const deletedTaskIds = new Set<string>();

type TaskStatus = LegacyTaskStatus;
interface BackgroundTask extends TaskCore {
  readonly kind: "interval";
  ownerPid?: number;
  ownerSession?: string;
  id: string; // e.g. 0001_read
  name: string;
  type: "background";
  operation: string;
  args: Record<string, unknown>;
  intervalMs: number;
  maxIterations?: number;
  iterations: number;
  startedAt: Date;
  updatedAt: Date;
  stoppedAt?: Date | null;
  lastError?: string | null;
  lastResult?: unknown;
  nextRunAt?: Date | null;
  folder: string; // e.g. tasks/background/0001_read
  backendId?: string | null; // backend the task was pinned to at start
  _lastPersistedAt?: number;
  _timer?: unknown; // transient engine timer handle, not persisted
  _facade?: C64Facade; // transient: facade pinned at start, so a later backend switch cannot retarget the task
}

const TASKS: Map<string, BackgroundTask> = new Map();
const logger = loggerFor("background");

export const MIN_INTERVAL_MS = 100;
export const MAX_RUNNING_TASKS = MAX_WORKING_TASKS;
export const MAX_ITERATIONS_LIMIT = 100_000;
/** One day. A larger value cannot be a setTimeout delay (Node runs a delay above 2^31-1 ms after 1 ms). */
export const MAX_INTERVAL_MS = 86_400_000;
const MAX_FINISHED_TASKS = 200;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_TASK_RESULT_WAIT_MS = 60_000;

// Operations runOperation implements, including the *_memory aliases.
const SUPPORTED_OPERATIONS = ["read", "write", "read_screen", "menu_button", "read_memory", "write_memory"] as const;
// The registry file is rewritten on every persist, so a stored result stays small (a screen is 1000 characters).
const MAX_STORED_RESULT_CHARS = 1024;

function summariseResult(result: unknown): unknown {
  let text: string;
  try {
    text = JSON.stringify(result) ?? "null";
  } catch {
    return String(result).slice(0, MAX_STORED_RESULT_CHARS);
  }
  if (text.length <= MAX_STORED_RESULT_CHARS) {
    return JSON.parse(text);
  }
  return { truncated: true, preview: text.slice(0, MAX_STORED_RESULT_CHARS) };
}

function normaliseOperation(op: string): string {
  switch (op) {
    case "read_memory":
      return "read";
    case "write_memory":
      return "write";
    default:
      return op;
  }
}

type PersistedTask = {
  ownerPid?: number;
  ownerSession?: string;
  id: string;
  name: string;
  type: "background";
  operation: string;
  args: Record<string, unknown>;
  intervalMs: number;
  maxIterations?: number;
  iterations: number;
  status: TaskStatus;
  startedAt: string;
  updatedAt: string;
  stoppedAt?: string | null;
  lastError?: string | null;
  lastResult?: unknown;
  nextRunAt?: string | null;
  folder: string;
  backendId?: string | null;
};

function toPersistedTask(t: BackgroundTask): PersistedTask {
  return {
    ownerPid: t.ownerPid, ownerSession: t.ownerSession,
    id: t.id,
    name: t.name,
    type: t.type,
    operation: t.operation,
    args: t.args,
    intervalMs: t.intervalMs,
    maxIterations: t.maxIterations,
    iterations: t.iterations,
    status: toLegacyStatus(t.state),
    startedAt: formatTimestampSpec(t.startedAt),
    updatedAt: formatTimestampSpec(t.updatedAt),
    stoppedAt: t.stoppedAt ? formatTimestampSpec(t.stoppedAt) : null,
    lastError: t.lastError ?? null,
    lastResult: t.lastResult ?? null,
    nextRunAt: t.nextRunAt ? formatTimestampSpec(t.nextRunAt) : null,
    folder: t.folder,
    backendId: t.backendId ?? null,
  };
}

function newIntervalTask(fields: Omit<BackgroundTask, "kind" | "controller" | "lease" | "cleanup">): BackgroundTask {
  const task: BackgroundTask = { ...fields, kind: "interval", controller: new AbortController(), lease: null };
  // The terminal transition clears the pending timer.
  task.cleanup = () => {
    if (task._timer) clearEngineTimer(task._timer);
    task._timer = null;
  };
  return task;
}

function fromPersistedTask(p: PersistedTask): BackgroundTask {
  return newIntervalTask({
    ownerPid: p.ownerPid, ownerSession: p.ownerSession,
    id: p.id,
    name: p.name,
    type: "background",
    operation: p.operation,
    args: p.args ?? {},
    intervalMs: p.intervalMs,
    maxIterations: p.maxIterations,
    iterations: p.iterations,
    state: fromLegacyStatus(p.status),
    startedAt: parseTimestampSpec(p.startedAt) ?? new Date(),
    updatedAt: parseTimestampSpec(p.updatedAt) ?? new Date(),
    stoppedAt: parseTimestampSpec(p.stoppedAt ?? null),
    lastError: p.lastError ?? null,
    lastResult: p.lastResult ?? null,
    nextRunAt: parseTimestampSpec(p.nextRunAt ?? null),
    folder: p.folder,
    backendId: p.backendId ?? null,
    _timer: null,
  });
}

function getTasksHomeDir(): string {
  const overrideFile = process.env.C64_TASK_STATE_FILE ? resolvePath(String(process.env.C64_TASK_STATE_FILE)) : null;
  if (overrideFile) {
    return dirname(overrideFile);
  }
  return resolvePath(stateRootDir());
}

function getTaskStateFilePath(): string {
  const override = process.env.C64_TASK_STATE_FILE;
  if (override) return resolvePath(String(override));
  return resolvePath(joinPath(getTasksHomeDir(), "tasks.json"));
}

function getBackgroundTaskFolderRelative(id: string): string {
  return `tasks/background/${id}`;
}

function getBackgroundTaskFolderAbsolute(id: string): string {
  const base = resolvePath(joinPath(getTasksHomeDir(), "tasks", "background"));
  const folder = resolvePath(joinPath(getTasksHomeDir(), getBackgroundTaskFolderRelative(id)));
  // The task name is schema-restricted to one path segment; this also guards ids read from a state file.
  if (!folder.startsWith(base + sep)) {
    throw new ToolValidationError("Task folder must stay inside the background task directory", { path: "$.name" });
  }
  return folder;
}

let tasksLoadedPromise: Promise<void> | null = null;

// Every caller awaits the same load, so a concurrent first call never sees an empty registry.
function ensureTasksLoaded(): Promise<void> {
  if (!tasksLoadedPromise) {
    tasksLoadedPromise = loadTasks();
  }
  return tasksLoadedPromise;
}

async function moveCorruptStateAside(path: string, reason: string): Promise<void> {
  const target = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    await fs.rename(path, target);
    logger.error(`Background task state file is unreadable (${reason}); moved it to ${target} and starting with an empty registry`);
  } catch (error) {
    logger.error(`Background task state file is unreadable (${reason}) and could not be moved aside: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * True when the process that wrote an owner record is still running. A record with this process's
 * PID but another session was left by an earlier process: a restarted server, typically in a
 * container, often gets the same PID, and that record is dead.
 */
function ownerIsLive(pid: unknown, session: unknown): boolean {
  if (pid === process.pid && session !== SESSION_ID) return false;
  return processIsAlive(pid);
}

function isOwned(task: BackgroundTask): boolean {
  return task.ownerPid === process.pid && task.ownerSession === SESSION_ID;
}

function requireOwnership(task: BackgroundTask): void {
  if (!isOwned(task)) throw new ToolValidationError("Task is owned by another live MCP process", { path: "$.name" });
}

async function loadTasks(): Promise<void> {
  await withTaskStateLock(getTaskStateFilePath(), readTasks);
}

async function readTasks(): Promise<void> {
  const path = getTaskStateFilePath();
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      await fs.mkdir(dirname(path), { recursive: true });
      await writeFileAtomic(path, JSON.stringify({ tasks: [] }, null, 2));
    } else {
      logger.error(`Unable to read background task state file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    await moveCorruptStateAside(path, error instanceof Error ? error.message : String(error));
    return;
  }
  if (!parsed || !Array.isArray(parsed.tasks)) {
    await moveCorruptStateAside(path, "missing tasks array");
    return;
  }
  const diskIds = new Set((parsed.tasks as PersistedTask[]).map((task) => task.id));
  for (const [name, task] of TASKS) {
    if (!isOwned(task) && !diskIds.has(task.id)) TASKS.delete(name);
  }
  for (const pt of parsed.tasks as PersistedTask[]) {
    const t = fromPersistedTask(pt);
    const liveOwner = ownerIsLive(t.ownerPid, t.ownerSession);
    if (!liveOwner) { t.ownerPid = process.pid; t.ownerSession = SESSION_ID; }
    if (t.state === "working" && !liveOwner) {
      transition(t, "cancelled");
      t.stoppedAt = new Date();
      t.updatedAt = new Date();
      t.lastError = "Interrupted by MCP server restart; start the task again to resume monitoring.";
      t.nextRunAt = null;
    }
    const local = TASKS.get(t.name);
    if (!local || !isOwned(local)) TASKS.set(t.name, t);
  }
  await pruneFinishedTasks();
  const localById = new Map([...TASKS.values()].map((task) => [task.id, task]));
  const snapshot: PersistedTask[] = parsed.tasks.map((task: PersistedTask) => {
    const local = localById.get(task.id);
    return local && !ownerIsLive(task.ownerPid, task.ownerSession) ? toPersistedTask(local) : task;
  });
  const finished = snapshot.filter((task) => task.status !== "running").sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const retained = new Set(finished.slice(0, MAX_FINISHED_TASKS).map((task) => task.id));
  const data = snapshot.filter((task) => task.status === "running" || retained.has(task.id));
  if (JSON.stringify(data) !== JSON.stringify(parsed.tasks)) {
    await writeFileAtomic(path, JSON.stringify({ tasks: data }, null, 2));
  }
}

let tempFileCounter = 0;

// Write to a temporary file in the same directory, then rename, so readers never see a partial file.
async function writeFileAtomic(path: string, data: string): Promise<void> {
  tempFileCounter += 1;
  const temp = `${path}.${process.pid}.${tempFileCounter}.tmp`;
  try {
    await fs.writeFile(temp, data, "utf8");
    await fs.rename(temp, path);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeTaskJson(task: BackgroundTask): Promise<void> {
  const folderAbs = getBackgroundTaskFolderAbsolute(task.id);
  const resultRelative = `${task.folder}/result.json`;
  const pt = toPersistedTask(task);
  const data = { ...pt, resultPath: resultRelative } as const;
  await fs.mkdir(folderAbs, { recursive: true });
  await writeFileAtomic(resolvePath(folderAbs, "task.json"), JSON.stringify(data, null, 2));
}

async function ensureResultAndLog(task: BackgroundTask): Promise<void> {
  const folderAbs = getBackgroundTaskFolderAbsolute(task.id);
  await fs.mkdir(folderAbs, { recursive: true });
  const resultPath = resolvePath(folderAbs, "result.json");
  const logPath = resolvePath(folderAbs, "log.txt");
  await writeFileAtomic(resultPath, JSON.stringify({
    id: task.id, type: "task", name: task.operation,
    created: formatTimestampSpec(task.startedAt), updatedAt: formatTimestampSpec(task.updatedAt),
    status: toLegacyStatus(task.state), iterations: task.iterations, lastResult: task.lastResult ?? null,
    lastError: task.lastError ?? null,
  }, null, 2));
  try {
    await fs.access(logPath);
  } catch {
    await fs.writeFile(logPath, "", "utf8");
  }
}

async function appendTaskLog(task: BackgroundTask, message: string): Promise<void> {
  const logPath = resolvePath(getBackgroundTaskFolderAbsolute(task.id), "log.txt");
  const ts = formatTimestampSpec(task.updatedAt ?? task.startedAt ?? new Date());
  await fs.appendFile(logPath, `[${ts}] ${message}\n`, "utf8");
  await capTaskLog(logPath);
}

// Keep only the last MAX_LOG_BYTES of log.txt once it grows beyond that.
async function capTaskLog(logPath: string): Promise<void> {
  const stats = await fs.stat(logPath);
  if (stats.size <= MAX_LOG_BYTES) return;
  const handle = await fs.open(logPath, "r");
  try {
    const buffer = Buffer.alloc(MAX_LOG_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_LOG_BYTES, stats.size - MAX_LOG_BYTES);
    let kept = buffer.subarray(0, bytesRead);
    const firstNewline = kept.indexOf(0x0a);
    if (firstNewline >= 0 && firstNewline < kept.length - 1) {
      kept = kept.subarray(firstNewline + 1); // drop the partial first line
    }
    await writeFileAtomic(logPath, kept.toString("utf8"));
  } finally {
    await handle.close();
  }
}

async function pruneFinishedTasks(): Promise<void> {
  const finished = [...TASKS.values()].filter((task) => task.state !== "working")
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  for (const task of finished.slice(MAX_FINISHED_TASKS)) {
    TASKS.delete(task.name);
    if (isOwned(task) || !ownerIsLive(task.ownerPid, task.ownerSession)) {
      try { await fs.rm(getBackgroundTaskFolderAbsolute(task.id), { recursive: true, force: true }); }
      catch (error) { logger.warn(`Unable to prune finished task artifacts: ${String(error)}`); }
    }
  }
}

// Persistence is serialised so two writers never rename over each other.
let persistChain: Promise<void> = Promise.resolve();

function persistTasks(changedTasks: readonly BackgroundTask[] = [], strict = false): Promise<void> {
  const run = persistChain.then(async () => {
    try {
      const path = getTaskStateFilePath();
      await withTaskStateLock(path, async () => {
        let disk: PersistedTask[] = [];
        try { disk = JSON.parse(await fs.readFile(path, "utf8")).tasks ?? []; }
        catch (error: any) { if (error?.code !== "ENOENT") throw error; }
        const owned = [...TASKS.values()].filter(isOwned);
        for (const task of changedTasks) {
          if (task.state === "working" && disk.some((other) => other.name === task.name && other.id !== task.id && other.status === "running" && ownerIsLive(other.ownerPid, other.ownerSession))) {
            throw new ToolValidationError("Task with this name is already running in another MCP process", { path: "$.name" });
          }
        }
        const ownedIds = new Set(owned.map((task) => task.id));
        const merged = disk.filter((task) => !(task.ownerPid === process.pid && task.ownerSession === SESSION_ID) && !ownedIds.has(task.id) && !deletedTaskIds.has(task.id));
        merged.push(...owned.map(toPersistedTask));
        const finished = merged.filter((task) => task.status !== "running").sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        const retained = new Set(finished.slice(0, MAX_FINISHED_TASKS).map((task) => task.id));
        const data = merged.filter((task) => task.status === "running" || retained.has(task.id));
        await writeFileAtomic(path, JSON.stringify({ tasks: data }, null, 2));
        deletedTaskIds.clear();
        await pruneFinishedTasks();
      });
      // Only the changed tasks get their per-task files rewritten.
      for (const t of changedTasks) {
        // A stopped task that was restarted under its name shares the folder with its successor; its stale object must not overwrite the successor's task.json.
        if (TASKS.get(t.name) !== t) continue;
        await writeTaskJson(t);
        await ensureResultAndLog(t);
        t._lastPersistedAt = Date.now();
      }
    } catch (error) {
      if (strict || error instanceof ToolValidationError) throw error;
      logger.warn(`Unable to persist background task state: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  persistChain = run.catch(() => {});
  return run;
}

function runOperation(task: BackgroundTask, ctx: Parameters<ToolDefinition["execute"]>[1]) {
  const args = task.args;
  const facade = task._facade;
  switch (normaliseOperation(task.operation)) {
    case "read": {
      const address = String((args as any).address ?? "$0400");
      const length = String((args as any).length ?? "16");
      return ctx.client.readMemory(address, length, facade);
    }
    case "write": {
      const address = String((args as any).address ?? "$0400");
      const bytes = String((args as any).bytes ?? "$00");
      return ctx.client.writeMemory(address, bytes, facade);
    }
    case "read_screen": {
      if (facade) return readScreenThroughFacade(ctx, facade);
      return ctx.client.readScreen();
    }
    case "menu_button": {
      return facade ? facade.menuButton() : ctx.client.menuButton();
    }
    default:
      return Promise.resolve({ success: true });
  }
}

function scheduleNextRun(task: BackgroundTask, ctx: Parameters<ToolDefinition["execute"]>[1]): void {
  if (task.state !== "working") return;
  const delay = Math.min(MAX_INTERVAL_MS, Math.max(0, task.intervalMs));
  task.nextRunAt = new Date(engineNow() + delay);
  task._timer = startEngineTimer(async () => {
    if (task.state !== "working") return;
    try {
      const result = await runOperation(task, ctx);
      // A stop that arrived while the operation was in flight wins: never turn it into completed/error.
      if (task.state !== "working") return;
      if (result && typeof result === "object" && "success" in result && (result as { success?: unknown }).success === false) {
        throw new Error(`Operation returned failure: ${JSON.stringify((result as { details?: unknown }).details ?? result)}`);
      }
      task.iterations += 1;
      task.lastResult = summariseResult(result);
      task.updatedAt = new Date();
      if (task.maxIterations && task.iterations >= task.maxIterations) {
        transition(task, "completed");
        task.stoppedAt = new Date();
        await appendTaskLog(task, `completed iterations=${task.iterations}`);
        await persistTasks([task]);
        return;
      }
      if (Date.now() - (task._lastPersistedAt ?? 0) >= 1000) {
        await appendTaskLog(task, `iteration=${task.iterations}`);
        await persistTasks([task]);
      }
      scheduleNextRun(task, ctx);
    } catch (err) {
      if (task.state !== "working") return;
      const message = err instanceof Error ? err.message : String(err);
      transition(task, "failed", { error: message });
      task.lastError = message;
      task.stoppedAt = new Date();
      // Nothing may escape this timer callback: an unhandled rejection ends the process when no handler is installed.
      try {
        await appendTaskLog(task, `error: ${task.lastError}`);
        await persistTasks([task]);
      } catch (persistError) {
        logger.warn(`Unable to record the failure of background task ${task.name}: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
      }
    }
  }, delay);
}

function stopTask(task: BackgroundTask): void {
  // A task that already finished keeps its state (a completed task stays completed).
  if (transition(task, "cancelled")) task.stoppedAt = new Date();
}

/** Stops every running task of every kind (used at process shutdown) and persists the state. */
export async function stopAllBackgroundTasks(): Promise<void> {
  await stopAllTasks();
}

async function stopAllIntervalTasks(): Promise<void> {
  const stopped: BackgroundTask[] = [];
  for (const task of TASKS.values()) {
    if (task.state === "working" && isOwned(task)) {
      stopTask(task);
      stopped.push(task);
    }
  }
  await persistTasks(stopped);
}

registerTaskSource("interval", {
  countWorking: () => Array.from(TASKS.values()).filter((task) => task.state === "working").length,
  stopAll: stopAllIntervalTasks,
});

function validateTaskOperation(operation: string, args: Record<string, unknown>): void {
  if (!(SUPPORTED_OPERATIONS as readonly string[]).includes(operation)) {
    throw new ToolValidationError(
      `Unsupported background task operation '${operation}'. Allowed operations: ${SUPPORTED_OPERATIONS.join(", ")}.`,
      { path: "$.operation" },
    );
  }
  const normalised = normaliseOperation(operation);
  if (normalised === "write") {
    for (const key of ["address", "bytes"] as const) {
      const value = args[key];
      if (value === undefined || value === null || String(value).trim() === "") {
        throw new ToolValidationError(`Background task operation 'write' requires arguments.${key}.`, { path: `$.arguments.${key}` });
      }
    }
  }
  if (normalised === "read" || normalised === "write") {
    // Checked now, so a bad argument fails the start instead of killing the task after one interval.
    const address = parseTaskAddress(String(args.address ?? "$0400"));
    let length: number;
    if (normalised === "read") {
      const rawLength = String(args.length ?? "16");
      const parsedLength = parseNumericLiteral(rawLength, "$.arguments.length");
      if (parsedLength === undefined || !Number.isInteger(parsedLength) || parsedLength < 1) {
        throw new ToolValidationError(`arguments.length must be a number of bytes of at least 1, got "${rawLength}"`, { path: "$.arguments.length" });
      }
      length = parsedLength;
    } else {
      const hex = stripHexByteSeparators(String(args.bytes ?? "$00"));
      if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new ToolValidationError("arguments.bytes must be whole hex bytes, for example $AA55", { path: "$.arguments.bytes" });
      }
      length = hex.length / 2;
    }
    assertAddressRange(address, length, "$.arguments.address");
  }
}

function parseTaskAddress(raw: string): number {
  const literal = parseNumericLiteral(raw, "$.arguments.address");
  const address = literal ?? resolveAddressSymbol(raw);
  if (address === undefined) {
    assertNotBareHex(raw, "$.arguments.address");
    throw new ToolValidationError(`Invalid address "${raw}"`, { path: "$.arguments.address" });
  }
  return address;
}

const noArgsSchema = objectSchema<Record<string, never>>({ description: "No arguments", properties: {}, additionalProperties: false });

const startBackgroundTaskArgsSchema = objectSchema({
  description: "Start a named background task that invokes a simple operation at fixed intervals.",
  properties: {
    // The name becomes part of the task folder path, so it must be a single safe path segment.
    name: stringSchema({
      description: "Unique task name (letters, digits, spaces, '_', '-', '.'; must not start with '.' or a space).",
      minLength: 1,
      pattern: /^[A-Za-z0-9_][A-Za-z0-9_. -]*$/,
    }),
    operation: stringSchema({ description: "read, write (needs arguments.address and bytes), read_screen, menu_button, or an allowlisted tool.op such as c64_memory.wait_for_text.", minLength: 1 }),
    arguments: optionalSchema(objectSchema({ description: "Operation-specific arguments", properties: {}, additionalProperties: true }), {} as any),
    intervalMs: optionalSchema(numberSchema({ description: `Interval milliseconds (${MIN_INTERVAL_MS} to ${MAX_INTERVAL_MS})`, integer: true, minimum: MIN_INTERVAL_MS, maximum: MAX_INTERVAL_MS, default: 1000 }), 1000),
    maxIterations: optionalSchema(numberSchema({ description: `Maximum number of iterations (1 to ${MAX_ITERATIONS_LIMIT}; omit for indefinite)`, integer: true, minimum: 1, maximum: MAX_ITERATIONS_LIMIT }), undefined),
  },
  required: ["name", "operation"],
  additionalProperties: false,
});

const stopBackgroundTaskArgsSchema = objectSchema({
  description: "Stop a background task by name.",
  properties: { name: stringSchema({ description: "Task name", minLength: 1 }) },
  required: ["name"],
  additionalProperties: false,
});

const listBackgroundTasksArgsSchema = noArgsSchema;
const stopAllBackgroundTasksArgsSchema = noArgsSchema;

function supersededStartResult(task: BackgroundTask) {
  return jsonResult({ started: false, superseded: true, name: task.name }, { success: true });
}

const taskResultArgsSchema = objectSchema({
  description: "Task status and result.",
  properties: {
    name: stringSchema({ description: "Task name", minLength: 1 }),
    waitMs: optionalSchema(numberSchema({ description: "Max wait in ms (0-60000)", integer: true, minimum: 0, maximum: MAX_TASK_RESULT_WAIT_MS, default: 0 }), 0),
  },
  required: ["name"],
  additionalProperties: false,
});

async function startCallTask(
  parsed: { name: string; operation: string; arguments?: unknown },
  rawArgs: Record<string, unknown>,
  ctx: Parameters<ToolDefinition["execute"]>[1],
) {
  const entry = lookupAllowlist(parsed.operation);
  if (!entry) {
    throw new ToolValidationError(
      `Unsupported background task operation '${parsed.operation}'. Operations that can run as detached tasks: ${listAllowlistKeys().join(", ")}; interval operations: ${SUPPORTED_OPERATIONS.join(", ")}.`,
      { path: "$.operation" },
    );
  }
  for (const key of ["intervalMs", "maxIterations"] as const) {
    if (rawArgs[key] !== undefined) {
      throw new ToolValidationError(`${key} applies to interval tasks only; ${parsed.operation} runs once.`, { path: `$.${key}` });
    }
  }
  const callArgs = { ...((parsed.arguments as Record<string, unknown> | undefined) ?? {}) };
  if ("op" in callArgs) {
    if (callArgs.op !== entry.op) throw new ToolValidationError(`arguments.op must be "${entry.op}" or omitted for ${parsed.operation}`, { path: "$.arguments.op" });
    delete callArgs.op;
  }
  // The effect of the allowlisted operation is checked here; the inner invoke checks it again.
  assertAccess("c64_system", "start_task", taskOperationEffect(parsed.operation));
  const existing = TASKS.get(parsed.name);
  if (existing?.state === "working") throw new ToolValidationError("Task with this name is already running", { path: "$.name" });
  const outcome = await runWithInlineWindow(
    { tool: entry.tool, op: entry.op, args: callArgs, ctx, name: parsed.name, requestSignal: ctx.signal },
    { keepCompleted: true },
  );
  if (outcome.kind === "result") return outcome.result;
  const task = outcome.task;
  if (existing) await removeIntervalTask(existing);
  return jsonResult({
    started: true,
    task: { id: task.id, name: task.name, operation: allowlistKey(task.tool, task.op), backendId: task.backendId, kind: "call" },
  }, { success: true });
}

async function removeIntervalTask(task: BackgroundTask): Promise<void> {
  if (!(isOwned(task) || !ownerIsLive(task.ownerPid, task.ownerSession))) return;
  deletedTaskIds.add(task.id);
  TASKS.delete(task.name);
  await persistTasks();
  await fs.rm(getBackgroundTaskFolderAbsolute(task.id), { recursive: true, force: true });
}

function callTaskListEntry(task: CallTask) {
  return {
    id: task.id,
    name: task.name ?? null,
    type: "call",
    kind: "call",
    operation: allowlistKey(task.tool, task.op),
    backendId: task.backendId,
    status: toLegacyStatus(task.state),
    statusMessage: task.statusMessage ?? null,
    startedAt: formatTimestampSpec(task.createdAt),
    updatedAt: formatTimestampSpec(task.updatedAt),
    stoppedAt: task.finishedAt ? formatTimestampSpec(task.finishedAt) : null,
    lastError: task.error ?? null,
  };
}

function waitForIntervalTask(task: BackgroundTask, waitMs: number, signal?: AbortSignal): Promise<void> {
  if (task.state !== "working" || waitMs <= 0 || signal?.aborted) return Promise.resolve();
  const deadline = engineNow() + waitMs;
  return new Promise((resolve) => {
    const poll = (): void => {
      if (task.state !== "working" || signal?.aborted || engineNow() >= deadline) { resolve(); return; }
      startEngineTimer(poll, Math.min(50, Math.max(1, deadline - engineNow())));
    };
    poll();
  });
}

export const tools: ToolDefinition[] = [
  {
    name: "start_background_task",
    description: "Start a background task that runs an operation at a fixed interval for N iterations or indefinitely.",
    summary: "Schedules a recurring operation and tracks its status.",
    inputSchema: startBackgroundTaskArgsSchema.jsonSchema,
    tags: ["background", "scheduler"],
    async execute(args, ctx) {
      try {
        await ensureTasksLoaded();
        await loadTasks();
        const parsed = startBackgroundTaskArgsSchema.parse(args ?? {});
        if (looksLikeAllowlistKey(parsed.operation)) return await startCallTask(parsed, (args ?? {}) as Record<string, unknown>, ctx);
        validateTaskOperation(parsed.operation, (parsed.arguments as Record<string, unknown> | undefined) ?? {});
        // The effect of the task operation is checked once, at start; a running task is not re-checked.
        assertAccess("c64_system", "start_task", taskOperationEffect(parsed.operation));
        const now = new Date();
        const existing = TASKS.get(parsed.name);
        if (existing) getBackgroundTaskFolderAbsolute(existing.id);
        if (existing && existing.state === "working") {
          throw new ToolValidationError("Task with this name is already running", { path: "$.name" });
        }
        const sameNameCall = findCallTask(parsed.name);
        if (sameNameCall?.state === "working") {
          throw new ToolValidationError("Task with this name is already running", { path: "$.name" });
        }
        if (sameNameCall) deleteCallTask(sameNameCall.id);
        if (countWorkingTasks() >= MAX_RUNNING_TASKS) {
          throw new ToolValidationError(`Too many running background tasks (limit ${MAX_RUNNING_TASKS}); stop one first.`, { path: "$.name" });
        }

        const newId = `${SESSION_ID}_${++nextTaskId}_${parsed.name}`;

        const task = newIntervalTask({
          id: newId,
          ownerPid: process.pid, ownerSession: SESSION_ID,
          name: parsed.name,
          type: "background",
          operation: parsed.operation,
          args: (parsed.arguments as Record<string, unknown>) ?? {},
          intervalMs: parsed.intervalMs ?? (existing?.intervalMs ?? 1000),
          maxIterations: parsed.maxIterations,
          iterations: 0,
          state: "working",
          startedAt: now,
          updatedAt: now,
          stoppedAt: null,
          lastError: null,
          nextRunAt: null,
          folder: getBackgroundTaskFolderRelative(newId),
          backendId: null,
          _timer: null,
          _facade: undefined,
        });

        // Reserve the name and id before the first await below. Everything above is synchronous,
        // so a concurrent start sees this task as running and cannot reuse its name or id.
        TASKS.set(task.name, task);
        // While this start awaits, the task may be stopped and its name reused by another start.
        // Only the task that is still the running registry entry may write its files or start its timer.
        const superseded = (): boolean => TASKS.get(task.name) !== task || task.state !== "working";
        try {
          await persistTasks([task], true);
          if (superseded()) return supersededStartResult(task);
          // Pin the facade now: a later c64_select_backend must not retarget a running task.
          const pinnedFacade = ctx.client.pinFacade ? await ctx.client.pinFacade() : undefined;
          if (superseded()) return supersededStartResult(task);
          task._facade = pinnedFacade;
          task.backendId = pinnedFacade?.type ?? (ctx.client.getActiveBackendType ? await ctx.client.getActiveBackendType() : null);
          if (superseded()) return supersededStartResult(task);
          // Ensure per-task structure and seed files
          await fs.mkdir(getBackgroundTaskFolderAbsolute(task.id), { recursive: true });
          if (superseded()) return supersededStartResult(task);
          await writeTaskJson(task);
          if (superseded()) return supersededStartResult(task);
          await ensureResultAndLog(task);
          if (superseded()) return supersededStartResult(task);
          await appendTaskLog(task, "started");
          if (superseded()) return supersededStartResult(task);
          scheduleNextRun(task, ctx);
        } catch (startError) {
          // Undo the reservation so the failed start neither blocks its name nor holds a running slot.
          if (task._timer) clearEngineTimer(task._timer);
          task._timer = null;
          if (TASKS.get(task.name) === task) {
            if (existing) TASKS.set(existing.name, existing);
            else TASKS.delete(task.name);
          }
          await persistTasks();
          throw startError;
        }
        await persistTasks([task]);
        if (existing && existing.id !== task.id && (isOwned(existing) || !ownerIsLive(existing.ownerPid, existing.ownerSession))) {
          await fs.rm(getBackgroundTaskFolderAbsolute(existing.id), { recursive: true, force: true });
        }
        return jsonResult({ started: true, task: { id: task.id, name: task.name, operation: task.operation, backendId: task.backendId ?? null, intervalMs: task.intervalMs, maxIterations: task.maxIterations ?? null, folder: task.folder } }, { success: true });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
  {
    name: "stop_background_task",
    description: "Stop a named background task.",
    summary: "Stops a running task and marks it as stopped.",
    inputSchema: stopBackgroundTaskArgsSchema.jsonSchema,
    tags: ["background", "scheduler"],
    async execute(args) {
      try {
        await ensureTasksLoaded();
        await loadTasks();
        const parsed = stopBackgroundTaskArgsSchema.parse(args ?? {});
        const task = TASKS.get(parsed.name);
        if (!task) {
          const call = findCallTask(parsed.name);
          if (call) {
            cancelCallTask(call.id);
            return jsonResult({ stopped: true, name: parsed.name, status: toLegacyStatus(call.state) }, { success: true });
          }
          // Idempotent stop: report success even if task does not exist anymore
          return jsonResult({ stopped: false, name: parsed.name, notFound: true }, { success: true });
        }
        requireOwnership(task);
        stopTask(task);
        await appendTaskLog(task, "stopped");
        await persistTasks([task]);
        return jsonResult({ stopped: true, name: task.name, status: toLegacyStatus(task.state) }, { success: true });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
  {
    name: "delete_background_task",
    description: "Delete a finished background task and its artifacts; running tasks must be stopped first.",
    summary: "Removes a finished task from the registry.",
    inputSchema: stopBackgroundTaskArgsSchema.jsonSchema,
    tags: ["background", "scheduler"],
    async execute(args) {
      try {
        await ensureTasksLoaded();
        await loadTasks();
        const parsed = stopBackgroundTaskArgsSchema.parse(args ?? {});
        const task = TASKS.get(parsed.name);
        const call = task ? undefined : findCallTask(parsed.name);
        if (call) {
          if (call.state === "working") throw new ToolValidationError("Stop the running task before deleting it", { path: "$.name" });
          deleteCallTask(call.id);
          return jsonResult({ deleted: true, name: parsed.name }, { success: true });
        }
        if (task?.state === "working") throw new ToolValidationError("Stop the running task before deleting it", { path: "$.name" });
        if (task) {
          requireOwnership(task);
          deletedTaskIds.add(task.id);
          TASKS.delete(task.name);
          await persistTasks();
          await fs.rm(getBackgroundTaskFolderAbsolute(task.id), { recursive: true, force: true });
        }
        return jsonResult({ deleted: Boolean(task), name: parsed.name }, { success: true });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
  {
    name: "list_background_tasks",
    description: "List known background tasks and their status.",
    summary: "Returns current registry entries.",
    inputSchema: listBackgroundTasksArgsSchema.jsonSchema,
    tags: ["background", "scheduler"],
    async execute(args) {
      try {
        await ensureTasksLoaded();
        await loadTasks();
        listBackgroundTasksArgsSchema.parse(args ?? {});
        const tasks = Array.from(TASKS.values()).map((t) => ({
          ownerPid: t.ownerPid, ownerSession: t.ownerSession,
    id: t.id,
          name: t.name,
          type: t.type,
          backendId: t.backendId ?? null,
          kind: "interval",
          status: toLegacyStatus(t.state),
          iterations: t.iterations,
          intervalMs: t.intervalMs,
          maxIterations: t.maxIterations ?? null,
          nextRunAt: t.nextRunAt ? formatTimestampSpec(t.nextRunAt) : null,
          startedAt: formatTimestampSpec(t.startedAt),
          updatedAt: formatTimestampSpec(t.updatedAt),
          stoppedAt: t.stoppedAt ? formatTimestampSpec(t.stoppedAt) : null,
          lastError: t.lastError ?? null,
          lastResult: t.lastResult ?? null,
          folder: t.folder,
        }));
        const all = [...tasks, ...listCallTasks().map(callTaskListEntry)];
        return jsonResult({ tasks: all }, { success: true, count: all.length });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
  {
    name: "get_background_task_result",
    description: "Read the status and result of a named background task, optionally waiting (bounded) for it to finish.",
    summary: "Returns status, done flag and the result or error of a task.",
    inputSchema: taskResultArgsSchema.jsonSchema,
    tags: ["background", "scheduler"],
    async execute(args, ctx) {
      try {
        await ensureTasksLoaded();
        await loadTasks();
        const parsed = taskResultArgsSchema.parse(args ?? {});
        const waitMs = parsed.waitMs ?? 0;
        const interval = TASKS.get(parsed.name);
        if (interval) {
          await waitForIntervalTask(interval, waitMs, ctx.signal);
          return jsonResult({
            name: interval.name, id: interval.id, kind: "interval", status: toLegacyStatus(interval.state),
            statusMessage: null, done: interval.state !== "working",
            ...(interval.lastResult !== undefined && interval.lastResult !== null ? { result: interval.lastResult } : {}),
            ...(interval.lastError ? { error: interval.lastError } : {}),
          }, { success: true });
        }
        const found = findCallTask(parsed.name);
        if (!found) throw new ToolValidationError(`No task named "${parsed.name}"`, { path: "$.name" });
        const call = (await waitForTask(found.id, waitMs, ctx.signal)) ?? found;
        const done = call.state !== "working";
        return jsonResult({
          name: call.name ?? parsed.name, id: call.id, kind: "call", status: toLegacyStatus(call.state),
          statusMessage: call.statusMessage ?? null, done,
          ...(done && call.result ? { result: call.result } : {}),
          ...(done && call.error ? { error: call.error } : {}),
        }, { success: true });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
  {
    name: "stop_all_background_tasks",
    description: "Stop all active background tasks.",
    summary: "Stops every running task and clears timers.",
    inputSchema: stopAllBackgroundTasksArgsSchema.jsonSchema,
    tags: ["background", "scheduler"],
    async execute(args) {
      try {
        await ensureTasksLoaded();
        await loadTasks();
        stopAllBackgroundTasksArgsSchema.parse(args ?? {});
        const stoppedTasks: BackgroundTask[] = [];
        for (const task of TASKS.values()) {
          // Tasks that already finished or were stopped are left as they are.
          if (task.state !== "working" || !isOwned(task)) continue;
          stopTask(task);
          stoppedTasks.push(task);
          await appendTaskLog(task, "stopped");
        }
        await persistTasks(stoppedTasks);
        let stoppedCalls = 0;
        for (const call of listCallTasks()) {
          if (call.state !== "working") continue;
          cancelCallTask(call.id);
          stoppedCalls += 1;
        }
        return jsonResult({ stoppedAll: true, count: stoppedTasks.length + stoppedCalls, totalTasks: TASKS.size + listCallTasks().length }, { success: true });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
];

export { getTasksHomeDir };
