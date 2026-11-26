import test from "#test/runner";
import assert from "#test/assert";
import {
  submitCall,
  waitForTask,
  cancelTask,
  handoverTask,
  getTask,
  findByName,
  listCallTasks,
  transition,
  stopAllTasks,
  runWithInlineWindow,
  inlineWindowMs,
  setEngineClock,
  registerTaskSource,
  getTaskSource,
  DEFAULT_INLINE_MS,
  MAX_WORKING_TASKS,
  __resetForTests,
} from "../../src/tasks/engine.js";
import { __resetLeasesForTests, listLeases } from "../../src/tasks/resources.js";
import { createFakeClock, deferred, settle, okResult, errorResult, baseCtx } from "./helpers.mjs";

const ALL_STATES = ["working", "completed", "failed", "cancelled"];
const TERMINAL_STATES = ["completed", "failed", "cancelled"];

// Allowlisted keys used below. c64_memory.wait_for_text is an observe lease; c64_sound.capture_samples
// and c64_graphics.capture_frame are exclusive leases on the backend.
const OBSERVE = { tool: "c64_memory", op: "wait_for_text" };
const EXCLUSIVE = { tool: "c64_sound", op: "capture_samples" };
const BOUNDED = { tool: "c64_graphics", op: "capture_frame" };

function zeroSource() {
  return { countWorking: () => 0, stopAll() {} };
}

// The "interval" source is process-wide state registered by src/tools/meta/background.ts when it is first
// imported. These tests replace it, so the original is captured once and put back after every test; otherwise
// later files in the same process (Bun runs a batch in one process) lose their real interval source.
let originalIntervalSource;
let originalCaptured = false;

function reset() {
  if (!originalCaptured) {
    originalCaptured = true;
    originalIntervalSource = getTaskSource("interval");
  }
  __resetForTests();
  __resetLeasesForTests();
  registerTaskSource("interval", zeroSource());
}

/** Runs one test body with a fresh fake clock; resets the engine before and after. */
function withEngine(body) {
  return async () => {
    reset();
    const fake = createFakeClock();
    setEngineClock(fake.clock);
    try {
      await body(fake);
    } finally {
      reset();
      if (originalIntervalSource) registerTaskSource("interval", originalIntervalSource);
    }
  };
}

function spec(overrides = {}) {
  return { ...EXCLUSIVE, ctx: baseCtx(), invoke: async () => okResult(), ...overrides };
}

function pending() {
  return () => new Promise(() => {});
}

test("immediate completion stores the result", withEngine(async () => {
  const result = okResult("done");
  const task = await submitCall(spec({ invoke: async () => result }));
  await settle();
  const got = await waitForTask(task.id, 0);
  assert.equal(got.state, "completed");
  assert.equal(got.result, result);
  assert.equal(getTask(task.id).state, "completed");
}));

test("delayed completion: waitForTask times out on the fake clock, then the task completes", withEngine(async (fake) => {
  const d = deferred();
  const task = await submitCall(spec({ invoke: () => d.promise }));
  const first = waitForTask(task.id, 500);
  await fake.advance(500);
  assert.equal((await first).state, "working");

  d.resolve(okResult("late"));
  await settle();
  assert.equal(getTask(task.id).state, "completed");
}));

test("waitForTask resolves early when the task finishes before the timeout", withEngine(async () => {
  const d = deferred();
  const task = await submitCall(spec({ invoke: () => d.promise }));
  const waiting = waitForTask(task.id, 5_000);
  d.resolve(okResult("early"));
  const got = await waiting;
  assert.equal(got.state, "completed");
  assert.equal(got.result.content[0].text, "early");
}));

test("two concurrent observe tasks complete independently", withEngine(async () => {
  const d1 = deferred();
  const d2 = deferred();
  const t1 = await submitCall(spec({ ...OBSERVE, invoke: () => d1.promise }));
  const t2 = await submitCall(spec({ tool: "c64_debug", op: "wait_for_state", invoke: () => d2.promise }));
  d2.resolve(okResult("second"));
  await settle();
  assert.equal(t2.state, "completed");
  assert.equal(t1.state, "working");
  d1.resolve(okResult("first"));
  await settle();
  assert.equal(t1.state, "completed");
  assert.equal(t1.result.content[0].text, "first");
}));

test("request signal already aborted at submit: task is cancelled and invoke is never called", withEngine(async () => {
  const ac = new AbortController();
  ac.abort();
  let calls = 0;
  const task = await submitCall(spec({
    requestSignal: ac.signal,
    invoke: async () => { calls += 1; return okResult(); },
  }));
  await settle();
  assert.equal(task.state, "cancelled");
  assert.equal(calls, 0);
  assert.equal(listLeases().length, 0);
}));

test("cancel during a run aborts the signal passed to invoke and leaves state cancelled", withEngine(async () => {
  const d = deferred();
  let seen;
  const task = await submitCall(spec({
    invoke: (_name, _args, ctx) => { seen = ctx.signal; return d.promise; },
  }));
  assert.equal(seen.aborted, false);
  cancelTask(task.id);
  assert.equal(seen.aborted, true);
  assert.equal(task.state, "cancelled");
  d.resolve(okResult("ignored"));
  await settle();
  assert.equal(task.state, "cancelled");
}));

test("cancel after completion keeps the completed state and returns the task", withEngine(async () => {
  const task = await submitCall(spec({ invoke: async () => okResult("kept") }));
  await settle();
  const returned = cancelTask(task.id);
  assert.equal(returned.state, "completed");
  assert.equal(returned.result.content[0].text, "kept");
}));

test("late completion after cancel stays cancelled and the result is not stored", withEngine(async () => {
  const d = deferred();
  const task = await submitCall(spec({ invoke: () => d.promise }));
  cancelTask(task.id);
  d.resolve(okResult("too late"));
  await settle();
  assert.equal(task.state, "cancelled");
  assert.equal(task.result, undefined);
}));

test("cancel racing a waitForTask timeout never rejects and leaves the task cancelled", withEngine(async (fake) => {
  const d = deferred();
  const task = await submitCall(spec({ invoke: () => d.promise }));
  const waiting = waitForTask(task.id, 100);
  // The timer fires synchronously inside advance(); the cancel follows in the same tick.
  const advancing = fake.advance(100);
  const returned = cancelTask(task.id);
  await advancing;
  const got = await waiting;
  assert.ok(got, "waitForTask resolves with the task");
  assert.equal(returned.state, "cancelled");
  assert.equal(task.state, "cancelled");
}));

test("repeated cancel is a no-op and transition() refuses every change of a terminal task", withEngine(async () => {
  const completed = await submitCall(spec({ invoke: async () => okResult() }));
  const failed = await submitCall(spec({ tool: "c64_debug", op: "wait_for_state", invoke: async () => { throw new Error("boom"); } }));
  const cancelled = await submitCall(spec({ tool: "c64_graphics", op: "capture_frame", invoke: pending() }));
  await settle();
  cancelTask(cancelled.id);

  const byState = { completed, failed, cancelled };
  for (const [state, task] of Object.entries(byState)) {
    assert.equal(task.state, state);
    const message = task.statusMessage;
    for (const to of ALL_STATES) {
      assert.equal(transition(task, to), false, `${state} -> ${to} must be refused`);
      assert.equal(task.state, state, `${state} must not change to ${to}`);
    }
    assert.equal(cancelTask(task.id).state, state, `repeated cancel keeps ${state}`);
    assert.equal(task.statusMessage, message, `repeated cancel does not rewrite the message of ${state}`);
  }
  for (const state of TERMINAL_STATES) assert.ok(byState[state].finishedAt, `${state} has finishedAt`);
}));

test("backend throw: task is failed with the error message and the original error object", withEngine(async () => {
  const thrown = new Error("backend exploded");
  const task = await submitCall(spec({ invoke: async () => { throw thrown; } }));
  await settle();
  assert.equal(task.state, "failed");
  assert.equal(task.error, "backend exploded");
  assert.equal(task.errorObject, thrown);
}));

test("isError result: task is failed and the result is kept", withEngine(async () => {
  const result = errorResult("device said no");
  const task = await submitCall(spec({ invoke: async () => result }));
  await settle();
  assert.equal(task.state, "failed");
  assert.equal(task.error, "device said no");
  assert.equal(task.result, result);
}));

test("ttl expiry removes the task after ttlMs on the fake clock and leaves no timers", withEngine(async (fake) => {
  const task = await submitCall(spec({ ttlMs: 1_000, invoke: async () => okResult() }));
  await settle();
  assert.equal(task.state, "completed");
  assert.equal(fake.allUnref(), true, "expiry timer is unref'd");
  await fake.advance(999);
  assert.ok(getTask(task.id), "still present before ttl");
  await fake.advance(1);
  assert.equal(getTask(task.id), undefined);
  assert.equal(fake.pending(), 0);
}));

test("retention cap: finished call tasks are capped at 64 and the oldest are dropped", withEngine(async (fake) => {
  const ids = [];
  for (let i = 0; i < 70; i += 1) {
    const task = await submitCall(spec({ invoke: async () => okResult(`#${i}`) }));
    ids.push(task.id);
    await settle();
    await fake.advance(1);
  }
  assert.equal(listCallTasks().length, 64);
  for (const id of ids.slice(0, 6)) assert.equal(getTask(id), undefined, "oldest task dropped");
  assert.ok(getTask(ids[6]), "seventh task kept");
  assert.ok(getTask(ids[69]), "newest task kept");
}));

test("working limit is shared across kinds: the 7th observe task is rejected with no task or lease left", withEngine(async () => {
  registerTaskSource("interval", { countWorking: () => 10, stopAll() {} });
  for (let i = 0; i < MAX_WORKING_TASKS - 10; i += 1) {
    await submitCall(spec({ ...OBSERVE, invoke: pending() }));
  }
  assert.equal(listCallTasks().length, 6);
  let calls = 0;
  await assert.rejects(
    submitCall(spec({ ...OBSERVE, invoke: async () => { calls += 1; return okResult(); } })),
    (error) => /limit/i.test(error.message),
  );
  assert.equal(calls, 0);
  assert.equal(listCallTasks().length, 6);
  assert.equal(listLeases().length, 6);
}));

test("stopAllTasks cancels working call tasks, calls the source stopAll and leaves no timers", withEngine(async (fake) => {
  let stopCalls = 0;
  registerTaskSource("interval", { countWorking: () => 0, stopAll() { stopCalls += 1; } });
  const w1 = await submitCall(spec({ ...OBSERVE, invoke: pending() }));
  const w2 = await submitCall(spec({ ...OBSERVE, invoke: pending() }));
  const done = await submitCall(spec({ invoke: async () => okResult() }));
  await settle();
  await stopAllTasks();
  assert.equal(w1.state, "cancelled");
  assert.equal(w2.state, "cancelled");
  assert.equal(done.state, "completed");
  assert.equal(stopCalls, 1);
  assert.equal(fake.pending(), 0);
}));

test("request signal: abort before handoverTask cancels the task", withEngine(async () => {
  const ac = new AbortController();
  const task = await submitCall(spec({ requestSignal: ac.signal, invoke: pending() }));
  ac.abort();
  assert.equal(task.state, "cancelled");
}));

test("request signal: abort after handoverTask does not cancel the task", withEngine(async () => {
  const ac = new AbortController();
  const d = deferred();
  const task = await submitCall(spec({ requestSignal: ac.signal, invoke: () => d.promise }));
  handoverTask(task.id);
  ac.abort();
  assert.equal(task.state, "working");
  d.resolve(okResult());
  await settle();
  assert.equal(task.state, "completed");
}));

test("lease lifecycle: one lease while working, none after each terminal path", withEngine(async () => {
  const paths = [
    { label: "completed", settle: (d) => d.resolve(okResult()), expect: "completed", cancel: false },
    { label: "failed by throw", settle: (d) => d.reject(new Error("boom")), expect: "failed", cancel: false },
    { label: "failed by isError", settle: (d) => d.resolve(errorResult("bad")), expect: "failed", cancel: false },
    { label: "cancelled", settle: null, expect: "cancelled", cancel: true },
  ];
  for (const path of paths) {
    const d = deferred();
    const task = await submitCall(spec({ invoke: () => d.promise }));
    const held = listLeases();
    assert.equal(held.length, 1, `${path.label}: one lease while working`);
    assert.equal(held[0].taskId, task.id, `${path.label}: lease belongs to the task`);
    assert.equal(held[0].mode, "exclusive");
    if (path.cancel) cancelTask(task.id);
    else path.settle(d);
    await settle();
    assert.equal(task.state, path.expect, `${path.label}: terminal state`);
    assert.equal(listLeases().length, 0, `${path.label}: no lease after finish`);
  }
}));

test("lease lifecycle: a bounded operation keeps its lease after cancel until invoke settles", withEngine(async () => {
  const d = deferred();
  const task = await submitCall(spec({ ...BOUNDED, invoke: () => d.promise }));
  assert.equal(listLeases().length, 1);
  cancelTask(task.id);
  assert.equal(task.state, "cancelled");
  assert.equal(listLeases().length, 1, "lease held while the underlying call runs");
  assert.equal(listLeases()[0].taskId, task.id);
  d.resolve(okResult("finished"));
  await settle();
  assert.equal(listLeases().length, 0, "lease released once invoke settles");
}));

test("exclusive conflict on one backend names the holding task; observe is allowed; another backend is allowed", withEngine(async () => {
  const first = await submitCall(spec({ backendId: "c64u", invoke: pending() }));
  await assert.rejects(
    submitCall(spec({ backendId: "c64u", invoke: pending() })),
    (error) => error.message.includes(first.id),
  );
  const observe = await submitCall(spec({ ...OBSERVE, backendId: "c64u", invoke: pending() }));
  assert.equal(observe.state, "working");
  const other = await submitCall(spec({ backendId: "vice", ctx: baseCtx({ client: { getActiveBackendType: async () => "vice" } }), invoke: pending() }));
  assert.equal(other.state, "working");
}));

test("name uniqueness: a name in use by a working task is rejected; a finished task's name is replaced", withEngine(async () => {
  const d = deferred();
  const first = await submitCall(spec({ name: "job", invoke: () => d.promise }));
  await assert.rejects(
    submitCall(spec({ name: "job", invoke: pending() })),
    (error) => error.message.includes("job"),
  );
  assert.equal(findByName("job").id, first.id);

  d.resolve(okResult());
  await settle();
  const second = await submitCall(spec({ name: "job", invoke: async () => okResult("second") }));
  await settle();
  assert.notEqual(second.id, first.id);
  assert.equal(findByName("job").id, second.id);
  assert.equal(getTask(first.id), undefined, "the finished task with the same name is replaced");
}));

test("submitCall rejects a key that is not allowlisted", withEngine(async () => {
  await assert.rejects(
    submitCall(spec({ tool: "c64_memory", op: "read", invoke: pending() })),
    (error) => /not an operation that can run as a background task/.test(error.message),
  );
}));

test("submitCall accepts the reserved key c64_memory.wait_until", withEngine(async () => {
  const task = await submitCall(spec({ tool: "c64_memory", op: "wait_until", invoke: pending() }));
  assert.equal(task.state, "working");
  assert.equal(task.op, "wait_until");
}));

test("runWithInlineWindow: a fast result is returned as kind result and the task record is dropped", withEngine(async () => {
  const outcome = await runWithInlineWindow(spec({ invoke: async () => okResult("fast") }), { inlineMs: 1_000 });
  assert.equal(outcome.kind, "result");
  assert.equal(outcome.result.content[0].text, "fast");
  assert.equal(listCallTasks().length, 0);
}));

test("runWithInlineWindow: a slow task is handed over, returned as kind task, and survives a later abort", withEngine(async (fake) => {
  const d = deferred();
  const ac = new AbortController();
  const running = runWithInlineWindow(spec({ requestSignal: ac.signal, invoke: () => d.promise }), { inlineMs: 50 });
  await settle();
  await fake.advance(50);
  const outcome = await running;
  assert.equal(outcome.kind, "task");
  assert.equal(outcome.task.state, "working");
  ac.abort();
  assert.equal(outcome.task.state, "working", "handed-over task ignores the request signal");
  d.resolve(okResult("eventually"));
  await settle();
  assert.equal(outcome.task.state, "completed");
}));

test("inlineWindowMs reads C64BRIDGE_TASK_INLINE_MS and falls back to the default for invalid values", () => {
  assert.equal(inlineWindowMs({ C64BRIDGE_TASK_INLINE_MS: "5" }), 5);
  assert.equal(inlineWindowMs({ C64BRIDGE_TASK_INLINE_MS: "0" }), 0);
  assert.equal(inlineWindowMs({ C64BRIDGE_TASK_INLINE_MS: "600000" }), 600_000);
  assert.equal(inlineWindowMs({}), DEFAULT_INLINE_MS);
  for (const raw of ["-1", "abc", "600001", "1.5", ""]) {
    assert.equal(inlineWindowMs({ C64BRIDGE_TASK_INLINE_MS: raw }), DEFAULT_INLINE_MS, `"${raw}" falls back`);
  }
});

test("runWithInlineWindow rethrows the same error object when the invoke rejects", withEngine(async () => {
  const thrown = new Error("inline failure");
  let caught;
  try {
    await runWithInlineWindow(spec({ invoke: async () => { throw thrown; } }), { inlineMs: 1_000 });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, thrown);
  assert.equal(listCallTasks().length, 0);
}));

test("runWithInlineWindow keepCompleted keeps a completed task and returns kind task", withEngine(async () => {
  const outcome = await runWithInlineWindow(spec({ invoke: async () => okResult("kept") }), { inlineMs: 1_000, keepCompleted: true });
  assert.equal(outcome.kind, "task");
  assert.equal(outcome.task.state, "completed");
  assert.ok(getTask(outcome.task.id), "completed task is still stored");
}));

test("a task is rejected if the active backend changed during lease acquisition", withEngine(async () => {
  let active = "c64u";
  const ctx = baseCtx({ client: {
    getActiveBackendType: async () => {
      const snapshot = active;
      active = "vice";
      return snapshot;
    },
  } });
  await assert.rejects(submitCall(spec({ ctx, invoke: () => assert.fail("stale backend must never run") })), (error) => {
    assert.equal(error.code, "resource_conflict");
    assert.match(error.message, /switch.*c64u.*vice/i);
    return true;
  });
  assert.deepEqual(listLeases(), []);
  assert.deepEqual(listCallTasks(), []);
}));

test("a rejected lease-conflicting restart keeps the previous finished task", withEngine(async () => {
  const previous = await submitCall(spec({ name: "job" }));
  await settle();
  assert.equal(previous.state, "completed");
  await submitCall(spec({ invoke: pending() }));
  await assert.rejects(submitCall(spec({ ...BOUNDED, name: "job" })), { code: "resource_conflict" });
  assert.equal(findByName("job"), previous);
}));
