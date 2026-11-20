import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { createLogger } from "./meta/helpers.mjs";

const sidwave = `song: { title: Capture Test, mode: PAL, tempo: 120 }
voices:
  - id: 1
    waveform: triangle
    patterns:
      main: { notes: [C4, E4, G4] }
timeline:
  - { bars: 1, layers: { v1: main } }
`;

for (const backend of ["vice", "u2"]) {
  for (const [op, args] of [
    ["analyze", { durationSeconds: 0.5 }],
    ["silence_all", { verify: true }],
    ["play_preset", { verify: true, waitBeforeCaptureMs: 0 }],
    ["pipeline", { sidwave, waitBeforeCaptureMs: 0 }],
  ]) {
    test(`HIL F2 ${op} on ${backend} attempts the microphone and reports when it is unavailable`, async () => {
      const calls = [];
      const client = {
        async getActiveBackendType() { return backend; },
        getAvailableBackends() { return [backend]; },
        switchBackend() {},
        async sidSilenceAll() { calls.push("silence"); return { success: true }; },
        async runPrg() { calls.push("play"); return { success: true }; },
        async recordAndAnalyzeAudio() {
          calls.push("capture");
          throw new Error("Audio backend not available. Please install 'naudiodon' dependencies (PortAudio).");
        },
      };
      const result = await toolRegistry.invoke("c64_sound", { op, ...args }, {
        client, logger: createLogger(), setPlatform() {},
        platform: { id: backend, features: [], limitedFeatures: [] },
      });
      const data = result.structuredContent?.data;
      const entry = op === "play_preset" ? data?.results[0] : data;
      const expectedMessage = `No measurement: the ${backend} backend has no audio stream (only c64u streams audio), and the host microphone is unavailable because naudiodon (PortAudio) is not installed.`;
      assert.deepEqual(entry?.verification, { measured: false, message: expectedMessage });
      assert.ok(result.content[0].text.includes(expectedMessage));
      assert.equal(entry?.analysisMetrics, undefined);
      assert.equal(entry?.silenceChecks, undefined);
      assert.equal(result.metadata?.maxRms, undefined);
      if (op === "analyze") {
        assert.equal(result.isError, true);
        assert.deepEqual(calls, ["capture"]);
      } else {
        assert.equal(result.isError, undefined);
        assert.equal(result.metadata.success, true);
        const expectedCalls = {
          silence_all: ["silence", "capture"],
          play_preset: ["silence", "play", "capture"],
          pipeline: ["play", "capture"],
        };
        assert.deepEqual(calls, expectedCalls[op]);
      }
    });
  }
}
