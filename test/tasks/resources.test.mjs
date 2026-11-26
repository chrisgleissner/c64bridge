import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../../src/tools/registry/index.js";
import { listAllowlistKeys, lookupAllowlist } from "../../src/tasks/allowlist.js";
import { C64Client } from "../../src/c64Client.js";
import { ToolExecutionError } from "../../src/tools/errors.js";
import {
  classifyOperation,
  acquireLease,
  releaseLease,
  assertForegroundAllowed,
  listLeases,
  __resetLeasesForTests,
} from "../../src/tasks/resources.js";
import { submitCall, cancelTask, waitForTask, __resetForTests } from "../../src/tasks/engine.js";
import { deferred, baseCtx } from "./helpers.mjs";

// Each test starts and ends with no leases and no tasks, so a failing test cannot leak state.
function isolated(fn) {
  return async () => {
    __resetLeasesForTests();
    __resetForTests();
    try {
      await fn();
    } finally {
      __resetLeasesForTests();
      __resetForTests();
    }
  };
}

async function withAccess(value, fn) {
  const previous = process.env.C64BRIDGE_ACCESS;
  if (value === undefined) delete process.env.C64BRIDGE_ACCESS;
  else process.env.C64BRIDGE_ACCESS = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.C64BRIDGE_ACCESS;
    else process.env.C64BRIDGE_ACCESS = previous;
  }
}

function exclusiveLease(taskId, backendId = "c64u") {
  return { taskId, backendId, mode: "exclusive", tool: "c64_sound", op: "capture_samples", pinned: false };
}

function observeLease(taskId, { backendId = "c64u", pinned = true } = {}) {
  return { taskId, backendId, mode: "observe", tool: "c64_memory", op: "wait_for_text", pinned };
}

// ---- (1) classifyOperation -----------------------------------------------------------------

const CLASSIFY_CASES = [
  { name: "backend switch", tool: "c64_select_backend", op: "select", effect: "read", backend: "c64u", expected: "backend-switch" },
  { name: "memory write", tool: "c64_memory", op: "write", effect: "write", backend: "c64u", expected: "memory-write" },
  { name: "memory read on c64u", tool: "c64_memory", op: "read", effect: "read", backend: "c64u", expected: "passive-read" },
  { name: "memory read on vice", tool: "c64_memory", op: "read", effect: "read", backend: "vice", expected: "interrupting-read" },
  { name: "system reset", tool: "c64_system", op: "reset", effect: "destructive", backend: "c64u", expected: "reset-power" },
  { name: "system reboot", tool: "c64_system", op: "reboot", effect: "destructive", backend: "c64u", expected: "reset-power" },
  { name: "system power_cycle", tool: "c64_system", op: "power_cycle", effect: "destructive", backend: "c64u", expected: "reset-power" },
  { name: "keyboard input", tool: "c64_input", op: "key", effect: "write", backend: "c64u", expected: "input" },
  { name: "frame capture", tool: "c64_graphics", op: "capture_frame", effect: "read", backend: "c64u", expected: "capture" },
  { name: "program start", tool: "c64_program", op: "run_prg", effect: "write", backend: "c64u", expected: "program-start" },
  { name: "config write", tool: "c64_config", op: "set", effect: "write", backend: "c64u", expected: "configuration" },
  { name: "rag query", tool: "c64_rag", op: "query", effect: "read", backend: "c64u", expected: "host-only" },
  { name: "interval write start", tool: "c64_system", op: "start_task", taskOperation: "write", effect: "write", backend: "c64u", expected: "memory-write" },
  { name: "interval write_memory start", tool: "c64_system", op: "start_task", taskOperation: "write_memory", effect: "write", backend: "c64u", expected: "memory-write" },
  { name: "interval menu_button start", tool: "c64_system", op: "start_task", taskOperation: "menu_button", effect: "write", backend: "c64u", expected: "input" },
  { name: "interval read start on c64u", tool: "c64_system", op: "start_task", taskOperation: "read", effect: "read", backend: "c64u", expected: "passive-read" },
  { name: "interval read_screen start on vice", tool: "c64_system", op: "start_task", taskOperation: "read_screen", effect: "read", backend: "vice", expected: "interrupting-read" },
  { name: "allowlisted task start", tool: "c64_system", op: "start_task", taskOperation: "c64_memory.wait_until", effect: "read", backend: "vice", expected: "host-only" },
  { name: "list_tasks", tool: "c64_system", op: "list_tasks", effect: "read", backend: "c64u", expected: "host-only" },
  { name: "task_result", tool: "c64_system", op: "task_result", effect: "read", backend: "c64u", expected: "host-only" },
  { name: "unknown tool, read effect", tool: "x_unknown_tool", op: "anything", effect: "read", backend: "c64u", expected: "passive-read" },
  { name: "unknown tool, read effect on vice", tool: "x_unknown_tool", op: "anything", effect: "read", backend: "vice", expected: "interrupting-read" },
  { name: "unknown tool, write effect", tool: "x_unknown_tool", op: "anything", effect: "write", backend: "c64u", expected: "memory-write" },
];

for (const c of CLASSIFY_CASES) {
  test(`classifyOperation: ${c.name} is ${c.expected}`, isolated(() => {
    assert.equal(classifyOperation(c.tool, c.op, c.effect, c.backend, c.taskOperation), c.expected);
  }));
}

// ---- (2) acquireLease / releaseLease -------------------------------------------------------

test("acquireLease: observe leases never conflict with each other", isolated(() => {
  acquireLease({ taskId: "obs-1", backendId: "c64u", mode: "observe", tool: "c64_memory", op: "wait_for_text", pinned: true });
  acquireLease({ taskId: "obs-2", backendId: "c64u", mode: "observe", tool: "c64_debug", op: "wait_for_state", pinned: false });
  assert.equal(listLeases().length, 2);
}));

test("acquireLease: a second exclusive lease on the same backend is rejected and names the holder", isolated(() => {
  acquireLease(exclusiveLease("holder-task-42"));
  assert.throws(
    () => acquireLease({ taskId: "second", backendId: "c64u", mode: "exclusive", tool: "c64_graphics", op: "capture_frame", pinned: false }),
    (error) => {
      assert.ok(error instanceof ToolExecutionError);
      assert.equal(error.code, "resource_conflict");
      assert.match(error.message, /holder-task-42/);
      assert.match(error.message, /c64_sound\.capture_samples/);
      assert.match(error.message, /cancel/i);
      assert.equal(error.details.heldBy, "holder-task-42");
      return true;
    },
  );
  assert.equal(listLeases().length, 1, "the rejected lease must not be recorded");
}));

test("acquireLease: exclusive leases on different backends do not conflict", isolated(() => {
  acquireLease(exclusiveLease("on-c64u", "c64u"));
  const lease = acquireLease(exclusiveLease("on-vice", "vice"));
  assert.equal(lease.taskId, "on-vice");
  assert.equal(listLeases().length, 2);
}));

test("acquireLease: mode none returns null and holds nothing", isolated(() => {
  assert.equal(acquireLease({ taskId: "none-1", backendId: "c64u", mode: "none", tool: "c64_rag", op: "basic", pinned: true }), null);
  assert.equal(listLeases().length, 0);
}));

test("releaseLease: releasing an exclusive lease lets the next exclusive lease through", isolated(() => {
  const first = acquireLease(exclusiveLease("first"));
  releaseLease(first);
  assert.equal(listLeases().length, 0);
  const second = acquireLease(exclusiveLease("second"));
  assert.equal(second.taskId, "second");
}));

test("releaseLease: null and undefined are accepted", isolated(() => {
  releaseLease(null);
  releaseLease(undefined);
  assert.equal(listLeases().length, 0);
}));

// ---- (3) assertForegroundAllowed with an exclusive lease on c64u ---------------------------

const BLOCKED_BY_EXCLUSIVE_CASES = [
  { cls: "memory-write", call: { tool: "c64_memory", op: "write", effect: "write", backendId: "c64u" } },
  { cls: "program-start", call: { tool: "c64_program", op: "run_prg", effect: "write", backendId: "c64u" } },
  { cls: "reset-power", call: { tool: "c64_system", op: "reset", effect: "destructive", backendId: "c64u" } },
  { cls: "input", call: { tool: "c64_input", op: "key", effect: "write", backendId: "c64u" } },
  { cls: "capture", call: { tool: "c64_graphics", op: "capture_frame", effect: "read", backendId: "c64u" } },
  { cls: "configuration", call: { tool: "c64_config", op: "set", effect: "write", backendId: "c64u" } },
  { cls: "backend-switch", call: { tool: "c64_select_backend", op: "select", effect: "read", backendId: "c64u" } },
];

for (const c of BLOCKED_BY_EXCLUSIVE_CASES) {
  test(`assertForegroundAllowed: exclusive c64u lease rejects ${c.cls} and names the holder`, isolated(() => {
    acquireLease(exclusiveLease("holder-7"));
    assert.throws(
      () => assertForegroundAllowed(c.call),
      (error) => {
        assert.equal(error.code, "resource_conflict");
        assert.match(error.message, /holder-7/);
        assert.match(error.message, new RegExp(`\\(${c.cls}\\)`));
        return true;
      },
    );
  }));
}

// Interrupting-read is only classified for the vice backend. A lease on c64u never matches a vice
// call, so this case uses a vice lease. See the report for why a c64u lease cannot block it.
test("assertForegroundAllowed: exclusive vice lease rejects interrupting-read and names the holder", isolated(() => {
  acquireLease(exclusiveLease("holder-vice", "vice"));
  assert.throws(
    () => assertForegroundAllowed({ tool: "c64_memory", op: "read", effect: "read", backendId: "vice" }),
    (error) => {
      assert.equal(error.code, "resource_conflict");
      assert.match(error.message, /holder-vice/);
      assert.match(error.message, /\(interrupting-read\)/);
      return true;
    },
  );
}));

test("assertForegroundAllowed: exclusive c64u lease allows passive-read and host-only calls", isolated(() => {
  acquireLease(exclusiveLease("holder-9"));
  assertForegroundAllowed({ tool: "c64_memory", op: "read", effect: "read", backendId: "c64u" });
  assertForegroundAllowed({ tool: "c64_rag", op: "query", effect: "read", backendId: "c64u" });
  assertForegroundAllowed({ tool: "c64_system", op: "list_tasks", effect: "read", backendId: "c64u" });
}));

test("assertForegroundAllowed: the holder's own call passes through the taskLease argument", isolated(() => {
  acquireLease(exclusiveLease("holder-self"));
  assertForegroundAllowed({ tool: "c64_memory", op: "write", effect: "write", backendId: "c64u" }, "holder-self");
  assertForegroundAllowed({ tool: "c64_graphics", op: "capture_frame", effect: "read", backendId: "c64u" }, "holder-self");
}));

test("assertForegroundAllowed: a taskLease that holds no lease does not bypass the gate", isolated(() => {
  acquireLease(exclusiveLease("holder-real"));
  assert.throws(
    () => assertForegroundAllowed({ tool: "c64_memory", op: "write", effect: "write", backendId: "c64u" }, "someone-else"),
    /holder-real/,
  );
}));

test("assertForegroundAllowed: a call on backend vice is allowed while the lease is on c64u", isolated(() => {
  acquireLease(exclusiveLease("holder-c64u"));
  assertForegroundAllowed({ tool: "c64_memory", op: "write", effect: "write", backendId: "vice" });
  assertForegroundAllowed({ tool: "c64_system", op: "reset", effect: "destructive", backendId: "vice" });
}));

// ---- (4) observe lease ---------------------------------------------------------------------

test("assertForegroundAllowed: observe lease allows a foreground memory write", isolated(() => {
  acquireLease(observeLease("observer-1"));
  assertForegroundAllowed({ tool: "c64_memory", op: "write", effect: "write", backendId: "c64u" });
}));

test("assertForegroundAllowed: observe lease pinned:true allows a backend switch", isolated(() => {
  acquireLease(observeLease("observer-pinned", { pinned: true }));
  assertForegroundAllowed({ tool: "c64_select_backend", op: "select", effect: "read", backendId: "c64u" });
}));

test("assertForegroundAllowed: observe lease pinned:false rejects a backend switch and names the task", isolated(() => {
  acquireLease(observeLease("observer-unpinned", { pinned: false }));
  assert.throws(
    () => assertForegroundAllowed({ tool: "c64_select_backend", op: "select", effect: "read", backendId: "c64u" }),
    (error) => {
      assert.equal(error.code, "resource_conflict");
      assert.match(error.message, /observer-unpinned/);
      return true;
    },
  );
}));

// ---- (5) gate through toolRegistry.invoke with a real engine task --------------------------

// A c64_memory client stub. Every write records a call. Reads return a fixed byte.
function memoryClient(calls) {
  const record = (name, value) => async () => { calls.push(name); return value; };
  return {
    getActiveBackendType: async () => "c64u",
    getAvailableBackends: () => ["c64u"],
    writeMemory: record("writeMemory", { success: true }),
    writeMemoryRaw: record("writeMemoryRaw", undefined),
    readMemory: record("readMemory", { success: true, data: "$41", details: { address: "$0400", length: 1, bytes: "$41" } }),
    readMemoryRaw: record("readMemoryRaw", Uint8Array.of(0x41)),
    pinFacade: record("pinFacade", undefined),
  };
}

// Starts a c64_sound capture_samples task that never settles, so its exclusive lease stays held.
async function startHoldingTask() {
  const never = deferred();
  const task = await submitCall({
    tool: "c64_sound",
    op: "capture_samples",
    args: {},
    ctx: baseCtx(),
    invoke: () => never.promise,
  });
  assert.equal(task.state, "working");
  assert.equal(listLeases().length, 1);
  return task;
}

function isResourceConflict(error) {
  return error?.code === "resource_conflict";
}

test("gate: a foreground memory write is rejected while a capture task holds the lease", isolated(() => withAccess("full", async () => {
  const task = await startHoldingTask();
  const calls = [];
  await assert.rejects(
    () => toolRegistry.invoke("c64_memory", { op: "write", address: "$0400", bytes: "$41" }, baseCtx({ client: memoryClient(calls) })),
    (error) => {
      assert.ok(error instanceof ToolExecutionError, `expected ToolExecutionError, got ${error?.constructor?.name}`);
      assert.equal(error.code, "resource_conflict");
      assert.match(error.message, new RegExp(task.id));
      return true;
    },
  );
  assert.deepEqual(calls.filter((name) => /write/i.test(name)), []);
  cancelTask(task.id);
})));

test("gate: a foreground memory read is not rejected while the capture task holds the lease", isolated(() => withAccess("full", async () => {
  const task = await startHoldingTask();
  const calls = [];
  try {
    await toolRegistry.invoke("c64_memory", { op: "read", address: "$0400", length: 1 }, baseCtx({ client: memoryClient(calls) }));
  } catch (error) {
    assert.notEqual(error?.code, "resource_conflict", `read was blocked by the gate: ${error?.message}`);
  }
  cancelTask(task.id);
})));

test("gate: after cancelTask the same memory write is no longer rejected by the gate", isolated(() => withAccess("full", async () => {
  const task = await startHoldingTask();
  cancelTask(task.id);
  assert.equal(listLeases().length, 0);
  const calls = [];
  try {
    await toolRegistry.invoke("c64_memory", { op: "write", address: "$0400", bytes: "$41" }, baseCtx({ client: memoryClient(calls) }));
  } catch (error) {
    assert.equal(isResourceConflict(error), false, `gate still blocks after cancel: ${error?.message}`);
  }
})));

test("gate: a call carrying taskLease equal to the holder's task id passes the gate", isolated(() => withAccess("full", async () => {
  const task = await startHoldingTask();
  const calls = [];
  try {
    await toolRegistry.invoke(
      "c64_memory",
      { op: "write", address: "$0400", bytes: "$41" },
      baseCtx({ client: memoryClient(calls), taskLease: task.id }),
    );
  } catch (error) {
    assert.equal(isResourceConflict(error), false, `own-task call was blocked: ${error?.message}`);
  }
  cancelTask(task.id);
})));

test("a VICE task is exempt from only its own lease", isolated(() => {
  acquireLease(exclusiveLease("capture", "vice"));
  acquireLease(observeLease("wait", { backendId: "vice", pinned: false }));
  const read = { tool: "c64_memory", op: "wait_for_text", effect: "read", backendId: "vice" };
  assert.throws(() => assertForegroundAllowed(read, "wait"), (error) => {
    assert.equal(error.code, "resource_conflict");
    assert.equal(error.details.heldBy, "capture");
    return true;
  });
}));

test("wait_until is the only allowlisted operation pinned to its backend", () => {
  assert.deepEqual(listAllowlistKeys().filter((key) => lookupAllowlist(key).pinned), ["c64_memory.wait_until"]);
});

const select = (backend, ctx) => toolRegistry.invoke("c64_select_backend", { op: "select", backend }, ctx);

function switchableContext(stopManagedSidwavePlayback) {
  let active = "c64u";
  return baseCtx({
    client: {
      getActiveBackendType: async () => active,
      pinFacade: async () => ({ type: active }),
      readMemoryRaw: async () => Uint8Array.of(0x41),
      getAvailableBackends: () => ["c64u", "vice"],
      switchBackend: (backend) => { active = backend; },
      stopManagedSidwavePlayback,
    },
    setPlatform() {},
  });
}

test("a switch rechecks leases after playback cleanup", isolated(async () => {
  const cleaning = deferred();
  const release = deferred();
  const ctx = switchableContext(() => {
    cleaning.resolve();
    return release.promise;
  });
  const switching = select("vice", ctx);
  await cleaning.promise;
  const task = await startHoldingTask();
  release.resolve();
  await assert.rejects(switching, isResourceConflict);
  assert.equal(await ctx.client.getActiveBackendType(), task.backendId);
}));

test("selecting the active backend succeeds with an unpinned lease", isolated(async () => {
  const ctx = switchableContext(() => assert.fail("no-op select must keep playback"));
  acquireLease(observeLease("unpinned", { pinned: false }));
  const result = await select("c64u", ctx);
  assert.equal(result.structuredContent.data.alreadyActive, true);
}));

test("c64_select_backend blocks an unpinned wait and allows a pinned wait_until", isolated(async () => {
  const ctx = switchableContext();
  const unpinned = await submitCall({ tool: "c64_memory", op: "wait_for_text", ctx, invoke: () => deferred().promise });
  await assert.rejects(select("vice", ctx), isResourceConflict);
  assert.equal(await ctx.client.getActiveBackendType(), "c64u");
  cancelTask(unpinned.id);

  const runWait = deferred();
  const pinned = await submitCall({
    tool: "c64_memory", op: "wait_until", ctx,
    args: { condition: { type: "equals", address: "$0400", bytes: "41" }, timeoutMs: 500 },
    invoke: async (tool, args, taskCtx) => {
      await runWait.promise;
      return toolRegistry.invoke(tool, args, taskCtx);
    },
  });
  const result = await select("vice", ctx);
  assert.equal(result.structuredContent?.data.activeBackend, "vice");
  assert.equal(await ctx.client.getActiveBackendType(), "vice");
  assert.equal(pinned.backendId, "c64u");
  assert.equal(pinned.state, "working");
  runWait.resolve();
  const completed = await waitForTask(pinned.id, 500);
  assert.equal(completed.state, "completed");
  assert.equal(completed.result?.structuredContent?.data.backend, "c64u");
  assert.equal(completed.result?.structuredContent?.data.met, true);
}));

test("a queued client switch checks leases at the actual backend change", isolated(async () => {
  const releasing = deferred();
  const release = deferred();
  const c64u = Promise.resolve({ type: "c64u" });
  const client = Object.assign(Object.create(C64Client.prototype), {
    initPromise: Promise.resolve(),
    activeType: "c64u",
    facadePromise: c64u,
    allFacades: new Map([["c64u", c64u], ["vice", Promise.resolve({ type: "vice" })]]),
    sidwaveQueue: new WeakMap(),
    sidwaveSessions: new Map([["session", {}]]),
    stopManagedSidwavePlayback: async () => {},
    releaseManagedSidwave: () => {
      releasing.resolve();
      return release.promise;
    },
  });
  const switching = select("vice", baseCtx({ client, setPlatform() {} }));
  await releasing.promise;
  const task = await startHoldingTask();
  release.resolve();
  await assert.rejects(switching, isResourceConflict);
  assert.equal(await client.getActiveBackendType(), task.backendId);
}));

test("a queued client switch is not rejected by the earlier switch's lease conflict once the lease is released", isolated(async () => {
  const firstRelease = deferred();
  const secondRelease = deferred();
  const secondReached = deferred();
  const c64u = Promise.resolve({ type: "c64u" });
  let releaseCalls = 0;
  const client = Object.assign(Object.create(C64Client.prototype), {
    initPromise: Promise.resolve(),
    activeType: "c64u",
    facadePromise: c64u,
    allFacades: new Map([["c64u", c64u], ["vice", Promise.resolve({ type: "vice" })]]),
    sidwaveQueue: new WeakMap(),
    sidwaveSessions: new Map([["session", {}]]),
    stopManagedSidwavePlayback: async () => {},
    releaseManagedSidwave: () => {
      releaseCalls += 1;
      if (releaseCalls === 1) return firstRelease.promise;
      secondReached.resolve();
      return secondRelease.promise;
    },
  });
  const ctx = baseCtx({ client, setPlatform() {} });
  const first = select("vice", ctx);
  while (releaseCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  // The second switch passes the start check and is queued behind the first one, which has not changed the backend yet.
  const second = select("vice", ctx);
  await new Promise((resolve) => setImmediate(resolve));
  const task = await startHoldingTask();
  firstRelease.resolve();
  await assert.rejects(first, isResourceConflict);
  // The second switch must run its own check, so it reaches its own release step after the first one was rejected.
  await Promise.race([
    secondReached.promise,
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  cancelTask(task.id);
  secondRelease.resolve();
  const result = await second;
  assert.ok(!result?.isError, `second switch failed: ${result?.content?.[0]?.text}`);
  assert.equal(await client.getActiveBackendType(), "vice");
}));
