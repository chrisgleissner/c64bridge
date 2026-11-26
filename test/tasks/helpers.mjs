// Shared helpers for the task engine tests: a fake clock with controllable timers and deferred promises.
export function createFakeClock(start = 1_000_000) {
  let now = start;
  let nextHandle = 1;
  const timers = new Map();
  const clock = {
    now: () => now,
    monotonicNow: () => now,
    setTimeout(callback, ms) {
      const handle = { id: nextHandle++, unref() { handle.unrefd = true; }, unrefd: false };
      timers.set(handle.id, { handle, at: now + Math.max(0, ms), callback });
      return handle;
    },
    clearTimeout(handle) {
      if (handle) timers.delete(handle.id);
    },
  };
  return {
    clock,
    /** Number of timers still pending. */
    pending: () => timers.size,
    /** True when every pending timer was unref'd. */
    allUnref: () => [...timers.values()].every((timer) => timer.handle.unrefd),
    /** Moves time forward and fires due timers in order; microtasks settle between timers. */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.values()].filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.handle.id - b.handle.id)[0];
        if (!due) break;
        timers.delete(due.handle.id);
        now = Math.max(now, due.at);
        due.callback();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

/** Lets promise continuations run (no timers involved). */
export async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function okResult(text = "ok") {
  return { content: [{ type: "text", text }], structuredContent: { type: "json", data: { text } }, metadata: { success: true } };
}

export function errorResult(text = "failed") {
  return { content: [{ type: "text", text }], metadata: { success: false }, isError: true };
}

export function baseCtx(overrides = {}) {
  return {
    client: { getActiveBackendType: async () => "c64u" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
}
