import test from "#test/runner";
import assert from "#test/assert";
import { pollUntil } from "../src/monitor/poller.js";

// Fake monotonic clock: only sleep() and read durations advance it. No real waiting happens in these tests.
function harness({ values, readMs = 0, onRead, signal, failAt, sleepRejects = false }) {
  const state = { t: 1000, reads: 0, active: 0, maxActive: 0, sleeps: [], progress: [], readTimes: [] };
  const deps = {
    now: () => state.t,
    async sleep(ms, sig) {
      state.sleeps.push(ms);
      if (sleepRejects && sig?.aborted) throw new Error("aborted");
      state.t += ms;
    },
    async read() {
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      state.reads += 1;
      state.readTimes.push(state.t);
      const index = state.reads - 1;
      if (onRead) onRead(index, state);
      state.t += readMs;
      await Promise.resolve();
      state.active -= 1;
      if (failAt !== undefined && index === failAt) throw new Error("socket closed");
      const value = typeof values === "function" ? values(index) : values[Math.min(index, values.length - 1)];
      return { kind: "bytes", bytes: Uint8Array.of(value) };
    },
    signal,
    onProgress: (done, total, message) => state.progress.push([done, total, message]),
  };
  return { state, deps };
}
const equals = (value) => ({ type: "equals", address: 0xc000, bytes: Uint8Array.of(value) });
const opts = (extra = {}) => ({ pollIntervalMs: 100, timeoutMs: 1000, maxIterations: 1000, backend: "c64u", ...extra });

test("met on the first read: one iteration, no sleep", async () => {
  const { state, deps } = harness({ values: [5] });
  const result = await pollUntil(equals(5), opts(), deps);
  assert.equal(result.met, true);
  assert.equal(result.reason, "condition_met");
  assert.equal(result.iterations, 1);
  assert.deepEqual(state.sleeps, []);
  assert.equal(result.firstObservation.iteration, 1);
  assert.equal(result.lastObservation.iteration, 1);
  assert.equal(result.observed, "$05");
  assert.equal(result.backend, "c64u");
  assert.deepEqual(result.target, { type: "memory", address: "$C000", length: 1 });
  assert.equal(result.error, undefined);
});

test("met after a delay: elapsed, iterations and both observations are reported", async () => {
  const { state, deps } = harness({ values: [0, 0, 0, 7] });
  const result = await pollUntil(equals(7), opts(), deps);
  assert.equal(result.reason, "condition_met");
  assert.equal(result.iterations, 4);
  assert.equal(result.elapsedMs, 300);
  assert.equal(result.firstObservation.value, "$00");
  assert.equal(result.lastObservation.value, "$07");
  assert.equal(result.lastObservation.elapsedMs, 300);
  assert.deepEqual(state.sleeps, [100, 100, 100]);
  assert.equal(result.expected, "equals $07");
});

test("never matching ends with a timeout and met false; the final sleep is shortened to the deadline", async () => {
  const { state, deps } = harness({ values: [0] });
  const result = await pollUntil(equals(1), opts({ pollIntervalMs: 300, timeoutMs: 1000 }), deps);
  assert.equal(result.met, false);
  assert.equal(result.reason, "timeout");
  assert.equal(result.elapsedMs, 1000);
  assert.deepEqual(state.sleeps, [300, 300, 300, 100]);
  assert.equal(result.iterations, 5, "a last read happens at the deadline");
  assert.equal(result.observed, "$00");
});

test("timeoutMs of 1 still makes one read", async () => {
  const { deps } = harness({ values: [0] });
  const result = await pollUntil(equals(1), opts({ timeoutMs: 1, pollIntervalMs: 50 }), deps);
  assert.equal(result.reason, "timeout");
  assert.ok(result.iterations >= 1);
});

test("a slow read that exceeds the timeout ends with a timeout without another sleep", async () => {
  const { state, deps } = harness({ values: [0], readMs: 2000 });
  const result = await pollUntil(equals(1), opts({ timeoutMs: 1000 }), deps);
  assert.equal(result.reason, "timeout");
  assert.equal(result.iterations, 1);
  assert.deepEqual(state.sleeps, []);
  assert.equal(result.elapsedMs, 2000);
});

test("maxIterations ends the wait with max_iterations before the timeout", async () => {
  const { state, deps } = harness({ values: [0] });
  const result = await pollUntil(equals(1), opts({ maxIterations: 3, timeoutMs: 100000 }), deps);
  assert.equal(result.met, false);
  assert.equal(result.reason, "max_iterations");
  assert.equal(result.iterations, 3);
  assert.equal(state.reads, 3);
  assert.equal(state.sleeps.length, 2, "no sleep after the last allowed read");
});

test("maxIterations of 1 reads exactly once", async () => {
  const { state, deps } = harness({ values: [0] });
  const result = await pollUntil(equals(1), opts({ maxIterations: 1 }), deps);
  assert.equal(result.reason, "max_iterations");
  assert.equal(state.reads, 1);
});

test("the condition met on the last allowed iteration wins over max_iterations", async () => {
  const { deps } = harness({ values: [0, 0, 1] });
  const result = await pollUntil(equals(1), opts({ maxIterations: 3 }), deps);
  assert.equal(result.reason, "condition_met");
});

test("a read error is a communication failure, not a timeout, and carries the fields collected so far", async () => {
  const { state, deps } = harness({ values: [0], failAt: 2 });
  const result = await pollUntil(equals(1), opts(), deps);
  assert.equal(result.met, false);
  assert.equal(result.reason, "communication_failure");
  assert.equal(result.error, "socket closed");
  assert.equal(result.iterations, 2, "only completed reads count");
  assert.equal(result.firstObservation.value, "$00");
  assert.equal(result.lastObservation.iteration, 2);
  assert.equal(state.reads, 3, "no retry after the failure");
  assert.equal(result.backend, "c64u");
});

test("a failure on the very first read carries no observations", async () => {
  const { deps } = harness({ values: [0], failAt: 0 });
  const result = await pollUntil(equals(1), opts(), deps);
  assert.equal(result.reason, "communication_failure");
  assert.equal(result.iterations, 0);
  assert.equal(result.observed, null);
  assert.equal(result.firstObservation, null);
  assert.equal(result.lastObservation, null);
  assert.equal(result.expected, "equals $01");
});

test("a non-Error rejection is reported as text", async () => {
  const { deps } = harness({ values: [0] });
  deps.read = async () => { throw "boom"; };
  const result = await pollUntil(equals(1), opts(), deps);
  assert.equal(result.reason, "communication_failure");
  assert.equal(result.error, "boom");
});

test("a signal that is already aborted reads nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const { state, deps } = harness({ values: [0], signal: controller.signal });
  const result = await pollUntil(equals(1), opts(), deps);
  assert.equal(result.reason, "cancelled");
  assert.equal(result.met, false);
  assert.equal(state.reads, 0);
  assert.equal(result.iterations, 0);
});

test("an abort during the sleep cancels before the next read", async () => {
  const controller = new AbortController();
  const { state, deps } = harness({ values: [0], signal: controller.signal });
  const baseSleep = deps.sleep;
  deps.sleep = async (ms, sig) => { await baseSleep(ms, sig); if (state.sleeps.length === 2) controller.abort(); };
  const result = await pollUntil(equals(1), opts(), deps);
  assert.equal(result.reason, "cancelled");
  assert.equal(state.reads, 2, "no read after the abort that happened during the second sleep");
  assert.equal(result.iterations, 2);
  assert.equal(result.lastObservation.iteration, 2);
});

test("an abort while a read is in flight cancels at once and the late read result is ignored", async () => {
  const controller = new AbortController();
  const { state, deps } = harness({ values: [1], signal: controller.signal });
  let release;
  deps.read = () => new Promise((resolve) => { release = () => resolve({ kind: "bytes", bytes: Uint8Array.of(1) }); });
  const pending = pollUntil(equals(1), opts(), deps);
  await Promise.resolve();
  controller.abort();
  const result = await pending;
  release();
  assert.equal(result.reason, "cancelled");
  assert.equal(result.met, false, "a read finishing after the abort does not make the wait succeed");
  assert.equal(result.iterations, 0);
  assert.equal(state.sleeps.length, 0);
});

test("a read that rejects after the abort is a cancellation, not a communication failure", async () => {
  const controller = new AbortController();
  const { deps } = harness({ values: [0], signal: controller.signal });
  deps.read = async () => { controller.abort(); throw new Error("aborted socket"); };
  const result = await pollUntil(equals(1), opts(), deps);
  assert.equal(result.reason, "cancelled");
  assert.equal(result.error, undefined);
});

test("a sleep that rejects on abort is treated as a cancellation", async () => {
  const controller = new AbortController();
  const { state, deps } = harness({ values: [0], signal: controller.signal, sleepRejects: true, onRead: (index) => { if (index === 1) controller.abort(); } });
  const result = await pollUntil(equals(1), opts(), deps);
  assert.equal(result.reason, "cancelled");
  assert.equal(state.reads, 2);
});

test("iterations never overlap and the next read starts only after the previous read and the interval", async () => {
  const { state, deps } = harness({ values: [0], readMs: 250 });
  const result = await pollUntil(equals(1), opts({ pollIntervalMs: 100, timeoutMs: 2000 }), deps);
  assert.equal(state.maxActive, 1);
  for (let i = 1; i < state.readTimes.length; i += 1) {
    assert.ok(state.readTimes[i] - state.readTimes[i - 1] >= 350 - 1e-9, `gap ${state.readTimes[i] - state.readTimes[i - 1]} must cover read plus interval`);
  }
  assert.equal(result.reason, "timeout");
});

test("changed uses the first observation as the snapshot", async () => {
  const { deps } = harness({ values: [9, 9, 9, 4] });
  const result = await pollUntil({ type: "changed", address: 0xc000, length: 1 }, opts(), deps);
  assert.equal(result.reason, "condition_met");
  assert.equal(result.iterations, 4);
  assert.equal(result.firstObservation.value, "$09");
  assert.match(result.expected, /\$09/);
});

test("screen conditions read the screen target and report text observations", async () => {
  const texts = ["LOADING", "LOADING", "READY."];
  let i = 0;
  const deps = { now: () => 0, sleep: async () => {}, read: async (target) => { assert.deepEqual(target, { kind: "screen" }); return { kind: "screen", text: texts[Math.min(i++, 2)] }; } };
  const result = await pollUntil({ type: "screen_text", text: "ready.", present: true, caseInsensitive: true }, opts(), deps);
  assert.equal(result.reason, "condition_met");
  assert.deepEqual(result.target, { type: "screen" });
  assert.equal(result.observed, "READY.");
  assert.equal(result.firstObservation.value, "LOADING");
});

test("checkpoint target is passed to the reader and hits are observed", async () => {
  let calls = 0;
  const deps = { now: () => 0, sleep: async () => {}, read: async (target) => { assert.deepEqual(target, { kind: "checkpoint", address: 0x810, access: "exec" }); calls += 1; return { kind: "hits", count: calls - 1 }; } };
  const result = await pollUntil({ type: "checkpoint", address: 0x810, kind: "exec" }, opts(), deps);
  assert.equal(result.reason, "condition_met");
  assert.equal(result.observed, 1);
});

test("progress is reported after every unmet iteration with the iteration cap as total", async () => {
  const { state, deps } = harness({ values: [0, 0, 1] });
  await pollUntil(equals(1), opts({ maxIterations: 50 }), deps);
  assert.deepEqual(state.progress.map(([done, total]) => [done, total]), [[1, 50], [2, 50]]);
  assert.match(state.progress[0][2], /iteration 1/);
});

test("without onProgress and signal the loop still works", async () => {
  const { deps } = harness({ values: [0, 1] });
  delete deps.onProgress;
  delete deps.signal;
  const result = await pollUntil(equals(1), opts(), deps);
  assert.equal(result.reason, "condition_met");
});
