import test from "#test/runner";
import assert from "#test/assert";
import { C64Client, audioCaptureTimeoutMs } from "../src/c64Client.js";

// HARD06 CLIENT-5: the audio capture waits about three times its duration, not 500 ms per
// 192-pair packet (171 s for 65536 pairs), and fails fast when no datagram arrives at all.

test("the capture timeout is three times the duration plus the start allowance", () => {
  assert.equal(audioCaptureTimeoutMs(48_000, 48_000), 4_500);
  assert.ok(audioCaptureTimeoutMs(65_536, 47_940.3408482143) < 6_000);
});

test("a capture whose stream never arrives fails within seconds and names the cause", async () => {
  const events = [];
  const client = new C64Client("http://127.0.0.1:1");
  client.facadePromise = Promise.resolve({
    type: "c64u",
    async streamStart(stream) { events.push(`start ${stream}`); return { success: true }; },
    async streamStop(stream) { events.push(`stop ${stream}`); return { success: true }; },
    async configGet() { return {}; },
  });
  const started = Date.now();
  const outcome = await Promise.race([
    client.captureSamples({ count: 65_536 }).then(() => "resolved", (error) => error),
    new Promise((resolve) => setTimeout(() => resolve("still waiting after 6 s"), 6_000)),
  ]);
  assert.ok(outcome instanceof Error, String(outcome));
  assert.match(outcome.message, /No audio datagram arrived within 1500ms/);
  assert.ok(Date.now() - started < 3_000);
  assert.deepEqual(events, ["start audio", "stop audio"]);
});
