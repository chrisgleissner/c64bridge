import test from "#test/runner";
import assert from "#test/assert";
import { audioModule, cancelGeneratedSidPlayback } from "../src/tools/audio.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("music_generate passes the video system to every note and reports it (SOUND-7)", async () => {
  const systems = [];
  const client = {
    sidSetVolume: async () => ({ success: true }),
    sidNoteOn: async (o) => { if (o.voice === 1) systems.push(o.system); return { success: true }; },
    sidNoteOff: async () => ({ success: true }),
  };
  try {
    const res = await audioModule.invoke("music_generate", { steps: 2, tempoMs: 40, system: "NTSC" }, { client, logger });
    assert.equal(res.metadata.system, "NTSC");
    const deadline = Date.now() + 2000;
    while (systems.length < 2 && Date.now() < deadline) await sleep(5);
    assert.deepEqual(systems, ["NTSC", "NTSC"]);
    const def = await audioModule.invoke("music_generate", { steps: 1, tempoMs: 40 }, { client, logger });
    assert.equal(def.metadata.system, "PAL");
  } finally {
    cancelGeneratedSidPlayback();
  }
});

test("music_generate note onsets keep the tempo when every REST call takes time (SOUND-6)", async () => {
  const onsets = [];
  const client = {
    sidSetVolume: async () => ({ success: true }),
    sidNoteOn: async ({ voice }) => { if (voice === 1) onsets.push(Date.now()); await sleep(20); return { success: true }; },
    sidNoteOff: async () => { await sleep(20); return { success: true }; },
  };
  try {
    await audioModule.invoke("music_generate", { steps: 4, tempoMs: 100 }, { client, logger });
    const deadline = Date.now() + 3000;
    while (onsets.length < 4 && Date.now() < deadline) await sleep(5);
    const span = onsets[3] - onsets[0];
    assert.ok(span < 345, `three steps took ${span} ms, expected about 300`);
  } finally {
    cancelGeneratedSidPlayback();
  }
});
