import test, { describe } from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import { audioModule } from "../src/tools/audio.js";
import { analyzePcmForTest, recordAndAnalyzeAudio } from "../src/audio/record_and_analyze_audio.js";
import { C64Client } from "../src/c64Client.js";
import { toolRegistry } from "../src/tools/registry/index.js";

// Keep the native microphone out of these tests on both runtimes.
const mockKey = Symbol.for("c64bridge.test.audioRuntimeMocks");
const factories = new Map();
let revision = 0;
const bunMock = globalThis.Bun ? (await import("bun:test")).mock : undefined;
if (!bunMock) globalThis[mockKey] = factories;
const hooks = bunMock ? undefined : (await import("node:module")).registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!factories.has(specifier)) return nextResolve(specifier, context);
    const source = `
      const value = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(mockKey))})].get(${JSON.stringify(specifier)})();
      export default value.default;
      export const AudioIO = value.AudioIO;
      export const SampleFormat16Bit = value.SampleFormat16Bit;
      // Revision ${revision}
    `;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  },
});

function mockModule(specifier, factory) {
  if (bunMock) bunMock.module(specifier, factory);
  else {
    factories.set(specifier, factory);
    revision += 1;
  }
}

test.afterEach(() => {
  bunMock?.restore();
  factories.clear();
});
test.after(() => {
  hooks?.deregister();
  delete globalThis[mockKey];
});

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function installAudioRuntimeMocks({
  fixedFreq = 440,
  rms = 0.2,
  includeQuit = true,
  startThrows = false,
  onStart,
} = {}) {
  const instances = [];

  class FakeAudioIO {
    constructor() {
      this.handlers = {};
      instances.push(this);
    }

    on(event, handler) {
      this.handlers[event] = handler;
    }

    start() {
      if (startThrows) {
        throw new Error("synthetic start failure");
      }
      onStart?.();

      const samples = 4096;
      const pcm = Buffer.alloc(samples * 2);
      for (let i = 0; i < samples; i += 1) {
        const value = Math.round(Math.sin((2 * Math.PI * fixedFreq * i) / 44100) * 16000);
        pcm.writeInt16LE(value, i * 2);
      }
      this.handlers.data?.(pcm);
    }

    stop() {
      this.stopCalled = true;
    }
  }

  if (includeQuit) {
    FakeAudioIO.prototype.quit = function quit() {
      this.quitCalled = true;
      this.quitCalls = (this.quitCalls ?? 0) + 1;
    };
  }

  mockModule("naudiodon", () => ({
    AudioIO: FakeAudioIO,
    SampleFormat16Bit: 16,
  }));
  mockModule("pitchfinder", () => ({
    default: {
      YIN: () => () => fixedFreq,
    },
  }));
  mockModule("meyda", () => ({
    default: {
      extract: () => ({ rms }),
    },
  }));

  return { instances };
}

describe("audio runtime integration", () => {
  test("recordAndAnalyzeAudio validates duration input before capture", async () => {
    await assert.rejects(recordAndAnalyzeAudio({ durationSeconds: "invalid" }), /durationSeconds must be a number/);
  });

  test("recordAndAnalyzeAudio surfaces missing audio backend dependencies", async () => {
    mockModule("naudiodon", () => { throw new Error("missing"); });
    await assert.rejects(recordAndAnalyzeAudio({ durationSeconds: 0.5 }), /Audio backend not available/);
  });

  test("recordAndAnalyzeAudio surfaces missing pitch detection dependencies", async () => {
    class FakeAudioIO {
      constructor() {
        this.handlers = {};
      }

      on(event, handler) {
        this.handlers[event] = handler;
      }

      start() {
        this.handlers.data?.(Buffer.alloc(2048));
      }

      quit() {}
    }

    mockModule("naudiodon", () => ({
      AudioIO: FakeAudioIO,
      SampleFormat16Bit: 16,
    }));
    mockModule("pitchfinder", () => {
      throw new Error("missing");
    });

    await assert.rejects(recordAndAnalyzeAudio({ durationSeconds: 0.5 }), /Missing dependency: pitchfinder/);
  });

  test("grouped VICE and U2 analysis reaches the real client microphone recorder and analyzes PCM", async () => {
    const { instances } = installAudioRuntimeMocks({ fixedFreq: 440, rms: 0.18 });
    for (const platform of ["vice", "u2"]) {
      const client = Object.create(C64Client.prototype);
      // Isolate backend I/O while exercising the real C64Client capture routing.
      client.facadePromise = Promise.resolve({ type: platform });
      client.captureSamples = () => { throw new Error("Microphone capture must not start an Ultimate stream"); };
      client.captureC64uAudioSamples = client.captureSamples;
      for (const op of ["record_analyze", "analyze"]) {
        const result = await toolRegistry.invoke("c64_sound", { op, durationSeconds: 0.5, ...(op === "analyze" ? { request: "check the music" } : {}) }, {
          client, rag: {}, logger: createLogger(), platform: { id: platform, features: [], limitedFeatures: [] },
        });
        assert.equal(result.isError, undefined);
        const analysis = op === "record_analyze" ? JSON.parse(result.content[0].text).analysis : result.metadata.analysis.analysis;
        assert.equal(analysis.source, "microphone");
        assert.equal(analysis.voices[0].detected_notes.some((note) => note.note === "A4"), true);
        assert.ok(analysis.global_metrics.average_rms > 0.1);
      }
    }
    assert.equal(instances.length, 4);
    assert.equal(instances.every((input) => input.quitCalled), true);
  });

  test("recordAndAnalyzeAudio captures PCM and analyzes note content", async () => {
    installAudioRuntimeMocks({ fixedFreq: 440, rms: 0.18 });

    const result = await recordAndAnalyzeAudio({
      durationSeconds: 0.5,
      expectedSidwave: {
        voices: [
          {
            patterns: {
              main: {
                notes: ["A4"],
              },
            },
          },
        ],
      },
    });

    assert.ok(result.analysis.durationSeconds > 0.05);
    assert.equal(result.analysis.voices[0]?.detected_notes.some((entry) => entry.note === "A4"), true);
    assert.ok(result.analysis.global_metrics.average_rms > 0);
    assert.ok(result.analysis.global_metrics.max_rms > 0);
  });

  test("recordAndAnalyzeAudio falls back to stop() when quit() is unavailable", async () => {
    const { instances } = installAudioRuntimeMocks({ includeQuit: false, fixedFreq: 523.25, rms: Number.NaN });

    const result = await recordAndAnalyzeAudio({ durationSeconds: 0.5 });

    assert.ok(result.analysis.voices[0]?.detected_notes.length > 0);
    assert.equal(instances[0]?.stopCalled, true);
    assert.equal(instances[0]?.quitCalled, undefined);
  });

  test("recordAndAnalyzeAudio falls back to manual RMS and tolerates invalid expected SIDWAVE", async () => {
    const instances = [];
    class FakeAudioIO {
      constructor() {
        this.handlers = {};
        instances.push(this);
      }

      on(event, handler) {
        this.handlers[event] = handler;
      }

      start() {
        const samples = 4096;
        const pcm = Buffer.alloc(samples * 2);
        for (let i = 0; i < samples; i += 1) {
          const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / 44100) * 12000);
          pcm.writeInt16LE(value, i * 2);
        }
        this.handlers.data?.(pcm);
      }

      quit() {
        this.quitCalled = true;
      }
    }

    mockModule("naudiodon", () => ({
      AudioIO: FakeAudioIO,
      SampleFormat16Bit: 16,
    }));
    mockModule("pitchfinder", () => ({
      default: {
        YIN: () => () => 440,
      },
    }));

    const result = await recordAndAnalyzeAudio({
      durationSeconds: 0.5,
      expectedSidwave: "{not valid yaml",
    });

    assert.ok(result.analysis.global_metrics.average_rms > 0);
    assert.equal(result.analysis.voices[0]?.detected_notes.some((entry) => entry.note === "A4"), true);
    assert.equal(instances[0]?.quitCalled, true);
  });

  test("recordAndAnalyzeAudio marks quiet captures as uncertain notes", async () => {
    installAudioRuntimeMocks({ fixedFreq: 440, rms: 0.001 });

    const result = await recordAndAnalyzeAudio({
      durationSeconds: 0.5,
      expectedSidwave: {
        voices: [
          {
            patterns: {
              main: {
                notes: ["BAD", "C4"],
              },
            },
          },
        ],
      },
    });

    assert.equal(result.analysis.voices[0]?.detected_notes.every((entry) => entry.note === null), true);
    assert.equal(result.analysis.voices[0]?.detected_notes.every((entry) => entry.uncertain === true), true);
  });

  test("recordAndAnalyzeAudio surfaces input startup failures", async () => {
    const { instances } = installAudioRuntimeMocks({ startThrows: true });

    await assert.rejects(recordAndAnalyzeAudio({ durationSeconds: 0.5 }), /synthetic start failure/);
    assert.equal(instances[0]?.quitCalls, 1);
  });

  test("microphone cancellation during startup closes the input exactly once", async () => {
    const controller = new AbortController();
    const { instances } = installAudioRuntimeMocks({ onStart: () => controller.abort() });

    await assert.rejects(recordAndAnalyzeAudio({ durationSeconds: 10, signal: controller.signal }), /cancelled/);
    assert.equal(instances[0]?.quitCalls, 1);
  });

  test("microphone cancellation stops active recording before its duration elapses", async () => {
    const controller = new AbortController();
    let started;
    const inputStarted = new Promise((resolve) => { started = resolve; });
    const { instances } = installAudioRuntimeMocks({ onStart: () => started() });
    const recording = recordAndAnalyzeAudio({ durationSeconds: 10, signal: controller.signal });
    recording.catch(() => {});
    await inputStarted;
    controller.abort();
    await assert.rejects(recording, /cancelled/);
    assert.equal(instances[0]?.quitCalls, 1);
  });

  test("audioModule analyze_audio and record_and_analyze_audio succeed with the mocked runtime", async () => {
    installAudioRuntimeMocks({ fixedFreq: 440, rms: 0.15 });
    const ctx = { client: {}, logger: createLogger() };

    const recorded = await audioModule.invoke(
      "record_and_analyze_audio",
      { durationSeconds: 0.5, expectedSidwave: { voices: [{ patterns: { main: { notes: ["A4"] } } }] } },
      ctx,
    );
    assert.equal(recorded.isError, undefined);
    assert.equal(recorded.metadata?.success, true);
    assert.equal(recorded.metadata?.voices?.length, 1);

    const analyzed = await audioModule.invoke(
      "analyze_audio",
      { request: "does the music sound right?", durationSeconds: 0.5, expectedSidwave: { voices: [{ patterns: { main: { notes: ["A4"] } } }] } },
      ctx,
    );

    assert.equal(analyzed.isError, undefined);
    assert.equal(analyzed.metadata?.analyzed, true);
    assert.ok(String(analyzed.content?.[0]?.text ?? "").includes("Mix:"));
    assert.ok(String(analyzed.content?.[0]?.text ?? "").includes("sounds accurate"));
  });

  test("analyzePcmForTest falls back when RMS extraction throws and splits changing pitches into segments", async () => {
    let callIndex = 0;
    mockModule("pitchfinder", () => ({
      default: {
        YIN: () => () => [440, 440, 493.88, 493.88, 493.88][callIndex++] ?? 493.88,
      },
    }));
    mockModule("meyda", () => ({
      default: {
        extract: () => {
          throw new Error("meyda missing");
        },
      },
    }));

    const signal = new Float32Array(4096);
    signal.fill(0.2);

    const result = await analyzePcmForTest(signal, 44100, {
      voices: [
        {
          patterns: {
            main: {
              notes: ["A4", "B4"],
            },
          },
        },
      ],
    });

    const detected = result.analysis.voices[0]?.detected_notes ?? [];
    assert.ok(detected.length > 1);
    assert.equal(detected.some((entry) => entry.note === "A4"), true);
    assert.equal(detected.some((entry) => entry.note === "B4"), true);
    assert.ok(result.analysis.global_metrics.average_rms > 0);
  });

  test("analyzePcmForTest handles empty captures without detected notes", async () => {
    mockModule("pitchfinder", () => ({
      default: {
        YIN: () => () => null,
      },
    }));
    mockModule("meyda", () => ({
      default: {
        extract: () => ({ rms: 0 }),
      },
    }));

    const result = await analyzePcmForTest(new Float32Array(0), 44100);

    assert.deepEqual(result.analysis.voices[0]?.detected_notes, []);
    assert.equal(result.analysis.global_metrics.average_pitch_deviation, null);
    assert.equal(result.analysis.global_metrics.detected_bpm, null);
    assert.equal(result.analysis.global_metrics.average_rms, null);
  });
});
