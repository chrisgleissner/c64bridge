import { describe, test, mock, beforeEach, expect } from "bun:test";
import { metaModule } from "../../src/tools/meta/index.js";
import { createLogger } from "./helpers.mjs";

function createAnalysis({ averageRms, maxRms, durationSeconds = 1.5, voices = [] } = {}) {
  return {
    sidwave: 1,
    analysis: {
      source: "microphone",
      durationSeconds,
      voices,
      global_metrics: {
        average_pitch_deviation: null,
        detected_bpm: null,
        average_rms: averageRms ?? null,
        max_rms: maxRms ?? null,
      },
    },
  };
}

const SAMPLE_SIDWAVE = `
song:
  title: "Meta Test"
  mode: PAL
  tempo: 110
voices:
  - id: 1
    name: "Lead"
    waveform: triangle
    patterns:
      main:
        notes: ["C4", "E4", "G4", "C5"]
timeline:
  - bars: 1
    layers: { v1: main }
`;

describe("meta/audio", () => {
  let ctx;

  beforeEach(() => {
    ctx = {
      logger: createLogger(),
      client: {
        sidSilenceAll: mock(async () => ({ success: true })),
        recordAndAnalyzeAudio: mock(async () => createAnalysis({ averageRms: 0.004, maxRms: 0.006 })),
        runPrg: mock(async () => ({ success: true, details: { run: true } })),
        sidplayAttachment: mock(async () => ({ success: true, details: { played: true } })),
      },
    };
  });

  test("silence_and_verify succeeds when RMS below threshold", async () => {
    const result = await metaModule.invoke(
      "silence_and_verify",
      { durationSeconds: 1, rmsThreshold: 0.01, waitBeforeCaptureMs: 0 },
      ctx,
    );

    expect(result.metadata.success).toBe(true);
    expect(result.metadata.silent).toBe(true);
    expect(result.structuredContent.data.silent).toBe(true);
    expect(result.structuredContent.data.metrics.maxRms).toBeCloseTo(0.006);
    expect(ctx.client.sidSilenceAll).toHaveBeenCalledTimes(1);
    expect(ctx.client.recordAndAnalyzeAudio).toHaveBeenCalledWith({ durationSeconds: 1 });
  });

  test("silence_and_verify reports noise when threshold exceeded", async () => {
    ctx.client.recordAndAnalyzeAudio = mock(async () => createAnalysis({ averageRms: 0.02, maxRms: 0.03 }));

    const result = await metaModule.invoke(
      "silence_and_verify",
      { rmsThreshold: 0.01, waitBeforeCaptureMs: 0 },
      ctx,
    );

    expect(result.metadata.success).toBe(false);
    expect(result.metadata.silent).toBe(false);
    expect(result.structuredContent.data.silent).toBe(false);
    expect(result.structuredContent.data.metrics.maxRms).toBeCloseTo(0.03);
  });

  test("silence_and_verify surfaces silencing failure", async () => {
    ctx.client.sidSilenceAll = mock(async () => ({ success: false, error: "bad" }));

    const result = await metaModule.invoke(
      "silence_and_verify",
      { waitBeforeCaptureMs: 0, durationSeconds: 0.5 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata.error?.kind).toBe("execution");
    expect(result.metadata.error?.details?.response?.error).toBe("bad");
  });

  test("silence_and_verify errors when RMS metrics missing", async () => {
    ctx.client.recordAndAnalyzeAudio = mock(async () => createAnalysis({ averageRms: null, maxRms: null }));

    const result = await metaModule.invoke(
      "silence_and_verify",
      { waitBeforeCaptureMs: 0, durationSeconds: 0.5 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata.error?.kind).toBe("execution");
  });

  test("silence_and_verify requires sidSilenceAll support on the client", async () => {
    delete ctx.client.sidSilenceAll;

    const result = await metaModule.invoke(
      "silence_and_verify",
      { waitBeforeCaptureMs: 0, durationSeconds: 0.5 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata.error?.kind).toBe("execution");
    expect(String(result.metadata.error?.message ?? result.content?.[0]?.text ?? "")).toContain("sidSilenceAll");
  });

  test("silence_and_verify falls back to alternate RMS metric fields", async () => {
    ctx.client.recordAndAnalyzeAudio = mock(async () => ({
      analysis: {
        global_metrics: {
          average_rms: null,
          max_rms: 0.009,
        },
      },
    }));

    const result = await metaModule.invoke(
      "silence_and_verify",
      { waitBeforeCaptureMs: 1, durationSeconds: 0.5, rmsThreshold: 0.01 },
      ctx,
    );

    expect(result.metadata.success).toBe(true);
    expect(result.structuredContent?.data?.durationSeconds).toBe(0.5);
    expect(result.structuredContent?.data?.metrics?.averageRms).toBeCloseTo(0.009);
    expect(result.structuredContent?.data?.metrics?.maxRms).toBeCloseTo(0.009);
  });

  test("music_compile_play_analyze compiles, plays, analyzes, and verifies silence", async () => {
    const responses = [
      createAnalysis({ averageRms: 0.003, maxRms: 0.004 }),
      createAnalysis({ averageRms: 0.06, maxRms: 0.09, durationSeconds: 1, voices: [{ id: 1, detected_notes: [{ note: "C4", frequency: 262, duration: 0.4 }] }] }),
      createAnalysis({ averageRms: 0.002, maxRms: 0.003 }),
    ];
    ctx.client.recordAndAnalyzeAudio = mock(async () => responses.shift() ?? createAnalysis({ averageRms: 0.002, maxRms: 0.003 }));

    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      {
        sidwave: SAMPLE_SIDWAVE,
        waitBeforeCaptureMs: 0,
        analysisDurationSeconds: 1,
        silenceDurationSeconds: 0.5,
        postSilenceWaitMs: 0,
        silenceWaitMs: 0,
      },
      ctx,
    );

    expect(result.metadata.success).toBe(true);
    const data = result.structuredContent?.data ?? {};
    expect(data.playback?.method).toBe("run_prg");
    expect(data.analysisMetrics?.maxRms).toBeCloseTo(0.09);
    expect(data.silenceChecks?.before?.silent).toBe(true);
    expect(data.silenceChecks?.after?.silent).toBe(true);
    expect(ctx.client.runPrg).toHaveBeenCalledTimes(1);
    expect(ctx.client.sidSilenceAll).toHaveBeenCalledTimes(2);
    expect(ctx.client.recordAndAnalyzeAudio).toHaveBeenCalledTimes(3);
  });

  test("music_compile_play_analyze surfaces playback failure", async () => {
    ctx.client.runPrg = mock(async () => ({ success: false, details: { error: "playback" } }));
    ctx.client.recordAndAnalyzeAudio = mock(async () => createAnalysis({ averageRms: 0.003, maxRms: 0.004 }));

    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      {
        sidwave: SAMPLE_SIDWAVE,
        waitBeforeCaptureMs: 0,
        verifySilenceBefore: false,
        verifySilenceAfter: false,
        silenceWaitMs: 0,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata.error?.kind).toBe("execution");
    expect(result.metadata.error?.details?.response?.error).toBe("playback");
  });

  test("music_compile_play_analyze rejects blank source input after trimming", async () => {
    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      { sidwave: "   " },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata.error?.kind).toBe("execution");
    expect(String(result.metadata.error?.message ?? result.content?.[0]?.text ?? "")).toContain("Provide sidwave or cpg source");
  });

  test("music_compile_play_analyze fails when post-silence check detects residual audio", async () => {
    const responses = [
      createAnalysis({ averageRms: 0.003, maxRms: 0.004 }),
      createAnalysis({ averageRms: 0.05, maxRms: 0.08 }),
      createAnalysis({ averageRms: 0.03, maxRms: 0.04 }),
    ];
    ctx.client.recordAndAnalyzeAudio = mock(async () => responses.shift() ?? createAnalysis({ averageRms: 0.03, maxRms: 0.04 }));

    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      {
        sidwave: SAMPLE_SIDWAVE,
        waitBeforeCaptureMs: 0,
        postSilenceWaitMs: 0,
        silenceRmsThreshold: 0.02,
        silenceWaitMs: 0,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata.error?.kind).toBe("execution");
    expect(result.metadata.error?.details?.metrics?.maxRms).toBeGreaterThan(0.02);
  });

  test("music_compile_play_analyze forwards expected SIDWAVE and normalises scalar playback details", async () => {
    const analyzerCalls = [];
    ctx.client.runPrg = mock(async () => ({ success: true, details: "ran" }));
    ctx.client.recordAndAnalyzeAudio = mock(async (args) => {
      analyzerCalls.push(args);
      return createAnalysis({ averageRms: null, maxRms: 0.03 });
    });

    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      {
        sidwave: SAMPLE_SIDWAVE,
        expectedSidwave: "expected",
        waitBeforeCaptureMs: 1,
        verifySilenceBefore: false,
        verifySilenceAfter: false,
        analysisDurationSeconds: 1,
        silenceWaitMs: 0,
      },
      ctx,
    );

    expect(result.metadata.success).toBe(true);
    expect(result.structuredContent?.data?.playback?.details).toEqual({ value: "ran" });
    expect(result.structuredContent?.data?.analysisMetrics?.averageRms).toBeNull();
    expect(result.structuredContent?.data?.analysisMetrics?.maxRms).toBeCloseTo(0.03);
    expect(analyzerCalls).toEqual([{ durationSeconds: 1, expectedSidwave: "expected" }]);
  });

  test("music_compile_play_analyze uses SID playback path", async () => {
    const responses = [
      createAnalysis({ averageRms: 0.002, maxRms: 0.003 }),
      createAnalysis({ averageRms: 0.03, maxRms: 0.05 }),
      createAnalysis({ averageRms: 0.002, maxRms: 0.003 }),
    ];
    ctx.client.recordAndAnalyzeAudio = mock(async () => responses.shift() ?? createAnalysis({ averageRms: 0.002, maxRms: 0.003 }));

    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      {
        sidwave: SAMPLE_SIDWAVE,
        output: "sid",
        waitBeforeCaptureMs: 0,
        analysisDurationSeconds: 1,
        silenceDurationSeconds: 0.5,
        postSilenceWaitMs: 0,
        silenceWaitMs: 0,
      },
      ctx,
    );

    expect(result.metadata.success).toBe(true);
    expect(result.structuredContent?.data?.playback?.method).toBe("sidplay_attachment");
    expect(ctx.client.sidplayAttachment).toHaveBeenCalledTimes(1);
    expect(ctx.client.runPrg).not.toHaveBeenCalled();
  });

  test("music_compile_play_analyze fails pre-silence verification when the baseline is noisy", async () => {
    ctx.client.recordAndAnalyzeAudio = mock(async () => createAnalysis({ averageRms: 0.03, maxRms: 0.05 }));

    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      {
        sidwave: SAMPLE_SIDWAVE,
        waitBeforeCaptureMs: 0,
        silenceRmsThreshold: 0.02,
        silenceWaitMs: 0,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata.error?.kind).toBe("execution");
    expect(result.metadata.error?.details?.metrics?.maxRms).toBeGreaterThan(0.02);
    expect(ctx.client.runPrg).not.toHaveBeenCalled();
  });

  test("music_compile_play_analyze requires RMS metrics from the main analysis capture", async () => {
    const responses = [
      createAnalysis({ averageRms: 0.002, maxRms: 0.003 }),
      createAnalysis({ averageRms: null, maxRms: null }),
      createAnalysis({ averageRms: 0.002, maxRms: 0.003 }),
    ];
    ctx.client.recordAndAnalyzeAudio = mock(async () => responses.shift() ?? createAnalysis({ averageRms: 0.002, maxRms: 0.003 }));

    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      {
        sidwave: SAMPLE_SIDWAVE,
        waitBeforeCaptureMs: 0,
        analysisDurationSeconds: 1,
        silenceDurationSeconds: 0.5,
        postSilenceWaitMs: 0,
        silenceWaitMs: 0,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata.error?.kind).toBe("execution");
    expect(result.metadata.error?.details?.globalMetrics).toEqual({
      average_pitch_deviation: null,
      detected_bpm: null,
      average_rms: null,
      max_rms: null,
    });
  });

  test("music_compile_play_analyze falls back to the playback response when details are missing", async () => {
    ctx.client.runPrg = mock(async () => ({ success: false }));
    ctx.client.recordAndAnalyzeAudio = mock(async () => createAnalysis({ averageRms: 0.003, maxRms: 0.004 }));

    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      {
        sidwave: SAMPLE_SIDWAVE,
        waitBeforeCaptureMs: 0,
        verifySilenceBefore: false,
        verifySilenceAfter: false,
        silenceWaitMs: 0,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata.error?.kind).toBe("execution");
    expect(result.metadata.error?.details?.response).toEqual({ success: false });
  });

  test("music_compile_play_analyze returns unknown errors for invalid SIDWAVE input", async () => {
    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      {
        sidwave: "not valid yaml: [",
        verifySilenceBefore: false,
        verifySilenceAfter: false,
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata.error?.kind).toBe("unknown");
  });

  test("music_compile_play_analyze disables post verification by silencing directly", async () => {
    ctx.client.recordAndAnalyzeAudio = mock(async () => createAnalysis({ averageRms: 0.01, maxRms: 0.02 }));

    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      {
        sidwave: SAMPLE_SIDWAVE,
        waitBeforeCaptureMs: 0,
        verifySilenceBefore: false,
        verifySilenceAfter: false,
        silenceWaitMs: 0,
      },
      ctx,
    );

    expect(result.metadata.success).toBe(true);
    expect(result.structuredContent?.data?.silenceChecks?.before).toBeNull();
    expect(result.structuredContent?.data?.silenceChecks?.after).toBeNull();
    expect(ctx.client.sidSilenceAll).toHaveBeenCalledTimes(1);
  });

  test("music_play_preset normalizes the legacy preset alias to fuer_elise across vice and c64u", async () => {
    const switches = [];
    let activeBackend = "c64u";
    const legacyAlias = String.fromCharCode(103, 101, 114, 109, 97, 110, 95, 97, 110, 116, 104, 101, 109);

    ctx.client.getActiveBackendType = mock(async () => activeBackend);
    ctx.client.getAvailableBackends = mock(() => ["vice", "c64u"]);
    ctx.client.switchBackend = mock((backend) => {
      activeBackend = backend;
      switches.push(backend);
    });
    ctx.client.runPrg = mock(async () => ({ success: true, details: { started: true } }));
    ctx.client.recordAndAnalyzeAudio = mock(async () => createAnalysis({
      averageRms: 0.06,
      maxRms: 0.09,
      durationSeconds: 1,
      voices: [{ id: 1, detected_notes: [{ note: "E5", frequency: 659 }] }],
    }));

    const result = await metaModule.invoke(
      "music_play_preset",
      {
        preset: legacyAlias,
        platforms: ["vice", "c64u"],
        waitBeforeCaptureMs: 0,
        analysisDurationSeconds: 1,
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.metadata.success).toBe(true);
    expect(result.metadata.preset).toBe("fuer_elise");
    expect(result.metadata.requestedPreset).toBe(legacyAlias);
    expect(result.metadata.legacyAliasUsed).toBe(true);
    expect(result.structuredContent.data.title).toBe("Für Elise");
    expect(result.structuredContent.data.results).toHaveLength(2);
    expect(result.structuredContent.data.results[0].verification.mode).toBe("audio-analysis");
    expect(ctx.client.recordAndAnalyzeAudio).toHaveBeenCalledTimes(2);
    expect(result.structuredContent.data.results[1].verification.mode).toBe("audio-analysis");
    expect(result.structuredContent.data.results[1].verification.voices[0].detected_notes[0].note).toBe("E5");
    expect(ctx.client.runPrg).toHaveBeenCalledTimes(2);
    expect(ctx.client.recordAndAnalyzeAudio).toHaveBeenCalledWith({
      durationSeconds: 1,
      expectedSidwave: expect.any(String),
    });
    expect(switches).toEqual(["vice", "c64u", "c64u"]);
  });

  test("music_play_preset resolves fuer_elise preset with correct title", async () => {
    ctx.client.getActiveBackendType = mock(async () => "c64u");
    ctx.client.getAvailableBackends = mock(() => ["c64u"]);
    ctx.client.switchBackend = mock(async () => {});
    ctx.client.runPrg = mock(async () => ({ success: true, details: { started: true } }));
    ctx.client.recordAndAnalyzeAudio = mock(async () => createAnalysis({
      averageRms: 0.05,
      maxRms: 0.08,
      durationSeconds: 1,
      voices: [{ id: 1, detected_notes: [{ note: "E5", frequency: 659 }] }],
    }));

    const result = await metaModule.invoke(
      "music_play_preset",
      {
        preset: "fuer_elise",
        platforms: ["c64u"],
        waitBeforeCaptureMs: 0,
        analysisDurationSeconds: 1,
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.metadata.success).toBe(true);
    expect(result.metadata.preset).toBe("fuer_elise");
    expect(result.metadata.legacyAliasUsed).toBe(false);
    expect(result.structuredContent.data.title).toBe("Für Elise");
    expect(result.structuredContent.data.results[0].verification.mode).toBe("audio-analysis");
    expect(ctx.client.runPrg).toHaveBeenCalledTimes(1);
  });

  test("music_play_preset throws when a requested backend is not available", async () => {
    ctx.client.getActiveBackendType = mock(async () => "vice");
    ctx.client.getAvailableBackends = mock(() => ["vice"]);
    ctx.client.switchBackend = mock(() => {});

    const result = await metaModule.invoke(
      "music_play_preset",
      { platforms: ["c64u"] },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata.error?.kind).toBe("execution");
  });

  test("music_play_preset throws for an unknown preset name", async () => {
    ctx.client.getActiveBackendType = mock(async () => "vice");
    ctx.client.getAvailableBackends = mock(() => ["vice"]);
    ctx.client.switchBackend = mock(() => {});

    const result = await metaModule.invoke(
      "music_play_preset",
      { preset: "nonexistent_xyz_preset" },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata.error?.kind).toBe("execution");
  });
});
