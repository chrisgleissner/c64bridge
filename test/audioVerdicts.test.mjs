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

test("pipeline is not a success when the capture is silent", async () => {
  const result = await toolRegistry.invoke("c64_sound", { op: "pipeline", sidwave: SCORE, verifySilenceBefore: false, verifySilenceAfter: false, waitBeforeCaptureMs: 0 }, context("c64u", playbackClient("c64u", silentAnalysis)));
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(JSON.stringify(result).includes('"audible":false'), true, JSON.stringify(result));
});

test("play_preset with verify reports audible false and an error for a silent capture", async () => {
  const result = await toolRegistry.invoke("c64_sound", { op: "play_preset", waitBeforeCaptureMs: 0 }, context("c64u", playbackClient("c64u", silentAnalysis)));
  assert.equal(result.isError, true, JSON.stringify(result));
  const entry = result.structuredContent.data.results[0];
  assert.equal(entry.verification.audible, false);
});
