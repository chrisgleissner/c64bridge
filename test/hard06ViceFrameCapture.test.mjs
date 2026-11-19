import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";
import { ViceBackend } from "../src/device.js";

// HARD06 VICE-6: a VICE frame is cropped to the inner area VICE reports, so its size does not
// depend on what the screen shows (a black border used to change it). VICE-8: only an empty frame
// is retried; a monitor error is reported at once.

function viceClient(displayGet) {
  const backend = Object.create(ViceBackend.prototype);
  let calls = 0;
  backend.withMonitor = async (fn) => fn({ displayGet: async () => { calls += 1; return displayGet(calls); } });
  Object.defineProperty(backend, "type", { value: "vice" });
  const client = new C64Client("http://127.0.0.1:1");
  client.facadePromise = Promise.resolve(backend);
  return { client, calls: () => calls };
}

/** A 10 x 6 canvas, inner area 4 x 2 at (3, 2); `fill` is the colour of every pixel. */
function snapshot(fill) {
  return { debugWidth: 10, debugHeight: 6, offsetX: 3, offsetY: 2, innerWidth: 4, innerHeight: 2, bitsPerPixel: 8, pixels: new Uint8Array(60).fill(fill) };
}

test("frames of different content have the size of the inner area", async () => {
  for (const fill of [0, 6]) {
    const { client } = viceClient(() => snapshot(fill));
    const { frames, warnings } = await client.captureFrames({ count: 1 });
    assert.equal(frames[0].width, 4);
    assert.equal(frames[0].height, 2);
    assert.equal(warnings, undefined);
  }
});

test("includeBorder returns the whole canvas", async () => {
  const { client } = viceClient(() => snapshot(0));
  const { frames } = await client.captureFrames({ count: 1, includeBorder: true });
  assert.equal(frames[0].width, 10);
  assert.equal(frames[0].height, 6);
});

test("a monitor error is not retried", async () => {
  const { client, calls } = viceClient(() => { throw new Error("VICE session lost: connection reset"); });
  const started = Date.now();
  await assert.rejects(() => client.captureFrames({ count: 1 }), /session lost/);
  assert.equal(calls(), 1);
  assert.ok(Date.now() - started < 500);
});

test("an empty frame is retried until VICE renders one", async () => {
  const { client, calls } = viceClient((call) => (call < 2 ? { ...snapshot(0), pixels: new Uint8Array(0) } : snapshot(1)));
  const { frames } = await client.captureFrames({ count: 1 });
  assert.equal(frames[0].width, 4);
  assert.equal(calls(), 2);
});
