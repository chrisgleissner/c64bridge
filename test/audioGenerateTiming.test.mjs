import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { arrangeSidwave } from "../src/sidwaveCompiler.js";
import { midiToNoteName, parseSidwave } from "../src/sidwave.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
async function generate(args) {
  const client = { runPrg: async () => ({ success: true }) };
  const platform = { id: "vice", features: [], limitedFeatures: [] };
  const result = await toolRegistry.invoke("c64_sound", { op: "generate", includeScore: true, ...args }, { client, logger, platform });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const score = parseSidwave(result.metadata.sidwave);
  return { ...result.metadata, score, arrangement: arrangeSidwave(score) };
}

test("generate uses a seeded progression, repeatable hooks and three arranged voices", async () => {
  const original = await generate({ seed: 65, system: "PAL" });
  const repeat = await generate({ seed: 65, system: "PAL" });
  const alternate = await generate({ seed: 64, system: "PAL" });
  assert.equal(original.sidwave, repeat.sidwave);
  assert.notEqual(original.sidwave, alternate.sidwave);
  assert.notEqual(original.key, alternate.key);
  assert.equal(original.score.song.length_bars, 8);
  const raw = JSON.parse(original.sidwave);
  assert.equal(raw.voices.length, 3);
  for (const drum of ["kick", "snare", "hat"]) assert.ok(original.sidwave.includes(`lib:${drum}`));
  assert.match(original.sidwave, /lib:chip_arp_(major|minor)/);
  assert.ok(original.arrangement.voices[2].notes.some((note) => note.legato && note.portamento > 0));
  const lead = raw.voices[2].patterns.Lead.groove;
  assert.deepEqual(lead.slice(0, 12), lead.slice(24, 36), "bars 5–6 repeat the hook exactly");
  assert.notEqual(original.sidwave, (await generate({ seed: 7, system: "PAL" })).sidwave);
});

test("generate styles set distinct tempos, voices and accents", async () => {
  const ambient = await generate({ style: "ambient", root: "D4" });
  assert.equal(ambient.tempo, 80);
  assert.match(ambient.key, /^D /);
  assert.match(ambient.sidwave, /lib:pad_slow/);
  assert.match(ambient.sidwave, /lib:bell_ring/);
  assert.ok(ambient.arrangement.instruments.some((inst) => inst.filtertable));
  const funk = await generate({ style: "funk" });
  assert.equal(funk.tempo, 105);
  assert.match(funk.sidwave, /lib:sync_lead/);
  assert.match(funk.sidwave, /lib:bass_pluck/);
});

test("generate keeps explicit root, pattern, steps, tempoMs, waveform, preset and system", async () => {
  const music = await generate({
    root: "D4", pattern: "0,3,7", steps: 5, tempoMs: 20, waveform: "saw", preset: "classic", system: "NTSC",
  });
  assert.equal(music.system, "NTSC");
  assert.equal(music.score.song.mode, "NTSC");
  assert.equal(music.steps, 5);
  assert.equal(music.waveform, "saw");
  assert.deepEqual(music.timeline.map(({ note }) => note), ["D4", "F4", "A4", "D4", "F4"]);
  const lead = music.arrangement.voices[2].notes;
  assert.deepEqual(lead.map(({ midi }) => midiToNoteName(midi)), ["D4", "F4", "A4", "D4", "F4"]);
  assert.deepEqual(lead.map(({ start }) => start), [0, 20, 40, 60, 80].map((ms) => Math.round(ms * music.arrangement.fps / 1000)));
  assert.ok(lead.every(({ inst }) => (music.arrangement.instruments[inst].wave & 0xf0) === 0x20));
  assert.equal(music.arrangement.voices[2].notes.length, 5);

  const expression = await generate({ root: "A3", pattern: "0,12", steps: 4, tempoMs: 60, preset: "expression", waveform: "noise" });
  assert.deepEqual(expression.timeline.map(({ durationMs }) => durationMs), [250, 180, 180, 400]);
  assert.equal(expression.preset, "expression");
});
