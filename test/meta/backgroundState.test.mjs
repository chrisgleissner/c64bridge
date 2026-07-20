import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tmpPath } from "./helpers.mjs";

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

async function loadBackgroundTools(tag) {
  return import(`../../src/tools/meta/background.ts?case=${tag}`);
}

function toolByName(tools, name) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Missing background tool ${name}`);
  }
  return tool;
}

describe("meta/background state loading", () => {
  let previousHome;

  beforeEach(() => {
    delete process.env.C64_TASK_STATE_FILE;
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });

  test("list_background_tasks loads persisted tasks from disk", async () => {
    const { file, dir } = tmpPath("background-state", "tasks.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      tasks: [
        {
          id: "0007_saved",
          name: "saved",
          type: "background",
          operation: "read",
          args: { address: "$0400", length: 2 },
          intervalMs: 25,
          maxIterations: 3,
          iterations: 2,
          status: "stopped",
          startedAt: "2025-03-08T10:00:00.000Z",
          updatedAt: "2025-03-08T10:00:10.000Z",
          stoppedAt: "2025-03-08T10:00:11.000Z",
          lastError: "offline",
          nextRunAt: "2025-03-08T10:00:20.000Z",
          folder: "tasks/background/0007_saved",
        },
      ],
    }, null, 2));

    process.env.C64_TASK_STATE_FILE = file;
    const { tools } = await loadBackgroundTools("persisted");
    const listTool = toolByName(tools, "list_background_tasks");

    const result = await listTool.execute({}, { client: {}, logger: createLogger() });

    expect(result.metadata?.success).toBe(true);
    expect(result.metadata?.count).toBe(1);
    expect(result.structuredContent?.data?.tasks?.[0]).toMatchObject({
      id: "0007_saved",
      name: "saved",
      status: "stopped",
      iterations: 2,
      folder: "tasks/background/0007_saved",
      lastError: "offline",
    });
  });

  test("ensureTasksLoaded creates an empty registry file when state is missing", async () => {
    const { file, dir } = tmpPath("background-missing", "tasks.json");
    await fs.mkdir(dir, { recursive: true });
    process.env.C64_TASK_STATE_FILE = file;

    const { tools } = await loadBackgroundTools("missing");
    const listTool = toolByName(tools, "list_background_tasks");

    const result = await listTool.execute({}, { client: {}, logger: createLogger() });

    expect(result.metadata?.success).toBe(true);
    expect(result.metadata?.count).toBe(0);
    const stored = JSON.parse(await fs.readFile(file, "utf8"));
    expect(stored).toEqual({ tasks: [] });
  });

  test("HARD01-022 a task persisted as 'running' is downgraded to 'stopped' on reload, not left as a zombie", async () => {
    const { file, dir } = tmpPath("background-duplicate", "tasks.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      tasks: [
        {
          id: "0012_dup",
          name: "dup",
          type: "background",
          operation: "read",
          args: {},
          intervalMs: 20,
          iterations: 1,
          status: "running",
          startedAt: "2025-03-08T10:00:00.000Z",
          updatedAt: "2025-03-08T10:00:05.000Z",
          stoppedAt: null,
          lastError: null,
          nextRunAt: "2025-03-08T10:00:20.000Z",
          folder: path.join("tasks", "background", "0012_dup"),
        },
      ],
    }, null, 2));

    process.env.C64_TASK_STATE_FILE = file;
    const { tools } = await loadBackgroundTools("duplicate");
    const listTool = toolByName(tools, "list_background_tasks");
    const startTool = toolByName(tools, "start_background_task");
    const stopTool = toolByName(tools, "stop_background_task");

    // The persisted "running" status must not survive reload: no timer exists
    // for it, so reporting it as running would be a false health signal.
    const listed = await listTool.execute({}, { client: {}, logger: createLogger() });
    const reloaded = listed.structuredContent?.data?.tasks?.find((t) => t.name === "dup");
    expect(reloaded?.status).toBe("stopped");
    expect(reloaded?.nextRunAt).toBeFalsy();
    expect(String(reloaded?.lastError ?? "")).toContain("restart");

    // Because the reloaded task is honestly "stopped", starting a new task
    // under the same name must now succeed rather than be rejected.
    const result = await startTool.execute(
      { name: "dup", operation: "read", intervalMs: 5, maxIterations: 1 },
      { client: {}, logger: createLogger() },
    );
    expect(result.isError).toBeUndefined();
    expect(result.metadata?.success).toBe(true);

    await stopTool.execute({ name: "dup" }, { client: {}, logger: createLogger() });
  });

  test("start_background_task supports read_memory alias with default arguments", async () => {
    const { file, dir } = tmpPath("background-alias", "tasks.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ tasks: [] }, null, 2));

    const calls = [];
    process.env.C64_TASK_STATE_FILE = file;
    const { tools } = await loadBackgroundTools("alias");
    const startTool = toolByName(tools, "start_background_task");
    const listTool = toolByName(tools, "list_background_tasks");

    const ctx = {
      client: {
        async readMemory(address, length) {
          calls.push({ address, length });
          return { success: true };
        },
      },
      logger: createLogger(),
    };

    const result = await startTool.execute(
      { name: "alias", operation: "read_memory", intervalMs: 5, maxIterations: 1 },
      ctx,
    );

    expect(result.metadata?.success).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const listed = await listTool.execute({}, ctx);
    expect(listed.structuredContent?.data?.tasks?.[0]?.status).toBe("completed");
    expect(calls).toEqual([{ address: "$0400", length: "16" }]);
  });

  test("list_background_tasks tolerates malformed persisted state files", async () => {
    const { file, dir } = tmpPath("background-bad-json", "tasks.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, "{not-json", "utf8");

    process.env.C64_TASK_STATE_FILE = file;
    const { tools } = await loadBackgroundTools("badjson");
    const listTool = toolByName(tools, "list_background_tasks");

    const result = await listTool.execute({}, { client: {}, logger: createLogger() });

    expect(result.metadata?.success).toBe(true);
    expect(result.metadata?.count).toBe(0);
  });

  test("list_background_tasks falls back when persisted timestamps are malformed", async () => {
    const { file, dir } = tmpPath("background-bad-dates", "tasks.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      tasks: [
        {
          id: "0015_weird",
          name: "weird",
          type: "background",
          operation: "read_screen",
          args: null,
          intervalMs: 50,
          iterations: 4,
          status: "error",
          startedAt: "not-a-date",
          updatedAt: "still-not-a-date",
          stoppedAt: "bad-stop",
          lastError: "boom",
          nextRunAt: "bad-next-run",
          folder: "tasks/background/0015_weird",
        },
      ],
    }, null, 2));

    process.env.C64_TASK_STATE_FILE = file;
    const { tools } = await loadBackgroundTools("baddates");
    const listTool = toolByName(tools, "list_background_tasks");

    const result = await listTool.execute({}, { client: {}, logger: createLogger() });

    expect(result.metadata?.success).toBe(true);
    const task = result.structuredContent?.data?.tasks?.[0];
    expect(task?.name).toBe("weird");
    expect(task?.startedAt).toMatch(/T/);
    expect(task?.updatedAt).toMatch(/T/);
    expect(task?.stoppedAt).toBeNull();
    expect(task?.nextRunAt).toBeNull();
  });

  test("getTasksHomeDir falls back to the standard .c64bridge directory", async () => {
    const { getTasksHomeDir } = await loadBackgroundTools("default-home");

    expect(getTasksHomeDir()).toBe(path.resolve(path.join(os.homedir(), ".c64bridge")));
  });

  test("start_background_task writes per-task state files alongside the registry file", async () => {
    const { file, dir } = tmpPath("background-task-files", "tasks.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ tasks: [] }, null, 2));
    process.env.C64_TASK_STATE_FILE = file;

    const { tools } = await loadBackgroundTools("task-files");
    const startTool = toolByName(tools, "start_background_task");
    const listTool = toolByName(tools, "list_background_tasks");
    const ctx = {
      client: {
        async readScreen() { return "READY."; },
      },
      logger: createLogger(),
    };

    const started = await startTool.execute(
      { name: "task-files", operation: "read_screen", intervalMs: 5, maxIterations: 1 },
      ctx,
    );

    expect(started.metadata?.success).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const listed = await listTool.execute({}, ctx);
    const task = listed.structuredContent?.data?.tasks?.find((entry) => entry.name === "task-files");
    const taskDir = path.join(dir, "tasks", "background", task.id);

    expect(task?.status).toBe("completed");
    expect(JSON.parse(await fs.readFile(file, "utf8")).tasks).toHaveLength(1);
    expect(await fs.readFile(path.join(taskDir, "task.json"), "utf8")).toContain("\"resultPath\"");
    expect(await fs.readFile(path.join(taskDir, "result.json"), "utf8")).toContain("\"status\"");
    expect(await fs.readFile(path.join(taskDir, "log.txt"), "utf8")).toContain("started");
  });

  test("stop_all_background_tasks preserves completed task status", async () => {
    const { file, dir } = tmpPath("background-completed", "tasks.json");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      tasks: [
        {
          id: "0042_done",
          name: "done",
          type: "background",
          operation: "read",
          args: {},
          intervalMs: 20,
          iterations: 3,
          status: "completed",
          startedAt: "2025-03-08T10:00:00.000Z",
          updatedAt: "2025-03-08T10:00:05.000Z",
          stoppedAt: "2025-03-08T10:00:05.500Z",
          lastError: null,
          nextRunAt: null,
          folder: path.join("tasks", "background", "0042_done"),
        },
      ],
    }, null, 2));
    const taskDir = path.join(dir, "tasks", "background", "0042_done");
    await fs.mkdir(taskDir, { recursive: true });
    await fs.writeFile(path.join(taskDir, "log.txt"), "", "utf8");

    process.env.C64_TASK_STATE_FILE = file;
    const { tools } = await loadBackgroundTools("completed");
    const stopAllTool = toolByName(tools, "stop_all_background_tasks");
    const listTool = toolByName(tools, "list_background_tasks");

    const stopResult = await stopAllTool.execute({}, { client: {}, logger: createLogger() });
    const listResult = await listTool.execute({}, { client: {}, logger: createLogger() });

    expect(stopResult.metadata?.success).toBe(true);
    expect(listResult.structuredContent?.data?.tasks?.[0]?.status).toBe("completed");
  });
});
