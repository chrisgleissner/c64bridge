import test from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import { C64Client } from "../src/c64Client.js";

process.env.C64_TEST_TARGET = process.env.C64_TEST_TARGET ?? "stub";

function createTrackingFacade({ ndxRef = { value: 0 }, autoDrain = true } = {}) {
  const writes = [];
  const reads = [];
  return {
    type: "c64u",
    async ping() { return true; },
    async readMemory(address, length) {
      reads.push({ address, length });
      if (address === 0x00C6 && length === 1) {
        // Return current pending count, optionally auto-draining to mimic
        // KERNAL consuming the queue.
        const value = ndxRef.value;
        if (autoDrain) ndxRef.value = 0;
        return Uint8Array.of(value);
      }
      return new Uint8Array(length);
    },
    async writeMemory(address, bytes) {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      writes.push({ address, bytes: Uint8Array.from(buf) });
      if (address === 0x00C6) {
        ndxRef.value = buf[0] ?? 0;
      }
    },
    writes,
    reads,
  };
}

function makeClient(facade) {
  // forceC64uFacade=true avoids the dual-facade discovery that would later
  // overwrite our injected facadePromise.
  const client = new C64Client("http://stub.local", { forceC64uFacade: true });
  Reflect.set(client, "facadePromise", Promise.resolve(facade));
  return client;
}

test("injectKeyboardQueue writes bytes to $0277 and length to $00C6", async () => {
  const facade = createTrackingFacade();
  const client = makeClient(facade);
  await client.injectKeyboardQueue(Uint8Array.of(0x48, 0x49, 13)); // HI<CR>

  // Look for the keyboard buffer write at $0277, then a separate length byte at $00C6
  const queueWrite = facade.writes.find((w) => w.address === 0x0277);
  const ndxWrite = facade.writes.find((w) => w.address === 0x00C6);
  assert.ok(queueWrite, "must write to KERNAL keyboard buffer at $0277");
  assert.deepEqual(Array.from(queueWrite.bytes), [0x48, 0x49, 13]);
  assert.ok(ndxWrite, "must write pending count to $00C6");
  assert.equal(ndxWrite.bytes[0], 3, "NDX should equal queued byte count");
});

test("injectKeyboardQueue chunks long input to fit the 10-byte buffer", async () => {
  const facade = createTrackingFacade();
  const client = makeClient(facade);

  // 25 bytes -> 3 chunks of 10/10/5
  const text = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXY");
  await client.injectKeyboardQueue(text);

  const queueWrites = facade.writes.filter((w) => w.address === 0x0277);
  const ndxWrites = facade.writes.filter((w) => w.address === 0x00C6);
  assert.equal(queueWrites.length, 3, "should split into three chunks");
  assert.equal(ndxWrites.length, 3, "each chunk must write a fresh NDX");
  assert.equal(queueWrites[0].bytes.length, 10);
  assert.equal(queueWrites[1].bytes.length, 10);
  assert.equal(queueWrites[2].bytes.length, 5);
  assert.equal(ndxWrites[2].bytes[0], 5, "final chunk length matches");
});

test("injectKeyboardQueue is a no-op for empty input", async () => {
  const facade = createTrackingFacade();
  const client = makeClient(facade);
  await client.injectKeyboardQueue(new Uint8Array(0));
  assert.equal(facade.writes.length, 0);
});

test("injectKeyboardQueue accepts numeric arrays and Buffers", async () => {
  const facade = createTrackingFacade();
  const client = makeClient(facade);
  await client.injectKeyboardQueue([0x41, 0x42]);
  await client.injectKeyboardQueue(Buffer.from([0x43]));
  const queueWrites = facade.writes.filter((w) => w.address === 0x0277);
  assert.equal(queueWrites.length, 2);
  assert.deepEqual(Array.from(queueWrites[0].bytes), [0x41, 0x42]);
  assert.deepEqual(Array.from(queueWrites[1].bytes), [0x43]);
});

test("HARD01-009 injectKeyboardQueue reports a drain timeout without overwriting input", async () => {
  // Force NDX never to clear so the helper has to bail out on its own timeout.
  const facade = createTrackingFacade({ ndxRef: { value: 1 }, autoDrain: false });
  // Override readMemory to always return non-zero
  facade.readMemory = async () => Uint8Array.of(1);
  const client = makeClient(facade);

  const start = Date.now();
  await assert.rejects(() => client.injectKeyboardQueue(Uint8Array.of(0x41, 0x42), {
    drainPollMs: 5,
    drainTimeoutMs: 60,
  }), /did not drain/);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 50, `expected drain wait to elapse, got ${elapsed}ms`);
  // The first chunk was queued, but no later chunk can overwrite it.
  assert.ok(facade.writes.find((w) => w.address === 0x0277));
});

test("HARD01-004 a transient machine:input probe failure does not permanently cache 'unknown'", async () => {
  let calls = 0;
  const facade = {
    ...createTrackingFacade(),
    async getInputState() {
      calls += 1;
      if (calls === 1) {
        throw new Error("ECONNRESET");
      }
      return { keyboard: { inputs: [] }, joysticks: [] };
    },
  };
  const client = makeClient(facade);

  const first = await client.getNativeEndpointCapabilities();
  assert.equal(first.machineInput, "unknown");

  // A transient network error must not be baked into the cache: the very
  // next read should retry rather than returning the stale "unknown".
  const second = await client.getNativeEndpointCapabilities();
  assert.equal(second.machineInput, "available");
  assert.equal(calls, 2, "expected the probe to run again after an unknown result");

  // And once a confirmed result exists, it stays cached (no further probes).
  const third = await client.getNativeEndpointCapabilities();
  assert.equal(third.machineInput, "available");
  assert.equal(calls, 2, "a confirmed result must not be re-probed");
});

test("writeMemoryRaw delegates to facade.writeMemory", async () => {
  const facade = createTrackingFacade();
  const client = makeClient(facade);
  await client.writeMemoryRaw(0x4000, Uint8Array.of(0xDE, 0xAD));
  const write = facade.writes.find((w) => w.address === 0x4000);
  assert.ok(write);
  assert.deepEqual(Array.from(write.bytes), [0xDE, 0xAD]);
});

test("HARD01-002 powerCycle fails closed when menu highlight cannot be verified", async () => {
  const inputs = [];
  const screens = [
    Buffer.from("MAIN MENU"),
    Buffer.from("TOOL MENU"),
    Buffer.from("TOOL MENU  POWER CYCLE"),
    Buffer.from("TOOL MENU  POWER CYCLE  1"),
    Buffer.from("TOOL MENU  POWER CYCLE  2"),
    Buffer.from("TOOL MENU  POWER CYCLE  3"),
    Buffer.from("TOOL MENU  POWER CYCLE  4"),
  ];
  const facade = {
    ...createTrackingFacade(),
    async menuButton() { return { success: true }; },
    async getInputState() { return { keyboard: { inputs: [] }, joysticks: [] }; },
    async readMenuScreen() { return Uint8Array.from(screens.shift()); },
    async sendInputEvents(batch) { inputs.push(batch); return { keyboard: { inputs: [] }, joysticks: [] }; },
  };
  const client = makeClient(facade);
  const result = await client.powerCycle();

  assert.equal(result.success, false);
  assert.deepEqual(inputs.map(({ events }) => events[0].inputs), [
    ["f1"], ["return"], ["cursor_up_down"], ["cursor_up_down"], ["cursor_up_down"], ["cursor_up_down"],
  ]);
  assert.ok(result.details.cleanup);
});

test("HARD01-003 powerCycle attempts a best-effort menu close after a mid-flow failure, but not before the menu opened", async () => {
  const menuButtonCalls = [];
  const screens = [
    Buffer.from("MAIN MENU"),
    Buffer.from("TOOL MENU"),
    Buffer.from("TOOL MENU  POWER CYCLE"),
    Buffer.from("TOOL MENU  POWER CYCLE  1"),
    Buffer.from("TOOL MENU  POWER CYCLE  2"),
    Buffer.from("TOOL MENU  POWER CYCLE  3"),
    Buffer.from("TOOL MENU  POWER CYCLE  4"),
  ];
  const facade = {
    ...createTrackingFacade(),
    async menuButton() { menuButtonCalls.push(Date.now()); return { success: true }; },
    async getInputState() { return { keyboard: { inputs: [] }, joysticks: [] }; },
    async readMenuScreen() { return Uint8Array.from(screens.shift()); },
    async sendInputEvents(batch) { return { keyboard: { inputs: [] }, joysticks: [] }; },
  };
  const client = makeClient(facade);
  const result = await client.powerCycle();

  assert.equal(result.success, false);
  // menuButton is called once to open the menu and once more, on failure, to
  // attempt a best-effort close.
  assert.equal(menuButtonCalls.length, 2, "expected the initial open call plus one cleanup call");
  assert.equal(result.details.cleanup.success, true);
});

test("HARD01-003 powerCycle does not attempt cleanup when the menu was never opened", async () => {
  const menuButtonCalls = [];
  const facade = {
    ...createTrackingFacade(),
    async menuButton() { menuButtonCalls.push(1); throw new Error("menu open failed"); },
    async getInputState() { return { keyboard: { inputs: [] }, joysticks: [] }; },
    async readMenuScreen() { return Uint8Array.from(Buffer.from("MAIN MENU")); },
    async sendInputEvents(batch) { return { keyboard: { inputs: [] }, joysticks: [] }; },
  };
  const client = makeClient(facade);
  const result = await client.powerCycle();

  assert.equal(result.success, false);
  // The single menuButton call above is the (failing) attempt to open the
  // menu itself, not a cleanup call: since opening never succeeded, no
  // separate close attempt should be issued.
  assert.equal(menuButtonCalls.length, 1, "expected only the failed open attempt, no cleanup call");
  assert.equal(result.details.cleanup.details, "menu cleanup was not attempted");
});

test("powerCycle uses reboot for U2-family cartridges", async () => {
  const facade = {
    ...createTrackingFacade(),
    type: "u2",
    async reboot() { return { success: true, details: { rebooted: true } }; },
  };
  const client = makeClient(facade);
  const result = await client.powerCycle();
  assert.equal(result.success, true);
  assert.equal(result.details.strategy, "reboot");
});
