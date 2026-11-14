import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import { metaModule } from "../../src/tools/meta/index.js";
import { getTasksHomeDir } from "../../src/tools/meta/background.js";
import { createLogger, tmpPath, waitForTaskCompletion } from "./helpers.mjs";

test("background tasks load persisted task state and expose default home dir", async () => {
  const previous = process.env.C64_TASK_STATE_FILE;
  const previousStateDir = process.env.C64BRIDGE_STATE_DIR;
  delete process.env.C64_TASK_STATE_FILE;
  delete process.env.C64BRIDGE_STATE_DIR;
  assert.ok(getTasksHomeDir().endsWith(".c64bridge"));
  if (previousStateDir !== undefined) process.env.C64BRIDGE_STATE_DIR = previousStateDir;

  const { file, dir } = tmpPath("background0", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    tasks: [
      {
        id: "0001_preloaded",
        name: "preloaded",
        type: "background",
        operation: "read",
        args: { address: "$0400", length: 1 },
        intervalMs: 50,
        maxIterations: 1,
        iterations: 1,
        status: "completed",
        startedAt: "2026-03-26T09:00:00.000Z",
        updatedAt: "2026-03-26T09:00:01.000Z",
        stoppedAt: "2026-03-26T09:00:01.000Z",
        lastError: null,
        nextRunAt: null,
        folder: "tasks/background/0001_preloaded",
      },
    ],
  }, null, 2));
  process.env.C64_TASK_STATE_FILE = file;

  try {
    const list = await metaModule.invoke("list_background_tasks", {}, {
      client: {},
      logger: createLogger(),
    });

    const task = list.structuredContent?.data?.tasks?.find((entry) => entry.name === "preloaded");
    assert.ok(task);
    assert.equal(task.id, "0001_preloaded");
    assert.equal(task.status, "completed");
    assert.equal(task.folder, "tasks/background/0001_preloaded");
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("background tasks persist and complete iterations", async () => {
  const { file, dir } = tmpPath("background", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ tasks: [] }, null, 2));
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    const ctx = {
      client: {
        async readMemory() { return { success: true, data: "$00" }; },
      },
      logger: createLogger(),
    };

  const start = await metaModule.invoke("start_background_task", { name: "t1", operation: "read", arguments: { address: "$0400", length: 1 }, intervalMs: 100, maxIterations: 2 }, ctx);
    assert.equal(start.metadata?.success, true);

    const t1 = await waitForTaskCompletion(metaModule, "t1", ctx);
    assert.ok(t1, "background task t1 should be present after completion window");
    assert.ok(t1.status === "completed" || t1.status === "stopped", `unexpected status ${String(t1.status)}`);

    const stopped = await metaModule.invoke("stop_background_task", { name: "t1" }, ctx);
    assert.equal(stopped.metadata?.success, true);

    const data = JSON.parse(await fs.readFile(file, "utf8"));
    assert.ok(Array.isArray(data.tasks));
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("background tasks reject names that would escape the task folder", async () => {
  const { file, dir } = tmpPath("background-traversal", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    const ctx = { client: {}, logger: createLogger() };
    for (const name of ["x/../../../../escaped", "..", "../escaped", "a\\b", ".hidden", " leading-space"]) {
      const res = await metaModule.invoke("start_background_task", { name, operation: "unknown_op", intervalMs: 100, maxIterations: 1 }, ctx);
      assert.equal(res.isError, true, `name ${JSON.stringify(name)} was accepted`);
      assert.equal(res.metadata?.error?.path, "$.name");
    }
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("background task names may contain spaces", async () => {
  const { file, dir } = tmpPath("background-spaces", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    const ctx = { client: { async readScreen() { return "READY."; } }, logger: createLogger() };
    const res = await metaModule.invoke("start_background_task", { name: "screen poll", operation: "read_screen", intervalMs: 100, maxIterations: 1 }, ctx);
    assert.equal(res.metadata?.success, true, JSON.stringify(res.content));
    await waitForTaskCompletion(metaModule, "screen poll", ctx);
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("background tasks stop all", async () => {
  const { file, dir } = tmpPath("background2", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    const ctx = { client: { async readScreen() { return "READY."; } }, logger: createLogger() };

    let res = await metaModule.invoke("start_background_task", { name: "noop", operation: "read_screen", intervalMs: 100, maxIterations: 1 }, ctx);
    assert.equal(res.metadata?.success, true);
    await waitForTaskCompletion(metaModule, "noop", ctx);
    res = await metaModule.invoke("stop_all_background_tasks", {}, ctx);
    assert.equal(res.metadata?.success, true, JSON.stringify(res.content));
    const list = await metaModule.invoke("list_background_tasks", {}, ctx);
    assert.equal(list.metadata?.success, true);
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("background tasks support write/read_screen/menu_button and stop missing task idempotently", async () => {
  const { file, dir } = tmpPath("background3", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    const calls = [];
    const ctx = {
      client: {
        async writeMemory(address, bytes) {
          calls.push(["write", address, bytes]);
          return { success: true };
        },
        async readScreen() {
          calls.push(["screen"]);
          return "READY.";
        },
        async menuButton() {
          calls.push(["menu"]);
          return { success: true };
        },
      },
      logger: createLogger(),
    };

    const writeTask = await metaModule.invoke("start_background_task", {
      name: "writer",
      operation: "write_memory",
      arguments: { address: "$0400", bytes: "$41" },
      intervalMs: 100,
      maxIterations: 1,
    }, ctx);
    const screenTask = await metaModule.invoke("start_background_task", {
      name: "screen",
      operation: "read_screen",
      intervalMs: 100,
      maxIterations: 1,
    }, ctx);
    const menuTask = await metaModule.invoke("start_background_task", {
      name: "menu",
      operation: "menu_button",
      intervalMs: 100,
      maxIterations: 1,
    }, ctx);

    assert.equal(writeTask.metadata?.success, true);
    assert.equal(screenTask.metadata?.success, true);
    assert.equal(menuTask.metadata?.success, true);

    await waitForTaskCompletion(metaModule, "writer", ctx);
    await waitForTaskCompletion(metaModule, "screen", ctx);
    await waitForTaskCompletion(metaModule, "menu", ctx);

    const stopMissing = await metaModule.invoke("stop_background_task", { name: "missing" }, ctx);
    assert.equal(stopMissing.metadata?.success, true);
    assert.equal(stopMissing.structuredContent?.data?.notFound, true);
    assert.ok(calls.some((entry) => entry[0] === "write"));
    assert.ok(calls.some((entry) => entry[0] === "screen"));
    assert.ok(calls.some((entry) => entry[0] === "menu"));
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("background tasks persist task errors and reuse ids when restarted", async () => {
  const { file, dir } = tmpPath("background4", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    let readCalls = 0;
    const ctx = {
      client: {
        async readMemory() {
          readCalls += 1;
          if (readCalls === 1) {
            throw new Error("simulated read failure");
          }
          return { success: true, data: "$00" };
        },
      },
      logger: createLogger(),
    };

    const first = await metaModule.invoke("start_background_task", {
      name: "flaky",
      operation: "read",
      intervalMs: 100,
      maxIterations: 1,
    }, ctx);
    assert.equal(first.metadata?.success, true);
    const firstTask = await waitForTaskCompletion(metaModule, "flaky", ctx);
    assert.equal(firstTask?.status, "error");
    assert.ok(String(firstTask?.lastError ?? "").includes("simulated read failure"));

    const second = await metaModule.invoke("start_background_task", {
      name: "flaky",
      operation: "read",
      intervalMs: 100,
      maxIterations: 1,
    }, ctx);
    assert.equal(second.metadata?.success, true);
    assert.equal(second.structuredContent?.data?.task?.id, firstTask?.id);
    const secondTask = await waitForTaskCompletion(metaModule, "flaky", ctx);
    assert.ok(secondTask?.status === "completed" || secondTask?.status === "stopped");
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("HARD01-028 a background iteration that resolves {success:false} is recorded as a failure, not counted as healthy", async () => {
  const { file, dir } = tmpPath("background-resolved-failure", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    const ctx = {
      client: {
        async readMemory() {
          // Resolved (not thrown) failure, as C64Client methods normally
          // report device-reported errors.
          return { success: false, details: "device unreachable" };
        },
      },
      logger: createLogger(),
    };

    const started = await metaModule.invoke("start_background_task", {
      name: "resolved-failure",
      operation: "read",
      intervalMs: 100,
      maxIterations: 1,
    }, ctx);
    assert.equal(started.metadata?.success, true);

    const task = await waitForTaskCompletion(metaModule, "resolved-failure", ctx);
    assert.equal(task?.status, "error");
    assert.ok(String(task?.lastError ?? "").includes("device unreachable"));
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("background tasks stop active timers and support write_memory alias defaults", async () => {
  const { file, dir } = tmpPath("background5", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    const calls = [];
    const ctx = {
      client: {
        async writeMemory(address, bytes) {
          calls.push([address, bytes]);
          return { success: true };
        },
      },
      logger: createLogger(),
    };

    const started = await metaModule.invoke("start_background_task", {
      name: "alias-writer",
      operation: "write_memory",
      arguments: { address: "$0400", bytes: "$00" },
      // Long enough that the stop below always lands before the first run, even under load.
      intervalMs: 10_000,
      maxIterations: 5,
    }, ctx);
    assert.equal(started.metadata?.success, true);

    const stopped = await metaModule.invoke("stop_background_task", { name: "alias-writer" }, ctx);
    assert.equal(stopped.metadata?.success, true);
    assert.equal(stopped.structuredContent?.data?.status, "stopped");

    const list = await metaModule.invoke("list_background_tasks", {}, ctx);
    const task = list.structuredContent?.data?.tasks?.find((entry) => entry.name === "alias-writer");
    assert.equal(task?.status, "stopped");

    const logPath = `${dir}/tasks/background/${task.id}/log.txt`;
    const logText = await fs.readFile(logPath, "utf8");
    assert.ok(logText.includes("started"));
    assert.ok(logText.includes("stopped"));
    assert.equal(calls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("T-02 write tasks require address and bytes and the write_memory alias runs with them", async () => {
  const { file, dir } = tmpPath("background6", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    const calls = [];
    const ctx = {
      client: {
        async writeMemory(address, bytes) {
          calls.push([address, bytes]);
          return { success: true };
        },
      },
      logger: createLogger(),
    };

    const noArgs = await metaModule.invoke("start_background_task", { name: "writer-noargs", operation: "write_memory", intervalMs: 100, maxIterations: 1 }, ctx);
    assert.equal(noArgs.isError, true);
    assert.equal(noArgs.metadata?.error?.path, "$.arguments.address");
    const noBytes = await metaModule.invoke("start_background_task", { name: "writer-nobytes", operation: "write", arguments: { address: "$0400" }, intervalMs: 100, maxIterations: 1 }, ctx);
    assert.equal(noBytes.isError, true);
    assert.equal(noBytes.metadata?.error?.path, "$.arguments.bytes");

    const started = await metaModule.invoke("start_background_task", {
      name: "writer-args",
      operation: "write_memory",
      arguments: { address: "$0400", bytes: "$41" },
      intervalMs: 100,
      maxIterations: 1,
    }, ctx);
    assert.equal(started.metadata?.success, true);
    const task = await waitForTaskCompletion(metaModule, "writer-args", ctx);
    assert.equal(task?.status, "completed");
    assert.deepEqual(calls, [["$0400", "$41"]]);
    assert.equal(calls.length, 1);
    // A rejected start must not leave a registry entry behind.
    const list = await metaModule.invoke("list_background_tasks", {}, ctx);
    assert.ok(!list.structuredContent.data.tasks.some((entry) => entry.name === "writer-noargs"));
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("T-02 start_task rejects unknown operations and lists the allowed ones", async () => {
  const { file, dir } = tmpPath("background-unknown-op", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    const ctx = { client: {}, logger: createLogger() };
    const res = await metaModule.invoke("start_background_task", { name: "bogus", operation: "unknown_op", intervalMs: 100, maxIterations: 1 }, ctx);
    assert.equal(res.isError, true);
    assert.equal(res.metadata?.error?.path, "$.operation");
    const text = JSON.stringify(res.content);
    for (const op of ["read", "write", "read_screen", "menu_button"]) {
      assert.ok(text.includes(op), `allowed operation ${op} not listed in: ${text}`);
    }
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("T-02 list_tasks returns the last result and last error of each task", async () => {
  const { file, dir } = tmpPath("background-results", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    let calls = 0;
    const ctx = {
      client: {
        async readMemory() {
          calls += 1;
          if (calls < 3) return { success: true, data: `$0${calls}` };
          throw new Error("third read failed");
        },
      },
      logger: createLogger(),
    };
    const started = await metaModule.invoke("start_background_task", { name: "results", operation: "read", arguments: { address: "$0400", length: 1 }, intervalMs: 100 }, ctx);
    assert.equal(started.metadata?.success, true);
    const task = await waitForTaskCompletion(metaModule, "results", ctx);
    assert.equal(task?.status, "error");
    assert.equal(task?.iterations, 2);
    assert.deepEqual(task?.lastResult, { success: true, data: "$02" });
    assert.ok(String(task?.lastError).includes("third read failed"));
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("background task tools validate input and reject duplicate running names", async () => {
  const { file, dir } = tmpPath("background7", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    const ctx = {
      client: {
        async readMemory() { return { success: true, data: "$00" }; },
      },
      logger: createLogger(),
    };

    const started = await metaModule.invoke("start_background_task", {
      name: "duplicate-check",
      operation: "read",
      // Long enough that the task is still running when the duplicate start arrives.
      intervalMs: 10_000,
      maxIterations: 1,
    }, ctx);
    assert.equal(started.metadata?.success, true);

    const duplicate = await metaModule.invoke("start_background_task", {
      name: "duplicate-check",
      operation: "read",
      intervalMs: 100,
    }, ctx);
    assert.equal(duplicate.isError, true);

    const invalidStart = await metaModule.invoke("start_background_task", {}, ctx);
    assert.equal(invalidStart.isError, true);

    const invalidList = await metaModule.invoke("list_background_tasks", { unexpected: true }, ctx);
    assert.equal(invalidList.isError, true);

    const invalidStopAll = await metaModule.invoke("stop_all_background_tasks", { unexpected: true }, ctx);
    assert.equal(invalidStopAll.isError, true);

    await metaModule.invoke("stop_background_task", { name: "duplicate-check" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("R-04 a background task stays on the backend it was started against after a backend switch", async () => {
  const { file, dir } = tmpPath("background-pinned", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    const facadeA = { type: "c64u", id: "A" };
    const facadeB = { type: "vice", id: "B" };
    let active = facadeA;
    const used = [];
    const ctx = {
      client: {
        async pinFacade() { return active; },
        async getActiveBackendType() { return active.type; },
        async writeMemory(address, bytes, facade) {
          used.push((facade ?? active).id);
          return { success: true };
        },
      },
      logger: createLogger(),
    };

    const started = await metaModule.invoke("start_background_task", {
      name: "pinned-writer",
      operation: "write",
      arguments: { address: "$0400", bytes: "$41" },
      intervalMs: 100,
      maxIterations: 3,
    }, ctx);
    assert.equal(started.metadata?.success, true);
    assert.equal(started.structuredContent?.data?.task?.backendId, "c64u");
    active = facadeB; // c64_select_backend after the task was started

    const task = await waitForTaskCompletion(metaModule, "pinned-writer", ctx);
    assert.equal(task?.status, "completed");
    assert.equal(task?.backendId, "c64u");
    assert.deepEqual(used, ["A", "A", "A"]);
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

// R-05: each test loads its own copy of the module so the registry and load state start empty.
async function freshBackground(tag, subdir) {
  const { file, dir } = tmpPath(subdir, "tasks.json");
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  const mod = await import(`../../src/tools/meta/background.ts?r05=${tag}`);
  const tool = (name) => mod.tools.find((entry) => entry.name === name);
  const restore = () => {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  };
  return { mod, tool, file, dir, restore };
}

const persistedTask = (id, name, extra = {}) => ({
  id,
  name,
  type: "background",
  operation: "read",
  args: {},
  intervalMs: 100,
  iterations: 1,
  status: "completed",
  startedAt: "2026-03-26T09:00:00.000Z",
  updatedAt: "2026-03-26T09:00:01.000Z",
  stoppedAt: "2026-03-26T09:00:01.000Z",
  lastError: null,
  nextRunAt: null,
  folder: `tasks/background/${id}`,
  ...extra,
});

test("R-05 interval, iteration and running task count are bounded", async () => {
  const { tool, restore } = await freshBackground("limits", "background-limits");
  try {
    const ctx = { client: { async readScreen() { return "READY."; } }, logger: createLogger() };
    const start = (args) => tool("start_background_task").execute(args, ctx);

    const fast = await start({ name: "fast", operation: "read_screen", intervalMs: 99 });
    assert.equal(fast.isError, true);
    const many = await start({ name: "many", operation: "read_screen", intervalMs: 100, maxIterations: 100_001 });
    assert.equal(many.isError, true);
    const edge = await start({ name: "edge", operation: "read_screen", intervalMs: 100, maxIterations: 100_000 });
    assert.equal(edge.metadata?.success, true);
    await tool("stop_background_task").execute({ name: "edge" }, ctx);

    for (let index = 0; index < 16; index += 1) {
      const res = await start({ name: `limit-${index}`, operation: "read_screen", intervalMs: 60_000 });
      assert.equal(res.metadata?.success, true, `task ${index} should start`);
    }
    const seventeenth = await start({ name: "limit-16", operation: "read_screen", intervalMs: 60_000 });
    assert.equal(seventeenth.isError, true);
    assert.ok(JSON.stringify(seventeenth.content).includes("16"));

    // Stopping one frees a slot.
    await tool("stop_background_task").execute({ name: "limit-0" }, ctx);
    const again = await start({ name: "limit-16", operation: "read_screen", intervalMs: 60_000 });
    assert.equal(again.metadata?.success, true);
    await tool("stop_all_background_tasks").execute({}, ctx);
  } finally {
    restore();
  }
});

test("R-05 concurrent first calls all see the persisted registry", async () => {
  const { tool, file, restore } = await freshBackground("concurrent", "background-concurrent");
  try {
    await fs.writeFile(file, JSON.stringify({ tasks: [persistedTask("0001_saved", "saved")] }));
    const ctx = { client: {}, logger: createLogger() };
    const results = await Promise.all([1, 2, 3].map(() => tool("list_background_tasks").execute({}, ctx)));
    for (const res of results) {
      assert.deepEqual(res.structuredContent.data.tasks.map((entry) => entry.name), ["saved"]);
    }
  } finally {
    restore();
  }
});

test("R-05 a stop that arrives during an iteration is not overwritten by completed", async () => {
  const { tool, restore } = await freshBackground("stoprace", "background-stoprace");
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const inFlight = new Promise((resolve) => { entered = resolve; });
    const ctx = {
      client: { async readMemory() { entered(); await gate; return { success: true, data: "$00" }; } },
      logger: createLogger(),
    };
    const started = await tool("start_background_task").execute({ name: "race", operation: "read", intervalMs: 100, maxIterations: 1 }, ctx);
    assert.equal(started.metadata?.success, true);
    await inFlight;
    const stopped = await tool("stop_background_task").execute({ name: "race" }, ctx);
    assert.equal(stopped.structuredContent.data.status, "stopped");
    release();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const list = await tool("list_background_tasks").execute({}, ctx);
    const task = list.structuredContent.data.tasks.find((entry) => entry.name === "race");
    assert.equal(task.status, "stopped");
    assert.equal(task.iterations, 0);
  } finally {
    restore();
  }
});

test("R-05 an unparseable state file is moved aside and the registry starts empty", async () => {
  const { tool, file, dir, restore } = await freshBackground("corrupt", "background-corrupt");
  try {
    await fs.writeFile(file, "{ not json");
    const ctx = { client: { async readScreen() { return "READY."; } }, logger: createLogger() };
    const list = await tool("list_background_tasks").execute({}, ctx);
    assert.deepEqual(list.structuredContent.data.tasks, []);
    const entries = await fs.readdir(dir);
    const aside = entries.filter((name) => name.startsWith("tasks.json.corrupt-"));
    assert.equal(aside.length, 1);
    assert.equal(await fs.readFile(`${dir}/${aside[0]}`, "utf8"), "{ not json");
    // The next start writes a fresh registry; the moved file stays as evidence.
    const started = await tool("start_background_task").execute({ name: "after-corrupt", operation: "read_screen", intervalMs: 60_000 }, ctx);
    assert.equal(started.metadata?.success, true);
    await tool("stop_all_background_tasks").execute({}, ctx);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).tasks[0].name, "after-corrupt");
  } finally {
    restore();
  }
});

test("R-05 log.txt is capped, only changed tasks are rewritten and no temporary files remain", async () => {
  const { tool, file, dir, restore } = await freshBackground("logcap", "background-logcap");
  try {
    const other = persistedTask("0001_other", "other");
    await fs.writeFile(file, JSON.stringify({ tasks: [other] }));
    await fs.mkdir(`${dir}/tasks/background/0001_other`, { recursive: true });
    await fs.writeFile(`${dir}/tasks/background/0001_other/task.json`, "SENTINEL");
    await fs.mkdir(`${dir}/tasks/background/0002_big`, { recursive: true });
    const line = `[2026-03-26T09:00:00.000Z] ${"x".repeat(100)}\n`;
    await fs.writeFile(`${dir}/tasks/background/0002_big/log.txt`, line.repeat(5000)); // about 520 KB

    const ctx = { client: { async readScreen() { return "READY."; } }, logger: createLogger() };
    const started = await tool("start_background_task").execute({ name: "big", operation: "read_screen", intervalMs: 100, maxIterations: 1 }, ctx);
    assert.equal(started.metadata?.success, true);
    assert.equal(started.structuredContent.data.task.id, "0002_big");
    await waitForTaskCompletion({ invoke: (name, args, c) => tool(name).execute(args, c) }, "big", ctx);
    // The task is marked completed before its final log line and task.json are written.
    // The last file written is task.json (after the log line and tasks.json), so its
    // completed status on disk means every write, including the rename, has finished.
    const tmpFiles = async () => (await fs.readdir(`${dir}/tasks/background/0002_big`)).concat(await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"));
    const taskJsonCompleted = async () => {
      try {
        return JSON.parse(await fs.readFile(`${dir}/tasks/background/0002_big/task.json`, "utf8")).status === "completed";
      } catch {
        return false; // not written yet
      }
    };
    const deadline = Date.now() + 10_000;
    while (!(await taskJsonCompleted())) {
      assert.ok(Date.now() < deadline, "task.json never reached the completed state");
      await new Promise((resolve) => setImmediate(resolve));
    }

    const log = await fs.readFile(`${dir}/tasks/background/0002_big/log.txt`, "utf8");
    assert.ok(log.length <= 256 * 1024, `log.txt is ${log.length} bytes`);
    assert.ok(log.includes("completed iterations=1"));
    assert.ok(log.startsWith("[2026-03-26T09:00:00.000Z] x"), "log must start at a line boundary");

    assert.equal(await fs.readFile(`${dir}/tasks/background/0001_other/task.json`, "utf8"), "SENTINEL");
    assert.deepEqual(await tmpFiles(), []);
  } finally {
    restore();
  }
});

test("R-05 a task folder derived from a persisted id cannot escape the task directory", async () => {
  const { tool, file, restore } = await freshBackground("contain", "background-contain");
  try {
    await fs.writeFile(file, JSON.stringify({ tasks: [persistedTask("0001_../../../../escaped", "evil")] }));
    const ctx = { client: { async readScreen() { return "READY."; } }, logger: createLogger() };
    const res = await tool("start_background_task").execute({ name: "evil", operation: "read_screen", intervalMs: 100, maxIterations: 1 }, ctx);
    assert.equal(res.isError, true);
  } finally {
    restore();
  }
});

test("stop_all_background_tasks counts only the tasks that were running", async () => {
  const { tool, file, restore } = await freshBackground("stopall-count", "background-stopall-count");
  try {
    await fs.writeFile(file, JSON.stringify({ tasks: [persistedTask("0001_done", "done")] }));
    const ctx = { client: { async readScreen() { return "READY."; } }, logger: createLogger() };
    const started = await tool("start_background_task").execute({ name: "live", operation: "read_screen", intervalMs: 60_000 }, ctx);
    assert.equal(started.metadata?.success, true);
    const stopped = await tool("stop_all_background_tasks").execute({}, ctx);
    assert.equal(stopped.structuredContent.data.count, 1);

    assert.equal(stopped.structuredContent.data.totalTasks, 2);
    const again = await tool("stop_all_background_tasks").execute({}, ctx);
    assert.equal(again.structuredContent.data.count, 0);
  } finally {
    restore();
  }
});

test("concurrent starts of the same name create one task, and distinct names get distinct ids", async () => {
  const { tool, restore } = await freshBackground("concurrent-start", "background-concurrent-start");
  try {
    const ctx = {
      client: {
        async pinFacade() { await new Promise((resolve) => setTimeout(resolve, 20)); return undefined; },
        async readScreen() { return "READY."; },
      },
      logger: createLogger(),
    };
    const start = (name) => tool("start_background_task").execute({ name, operation: "read_screen", intervalMs: 60_000 }, ctx);
    const same = await Promise.all([start("dup"), start("dup"), start("dup")]);
    assert.equal(same.filter((res) => res.metadata?.success === true).length, 1);
    assert.equal(same.filter((res) => res.isError === true).length, 2);
    const distinct = await Promise.all([start("a"), start("b"), start("c")]);
    const ids = distinct.map((res) => res.structuredContent.data.task.id);
    assert.equal(new Set(ids).size, 3, ids.join(","));
    const list = await tool("list_background_tasks").execute({}, ctx);
    assert.equal(list.structuredContent.data.tasks.filter((entry) => entry.name === "dup").length, 1);
    await tool("stop_all_background_tasks").execute({}, ctx);
  } finally {
    restore();
  }
});

test("a failed facade pin releases the reserved task name", async () => {
  const { tool, restore } = await freshBackground("pin-fail", "background-pin-fail");
  try {
    let fail = true;
    const ctx = {
      client: {
        async pinFacade() { if (fail) throw new Error("no backend"); return undefined; },
        async readScreen() { return "READY."; },
      },
      logger: createLogger(),
    };
    const first = await tool("start_background_task").execute({ name: "pin", operation: "read_screen", intervalMs: 60_000 }, ctx);
    assert.equal(first.isError, true);
    fail = false;
    const second = await tool("start_background_task").execute({ name: "pin", operation: "read_screen", intervalMs: 60_000 }, ctx);
    assert.equal(second.metadata?.success, true);
    await tool("stop_all_background_tasks").execute({}, ctx);
  } finally {
    restore();
  }
});
