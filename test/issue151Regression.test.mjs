import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { C64Client } from "../src/c64Client.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";
import { registerHarnessSuite, withSharedMcpClient } from "./helpers/mcpTestHarness.mjs";

const c64u = (process.env.C64_MODE ?? "c64u") === "c64u";
const c64Test = c64u ? test : test.skip;
if (c64u) registerHarnessSuite("issue-151-regressions");

function signal(overrides = {}) {
  return { frequency: 440, sampleRate: 47982.8869047619, amplitude: 4000, leftOffset: 26900, rightOffset: 20000, rightGain: 1, ...overrides };
}

async function call(client, name, args) {
  return client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema);
}

c64Test("issue #151: public MCP analysis uses streamed PCM and removes both reported idle offsets", async () => {
  await withSharedMcpClient(async ({ client, mockServer }) => {
    for (const offsets of [[26900, 20000], [7500, 5500]]) {
      mockServer.state.audioSignal = signal({ amplitude: 0, leftOffset: offsets[0], rightOffset: offsets[1] });
      const result = await call(client, "c64_sound", { op: "record_analyze", durationSeconds: 0.5 });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const analysis = JSON.parse(result.content[0].text).analysis;
      assert.equal(analysis.source, "ultimate-stream");
      assert.ok(analysis.global_metrics.max_rms < 0.001);
      assert.ok(analysis.voices[0].detected_notes.every((n) => n.note === null));
      assert.equal(mockServer.state.streams.audio.active, false);
    }

    for (const rightGain of [1, -1, 0]) {
      mockServer.state.audioSignal = signal({ rightGain });
      mockServer.state.streamHostResolveFailures = 1;
      const result = await call(client, "c64_sound", { op: "record_analyze", durationSeconds: 0.5 });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const analysis = JSON.parse(result.content[0].text).analysis;
      assert.equal(analysis.source, "ultimate-stream");
      assert.ok(Math.abs(analysis.durationSeconds - 0.5) < 0.001);
      assert.ok(Math.abs(analysis.global_metrics.average_rms - 4000 / 32768 / Math.SQRT2) < 0.002);
      const note = analysis.voices[0].detected_notes.find((n) => n.note);
      assert.equal(note?.note, "A4");
      assert.ok(Math.abs(note.frequency - 440) < 0.5);
      assert.equal(mockServer.state.streams.audio.active, false);
    }
  });
});

c64Test("issue #151: public MCP silence verification distinguishes offset-only idle from opposite-phase residual audio", async () => {
  await withSharedMcpClient(async ({ client, mockServer }) => {
    mockServer.state.audioSignal = signal({ amplitude: 0 });
    const idle = await call(client, "c64_sound", { op: "silence_all", verify: true });
    assert.equal(idle.isError, undefined, JSON.stringify(idle));
    assert.equal(idle.metadata.verification.silent, true);
    assert.equal(idle.metadata.verification.analysis.analysis.source, "ultimate-stream");

    mockServer.state.audioSignal = signal({ rightGain: -1 });
    const residual = await call(client, "c64_sound", { op: "silence_all", verify: true });
    assert.equal(residual.isError, true);
    assert.match(residual.content[0].text, /residual audio/);
    assert.equal(mockServer.state.streams.audio.active, false);
  });
});

c64Test("issue #151: public sample/video capture and stream start recover from firmware 404 and retain terminal reasons", async () => {
  await withSharedMcpClient(async ({ client, mockServer }) => {
    for (const [name, args, stream] of [
      ["c64_sound", { op: "capture_samples", count: 256 }, "audio"],
      ["c64_graphics", { op: "capture_frame" }, "video"],
      ["c64_stream", { op: "start", stream: "audio", target: "127.0.0.1:19999" }, "audio"],
    ]) {
      const before = mockServer.state.streamActionLog.length;
      mockServer.state.streamHostResolveFailures = 1;
      const result = await call(client, name, args);
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const starts = mockServer.state.streamActionLog.slice(before).filter((e) => e.action.startsWith("start"));
      assert.deepEqual(starts.map((e) => e.action), ["start-rejected", "start"]);
      assert.equal(starts[0].target, starts[1].target);
      await call(client, "c64_stream", { op: "stop", stream });
      assert.equal(mockServer.state.streams[stream].active, false);
    }
    for (const target of ["127.0.0.1:19999", "192.0.2.77:19999"]) {
      mockServer.state.streamNeighborReady = false;
      const before = mockServer.state.streamActionLog.length;
      const failure = await call(client, "c64_stream", { op: "start", stream: "audio", target });
      assert.equal(failure.isError, true);
      assert.match(failure.content[0].text, /Network Host Resolve Error/);
      const attempts = mockServer.state.streamActionLog.slice(before).filter((e) => e.action === "start-rejected");
      assert.equal(attempts.length, target.startsWith("127.") ? 2 : 1);
    }
  });
});

c64Test("public Ultimate capture and pitch analysis use the clock rate of every firmware System Mode", async () => {
  await withSharedMcpClient(async ({ client, mockServer }) => {
    for (const [mode, sampleRate] of [
      ["PAL", 47982.8869047619], ["NTSC", 47940.3408482143],
      ["PAL-60", 47940.3408482143], ["PAL-60/L", 47940.3408482143],
      ["NTSC-50", 47982.8869047619], ["NTSC-50/L", 47982.8869047619],
    ]) {
      mockServer.state.configs["U64 Specific Settings"]["System Mode"] = mode;
      // The obsolete Video/Mode intentionally disagrees with the real firmware setting.
      mockServer.state.configs.Video.Mode = mode === "PAL" ? "NTSC" : "PAL";
      mockServer.state.audioSignal = signal({ sampleRate, frequency: 523.25 });
      const capture = await call(client, "c64_sound", { op: "capture_samples", count: 256 });
      assert.equal(capture.isError, undefined);
      assert.equal(capture.metadata.sampleRateHz, sampleRate);
      const recorded = await call(client, "c64_sound", { op: "record_analyze", durationSeconds: 0.5 });
      assert.equal(recorded.isError, undefined, JSON.stringify(recorded));
      const analysis = JSON.parse(recorded.content[0].text).analysis;
      assert.ok(Math.abs(analysis.durationSeconds - 0.5) < 0.001);
      const note = analysis.voices[0].detected_notes.find((n) => n.note);
      assert.equal(note?.note, "C5");
      assert.ok(Math.abs(note.frequency - 523.25) < 0.5);
    }
  });
});

c64Test("public analysis keeps the measured pitch and level of a partial UDP capture, but rejects insufficient audio", async () => {
  await withSharedMcpClient(async ({ client, mockServer }) => {
    mockServer.state.audioSignal = signal();
    mockServer.state.audioPacketLimit = 40;
    const partial = await call(client, "c64_sound", { op: "record_analyze", durationSeconds: 0.5 });
    assert.equal(partial.isError, undefined, JSON.stringify(partial));
    const analysis = JSON.parse(partial.content[0].text).analysis;
    assert.ok(Math.abs(analysis.durationSeconds - 40 * 192 / signal().sampleRate) < 0.0001);
    assert.ok(Math.abs(analysis.global_metrics.average_rms - 4000 / 32768 / Math.SQRT2) < 0.002);
    assert.equal(analysis.voices[0].detected_notes.find((n) => n.note)?.note, "A4");
    assert.equal(mockServer.state.streams.audio.active, false);
    mockServer.state.audioPacketLimit = 10; // 1920 frames, just below the 2048-frame analysis window.
    const insufficient = await call(client, "c64_sound", { op: "record_analyze", durationSeconds: 0.5 });
    assert.equal(insufficient.isError, true);
    assert.match(insufficient.content[0].text, /Timed out/);
    assert.equal(mockServer.state.streams.audio.active, false);
  });
});

c64Test("issue #151: real ping subprocess primes a persistent neighbor gate for audio and both video capture paths", async () => {
  if (process.platform === "win32") return;
  const mock = await startMockC64Server();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue151-ping-"));
  const marker = path.join(dir, "primed");
  const argumentsPath = path.join(dir, "arguments");
  fs.writeFileSync(path.join(dir, "ping"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsPath}'\nprintf primed > '${marker}'\n`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    const client = new C64Client(mock.baseUrl);
    mock.state.streamNeighborReady = () => fs.existsSync(marker);
    for (const capture of [
      () => client.captureSamples({ count: 256 }),
      () => client.captureFrames({ count: 1 }),
      () => client.captureFrames({ count: 1, reuseSession: true }),
      () => client.streamStart("audio", "127.0.0.1:19999"),
    ]) {
      fs.rmSync(marker, { force: true });
      const before = mock.state.streamActionLog.length;
      const result = await capture();
      assert.notEqual(result.success, false);
      assert.equal(fs.readFileSync(argumentsPath, "utf8").trim().split("\n").at(-1), "127.0.0.1");
      const starts = mock.state.streamActionLog.slice(before).filter((e) => e.action.startsWith("start"));
      assert.deepEqual(starts.map((e) => e.action), ["start-rejected", "start"]);
      assert.equal(starts[0].target, starts[1].target);
      await client.releaseVideoCapture();
      await client.streamStop("audio");
    }
  } finally {
    process.env.PATH = originalPath;
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

c64Test("audio capture retains UDP packets sent before the HTTP start response", async () => {
  const mock = await startMockC64Server();
  try {
    mock.state.audioPacketLimit = 2;
    mock.state.streamStartResponseDelayMs = 50;
    const result = await new C64Client(mock.baseUrl).captureSamples({ count: 256 });
    assert.equal(result.samplePairs, 256);
    assert.equal(mock.state.streams.audio.active, false);
  } finally {
    await mock.close();
  }
});

c64Test("Ultimate analysis rejects invalid durations before accessing the backend", async () => {
  const client = new C64Client("http://127.0.0.1");
  client.facadePromise = Promise.resolve({ type: "c64u", configGet() { throw new Error("backend accessed"); } });
  for (const durationSeconds of ["invalid", NaN, Infinity, -Infinity]) {
    await assert.rejects(() => client.recordAndAnalyzeAudio({ durationSeconds }), /durationSeconds must be a/);
  }
});

c64Test("audio capture preserves the primary failure when stopping the stream also fails", async () => {
  const mock = await startMockC64Server();
  try {
    const client = new C64Client(mock.baseUrl);
    const facade = await client.facadePromise;
    facade.streamStart = async () => { throw new Error("primary start failure"); };
    facade.streamStop = async () => { throw new Error("cleanup failure"); };
    await assert.rejects(() => client.captureSamples({ count: 256 }), /primary start failure/);
  } finally {
    await mock.close();
  }
});
