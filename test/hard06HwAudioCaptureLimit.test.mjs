import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";
import { MAX_AUDIO_CAPTURE_PAIRS } from "../src/streamCapture.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

// Measured on an Ultimate 64 Elite (firmware 3.15a, 2026-11-20, results.md row 27): 65536 pairs are
// 1.37 s of audio at 47982.89 Hz, so a 2 s capture (about 95966 pairs) does not fit in one request.
// It used to be shortened to 65536 pairs without a notice.

test("HW6-27 a capture longer than 65536 sample pairs is refused, naming the maximum, before the stream starts", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  const twoSeconds = Math.ceil(2 * 47_982.8869047619);
  let error;
  try {
    await client.captureSamples({ count: twoSeconds });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error, "expected a rejection");
  assert.match(error.message, /1 to 65536 stereo sample pairs/);
  assert.match(error.message, /1\.37 s/);
  assert.match(error.message, new RegExp(`${twoSeconds} was requested`));
  assert.equal(MAX_AUDIO_CAPTURE_PAIRS, 65536);
});
