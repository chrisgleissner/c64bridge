import test from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import { C64Client, KeyboardQueueDrainTimeoutError } from "../src/c64Client.js";

// HARD06 CLIENT-2: the generic (Ultimate) keyboard injection never overwrites bytes still in the
// KERNAL queue, and concurrent injections run one after another. CLIENT-8: the VICE drain timeout
// names the timeout actually used and counts queued bytes as delivered.

/** Memory model: the KERNAL takes one byte from the queue every 2 ms while `running`; each request takes 2 ms, one at a time. */
function machine() {
  const mem = new Uint8Array(65536);
  const state = { running: true, typed: [] };
  const timer = setInterval(() => {
    if (state.running && mem[0xc6] > 0) {
      state.typed.push(mem[0x277]);
      mem.copyWithin(0x277, 0x278, 0x281);
      mem[0xc6] -= 1;
    }
  }, 2);
  let chain = Promise.resolve();
  const serial = (fn) => {
    const next = chain.then(() => new Promise((resolve) => setTimeout(() => resolve(fn()), 2)));
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
  const facade = {
    type: "c64u",
    readMemory: (address, length) => serial(() => mem.slice(address, address + length)),
    writeMemory: (address, bytes) => serial(() => { mem.set(bytes, address); }),
  };
  const client = new C64Client("http://127.0.0.1:1", { forceC64uFacade: true });
  Reflect.set(client, "facadePromise", Promise.resolve(facade));
  return { client, state, typed: () => Buffer.from(state.typed).toString("latin1"), stop: () => clearInterval(timer) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

test("retrying the remaining input after a drain timeout types every byte once", async () => {
  const m = machine();
  try {
    m.state.running = false;
    const text = Buffer.from('LOAD"GAME",8,1\r', "latin1");
    const error = await m.client.injectKeyboardQueue(text, { drainTimeoutMs: 60 }).catch((e) => e);
    assert.ok(error instanceof KeyboardQueueDrainTimeoutError);
    assert.equal(error.delivered, 10);
    assert.equal(error.pending, 10);
    m.state.running = true;
    await m.client.injectKeyboardQueue(text.subarray(error.delivered), { drainTimeoutMs: 1_000 });
    await settle();
    assert.equal(m.typed(), text.toString("latin1"));
  } finally {
    m.stop();
  }
});

test("bytes already in the queue are not overwritten", async () => {
  const m = machine();
  try {
    m.state.running = false;
    await m.client.injectKeyboardQueue(Buffer.from("AB"), { drainTimeoutMs: 30 }).catch(() => undefined);
    const error = await m.client.injectKeyboardQueue(Buffer.from("CD"), { drainTimeoutMs: 30 }).catch((e) => e);
    assert.ok(error instanceof KeyboardQueueDrainTimeoutError);
    assert.equal(error.delivered, 0);
    assert.match(error.message, /still holds 2 byte\(s\) from earlier input/);
    m.state.running = true;
    await settle();
    assert.equal(m.typed(), "AB");
  } finally {
    m.stop();
  }
});

test("two concurrent injections are typed one after the other", async () => {
  const m = machine();
  try {
    const [first, second] = await Promise.all([
      m.client.injectKeyboardQueue(Buffer.from("PRINT 1\r")),
      m.client.injectKeyboardQueue(Buffer.from("LIST\r")),
    ]);
    await settle();
    assert.equal(first.delivered, 8);
    assert.equal(second.delivered, 5);
    assert.equal(m.typed(), "PRINT 1\rLIST\r");
  } finally {
    m.stop();
  }
});

test("a VICE drain timeout names the timeout used and counts queued bytes as delivered", async () => {
  const seen = [];
  const client = new C64Client("http://127.0.0.1:1", { forceC64uFacade: true });
  Reflect.set(client, "facadePromise", Promise.resolve({
    type: "vice",
    async feedKeyboard(bytes, options) {
      seen.push(options?.drainTimeoutMs);
      return { delivered: bytes.length, status: "timeout", pending: 7 };
    },
  }));
  const error = await client.injectKeyboardQueue(Buffer.alloc(40, 0x41)).catch((e) => e);
  assert.ok(error instanceof KeyboardQueueDrainTimeoutError);
  assert.deepEqual(seen, [6_000]);
  assert.equal(error.timeoutMs, 6_000);
  assert.equal(error.delivered, 40);
  assert.match(error.message, /after 6000ms; delivered 40 of 40 byte\(s\)\. 7 of them are still queued/);
});
