import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { audioModule } from "../src/tools/audio.js";
import { analyzePcmForTest, recordAndAnalyzeAudio } from "../src/audio/record_and_analyze_audio.js";
import { C64Client } from "../src/c64Client.js";
import { toolRegistry } from "../src/tools/registry/index.js";

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
    };
  }

  mock.module("naudiodon", () => ({
    AudioIO: FakeAudioIO,
    SampleFormat16Bit: 16,
  }));
  mock.module("pitchfinder", () => ({
    default: {
      YIN: () => () => fixedFreq,
    },
  }));
  mock.module("meyda", () => ({
    default: {
      extract: () => ({ rms }),
    },
  }));

  return { instances };
}

afterEach(() => {
  mock.restore();
});

afterAll(() => {
  mock.restore();
});

describe("audio runtime integration", () => {
  test("recordAndAnalyzeAudio validates duration input before capture", async () => {
    await expect(recordAndAnalyzeAudio({ durationSeconds: "invalid" })).rejects.toThrow("durationSeconds must be a number");
  });

  test("recordAndAnalyzeAudio surfaces missing audio backend dependencies", async () => {
    await expect(recordAndAnalyzeAudio({ durationSeconds: 0.5 })).rejects.toThrow("Audio backend not available");
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

    mock.module("naudiodon", () => ({
      AudioIO: FakeAudioIO,
      SampleFormat16Bit: 16,
    }));
    mock.module("pitchfinder", () => {
      throw new Error("missing");
    });

    await expect(recordAndAnalyzeAudio({ durationSeconds: 0.5 })).rejects.toThrow("Missing dependency: pitchfinder");
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
        expect(result.isError).toBeUndefined();
        const analysis = op === "record_analyze" ? JSON.parse(result.content[0].text).analysis : result.metadata.analysis.analysis;
        expect(analysis.source).toBe("microphone");
        expect(analysis.voices[0].detected_notes.some((note) => note.note === "A4")).toBe(true);
        expect(analysis.global_metrics.average_rms).toBeGreaterThan(0.1);
      }
    }
    expect(instances).toHaveLength(4);
    expect(instances.every((input) => input.quitCalled)).toBe(true);
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

    expect(result.analysis.durationSeconds).toBeGreaterThan(0.05);
    expect(result.analysis.voices[0]?.detected_notes.some((entry) => entry.note === "A4")).toBe(true);
    expect(result.analysis.global_metrics.average_rms).toBeGreaterThan(0);
    expect(result.analysis.global_metrics.max_rms).toBeGreaterThan(0);
  });

  test("recordAndAnalyzeAudio falls back to stop() when quit() is unavailable", async () => {
    const { instances } = installAudioRuntimeMocks({ includeQuit: false, fixedFreq: 523.25, rms: Number.NaN });

    const result = await recordAndAnalyzeAudio({ durationSeconds: 0.5 });

    expect(result.analysis.voices[0]?.detected_notes.length).toBeGreaterThan(0);
    expect(instances[0]?.stopCalled).toBe(true);
    expect(instances[0]?.quitCalled).toBeUndefined();
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

    mock.module("naudiodon", () => ({
      AudioIO: FakeAudioIO,
      SampleFormat16Bit: 16,
    }));
    mock.module("pitchfinder", () => ({
      default: {
        YIN: () => () => 440,
      },
    }));

    const result = await recordAndAnalyzeAudio({
      durationSeconds: 0.5,
      expectedSidwave: "{not valid yaml",
    });

    expect(result.analysis.global_metrics.average_rms).toBeGreaterThan(0);
    expect(result.analysis.voices[0]?.detected_notes.some((entry) => entry.note === "A4")).toBe(true);
    expect(instances[0]?.quitCalled).toBe(true);
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

    expect(result.analysis.voices[0]?.detected_notes.every((entry) => entry.note === null)).toBe(true);
    expect(result.analysis.voices[0]?.detected_notes.every((entry) => entry.uncertain === true)).toBe(true);
  });

  test("recordAndAnalyzeAudio surfaces input startup failures", async () => {
    installAudioRuntimeMocks({ startThrows: true });

    await expect(recordAndAnalyzeAudio({ durationSeconds: 0.5 })).rejects.toThrow("synthetic start failure");
  });

  test("audioModule analyze_audio and record_and_analyze_audio succeed with the mocked runtime", async () => {
    installAudioRuntimeMocks({ fixedFreq: 440, rms: 0.15 });
    const ctx = { client: {}, logger: createLogger() };

    const recorded = await audioModule.invoke(
      "record_and_analyze_audio",
      { durationSeconds: 0.5, expectedSidwave: { voices: [{ patterns: { main: { notes: ["A4"] } } }] } },
      ctx,
    );
    expect(recorded.isError).toBeUndefined();
    expect(recorded.metadata?.success).toBe(true);
    expect(recorded.metadata?.voices?.length).toBe(3);

    const analyzed = await audioModule.invoke(
      "analyze_audio",
      { request: "does the music sound right?", durationSeconds: 0.5, expectedSidwave: { voices: [{ patterns: { main: { notes: ["A4"] } } }] } },
      ctx,
    );

    expect(analyzed.isError).toBeUndefined();
    expect(analyzed.metadata?.analyzed).toBe(true);
    expect(String(analyzed.content?.[0]?.text ?? "")).toContain("Voice 1:");
    expect(String(analyzed.content?.[0]?.text ?? "")).toContain("sounds accurate");
  });

  test("analyzePcmForTest falls back when RMS extraction throws and splits changing pitches into segments", async () => {
    let callIndex = 0;
    mock.module("pitchfinder", () => ({
      default: {
        YIN: () => () => [440, 440, 493.88, 493.88, 493.88][callIndex++] ?? 493.88,
      },
    }));
    mock.module("meyda", () => ({
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
    expect(detected.length).toBeGreaterThan(1);
    expect(detected.some((entry) => entry.note === "A4")).toBe(true);
    expect(detected.some((entry) => entry.note === "B4")).toBe(true);
    expect(result.analysis.global_metrics.average_rms).toBeGreaterThan(0);
  });

  test("analyzePcmForTest handles empty captures without detected notes", async () => {
    mock.module("pitchfinder", () => ({
      default: {
        YIN: () => () => null,
      },
    }));
    mock.module("meyda", () => ({
      default: {
        extract: () => ({ rms: 0 }),
      },
    }));

    const result = await analyzePcmForTest(new Float32Array(0), 44100);

    expect(result.analysis.voices[0]?.detected_notes).toEqual([]);
    expect(result.analysis.global_metrics.average_pitch_deviation).toBeNull();
    expect(result.analysis.global_metrics.detected_bpm).toBeNull();
    expect(result.analysis.global_metrics.average_rms).toBeNull();
  });
});
