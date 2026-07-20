import test from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import { audioModule } from "../src/tools/audio.js";

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function buildSidwaveDoc() {
  return {
    song: {
      title: "Test Song",
      tempo: 110,
      mode: "PAL",
      length_bars: 2,
    },
    voices: [
      {
        id: 1,
        name: "Lead",
        waveform: "triangle",
        adsr: [2, 2, 10, 3],
        pulse_width: 2048,
        patterns: {
          main: {
            type: "arpeggio",
            notes: ["C4", "E4", "G4"],
          },
        },
      },
    ],
    timeline: [
      {
        section: "A",
        bars: 2,
        layers: {
          v1: "main",
        },
      },
    ],
  };
}

test("music_generate builds timeline and triggers SID sequence", async () => {
  const volumeCalls = [];
  const noteCalls = [];
  let noteOffCount = 0;

  const ctx = {
    client: {
      sidSetVolume: async (volume) => {
        volumeCalls.push(volume);
        return { success: true };
      },
      sidNoteOn: async (payload) => {
        noteCalls.push(payload);
        return { success: true };
      },
      sidNoteOff: async () => {
        noteOffCount += 1;
        return { success: true };
      },
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke(
    "music_generate",
    { root: "C4", pattern: "0,4", steps: 2, tempoMs: 40, waveform: "tri" },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.metadata.intervals, [0, 4]);
  assert.equal(result.metadata.steps, 2);
  assert.equal(result.metadata.timeline.length, 2);

  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(volumeCalls.length, 1);
  assert.equal(noteCalls.length, 2);
  // HARD01-033: the gate is cleared between every note (steps) plus a final
  // release, so envelope articulation retriggers for each note.
  assert.equal(noteOffCount, 3);
  assert.deepEqual(noteCalls.map((call) => call.note), ["C4", "E4"]);
});

test("music_generate defaults to triangle waveform and best-practice ADSR", async () => {
  const volumeCalls = [];
  const noteCalls = [];
  let noteOffCount = 0;

  const ctx = {
    client: {
      sidSetVolume: async (v) => { volumeCalls.push(v); return { success: true }; },
      sidNoteOn: async (p) => { noteCalls.push(p); return { success: true }; },
      sidNoteOff: async () => { noteOffCount += 1; return { success: true }; },
    },
    logger: createLogger(),
  };

  // Omit waveform and ADSR to exercise defaults
  const result = await audioModule.invoke(
    "music_generate",
    { root: "C4", pattern: "0", steps: 1, tempoMs: 30 },
    ctx,
  );

  assert.equal(result.isError, undefined);
  // Wait a tick for the fire-and-forget playback
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(volumeCalls.length, 1);
  assert.equal(noteCalls.length, 1);
  const call = noteCalls[0];
  assert.equal(call.waveform, "tri");
  assert.equal(call.attack, 1);
  assert.equal(call.decay, 7);
  assert.equal(call.sustain, 15);
  assert.equal(call.release, 0);
  // HARD01-033: one gate-clear before the (non-existent) next note never
  // happens for a single-step run, but the trailing release still fires,
  // plus the loop's own gate-clear for its one note.
  assert.equal(noteOffCount, 2);
});

test("music_generate expression preset uses varied durations and reports preset", async () => {
  const ctx = {
    client: {
      sidSetVolume: async () => ({ success: true }),
      sidNoteOn: async () => ({ success: true }),
      sidNoteOff: async () => ({ success: true }),
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke(
    "music_generate",
    { root: "C4", pattern: "0,4,7", steps: 4, preset: "expression", tempoMs: 50 },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.metadata.preset, "expression");
  const timeline = result.metadata.timeline;
  assert.equal(Array.isArray(timeline), true);
  // Expect the first four durations to match the expressive pattern
  const durations = timeline.slice(0, 4).map((e) => e.durationMs);
  assert.deepEqual(durations, [250, 180, 180, 400]);
});

test("music_generate survives playback error and logs", async () => {
  let noteOnCalls = 0;
  const ctx = {
    client: {
      sidSetVolume: async () => ({ success: true }),
      sidNoteOn: async () => { noteOnCalls += 1; throw new Error("boom"); },
      sidNoteOff: async () => ({ success: true }),
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke(
    "music_generate",
    { root: "C4", pattern: "0", steps: 1, tempoMs: 30 },
    ctx,
  );

  assert.equal(result.isError, undefined);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(noteOnCalls, 1);
});

test("HARD01-030 music_generate pins its facade so a mid-playback backend switch cannot retarget later notes", async () => {
  const events = [];
  let activeFacadeType = "vice";
  const viceFacade = { type: "vice" };
  const c64uFacade = { type: "c64u" };

  const ctx = {
    client: {
      async pinFacade() {
        return activeFacadeType === "vice" ? viceFacade : c64uFacade;
      },
      async sidSetVolume(volume, facade) {
        events.push({ op: "volume", facade: facade?.type });
        return { success: true };
      },
      async sidNoteOn(payload, facade) {
        events.push({ op: `note-on-${payload.note}`, facade: facade?.type });
        // Simulate a concurrent c64_select_backend firing mid-arpeggio.
        activeFacadeType = "c64u";
        return { success: true };
      },
      async sidNoteOff(voice, facade) {
        events.push({ op: "note-off", facade: facade?.type });
        return { success: true };
      },
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke(
    "music_generate",
    { root: "C4", pattern: "0,4", steps: 2, tempoMs: 20, waveform: "tri" },
    ctx,
  );
  assert.equal(result.isError, undefined);

  await new Promise((resolve) => setTimeout(resolve, 150));

  // Every write must have used the facade pinned when the arpeggio started
  // (vice), never the one made active by the mid-flight switch (c64u).
  assert.ok(events.length > 0);
  assert.ok(events.every((event) => event.facade === "vice"), JSON.stringify(events));
});

test("music_compile_and_play compiles SIDWAVE to PRG and runs on C64", async () => {
  let runPrgCalls = 0;
  let sidAttachmentCalls = 0;

  const ctx = {
    client: {
      runPrg: async (prg) => {
        runPrgCalls += 1;
        assert.ok(prg instanceof Uint8Array || Buffer.isBuffer(prg));
        return { success: true, details: { bytes: prg.length } };
      },
      sidplayAttachment: async () => {
        sidAttachmentCalls += 1;
        return { success: true };
      },
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke(
    "music_compile_and_play",
    { sidwave: buildSidwaveDoc() },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.ranOnC64, true);
  assert.equal(result.metadata.format, "prg");
  assert.equal(runPrgCalls, 1);
  assert.equal(sidAttachmentCalls, 0);
});

test("music_compile_and_play can emit SID and use attachment playback", async () => {
  let sidAttachmentCalls = 0;

  const ctx = {
    client: {
      runPrg: async () => {
        throw new Error("runPrg should not be called for SID output");
      },
      sidplayAttachment: async (sidBuffer) => {
        sidAttachmentCalls += 1;
        assert.ok(Buffer.isBuffer(sidBuffer));
        return { success: true, details: { bytes: sidBuffer.length } };
      },
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke(
    "music_compile_and_play",
    { sidwave: buildSidwaveDoc(), output: "sid" },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.format, "sid");
  assert.equal(result.metadata.ranOnC64, true);
  assert.equal(sidAttachmentCalls, 1);
});

test("sidplay_file delegates to C64 client and returns metadata", async () => {
  const calls = [];
  const ctx = {
    client: {
      sidplayFile: async (path, songnr) => {
        calls.push({ path, songnr });
        return { success: true, details: { path, songnr } };
      },
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke(
    "sidplay_file",
    { path: "/music/song.sid", songnr: 1 },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { path: "/music/song.sid", songnr: 1 });
  assert.equal(result.metadata.path, "/music/song.sid");
  assert.equal(result.metadata.songnr, 1);
});

test("modplay_file delegates to C64 client", async () => {
  const calls = [];
  const ctx = {
    client: {
      modplayFile: async (path) => {
        calls.push(path);
        return { success: true, details: { path } };
      },
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke(
    "modplay_file",
    { path: "/music/song.mod" },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "/music/song.mod");
  assert.equal(result.metadata.path, "/music/song.mod");
});

test("music_compile_and_play handles C64 firmware failure for PRG", async () => {
  const ctx = {
    client: {
      runPrg: async () => {
        return { success: false, details: { error: "firmware error" } };
      },
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke(
    "music_compile_and_play",
    { sidwave: buildSidwaveDoc() },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("firmware reported failure"));
});

test("music_compile_and_play handles C64 firmware failure for SID", async () => {
  const ctx = {
    client: {
      sidplayAttachment: async () => {
        return { success: false, details: { error: "firmware error" } };
      },
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke(
    "music_compile_and_play",
    { sidwave: buildSidwaveDoc(), output: "sid" },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("firmware reported failure"));
});

test("music_compile_and_play wraps unexpected errors", async () => {
  const ctx = {
    client: {
      runPrg: async () => { throw new Error("unexpected boom"); },
    },
    logger: createLogger(),
  };
  const result = await audioModule.invoke("music_compile_and_play", { sidwave: buildSidwaveDoc() }, ctx);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("unexpected boom"));
});

test("music_compile_and_play validates sidwave input", async () => {
  const ctx = {
    client: {
      runPrg: async () => ({ success: true }),
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke(
    "music_compile_and_play",
    { sidwave: null },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("sidwave or cpg"));
});

test("music_compile_and_play respects dryRun flag", async () => {
  let runPrgCalled = false;
  const ctx = {
    client: {
      runPrg: async () => {
        runPrgCalled = true;
        return { success: true };
      },
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke(
    "music_compile_and_play",
    { sidwave: buildSidwaveDoc(), dryRun: true },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.ranOnC64, false);
  assert.equal(result.metadata.dryRun, true);
  assert.equal(runPrgCalled, false);
});

// --- Additional coverage for audio tools ---

test("sid_volume clamps and normalizes address", async () => {
  const ctx = {
    client: {
      sidSetVolume: async () => ({ success: true, details: { address: 0xD418 } }),
    },
    logger: createLogger(),
  };
  const res = await audioModule.invoke("sid_volume", { volume: 12.9 }, ctx);
  assert.equal(res.isError, undefined);
  assert.equal(res.metadata.appliedVolume, 12);
  assert.equal(res.metadata.address, "$D418");
});

test("sid_volume reports firmware failure", async () => {
  const ctx = { client: { sidSetVolume: async () => ({ success: false, details: { reason: "denied" } }) }, logger: createLogger() };
  const res = await audioModule.invoke("sid_volume", { volume: 10 }, ctx);
  assert.equal(res.isError, true);
});

test("sid_volume wraps unexpected errors", async () => {
  const ctx = { client: { sidSetVolume: async () => { throw "bad"; } }, logger: createLogger() };
  const res = await audioModule.invoke("sid_volume", { volume: 5 }, ctx);
  assert.equal(res.isError, true);
});

test("sid_reset soft and hard", async () => {
  let hard = 0; let soft = 0;
  const ctx = {
    client: {
      sidReset: async (isHard) => { isHard ? hard++ : soft++; return { success: true }; },
    },
    logger: createLogger(),
  };
  const softRes = await audioModule.invoke("sid_reset", {}, ctx);
  const hardRes = await audioModule.invoke("sid_reset", { hard: true }, ctx);
  assert.equal(softRes.isError, undefined);
  assert.equal(hardRes.isError, undefined);
  assert.equal(soft, 1);
  assert.equal(hard, 1);
});

test("sid_reset reports firmware failure and unexpected errors", async () => {
  const failure = await audioModule.invoke("sid_reset", { hard: true }, {
    client: { sidReset: async () => ({ success: false, details: "denied" }) },
    logger: createLogger(),
  });
  assert.equal(failure.isError, true);

  const unexpected = await audioModule.invoke("sid_reset", {}, {
    client: { sidReset: async () => { throw new Error("boom"); } },
    logger: createLogger(),
  });
  assert.equal(unexpected.isError, true);
});

test("sid_note_on passes parameters and returns metadata", async () => {
  const calls = [];
  const ctx = {
    client: {
      sidNoteOn: async (p) => { calls.push(p); return { success: true }; },
    },
    logger: createLogger(),
  };
  const res = await audioModule.invoke("sid_note_on", { voice: 2, note: "A4", waveform: "tri", pulseWidth: 1000, attack: 2, decay: 3, sustain: 4, release: 5 }, ctx);
  assert.equal(res.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(res.metadata.voice, 2);
  assert.equal(res.metadata.waveform, "tri");
});

test("sid_note_on surfaces firmware failure", async () => {
  const ctx = { client: { sidNoteOn: async () => ({ success: false, details: { e: 1 } }) }, logger: createLogger() };
  const res = await audioModule.invoke("sid_note_on", { voice: 1, frequencyHz: 440 }, ctx);
  assert.equal(res.isError, true);
});

test("sid_note_on uses default PAL reminder when system is omitted", async () => {
  const res = await audioModule.invoke("sid_note_on", {
    voice: 1,
    note: "C4",
  }, {
    client: { sidNoteOn: async () => ({ success: true, details: { address: "d400" } }) },
    logger: createLogger(),
  });

  assert.equal(res.isError, undefined);
  assert.equal(res.metadata.system, "PAL");
  assert.ok(String(res.content[0].text).includes("Using PAL timing"));
});

test("sid_note_off and silence_all", async () => {
  const ctx = {
    client: {
      sidNoteOff: async () => ({ success: true }),
      sidSilenceAll: async () => ({ success: true }),
    },
    logger: createLogger(),
  };
  const off = await audioModule.invoke("sid_note_off", { voice: 1 }, ctx);
  const silence = await audioModule.invoke("sid_silence_all", {}, ctx);
  assert.equal(off.isError, undefined);
  assert.equal(silence.isError, undefined);
});

test("sid_note_off reports firmware failure", async () => {
  const res = await audioModule.invoke("sid_note_off", { voice: 2 }, {
    client: { sidNoteOff: async () => ({ success: false, details: "busy" }) },
    logger: createLogger(),
  });

  assert.equal(res.isError, true);
});

test("sid_note_off wraps unexpected errors", async () => {
  const res = await audioModule.invoke("sid_note_off", { voice: 2 }, {
    client: { sidNoteOff: async () => { throw new Error("note off boom"); } },
    logger: createLogger(),
  });

  assert.equal(res.isError, true);
  assert.ok(String(res.content[0].text).includes("note off boom"));
});

test("sid_silence_all verify reports silence metrics", async () => {
  const ctx = {
    client: {
      sidSilenceAll: async () => ({ success: true, details: { address: 0xd400 } }),
      recordAndAnalyzeAudio: async ({ durationSeconds }) => ({
        analysis: {
          durationSeconds,
          global_metrics: {
            average_rms: 0.01,
            max_rms: 0.015,
          },
        },
      }),
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke("sid_silence_all", { verify: true }, ctx);

  assert.equal(result.isError, undefined);
  assert.ok(result.metadata);
  assert.equal(result.metadata.verify, true);
  assert.ok(result.metadata.verification);
  assert.equal(result.metadata.verification.silent, true);
  assert.ok(result.metadata.verification.maxRms <= 0.02);
});

test("sid_silence_all verify fails when residual audio remains", async () => {
  const ctx = {
    client: {
      sidSilenceAll: async () => ({ success: true }),
      recordAndAnalyzeAudio: async () => ({
        analysis: {
          durationSeconds: 1.5,
          global_metrics: {
            average_rms: 0.03,
            max_rms: 0.05,
          },
        },
      }),
    },
    logger: createLogger(),
  };

  const result = await audioModule.invoke("sid_silence_all", { verify: true }, ctx);

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("residual audio"));
});

test("sid_silence_all verify fails when analyzer omits RMS metrics", async () => {
  const result = await audioModule.invoke("sid_silence_all", { verify: true }, {
    client: {
      sidSilenceAll: async () => ({ success: true }),
      recordAndAnalyzeAudio: async () => ({
        analysis: {
          durationSeconds: 1.5,
          global_metrics: {},
        },
      }),
    },
    logger: createLogger(),
  });

  assert.equal(result.isError, true);
  assert.ok(String(result.content[0].text).includes("RMS metrics"));
});

test("sid_silence_all surfaces firmware failure before verification", async () => {
  const result = await audioModule.invoke("sid_silence_all", { verify: true }, {
    client: {
      sidSilenceAll: async () => ({ success: false }),
    },
    logger: createLogger(),
  });

  assert.equal(result.isError, true);
  assert.ok(String(result.content[0].text).includes("silencing SID"));
});

test("sidplay_file and modplay_file surface execution failures", async () => {
  const sidResult = await audioModule.invoke("sidplay_file", { path: "/music/bad.sid" }, {
    client: {
      sidplayFile: async () => ({ success: false, details: "offline" }),
    },
    logger: createLogger(),
  });
  assert.equal(sidResult.isError, true);

  const modResult = await audioModule.invoke("modplay_file", { path: "/music/bad.mod" }, {
    client: {
      modplayFile: async () => { throw new Error("mod boom"); },
    },
    logger: createLogger(),
  });
  assert.equal(modResult.isError, true);
});

test("sidplay_file wraps unexpected failures and modplay_file surfaces firmware failures", async () => {
  const sidResult = await audioModule.invoke("sidplay_file", { path: "/music/crash.sid" }, {
    client: {
      sidplayFile: async () => { throw new Error("sid crash"); },
    },
    logger: createLogger(),
  });
  assert.equal(sidResult.isError, true);
  assert.ok(String(sidResult.content[0].text).includes("sid crash"));

  const modResult = await audioModule.invoke("modplay_file", { path: "/music/fail.mod" }, {
    client: {
      modplayFile: async () => ({ success: false }),
    },
    logger: createLogger(),
  });
  assert.equal(modResult.isError, true);
  assert.ok(String(modResult.content[0].text).includes("MOD playback"));
});

test("analyze_audio returns guidance when no keywords detected", async () => {
  const res = await audioModule.invoke("analyze_audio", { request: "just print status" }, { client: {} });
  assert.equal(res.isError, undefined);
  assert.ok(res.content[0].text.includes("No audio verification keywords"));
});

test("analyze_audio wraps backend errors when keywords present", async () => {
  const res = await audioModule.invoke("analyze_audio", { request: "please check if the music sounds right" }, { client: {} });
  assert.equal(res.isError, true);
});

test("analyze_audio reports missing analysis and moderate pitch drift feedback", async () => {
  const missing = await audioModule.invoke("analyze_audio", { request: "please check if the music sounds right" }, {
    client: {
      recordAndAnalyzeAudio: async () => ({}),
    },
    logger: createLogger(),
  });
  assert.equal(missing.isError, undefined);
  assert.ok(String(missing.content[0].text).includes("no musical content"));

  const moderate = await audioModule.invoke("analyze_audio", { request: "does the music sound right?" }, {
    client: {
      recordAndAnalyzeAudio: async () => ({
        analysis: {
          durationSeconds: 2,
          voices: [{ id: 1, detected_notes: [{ note: "A4", frequency: 440 }], average_deviation: 30 }],
          global_metrics: {
            average_pitch_deviation: 30,
            detected_bpm: 128,
          },
        },
      }),
    },
    logger: createLogger(),
  });
  assert.equal(moderate.isError, undefined);
  assert.ok(String(moderate.content[0].text).includes("Detected tempo: 128 BPM"));
  assert.ok(String(moderate.content[0].text).includes("some pitch variation"));
});

test("record_and_analyze_audio returns error when backend missing", async () => {
  const res = await audioModule.invoke("record_and_analyze_audio", { durationSeconds: 0.5 }, { client: {} });
  assert.equal(res.isError, true);
});

test("record_and_analyze_audio validates schema-level errors", async () => {
  const res = await audioModule.invoke("record_and_analyze_audio", { durationSeconds: 0.1 }, { client: {} });
  assert.equal(res.isError, true);
  assert.ok(String(res.content[0].text).length > 0);
});

test("music_generate validates pattern input", async () => {
  const res = await audioModule.invoke("music_generate", { root: "C4", pattern: "", steps: 1, tempoMs: 50, waveform: "pulse" }, { client: {} });
  assert.equal(res.isError, true);
});

test("music_compile_and_play accepts cpg text input on dry run", async () => {
  const sidwaveText = `
song:
  title: Test Song
  tempo: 110
  mode: PAL
  length_bars: 1
voices:
  - id: 1
    name: Lead
    waveform: triangle
    adsr: [2, 2, 10, 3]
    pulse_width: 2048
    patterns:
      main:
        type: arpeggio
        notes: [C4, E4, G4]
timeline:
  - section: A
    bars: 1
    layers:
      v1: main
`;
  const result = await audioModule.invoke("music_compile_and_play", {
    cpg: sidwaveText,
    dryRun: true,
  }, {
    client: {},
    logger: createLogger(),
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.metadata.dryRun, true);
  assert.equal(result.metadata.ranOnC64, false);
});

test("music_compile_and_play rejects empty sidwave strings", async () => {
  const result = await audioModule.invoke("music_compile_and_play", {
    sidwave: "   ",
    dryRun: true,
  }, {
    client: {},
    logger: createLogger(),
  });

  assert.equal(result.isError, true);
  assert.ok(String(result.content[0].text).includes("must not be empty"));
});
