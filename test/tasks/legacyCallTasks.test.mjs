import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toolRegistry } from "../../src/tools/registry/index.js";
import { metaModule } from "../../src/tools/meta/index.js";
import { stopAllBackgroundTasks } from "../../src/tools/meta/background.js";
import { __resetForTests, setEngineClock, submitCall } from "../../src/tasks/engine.js";
import { acquireLease, releaseLease, __resetLeasesForTests } from "../../src/tasks/resources.js";
import { runNativeCall } from "../../src/mcp/tasksAdapter.js";
import { lookupAllowlist } from "../../src/tasks/allowlist.js";
import { taskOperationEffect } from "../../src/tools/access.js";
import { baseCtx, createFakeClock, deferred, settle } from "./helpers.mjs";

function platformCtx(client) {
  return {
    ...baseCtx({ client }),
    rag: {},
    platform: { id: "c64u", features: [], limitedFeatures: [] },
    setPlatform: () => ({ id: "c64u", features: [], limitedFeatures: [] }),
  };
}

const screenClient = (screen) => ({ getActiveBackendType: async () => "c64u", readScreen: async () => screen });

async function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function withState(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "call-tasks-"));
  try {
    return await withEnv({ C64_TASK_STATE_FILE: path.join(dir, "tasks.json") }, async () => {
      __resetForTests();
      __resetLeasesForTests();
      try { return await fn(); } finally {
        await stopAllBackgroundTasks();
        __resetForTests();
        __resetLeasesForTests();
      }
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const system = (args, ctx) => toolRegistry.invoke("c64_system", args, ctx);
const data = (result) => result.structuredContent?.data;

test("start_task runs an allowlisted operation as a call task and task_result returns its result", () => withState(async () => {
  const ctx = platformCtx(screenClient("READY."));
  const started = await withEnv({ C64BRIDGE_TASK_INLINE_MS: "5000" }, () => system({ op: "start_task", name: "w1", operation: "c64_memory.wait_for_text", arguments: { pattern: "READY.", timeoutMs: 1000 } }, ctx));
  assert.equal(started.isError, undefined);
  assert.equal(data(started).started, true);
  assert.equal(data(started).task.kind, "call");
  assert.equal(data(started).task.operation, "c64_memory.wait_for_text");
  const result = await system({ op: "task_result", name: "w1" }, ctx);
  assert.equal(data(result).done, true);
  assert.equal(data(result).status, "completed");
  assert.equal(data(result).kind, "call");
  assert.equal(data(result).result.structuredContent.data.matched, true);
  const list = await system({ op: "list_tasks" }, ctx);
  assert.equal(data(list).tasks.find((task) => task.name === "w1").kind, "call");
  assert.equal((await system({ op: "delete_task", name: "w1" }, ctx)).metadata.success, true);
  assert.equal(data(await system({ op: "list_tasks" }, ctx)).tasks.some((task) => task.name === "w1"), false);
}));

test("a slow call task is handed over, task_result waits only waitMs, and stop_task cancels it", () => withState(async () => {
  const ctx = platformCtx(screenClient("NOTHING"));
  const started = await withEnv({ C64BRIDGE_TASK_INLINE_MS: "0" }, () => system({ op: "start_task", name: "slow", operation: "c64_memory.wait_for_text", arguments: { pattern: "NEVER", timeoutMs: 120000 } }, ctx));
  assert.equal(data(started).started, true);
  const before = performance.now();
  const pending = await system({ op: "task_result", name: "slow", waitMs: 60 }, ctx);
  assert.ok(performance.now() - before < 5000, "task_result must return after waitMs");
  assert.equal(data(pending).done, false);
  assert.equal(data(pending).status, "running");
  assert.equal(data(pending).result, undefined);
  assert.equal((await system({ op: "delete_task", name: "slow" }, ctx)).isError, true, "a running task cannot be deleted");
  const stopped = await system({ op: "stop_task", name: "slow" }, ctx);
  assert.equal(data(stopped).stopped, true);
  const after = await system({ op: "task_result", name: "slow", waitMs: 0 }, ctx);
  assert.equal(data(after).status, "stopped");
  assert.equal(data(after).done, true);
}));

test("stop_all_tasks cancels running call tasks and counts them", () => withState(async () => {
  const ctx = platformCtx(screenClient("NOTHING"));
  await withEnv({ C64BRIDGE_TASK_INLINE_MS: "0" }, async () => {
    for (const name of ["a", "b"]) {
      await system({ op: "start_task", name, operation: "c64_memory.wait_for_text", arguments: { pattern: "NEVER", timeoutMs: 120000 } }, ctx);
    }
  });
  const stopped = await system({ op: "stop_all_tasks" }, ctx);
  assert.equal(data(stopped).count, 2);
  for (const name of ["a", "b"]) {
    assert.equal(data(await system({ op: "task_result", name }, ctx)).status, "stopped");
  }
}));

test("start_task rejects interval arguments, unknown allowlist keys and unknown task names", () => withState(async () => {
  const ctx = platformCtx(screenClient("READY."));
  const cases = [
    [{ operation: "c64_memory.wait_for_text", arguments: { pattern: "x" }, intervalMs: 500 }, /intervalMs/],
    [{ operation: "c64_memory.wait_for_text", arguments: { pattern: "x" }, maxIterations: 2 }, /maxIterations/],
    [{ operation: "c64_system.power_cycle" }, /Unsupported background task operation/],
    [{ operation: "c64_memory.wait_for_text", arguments: { op: "read", pattern: "x" } }, /arguments\.op/],
  ];
  for (const [extra, pattern] of cases) {
    const result = await system({ op: "start_task", name: "bad", ...extra }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, pattern);
  }
  const missing = await system({ op: "task_result", name: "nope" }, ctx);
  assert.equal(missing.isError, true);
}));

test("an operation that fails inside the inline window returns the ordinary error result", () => withState(async () => {
  const ctx = platformCtx(screenClient("READY."));
  const result = await withEnv({ C64BRIDGE_TASK_INLINE_MS: "5000" }, () => system({ op: "start_task", name: "invalid", operation: "c64_memory.wait_for_text", arguments: { timeoutMs: 1000 } }, ctx));
  assert.equal(result.isError, true);
  assert.equal(data(await system({ op: "list_tasks" }, ctx)).tasks.some((task) => task.name === "invalid"), false, "a failed fast task leaves no record");
}));

test("taskOperationEffect uses the declared effect of an allowlisted operation", () => {
  assert.equal(taskOperationEffect("c64_memory.wait_for_text"), "read");
  assert.equal(taskOperationEffect("c64_sound.pipeline"), "write");
  assert.equal(taskOperationEffect("read_screen"), "read");
  assert.equal(taskOperationEffect("menu_button"), "write");
});

for (const [mode, operation, blocked] of [
  ["read-only", "c64_sound.pipeline", true],
  ["read-only", "c64_program.batch_run", true],
  ["read-only", "c64_memory.wait_for_text", false],
  ["no-destructive", "c64_sound.pipeline", false],
  ["no-destructive", "c64_program.batch_run", false],
  ["no-destructive", "c64_memory.wait_for_text", false],
]) {
  test(`start_task ${operation} in ${mode} mode is ${blocked ? "blocked" : "not blocked"} by the access check`, () => withState(() => withEnv({ C64BRIDGE_ACCESS: mode, C64BRIDGE_TASK_INLINE_MS: "5000" }, async () => {
    let submissions = 0;
    const ctx = platformCtx({ ...screenClient("READY."), getActiveBackendType: async () => { submissions += 1; return "c64u"; } });
    const args = { name: "acc", operation, arguments: operation.endsWith("wait_for_text") ? { pattern: "READY.", timeoutMs: 1000 } : {} };
    const viaRegistry = await toolRegistry.invoke("c64_system", { op: "start_task", ...args }, ctx).catch((error) => ({ thrown: error }));
    const viaModule = await metaModule.invoke("start_background_task", args, ctx);
    for (const outcome of [viaRegistry.thrown ? { isError: true, content: [{ text: viaRegistry.thrown.message }] } : viaRegistry, viaModule]) {
      const text = outcome.content?.[0]?.text ?? "";
      assert.equal(/is blocked: it has effect/.test(text), blocked, `${mode} ${operation}: ${text}`);
    }
    // A blocked start is refused before a task is submitted (submission resolves the backend id); an allowed one submits.
    assert.equal(submissions > 0, !blocked, `${mode} ${operation}: submissions=${submissions}`);
  })));
}

test("the inner invoke enforces the access mode for a call task even when the start check is bypassed", () => withState(() => withEnv({ C64BRIDGE_ACCESS: "read-only" }, async () => {
  // submitCall goes straight to toolRegistry.invoke, so only the inner check can stop a write operation here.
  const task = await submitCall({ tool: "c64_sound", op: "pipeline", args: { sidwave: "x" }, ctx: platformCtx(screenClient("")) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(task.state, "failed");
  assert.match(task.error, /is blocked: it has effect "write"/);
})));

test("interval tasks run on the engine clock, and stop_all leaves no timer behind", () => withState(async () => {
  const fake = createFakeClock();
  setEngineClock(fake.clock);
  let reads = 0;
  const ctx = platformCtx({ getActiveBackendType: async () => "c64u", readMemory: async () => { reads += 1; return { success: true, data: "$00" }; } });
  const started = await system({ op: "start_task", name: "tick", operation: "read", arguments: { address: "$0400", length: 1 }, intervalMs: 100 }, ctx);
  assert.equal(data(started).started, true);
  assert.equal(fake.pending(), 1, "one pending iteration timer");
  assert.ok(fake.allUnref(), "interval timers are unref'd");
  await fake.advance(100);
  await settle();
  assert.equal(reads, 1);
  assert.equal(data(await system({ op: "list_tasks" }, ctx)).tasks.find((task) => task.name === "tick").status, "running");
  await stopAllBackgroundTasks();
  assert.equal(fake.pending(), 0, "stopAllBackgroundTasks clears every timer");
  assert.equal(data(await system({ op: "list_tasks" }, ctx)).tasks.find((task) => task.name === "tick").status, "stopped");
  await fake.advance(1000);
  assert.equal(reads, 1, "a stopped task never runs again");
}));

test("a working call task and interval tasks share the limit of 16", () => withState(async () => {
  const ctx = platformCtx(screenClient("NOTHING"));
  await withEnv({ C64BRIDGE_TASK_INLINE_MS: "0" }, async () => {
    for (let index = 0; index < 8; index += 1) {
      const started = await system({ op: "start_task", name: `i${index}`, operation: "read_screen", intervalMs: 100000 }, ctx);
      assert.equal(data(started).started, true);
    }
    for (let index = 0; index < 8; index += 1) {
      const started = await system({ op: "start_task", name: `c${index}`, operation: "c64_memory.wait_for_text", arguments: { pattern: "NEVER", timeoutMs: 120000 } }, ctx);
      assert.equal(data(started).started, true, `call ${index}: ${started.content?.[0]?.text}`);
    }
    const overInterval = await system({ op: "start_task", name: "i9", operation: "read_screen", intervalMs: 100000 }, ctx);
    assert.equal(overInterval.isError, true);
    assert.match(overInterval.content[0].text, /Too many running background tasks/);
    const overCall = await system({ op: "start_task", name: "c9", operation: "c64_memory.wait_for_text", arguments: { pattern: "NEVER", timeoutMs: 120000 } }, ctx);
    assert.equal(overCall.isError, true);
    assert.match(overCall.content[0].text, /Too many running background tasks/);
  });
}));

const intervalStart = (name, operation = "read", args = {}) => ({
  op: "start_task", name, operation, intervalMs: 100, arguments: args,
});
const callStart = (name) => ({
  op: "start_task", name, operation: "c64_memory.wait_for_text",
  arguments: { pattern: "NEVER", timeoutMs: 120000 },
});

function exclusiveLease() {
  return acquireLease({ taskId: "capture", backendId: "c64u", mode: "exclusive", tool: "c64_sound", op: "capture_samples", pinned: false });
}

test("an exclusive lease rejects conflicting interval starts", () => withState(async () => {
  exclusiveLease();
  const ctx = platformCtx(screenClient("READY."));
  for (const operation of ["write", "write_memory", "menu_button"]) {
    await assert.rejects(system(intervalStart("blocked", operation, { address: "$0400", bytes: "$41" }), ctx), { code: "resource_conflict" });
  }
  assert.equal(data(await system(intervalStart("passive"), ctx)).started, true);
}));

test("an interval skips and logs a blocked iteration and resumes after release", () => withState(async () => {
  const fake = createFakeClock();
  setEngineClock(fake.clock);
  let writes = 0;
  const ctx = platformCtx({ ...screenClient(""), writeMemory: async () => { writes += 1; return { success: true }; } });
  const started = await system(intervalStart("skip", "write", { address: "$0400", bytes: "$41" }), ctx);
  assert.equal(data(started).started, true);
  const lease = exclusiveLease();
  await fake.advance(100);
  assert.equal(writes, 0);
  const logPath = path.join(path.dirname(process.env.C64_TASK_STATE_FILE), data(started).task.folder, "log.txt");
  for (let attempts = 0; fake.pending() === 0 && attempts < 100; attempts += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.match(await fs.readFile(logPath, "utf8"), /skipp.*capture/i);
  assert.equal(data(await system({ op: "task_result", name: "skip" }, ctx)).status, "running");
  releaseLease(lease);
  await fake.advance(100);
  assert.equal(writes, 1);
}));

async function seedForeignIntervals(names, status) {
  const now = new Date().toISOString();
  const tasks = names.map((name) => ({
    name, id: `foreign_${name}`, ownerPid: process.ppid, ownerSession: "foreign",
    status, intervalMs: 100, operation: "read", args: {}, iterations: 1,
    startedAt: now, updatedAt: now, folder: `tasks/background/foreign_${name}`,
  }));
  await fs.writeFile(process.env.C64_TASK_STATE_FILE, JSON.stringify({ tasks }));
}

test("foreign intervals do not use this process's working-task slots", () => withState(async () => {
  await seedForeignIntervals(Array.from({ length: 16 }, (_, i) => `foreign-${i}`), "running");
  const ctx = platformCtx(screenClient("NOTHING"));
  const interval = await system(intervalStart("local"), ctx);
  assert.equal(data(interval)?.started, true, interval.content[0].text);
  const call = await withEnv({ C64BRIDGE_TASK_INLINE_MS: "0" }, () => system(callStart("local-call"), ctx));
  assert.equal(data(call)?.started, true, call.content[0].text);
}));

test("result, stop and delete resolve a local call ahead of a foreign interval", () => withState(async () => {
  await seedForeignIntervals(["shared"], "completed");
  const ctx = platformCtx(screenClient("NOTHING"));
  const call = await withEnv({ C64BRIDGE_TASK_INLINE_MS: "0" }, () => system(callStart("shared"), ctx));
  assert.equal(data(call)?.started, true);
  assert.equal(data(await system({ op: "task_result", name: "shared" }, ctx)).id, data(call).task.id);
  assert.equal(data(await system({ op: "stop_task", name: "shared" }, ctx)).status, "stopped");
  assert.equal(data(await system({ op: "delete_task", name: "shared" }, ctx)).deleted, true);
  assert.equal(data(await system({ op: "task_result", name: "shared" }, ctx)).id, "foreign_shared");
}));

test("concurrent interval and call starts cannot both take the same name", () => withState(() => withEnv({ C64BRIDGE_TASK_INLINE_MS: "0" }, async () => {
  const lookup = deferred();
  const resolving = deferred();
  const callContext = platformCtx({
    ...screenClient("NOTHING"),
    getActiveBackendType: () => {
      resolving.resolve();
      return lookup.promise;
    },
  });
  const call = system(callStart("race"), callContext);
  await resolving.promise;
  const interval = await system({ ...intervalStart("race"), intervalMs: 60_000 }, platformCtx(screenClient("")));
  lookup.resolve("c64u");
  const results = [await call, interval];
  assert.equal(results.filter((result) => data(result)?.started).length, 1);
  assert.equal(results.filter((result) => result.isError).length, 1);
})));

test("a rejected interval restart keeps the previous finished call task", () => withState(async () => {
  const ctx = platformCtx(screenClient("READY."));
  const previous = await system({
    ...callStart("restart"),
    arguments: { pattern: "READY.", timeoutMs: 1000 },
  }, ctx);
  assert.equal(data(previous)?.started, true);
  for (let i = 0; i < 16; i += 1) {
    assert.equal(data(await system({ ...intervalStart(`fill-${i}`), intervalMs: 100000 }, ctx))?.started, true);
  }
  assert.equal((await system(intervalStart("restart"), ctx)).isError, true);
  assert.equal(data(await system({ op: "task_result", name: "restart" }, ctx))?.id, data(previous).task.id);
}));

test("direct, native and legacy waits respect the same exclusive VICE lease", () => withState(() => withEnv({ C64BRIDGE_TASK_INLINE_MS: "5000" }, async () => {
  acquireLease({ taskId: "vice-capture", backendId: "vice", mode: "exclusive", tool: "c64_sound", op: "capture_samples", pinned: false });
  let reads = 0;
  const ctx = platformCtx({
    getActiveBackendType: async () => "vice",
    readScreen: async () => { reads += 1; return "READY."; },
  });
  const rest = { pattern: "READY.", timeoutMs: 1000 };
  const op = "wait_for_text";
  const entry = lookupAllowlist("c64_memory.wait_for_text");
  const conflict = { code: "resource_conflict", details: { heldBy: "vice-capture", tool: "c64_sound", op: "capture_samples", backend: "vice", class: "interrupting-read" } };
  await assert.rejects(toolRegistry.invoke("c64_memory", { op, ...rest }, ctx), conflict);
  await assert.rejects(runNativeCall({ entry, op, rest }, "c64_memory", ctx), conflict);
  const legacy = await system({ ...callStart("blocked-wait"), arguments: rest }, ctx);
  assert.equal(legacy.isError, true);
  assert.equal(legacy.metadata.error.code, conflict.code);
  assert.equal(legacy.metadata.error.details.heldBy, "vice-capture");
  assert.equal(reads, 0);
})));

test("a live foreign interval reserves its running name for interval and call starts", () => withState(async () => {
  await seedForeignIntervals(["foreign-name"], "running");
  const ctx = platformCtx(screenClient("READY."));
  for (const args of [intervalStart("foreign-name"), callStart("foreign-name")]) {
    const result = await system(args, ctx);
    assert.equal(result.isError, true, result.content[0].text);
    assert.match(result.content[0].text, /"foreign-name".*already running in another MCP process/);
  }
  const foreign = await system({ op: "task_result", name: "foreign-name" }, ctx);
  assert.equal(data(foreign).id, "foreign_foreign-name");
  assert.equal(data(foreign).status, "running");
}));
