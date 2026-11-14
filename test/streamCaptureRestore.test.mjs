import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";
import { forgetUserStream, rememberUserStream } from "../src/streamTargets.js";
import { streamingModule } from "../src/tools/streaming.js";

function clientWithStubFacade(events) {
  const client = new C64Client("http://127.0.0.1:1");
  client.facadePromise = Promise.resolve({
    type: "c64u",
    async streamStart(stream, target) { events.push(`start ${stream} ${target}`); return { success: true }; },
    async streamStop(stream) { events.push(`stop ${stream}`); return { success: true }; },
  });
  return client;
}

const isCaptureTarget = (event) => /^start \w+ 127\.0\.0\.1:\d+$/.test(event);

test("frame capture restarts the stream the user started with stream_start", async () => {
  const events = [];
  const client = clientWithStubFacade(events);
  const ctx = { client, logger: { debug() {}, info() {}, warn() {}, error() {} } };
  try {
    await streamingModule.invoke("stream_start", { stream: "video", target: "192.168.1.10:11000" }, ctx);
    events.length = 0;
    await assert.rejects(() => client.captureFrames({ count: 1 }), /Timed out/);
    assert.ok(isCaptureTarget(events[0]), events.join("|"));
    assert.equal(events.at(-1), "start video 192.168.1.10:11000", events.join("|"));
    await streamingModule.invoke("stream_stop", { stream: "video" }, ctx);
    events.length = 0;
    await assert.rejects(() => client.captureFrames({ count: 1 }), /Timed out/);
    assert.equal(events.some((event) => event.includes("192.168.1.10")), false, events.join("|"));
  } finally {
    forgetUserStream("video");
  }
});

test("audio captures of the same stream run one after another", async () => {
  const events = [];
  const client = clientWithStubFacade(events);
  rememberUserStream("audio", "192.168.1.10:11001");
  try {
    const results = await Promise.allSettled([client.captureSamples({ count: 16 }), client.captureSamples({ count: 16 })]);
    assert.equal(results.every((r) => r.status === "rejected"), true);
    // Serialised: start(capture), stop, start(user), then the second capture begins.
    const kinds = events.map((event) => (isCaptureTarget(event) ? "capture" : event.includes("192.168.1.10") ? "user" : "stop"));
    assert.deepEqual(kinds, ["capture", "stop", "user", "capture", "stop", "user"], events.join("|"));
  } finally {
    forgetUserStream("audio");
  }
});

test("capture_samples passes the capture warnings into the result", async () => {
  const { toolRegistry } = await import("../src/tools/registry/index.js");
  const client = {
    async captureSamples() {
      return { backend: "c64u", channels: 2, sampleRateHz: 48000, samplePairs: 1, samples: new Int16Array(2), warnings: ["The audio stream started with c64_stream was restarted toward 1.2.3.4:5 after the capture."] };
    },
  };
  const noop = () => {};
  const ctx = { client, rag: {}, logger: { debug: noop, info: noop, warn: noop, error: noop }, platform: { id: "c64u", features: [], limitedFeatures: [] }, setPlatform: noop };
  const result = await toolRegistry.invoke("c64_sound", { op: "capture_samples", count: 1 }, ctx);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.match(result.structuredContent.data.warnings[0], /restarted toward/);
});
