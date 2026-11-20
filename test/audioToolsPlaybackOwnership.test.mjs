import test from "#test/runner";
import assert from "#test/assert";
import { audioModule } from "../src/tools/audio.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const SONG = "sidwave: 1.0\ntempo: 120\nvoices:\n  - id: 1\n    patterns: { A: { groove: [C4, E4] } }\ntimeline:\n  - { bars: 1, layers: { v1: A } }\n";

function makeClient() {
  const events = [];
  const facade = { type: "vice" };
  return {
    events,
    client: {
      pinFacade: async () => facade,
      runPrg: async () => { events.push("run"); return { success: true }; },
      stopSidwavePlayback: async (pinned) => { assert.equal(pinned, facade); events.push("stop"); },
      sidNoteOn: async () => { events.push("on"); return { success: true }; },
      sidNoteOff: async () => { events.push("off"); return { success: true }; },
      sidplayFile: async () => { events.push("sid"); return { success: true }; },
      modplayFile: async () => { events.push("mod"); return { success: true }; },
    },
  };
}

for (const [tool, args, event] of [
  ["music_generate", {}, "run"],
  ["music_compile_and_play", { sidwave: SONG }, "run"],
  ["sidplay_file", { path: "/a.sid" }, "sid"],
  ["modplay_file", { path: "/a.mod" }, "mod"],
  ["sid_note_on", { voice: 2, note: "C4" }, "on"],
  ["sid_note_off", { voice: 2 }, "off"],
]) {
  test(`${tool} takes over after stopping the generated SIDWAVE PRG`, async () => {
    const { client, events } = makeClient();
    const ctx = { client, logger };
    assert.equal((await audioModule.invoke("music_generate", {}, ctx)).isError, undefined);
    assert.equal((await audioModule.invoke(tool, args, ctx)).isError, undefined);
    assert.deepEqual(events, ["run", "stop", event]);
  });
}

test("a dry-run compile leaves the installed SIDWAVE PRG playing", async () => {
  const { client, events } = makeClient();
  const ctx = { client, logger };
  assert.equal((await audioModule.invoke("music_generate", {}, ctx)).isError, undefined);
  assert.equal((await audioModule.invoke("music_compile_and_play", { sidwave: SONG, dryRun: true }, ctx)).isError, undefined);
  assert.deepEqual(events, ["run"]);
});

test("sid_note_on states the $02A6 polarity as 1 = PAL, 0 = NTSC (MEDIA-4)", async () => {
  const { client } = makeClient();
  const res = await audioModule.invoke("sid_note_on", { voice: 1, note: "A4" }, { client, logger });
  const text = JSON.stringify(res);
  assert.ok(/1 = PAL, 0 = NTSC/.test(text), text.slice(0, 400));
  assert.ok(!/1=NTSC/.test(text));
});
