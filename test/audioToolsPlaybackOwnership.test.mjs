import test from "#test/runner";
import assert from "#test/assert";
import { audioModule, cancelGeneratedSidPlayback } from "../src/tools/audio.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const SONG = "sidwave: 1.0\ntempo: 120\nvoices:\n  - id: 1\n    patterns: { A: { groove: [C4, E4] } }\ntimeline:\n  - { bars: 1, layers: { v1: A } }\n";

function makeClient(extra = {}) {
  const state = { noteOns: 0 };
  return {
    state,
    client: {
      sidSetVolume: async () => ({ success: true }),
      sidNoteOn: async () => { state.noteOns += 1; return { success: true }; },
      sidNoteOff: async () => ({ success: true }),
      runPrg: async () => ({ success: true }),
      sidplayFile: async () => ({ success: true }),
      modplayFile: async () => ({ success: true }),
      sidplayAttachment: async () => ({ success: true }),
      ...extra,
    },
  };
}

async function startGenerate(ctx) {
  await audioModule.invoke("music_generate", { steps: 128, tempoMs: 20 }, ctx);
  const deadline = Date.now() + 2000;
  while (ctx.state.noteOns === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
}

for (const [name, tool, args] of [
  ["music_compile_and_play", "music_compile_and_play", { sidwave: SONG }],
  ["sidplay_file", "sidplay_file", { path: "/a.sid" }],
  ["modplay_file", "modplay_file", { path: "/a.mod" }],
  ["sid_note_on", "sid_note_on", { voice: 2, note: "C4" }],
  ["sid_note_off", "sid_note_off", { voice: 2 }],
]) {
  test(`${name} stops a running music_generate sequence (SOUND-6)`, async () => {
    const { client, state } = makeClient();
    const ctx = { client, logger, state };
    try {
      await startGenerate(ctx);
      assert.ok(state.noteOns > 0);
      await audioModule.invoke(tool, args, { client, logger });
      await new Promise((r) => setTimeout(r, 30)); // lets an in-flight step finish
      const settled = state.noteOns;
      await new Promise((r) => setTimeout(r, 120));
      // sid_note_on itself issues one note; the generated sequence must add none
      assert.equal(state.noteOns, settled);
    } finally {
      cancelGeneratedSidPlayback();
    }
  });
}

test("a dry-run compile does not stop a running music_generate sequence (SOUND-6)", async () => {
  const { client, state } = makeClient();
  try {
    await startGenerate({ client, logger, state });
    await audioModule.invoke("music_compile_and_play", { sidwave: SONG, dryRun: true }, { client, logger });
    const before = state.noteOns;
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(state.noteOns > before);
  } finally {
    cancelGeneratedSidPlayback();
  }
});

test("sid_note_on states the $02A6 polarity as 1 = PAL, 0 = NTSC (MEDIA-4)", async () => {
  const { client } = makeClient();
  const res = await audioModule.invoke("sid_note_on", { voice: 1, note: "A4" }, { client, logger });
  const text = JSON.stringify(res);
  assert.ok(/1 = PAL, 0 = NTSC/.test(text), text.slice(0, 400));
  assert.ok(!/1=NTSC/.test(text));
});
