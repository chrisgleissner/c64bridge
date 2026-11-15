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

import { startMockC64Server } from "../scripts/mockC64Server.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const operation of ["start", "stop"]) {
  test(`a user stream ${operation} waits for capture cleanup before changing the target`, async () => {
    const mock = await startMockC64Server();
    const client = new C64Client(mock.baseUrl);
    const entered = deferred();
    const release = deferred();
    try {
      await client.streamStart("video", "127.0.0.1:65530");
      const facade = await client.facadePromise;
      const originalStart = facade.streamStart.bind(facade);
      let intercept = true;
      facade.streamStart = async (...args) => {
        const result = await originalStart(...args);
        if (intercept) {
          intercept = false;
          entered.resolve();
          await release.promise;
        }
        return result;
      };
      const capture = client.captureFrames({ count: 1 });
      await entered.promise;
      let changed = false;
      const change = (operation === "stop"
        ? client.streamStop("video")
        : client.streamStart("video", "127.0.0.1:65531"))
        .then((result) => { changed = true; return result; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(changed, false, "start/stop must not finish while capture owns the stream");
      release.resolve();
      assert.equal((await capture).frames.length, 1);
      assert.equal((await change).success, true);
      assert.equal(mock.state.streams.video.active, operation === "start");
      if (operation === "start") assert.equal(mock.state.streams.video.target, "127.0.0.1:65531");
    } finally {
      release.resolve();
      await client.streamStop("video");
      await mock.close();
      forgetUserStream("video");
    }
  });
}

test("one-shot capture invalidates and recreates a prepared reusable video session", async () => {
  const mock = await startMockC64Server();
  const client = new C64Client(mock.baseUrl);
  try {
    await Promise.all([
      client.prepareVideoCapture({ keepAliveMs: 10_000 }),
      client.prepareVideoCapture({ keepAliveMs: 10_000 }),
    ]);
    assert.equal(mock.state.streamActionLog.filter((event) => event.action === "start").length, 1,
      "concurrent prepares share one session and socket");
    assert.equal((await client.captureFrames({ count: 1 })).frames.length, 1);
    assert.equal((await client.captureFrames({ count: 1, reuseSession: true, keepAliveMs: 10_000 })).frames.length, 1);
    const captures = await Promise.all([
      client.captureFrames({ count: 1, reuseSession: true, keepAliveMs: 10_000 }),
      client.captureFrames({ count: 1 }),
    ]);
    assert.ok(captures.every((capture) => capture.frames.length === 1));
    await client.releaseVideoCapture();
    assert.equal(mock.state.streams.video.active, false);
  } finally {
    await client.releaseVideoCapture();
    await mock.close();
    forgetUserStream("video");
  }
});

test("a failed reusable capture disposes the session and restores the user's stream", async () => {
  const events = [];
  const client = clientWithStubFacade(events);
  try {
    await client.streamStart("video", "192.168.1.10:11000");
    await client.prepareVideoCapture({ keepAliveMs: 10_000 });
    const originalSession = client.c64uVideoCaptureSession;
    assert.ok(originalSession.stopTimer, "the reusable stream initially has a keepalive timer");
    await assert.rejects(() => client.captureFrames({ count: 1, reuseSession: true }), /Timed out/);
    assert.equal(originalSession.closed, true);
    assert.equal(originalSession.stopTimer, null);
    assert.equal(client.c64uVideoCaptureSession, null);
    assert.equal(events.at(-1), "start video 192.168.1.10:11000");
  } finally {
    await client.releaseVideoCapture();
    await client.streamStop("video");
    forgetUserStream("video");
  }
});

test("reusable capture cleanup retains the original collection failure", async () => {
  const events = [];
  const client = clientWithStubFacade(events);
  try {
    await client.prepareVideoCapture({ keepAliveMs: 10_000 });
    client.collectFramesFromC64uVideoCaptureSession = async () => { throw new Error("original collection failure"); };
    const facade = await client.facadePromise;
    facade.streamStop = async () => { throw new Error("cleanup failure"); };
    await assert.rejects(() => client.captureFrames({ count: 1, reuseSession: true }), /original collection failure/);
    assert.equal(client.c64uVideoCaptureSession, null);
  } finally {
    await client.releaseVideoCapture();
    forgetUserStream("video");
  }
});
