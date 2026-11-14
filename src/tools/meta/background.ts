// Background task management meta tools
import { assertAccess, taskOperationEffect } from "../access.js";
import type { ToolDefinition } from "../types.js";
import { objectSchema, stringSchema, numberSchema, optionalSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolValidationError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { promises as fs } from "node:fs";
import { dirname, resolve as resolvePath, join as joinPath, sep } from "node:path";
import os from "node:os";
import type { C64Facade } from "../../device.js";
import { screenCodesToAscii } from "../../petscii.js";
import { loggerFor } from "../../logger.js";
import { formatTimestampSpec, parseTimestampSpec } from "./util.js";

type TaskStatus = "running" | "completed" | "stopped" | "error";
interface BackgroundTask {
  id: string; // e.g. 0001_read
  name: string;
  type: "background";
  operation: string;
  args: Record<string, unknown>;
  intervalMs: number;
  maxIterations?: number;
  iterations: number;
  status: TaskStatus;
  startedAt: Date;
  updatedAt: Date;
  stoppedAt?: Date | null;
  lastError?: string | null;
  lastResult?: unknown;
  nextRunAt?: Date | null;
  folder: string; // e.g. tasks/background/0001_read
  backendId?: string | null; // backend the task was pinned to at start
  _timer?: NodeJS.Timeout | null; // transient, not persisted
  _facade?: C64Facade; // transient: facade pinned at start, so a later backend switch cannot retarget the task
}

const TASKS: Map<string, BackgroundTask> = new Map();
const logger = loggerFor("background");

export const MIN_INTERVAL_MS = 100;
export const MAX_RUNNING_TASKS = 16;
export const MAX_ITERATIONS_LIMIT = 100_000;
const MAX_LOG_BYTES = 256 * 1024;

// Operations runOperation implements, including the *_memory aliases.
const SUPPORTED_OPERATIONS = ["read", "write", "read_screen", "menu_button", "read_memory", "write_memory"] as const;
const MAX_STORED_RESULT_CHARS = 4096;

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
    id: t.id,
    name: t.name,
    type: t.type,
    operation: t.operation,
    args: t.args,
    intervalMs: t.intervalMs,
    maxIterations: t.maxIterations,
    iterations: t.iterations,
    status: t.status,
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

function fromPersistedTask(p: PersistedTask): BackgroundTask {
  return {
    id: p.id,
    name: p.name,
    type: "background",
    operation: p.operation,
    args: p.args ?? {},
    intervalMs: p.intervalMs,
    maxIterations: p.maxIterations,
    iterations: p.iterations,
    status: p.status,
    startedAt: parseTimestampSpec(p.startedAt) ?? new Date(),
    updatedAt: parseTimestampSpec(p.updatedAt) ?? new Date(),
    stoppedAt: parseTimestampSpec(p.stoppedAt ?? null),
    lastError: p.lastError ?? null,
    lastResult: p.lastResult ?? null,
    nextRunAt: parseTimestampSpec(p.nextRunAt ?? null),
    folder: p.folder,
    backendId: p.backendId ?? null,
    _timer: null,
  };
}

function getTasksHomeDir(): string {
  const overrideFile = process.env.C64_TASK_STATE_FILE ? resolvePath(String(process.env.C64_TASK_STATE_FILE)) : null;
  if (overrideFile) {
    return dirname(overrideFile);
  }
  return resolvePath(joinPath(os.homedir(), ".c64bridge"));
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

async function loadTasks(): Promise<void> {
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
  for (const pt of parsed.tasks as PersistedTask[]) {
    const t = fromPersistedTask(pt);
    if (t.status === "running") {
      t.status = "stopped";
      t.stoppedAt = new Date();
      t.updatedAt = new Date();
      t.lastError = "Interrupted by MCP server restart; start the task again to resume monitoring.";
      t.nextRunAt = null;
    }
    TASKS.set(t.name, t);
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
  try {
    await fs.access(resultPath);
  } catch {
    const initial = {
      id: task.id,
      type: "task",
      name: task.operation,
      created: formatTimestampSpec(task.startedAt),
      status: task.status,
      iterations: task.iterations,
    } as Record<string, unknown>;
    await writeFileAtomic(resultPath, JSON.stringify(initial, null, 2));
  }
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

// Persistence is serialised so two writers never rename over each other.
let persistChain: Promise<void> = Promise.resolve();

function persistTasks(changedTasks: readonly BackgroundTask[] = []): Promise<void> {
  const run = persistChain.then(async () => {
    try {
      const path = getTaskStateFilePath();
      await fs.mkdir(dirname(path), { recursive: true });
      const data = Array.from(TASKS.values()).map((t) => toPersistedTask(t));
      await writeFileAtomic(path, JSON.stringify({ tasks: data }, null, 2));
      // Only the changed tasks get their per-task files rewritten.
      for (const t of changedTasks) {
        // A stopped task that was restarted under its name shares the folder with its successor; its stale object must not overwrite the successor's task.json.
        if (TASKS.get(t.name) !== t) continue;
        await writeTaskJson(t);
        await ensureResultAndLog(t);
      }
    } catch (error) {
      logger.warn(`Unable to persist background task state: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  persistChain = run;
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
      if (facade) {
        return ctx.client
          .readMemoryRaw(0x0400, 0x03e8, facade)
          .then((bytes) => screenCodesToAscii(bytes, { columns: 40, rows: 25 }));
      }
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
  if (task.status !== "running") return;
  const delay = Math.max(0, task.intervalMs);
  task.nextRunAt = new Date(Date.now() + delay);
  task._timer = setTimeout(async () => {
    if (task.status !== "running") return;
    try {
      const result = await runOperation(task, ctx);
      // A stop that arrived while the operation was in flight wins: never turn it into completed/error.
      if (task.status !== "running") return;
      if (result && typeof result === "object" && "success" in result && (result as { success?: unknown }).success === false) {
        throw new Error(`Operation returned failure: ${JSON.stringify((result as { details?: unknown }).details ?? result)}`);
      }
      task.iterations += 1;
      task.lastResult = summariseResult(result);
      task.updatedAt = new Date();
      if (task.maxIterations && task.iterations >= task.maxIterations) {
        task.status = "completed";
        task.stoppedAt = new Date();
        task._timer = null;
        await appendTaskLog(task, `completed iterations=${task.iterations}`);
        await persistTasks([task]);
        return;
      }
      await appendTaskLog(task, `iteration=${task.iterations}`);
      await persistTasks([task]);
      scheduleNextRun(task, ctx);
    } catch (err) {
      if (task.status !== "running") return;
      task.status = "error";
      task.lastError = err instanceof Error ? err.message : String(err);
      task.stoppedAt = new Date();
      task._timer = null;
      await appendTaskLog(task, `error: ${task.lastError}`);
      await persistTasks([task]);
    }
  }, delay);
  // A pending task timer must never keep the process alive on its own.
  task._timer.unref?.();
}

function stopTask(task: BackgroundTask): void {
  if (task._timer) {
    clearTimeout(task._timer);
  }
  task._timer = null;
  task.status = task.status === "completed" ? task.status : "stopped";
  task.stoppedAt = new Date();
}

/** Stops every running task (used at process shutdown) and persists the state. */
export async function stopAllBackgroundTasks(): Promise<void> {
  const stopped: BackgroundTask[] = [];
  for (const task of TASKS.values()) {
    if (task.status === "running") {
      stopTask(task);
      stopped.push(task);
    }
  }
  await persistTasks(stopped);
}

function validateTaskOperation(operation: string, args: Record<string, unknown>): void {
  if (!(SUPPORTED_OPERATIONS as readonly string[]).includes(operation)) {
    throw new ToolValidationError(
      `Unsupported background task operation '${operation}'. Allowed operations: ${SUPPORTED_OPERATIONS.join(", ")}.`,
      { path: "$.operation" },
    );
  }
  if (normaliseOperation(operation) === "write") {
    for (const key of ["address", "bytes"] as const) {
      const value = args[key];
      if (value === undefined || value === null || String(value).trim() === "") {
        throw new ToolValidationError(`Background task operation 'write' requires arguments.${key}.`, { path: `$.arguments.${key}` });
      }
    }
  }
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
    operation: stringSchema({ description: "Operation name: read, write, read_screen or menu_button (read_memory and write_memory are aliases). write requires arguments.address and arguments.bytes.", minLength: 1 }),
    arguments: optionalSchema(objectSchema({ description: "Operation-specific arguments", properties: {}, additionalProperties: true }), {} as any),
    intervalMs: optionalSchema(numberSchema({ description: `Interval milliseconds (minimum ${MIN_INTERVAL_MS})`, integer: true, minimum: MIN_INTERVAL_MS, default: 1000 }), 1000),
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
        const parsed = startBackgroundTaskArgsSchema.parse(args ?? {});
        validateTaskOperation(parsed.operation, (parsed.arguments as Record<string, unknown> | undefined) ?? {});
        // The effect of the task operation is checked once, at start; a running task is not re-checked.
        assertAccess("c64_system", "start_task", taskOperationEffect(parsed.operation));
        const now = new Date();
        const existing = TASKS.get(parsed.name);
        if (existing && existing.status === "running") {
          throw new ToolValidationError("Task with this name is already running", { path: "$.name" });
        }
        const runningCount = Array.from(TASKS.values()).filter((t) => t.status === "running").length;
        if (runningCount >= MAX_RUNNING_TASKS) {
          throw new ToolValidationError(`Too many running background tasks (limit ${MAX_RUNNING_TASKS}); stop one first.`, { path: "$.name" });
        }

        // Determine next global counter by scanning existing registry entries
        const allTasks = Array.from(TASKS.values());
        const currentMax = allTasks.reduce((max, t) => {
          const match = /^([0-9]{4})_/.exec(t.id);
          const n = match ? Number(match[1]) : 0;
          return Number.isFinite(n) && n > max ? n : max;
        }, 0);

        const newCounter = String(currentMax + 1).padStart(4, "0");
        const newId = `${newCounter}_${parsed.name}`;

        const task: BackgroundTask = {
          id: existing && existing.status !== "running" ? existing.id : newId,
          name: parsed.name,
          type: "background",
          operation: parsed.operation,
          args: (parsed.arguments as Record<string, unknown>) ?? {},
          intervalMs: parsed.intervalMs ?? (existing?.intervalMs ?? 1000),
          maxIterations: parsed.maxIterations,
          iterations: 0,
          status: "running",
          startedAt: now,
          updatedAt: now,
          stoppedAt: null,
          lastError: null,
          nextRunAt: null,
          folder: getBackgroundTaskFolderRelative(existing && existing.status !== "running" ? existing.id : newId),
          backendId: null,
          _timer: null,
          _facade: undefined,
        };

        // Reserve the name and id before the first await below. Everything above is synchronous,
        // so a concurrent start sees this task as running and cannot reuse its name or id.
        TASKS.set(task.name, task);
        // While this start awaits, the task may be stopped and its name reused by another start.
        // Only the task that is still the running registry entry may write its files or start its timer.
        const superseded = (): boolean => TASKS.get(task.name) !== task || task.status !== "running";
        try {
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
          if (task._timer) clearTimeout(task._timer);
          task._timer = null;
          if (TASKS.get(task.name) === task) {
            if (existing) TASKS.set(existing.name, existing);
            else TASKS.delete(task.name);
          }
          throw startError;
        }
        await persistTasks([task]);
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
        const parsed = stopBackgroundTaskArgsSchema.parse(args ?? {});
        const task = TASKS.get(parsed.name);
        if (!task) {
          // Idempotent stop: report success even if task does not exist anymore
          return jsonResult({ stopped: false, name: parsed.name, notFound: true }, { success: true });
        }
        stopTask(task);
        await appendTaskLog(task, "stopped");
        await persistTasks([task]);
        return jsonResult({ stopped: true, name: task.name, status: task.status }, { success: true });
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
        listBackgroundTasksArgsSchema.parse(args ?? {});
        const tasks = Array.from(TASKS.values()).map((t) => ({
          id: t.id,
          name: t.name,
          type: t.type,
          backendId: t.backendId ?? null,
          status: t.status,
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
        return jsonResult({ tasks }, { success: true, count: tasks.length });
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
        stopAllBackgroundTasksArgsSchema.parse(args ?? {});
        const stoppedTasks: BackgroundTask[] = [];
        for (const task of TASKS.values()) {
          // Tasks that already finished or were stopped are left as they are.
          if (task.status !== "running") continue;
          stopTask(task);
          stoppedTasks.push(task);
          await appendTaskLog(task, "stopped");
        }
        await persistTasks(stoppedTasks);
        return jsonResult({ stoppedAll: true, count: stoppedTasks.length, totalTasks: TASKS.size }, { success: true });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
];

export { getTasksHomeDir };
