import test, { describe } from "#test/runner";
import assert from "#test/assert";
import { parseSidwave } from "../../src/sidwave.js";
import { arrangeSidwave, SIDWAVE_MEMORY_END } from "../../src/sidwaveCompiler.js";
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

function mock(fn) {
  const spy = (...args) => {
    spy.calls.push(args);
    return fn(...args);
  };
  spy.calls = [];
  return spy;
}

describe("meta/audio", () => {
  let ctx;

  test.beforeEach(() => {
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
        verifySilenceBefore: true,
        verifySilenceAfter: true,
        waitBeforeCaptureMs: 0,
        analysisDurationSeconds: 1,
        silenceDurationSeconds: 0.5,
        postSilenceWaitMs: 0,
        silenceWaitMs: 0,
      },
      ctx,
    );

    assert.equal(result.metadata.success, true);
    const data = result.structuredContent?.data ?? {};
    assert.equal(data.playback?.method, "run_prg");
    assert.ok(Math.abs(data.analysisMetrics?.maxRms - 0.09) < 0.005);
    assert.equal(data.silenceChecks?.before?.silent, true);
    assert.equal(data.silenceChecks?.after?.silent, true);
    assert.equal(ctx.client.runPrg.calls.length, 1);
    assert.equal(ctx.client.sidSilenceAll.calls.length, 2);
    assert.equal(ctx.client.recordAndAnalyzeAudio.calls.length, 3);
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

    assert.equal(result.isError, true);
    assert.equal(result.metadata.error?.kind, "execution");
    assert.equal(result.metadata.error?.details?.response?.error, "playback");
  });

  test("music_compile_play_analyze rejects blank source input after trimming", async () => {
    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      { sidwave: "   " },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.metadata.error?.kind, "execution");
    assert.ok(String(result.metadata.error?.message ?? result.content?.[0]?.text ?? "").includes("Provide sidwave or cpg source"));
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
        verifySilenceBefore: true,
        verifySilenceAfter: true,
        waitBeforeCaptureMs: 0,
        postSilenceWaitMs: 0,
        silenceRmsThreshold: 0.02,
        silenceWaitMs: 0,
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.metadata.error?.kind, "execution");
    assert.ok(result.metadata.error?.details?.metrics?.maxRms > 0.02);
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

    assert.equal(result.metadata.success, true);
    assert.deepEqual(result.structuredContent?.data?.playback?.details, { value: "ran" });
    assert.equal(result.structuredContent?.data?.analysisMetrics?.averageRms, null);
    assert.ok(Math.abs(result.structuredContent?.data?.analysisMetrics?.maxRms - 0.03) < 0.005);
    assert.deepEqual(analyzerCalls, [{ durationSeconds: 1, expectedSidwave: "expected" }]);
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
        verifySilenceBefore: true,
        verifySilenceAfter: true,
        output: "sid",
        waitBeforeCaptureMs: 0,
        analysisDurationSeconds: 1,
        silenceDurationSeconds: 0.5,
        postSilenceWaitMs: 0,
        silenceWaitMs: 0,
      },
      ctx,
    );

    assert.equal(result.metadata.success, true);
    assert.equal(result.structuredContent?.data?.playback?.method, "sidplay_attachment");
    assert.equal(ctx.client.sidplayAttachment.calls.length, 1);
    assert.equal(ctx.client.runPrg.calls.length, 0);
  });

  test("music_compile_play_analyze fails pre-silence verification when the baseline is noisy", async () => {
    ctx.client.recordAndAnalyzeAudio = mock(async () => createAnalysis({ averageRms: 0.03, maxRms: 0.05 }));

    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      {
        sidwave: SAMPLE_SIDWAVE,
        verifySilenceBefore: true,
        verifySilenceAfter: true,
        waitBeforeCaptureMs: 0,
        silenceRmsThreshold: 0.02,
        silenceWaitMs: 0,
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.metadata.error?.kind, "execution");
    assert.ok(result.metadata.error?.details?.metrics?.maxRms > 0.02);
    assert.equal(ctx.client.runPrg.calls.length, 0);
  });

  test("music_compile_play_analyze reports when the main capture yields no RMS measurement", async () => {
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
        verifySilenceBefore: true,
        verifySilenceAfter: true,
        waitBeforeCaptureMs: 0,
        analysisDurationSeconds: 1,
        silenceDurationSeconds: 0.5,
        postSilenceWaitMs: 0,
        silenceWaitMs: 0,
      },
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.metadata.success, true);
    assert.equal(result.metadata.analyzed, false);
    assert.equal(result.structuredContent.data.analysis, null);
    assert.equal(result.structuredContent.data.analysisMetrics, undefined);
    assert.equal(result.structuredContent.data.verification.measured, false);
    assert.match(result.structuredContent.data.verification.message, /no measurement.*RMS metrics/i);
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

    assert.equal(result.isError, true);
    assert.equal(result.metadata.error?.kind, "execution");
    assert.deepEqual(result.metadata.error?.details?.response, { success: false });
  });

  test("music_compile_play_analyze returns validation errors for invalid SIDWAVE input", async () => {
    const result = await metaModule.invoke(
      "music_compile_play_analyze",
      {
        sidwave: "not valid yaml: [",
        verifySilenceBefore: false,
        verifySilenceAfter: false,
      },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.metadata.error?.kind, "validation");
    assert.equal(result.metadata.error?.path, "$");
  });

  test("music_compile_play_analyze disables post verification by silencing directly", async () => {
    ctx.client.recordAndAnalyzeAudio = mock(async () => createAnalysis({ averageRms: 0.06, maxRms: 0.09 }));

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

    assert.equal(result.metadata.success, true);
    assert.equal(result.structuredContent?.data?.silenceChecks?.before, null);
    assert.equal(result.structuredContent?.data?.silenceChecks?.after, null);
    assert.equal(ctx.client.sidSilenceAll.calls.length, 1);
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
        verify: true,
        platforms: ["vice", "c64u"],
        waitBeforeCaptureMs: 0,
        analysisDurationSeconds: 1,
      },
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.metadata.success, true);
    assert.equal(result.metadata.preset, "fuer_elise");
    assert.equal(result.metadata.requestedPreset, legacyAlias);
    assert.equal(result.metadata.legacyAliasUsed, true);
    assert.equal(result.structuredContent.data.title, "Für Elise");
    assert.equal(result.structuredContent.data.results.length, 2);
    assert.equal(result.structuredContent.data.results[0].verification.mode, "audio-analysis");
    assert.equal(ctx.client.recordAndAnalyzeAudio.calls.length, 2);
    assert.equal(result.structuredContent.data.results[1].verification.mode, "audio-analysis");
    assert.equal(result.structuredContent.data.results[1].verification.voices[0].detected_notes[0].note, "E5");
    assert.equal(ctx.client.runPrg.calls.length, 2);
    const [analysisOptions] = ctx.client.recordAndAnalyzeAudio.calls[0];
    assert.equal(analysisOptions.durationSeconds, 1);
    assert.equal(typeof analysisOptions.expectedSidwave, "string");
    assert.deepEqual(switches, ["vice", "c64u", "c64u"]);
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
        verify: true,
        platforms: ["c64u"],
        waitBeforeCaptureMs: 0,
        analysisDurationSeconds: 1,
      },
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.metadata.success, true);
    assert.equal(result.metadata.preset, "fuer_elise");
    assert.equal(result.metadata.legacyAliasUsed, false);
    assert.equal(result.structuredContent.data.title, "Für Elise");
    assert.equal(result.structuredContent.data.results[0].verification.mode, "audio-analysis");
    assert.equal(ctx.client.runPrg.calls.length, 1);
  });

  test("music_play_preset leaves the last backend playing and silences earlier ones before switching", async () => {
    const events = [];
    let activeBackend = "c64u";
    ctx.client.getActiveBackendType = mock(async () => activeBackend);
    ctx.client.getAvailableBackends = mock(() => ["vice", "c64u"]);
    ctx.client.switchBackend = mock((backend) => { activeBackend = backend; events.push(`switch:${backend}`); });
    ctx.client.sidSilenceAll = mock(async () => { events.push(`silence:${activeBackend}`); return { success: true }; });
    ctx.client.runPrg = mock(async () => { events.push(`play:${activeBackend}`); return { success: true }; });

    const result = await metaModule.invoke(
      "music_play_preset",
      { preset: "fuer_elise", platforms: ["vice", "c64u"], verify: false, restoreActiveBackend: false },
      ctx,
    );

    assert.equal(result.metadata.success, true);
    // Each backend is silenced before it plays; vice is stopped before switching to c64u,
    // and c64u, the last backend, keeps playing.
    assert.deepEqual(events, ["switch:vice", "silence:vice", "play:vice", "silence:vice", "switch:c64u", "silence:c64u", "play:c64u"]);
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

    assert.equal(result.isError, true);
    assert.equal(result.metadata.error?.kind, "execution");
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

    assert.equal(result.isError, true);
    assert.equal(result.metadata.error?.kind, "execution");
  });

  for (const key of ["chiptune_drive", "ambient_filter", "funk_bass"]) {
    test(`music_play_preset compiles and launches ${key} with all the featured sounds`, async () => {
      ctx.client.getActiveBackendType = mock(async () => "c64u");
      ctx.client.getAvailableBackends = mock(() => ["c64u"]);
      ctx.client.switchBackend = mock(async () => {});
      const args = key === "chiptune_drive" ? {} : { preset: key };
      const result = await metaModule.invoke("music_play_preset", { ...args, verify: false }, ctx);
      assert.equal(result.isError, undefined);
      assert.equal(result.metadata.preset, key);
      const source = result.structuredContent.data.sidwave;
      const score = parseSidwave(source);
      if (key === "chiptune_drive") {
        assert.equal(score.speed, 2);
        assert.ok(score.song.tempo >= 125 && score.song.tempo <= 140);
      }
      for (const name of ["kick", "snare", "hat", "filter_bass", "lead_pwm"]) assert.ok(source.includes(`lib:${name}`));
      assert.match(source, /lib:chip_arp_(major|minor)/);
      const arrangement = arrangeSidwave(score);
      assert.ok(arrangement.instruments.some((instrument) => instrument.wave & 0x06));
      assert.ok(arrangement.instruments.some((instrument) => instrument.pulsetable && instrument.vibRate > 0));
      assert.ok(arrangement.voices.some(({ notes }) => notes.some((note) => note.legato && note.portamento > 0)));
      assert.equal(ctx.client.runPrg.calls.length, 1);
      const [prg] = ctx.client.runPrg.calls[0];
      assert.ok(0x0801 + prg.length - 2 < SIDWAVE_MEMORY_END);
    });
  }
});
