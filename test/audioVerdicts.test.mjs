import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { analyzePcmForTest } from "../src/audio/record_and_analyze_audio.js";
import { createLogger } from "./meta/helpers.mjs";

const SCORE = `song: { title: Verdict Test, mode: PAL, tempo: 120 }
voices:
  - id: 1
    waveform: triangle
    patterns:
      main: { notes: [C4, E4, G4] }
timeline:
  - { bars: 1, layers: { v1: main } }
`;

function context(platform, client) {
  return { client, platform: { id: platform, features: [], limitedFeatures: [] }, rag: {}, logger: createLogger(), setPlatform() {} };
}

async function silentAnalysis() {
  return analyzePcmForTest(new Float32Array(44100 * 2), 44100);
}

function playbackClient(platform, recordAndAnalyzeAudio) {
  return {
    async getActiveBackendType() { return platform; },
    getAvailableBackends() { return [platform]; },
    switchBackend() {},
    async sidSilenceAll() { return { success: true }; },
    async runPrg() { return { success: true }; },
    recordAndAnalyzeAudio,
  };
}

test("analyze gives no positive verdict for a silent capture", async () => {
  const result = await toolRegistry.invoke("c64_sound", { op: "analyze", request: "does the music sound right?" }, context("c64u", playbackClient("c64u", silentAnalysis)));
  const text = result.content[0].text;
  assert.ok(!/sounds accurate/.test(text), text);
  assert.ok(/no audio/i.test(text), text);
});

test("analyze gives no positive verdict for an empty capture", async () => {
  const result = await toolRegistry.invoke("c64_sound", { op: "analyze", request: "does the music sound right?" }, context("c64u", playbackClient("c64u", async () => ({ analysis: { voices: [], global_metrics: { average_pitch_deviation: null } } }))));
  const text = result.content[0].text;
  assert.ok(!/sounds accurate/.test(text), text);
});

for (const verifySilenceAfter of [false, true]) {
  test(`pipeline silences playback before rejecting a silent capture (verifySilenceAfter=${verifySilenceAfter})`, async () => {
    let playing = false;
    let silenceCalls = 0;
    const client = playbackClient("c64u", silentAnalysis);
    client.runPrg = async () => { playing = true; return { success: true }; };
    client.sidSilenceAll = async () => { silenceCalls++; playing = false; return { success: true }; };
    const result = await toolRegistry.invoke("c64_sound", { op: "pipeline", sidwave: SCORE, verifySilenceBefore: false, verifySilenceAfter, waitBeforeCaptureMs: 0 }, context("c64u", client));
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(JSON.stringify(result).includes('"audible":false'), true, JSON.stringify(result));
    assert.equal(silenceCalls, 1);
    assert.equal(playing, false);
  });
}

test("pipeline preserves the no-audio error when playback cleanup fails", async () => {
  const client = playbackClient("c64u", silentAnalysis);
  client.sidSilenceAll = async () => ({ success: false, details: { error: "offline" } });
  const result = await toolRegistry.invoke("c64_sound", { op: "pipeline", sidwave: SCORE, verifySilenceBefore: false, waitBeforeCaptureMs: 0 }, context("c64u", client));
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.data.message, /No audio was detected/);
  assert.equal(result.metadata.error.details.audible, false);
  assert.match(result.metadata.error.details.cleanupError, /Unable to silence SID/);
});

for (const op of ["pipeline", "play_preset"]) {
  test(`${op} forwards the request cancellation signal to audio capture`, async () => {
    const controller = new AbortController();
    let captures = 0;
    const client = playbackClient("c64u", async (options) => {
      captures++;
      assert.equal(options.signal, controller.signal);
      return { analysis: { voices: [], global_metrics: { average_rms: 0.06, max_rms: 0.08 } } };
    });
    const ctx = { ...context("c64u", client), signal: controller.signal };
    const args = op === "pipeline"
      ? { op, sidwave: SCORE, verifySilenceBefore: false, verifySilenceAfter: false, waitBeforeCaptureMs: 0 }
      : { op, verify: true, waitBeforeCaptureMs: 0 };
    const result = await toolRegistry.invoke("c64_sound", args, ctx);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(captures, 1);
  });
}

test("play_preset with verify reports audible false and an error for a silent capture", async () => {
  const result = await toolRegistry.invoke("c64_sound", { op: "play_preset", verify: true, waitBeforeCaptureMs: 0 }, context("c64u", playbackClient("c64u", silentAnalysis)));
  assert.equal(result.isError, true, JSON.stringify(result));
  const entry = result.structuredContent.data.results[0];
  assert.equal(entry.verification.audible, false);
});

test("play_preset keeps the playback entry when the analyzer throws on VICE", async () => {
  const result = await toolRegistry.invoke("c64_sound", { op: "play_preset", verify: true, waitBeforeCaptureMs: 0 }, context("vice", playbackClient("vice", async () => { throw new Error("Audio backend not available"); })));
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const entry = result.structuredContent.data.results[0];
  assert.equal(entry.success, true);
  assert.equal(entry.backend, "vice");
  assert.match(entry.verification.error, /Audio backend not available/);
});

test("HARD06 SOUND-4 pipeline without an audio capture backend plays and says the analysis was skipped", async () => {
  const client = playbackClient("vice", undefined);
  delete client.recordAndAnalyzeAudio;
  let played = 0;
  client.runPrg = async () => { played += 1; return { success: true }; };
  const result = await toolRegistry.invoke("c64_sound", { op: "pipeline", sidwave: SCORE, waitBeforeCaptureMs: 0 }, context("vice", client));
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.equal(played, 1);
  const data = result.structuredContent.data;
  assert.equal(data.analysis, null);
  assert.match(data.warnings[0], /No audio capture backend/);
});

test("HARD06 SOUND-15 play_preset and pipeline do not record audio unless asked", async () => {
  let captures = 0;
  const client = playbackClient("c64u", async () => { captures += 1; return analyzePcmForTest(new Float32Array(44100).fill(0.2), 44100); });
  const preset = await toolRegistry.invoke("c64_sound", { op: "play_preset" }, context("c64u", client));
  assert.equal(preset.isError, undefined, JSON.stringify(preset.content));
  assert.equal(captures, 0);
  assert.equal(preset.structuredContent.data.verificationEnabled, false);
  const pipeline = await toolRegistry.invoke("c64_sound", { op: "pipeline", sidwave: SCORE, waitBeforeCaptureMs: 0 }, context("c64u", client));
  assert.equal(pipeline.isError, undefined, JSON.stringify(pipeline.content));
  assert.equal(captures, 1, "only the analysis capture, no silence checks");
});
