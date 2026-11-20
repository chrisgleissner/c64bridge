import test from "#test/runner";
import assert from "#test/assert";
import { audioModule } from "../src/tools/audio.js";
import { machineControlModule } from "../src/tools/machineControl.js";
import { setPlatform } from "../src/platform.js";

// HARD06 wave 2 P2: reset, reboot and power_cycle stop a generated sequence; the SID system defaults
// from $02A6; set_volume exposes filterMode; the recording tool passes its abort signal.

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeClient(flag, extra = {}) {
  const state = { noteOns: 0, noteOnSystems: [], volumeCalls: [] };
  return {
    state,
    client: {
      async readMemoryRaw(address) { if (address !== 0x02a6 || flag === undefined) throw new Error("unreadable"); return Uint8Array.of(flag); },
      sidSetVolume: async (...a) => { state.volumeCalls.push(a); return { success: true, details: { notice: "filter bits cleared" } }; },
      sidNoteOn: async (o) => { state.noteOns += 1; state.noteOnSystems.push(o.system); return { success: true }; },
      sidNoteOff: async () => ({ success: true }),
      reset: async () => ({ success: true, details: {} }),
      reboot: async () => ({ success: true, details: {} }),
      powerCycle: async () => ({ success: true, details: {} }),
      ...extra,
    },
  };
}

for (const tool of ["reset_c64", "reboot_c64", "power_cycle"]) {
  test(`${tool} detaches generated SIDWAVE playback before controlling the machine`, async () => {
    setPlatform("c64u");
    const calls = [];
    const operation = { reset_c64: "reset", reboot_c64: "reboot", power_cycle: "powerCycle" }[tool];
    const { client } = makeClient(1, {
      runPrg: async () => { calls.push("generate"); return { success: true }; },
      stopSidwavePlayback: async () => { calls.push("stop"); },
      [operation]: async () => { calls.push(tool); return { success: true }; },
    });
    assert.equal((await audioModule.invoke("music_generate", {}, { client, logger })).isError, undefined);
    assert.equal((await machineControlModule.invoke(tool, {}, { client, logger })).isError, undefined);
    assert.deepEqual(calls, ["generate", "stop", tool]);
  });
}

test("note_on without system reads $02A6 and states the source", async () => {
  const ntsc = makeClient(0);
  const res = await audioModule.invoke("sid_note_on", { voice: 1, note: "A4" }, { client: ntsc.client, logger });
  assert.deepEqual(ntsc.state.noteOnSystems, ["NTSC"]);
  assert.equal(res.structuredContent.data.system, "NTSC");
  assert.match(res.content[0].text, /NTSC timing \(read from the machine \(\$02A6 = 0\)\)/);
  const pal = makeClient(1);
  await audioModule.invoke("sid_note_on", { voice: 1, note: "A4" }, { client: pal.client, logger });
  assert.deepEqual(pal.state.noteOnSystems, ["PAL"]);
});

test("an explicit system wins, and an unreadable flag falls back to PAL with a notice", async () => {
  const given = makeClient(1);
  await audioModule.invoke("sid_note_on", { voice: 1, note: "A4", system: "NTSC" }, { client: given.client, logger });
  assert.deepEqual(given.state.noteOnSystems, ["NTSC"]);
  const none = makeClient(undefined);
  const res = await audioModule.invoke("sid_note_on", { voice: 1, note: "A4" }, { client: none.client, logger });
  assert.deepEqual(none.state.noteOnSystems, ["PAL"]);
  assert.match(res.content[0].text, /\$02A6 could not be read/);
});

test("set_volume passes filterMode and reports the client's notice", async () => {
  const { client, state } = makeClient(1);
  const res = await audioModule.invoke("sid_volume", { volume: 15, filterMode: 1 }, { client, logger });
  assert.deepEqual(state.volumeCalls[0], [15, undefined, { filterMode: 1 }]);
  assert.match(res.content[0].text, /filter bits cleared/);
  await audioModule.invoke("sid_volume", { volume: 5 }, { client, logger });
  assert.deepEqual(state.volumeCalls[1], [5, undefined, undefined]);
});

test("analyze_audio hands its abort signal to the recorder", async () => {
  const seen = [];
  const { client } = makeClient(1, { recordAndAnalyzeAudio: async (o) => { seen.push(o.signal); return { analysis: { summary: "x" }, durationSeconds: 1 }; } });
  const controller = new AbortController();
  await audioModule.invoke("record_and_analyze_audio", { durationSeconds: 1 }, { client, logger, signal: controller.signal }).catch(() => {});
  assert.equal(seen[0], controller.signal);
});
