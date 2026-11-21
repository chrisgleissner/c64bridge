import test from "#test/runner";
import assert from "#test/assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emulate } from "./helpers/sidwaveFuzzKit.mjs";
import { compileDoc, runPrg, runPsidWrites } from "./helpers/sidwaveEmulator.mjs";
import { parseSidwave } from "../src/sidwave.js";
import { arrangeSidwave, compileSidwaveStem, compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { analyseQuality } from "../src/audio/sidwaveQuality.js";
import { expectedSchedule } from "../src/audio/sidwaveFidelity.js";
import { readWav } from "../src/audio/sidwaveReference.js";

const sidplayfpAvailable = !spawnSync("sidplayfp", ["--help"]).error;

function score(voice, extra = {}) {
  return {
    sidwave: 1.2, mode: "PAL", tempo: 150,
    voices: [{ id: 1, patterns: { A: { groove: ["A4", "E4", "D4", "G4", "A4", "E4", "A4", "D4"] } }, ...voice }],
    timeline: [{ bars: 2, layers: { v1: "A" } }], end: true, ...extra,
  };
}

test("pulse-width fractions give the same 12-bit writes on instruments, voices and tables", () => {
  for (const [fraction, width] of [[0.5, 2048], [0.25, 1024], [0.00025, 1], [1, 4094]]) {
    const instrument = { waveform: "pulse" };
    const variants = [
      score({ instrument: "bass" }, { instruments: { bass: { ...instrument, pulse_width: fraction } } }),
      score({ ...instrument, pulse_width: fraction }),
      score({ instrument: "bass" }, { instruments: { bass: { ...instrument, pulsetable: [{ set: fraction }] } } }),
      score({ ...instrument, pulse_width: width === 1 ? fraction : width }),
    ];
    for (const variant of variants) {
      const { sid } = compileDoc(variant);
      const { calls: [{ regs }] } = runPsidWrites(sid, 1);
      assert.equal(regs[2] + 256 * regs[3], width);
      assert.equal(regs[4] & 0xf1, 0x41);
    }
  }
});

test("hard restart writes gate and then ADSR both when releasing and when starting the next note", () => {
  const { doc, sid } = compileDoc(score({ adsr: [0, 7, 6, 1] }));
  const start = arrangeSidwave(doc).voices[0].notes[1].start;
  const { calls } = runPsidWrites(sid, start + 1);
  const envelopeWrites = (frame) => calls[frame].writes
    .filter(({ addr }) => addr >= 0xd404 && addr <= 0xd406)
    .map(({ addr, value }) => [addr, value]);
  assert.deepEqual(envelopeWrites(start - 2), [[0xd404, 0x40], [0xd405, 0], [0xd406, 0]]);
  assert.deepEqual(envelopeWrites(start), [[0xd404, 0x41], [0xd405, 7], [0xd406, 0x61]]);
});

function sidplayfp(t, sid, model) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-composer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "score.sid");
  const wav = path.join(dir, "score.wav");
  fs.writeFileSync(file, sid);
  const run = spawnSync("sidplayfp", ["-m", model === "8580" ? "-mnf" : "-mof", "-f48000", "-t5", `-w${wav}`, file], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return { dir, wav };
}

for (const model of ["6581", "8580"]) {
  test(`sidplayfp ${model} attack zero sounds within the first frame of every note`, { skip: !sidplayfpAvailable }, (t) => {
    for (const attack of [0, 1]) {
      const { doc, sid } = compileDoc(score({ adsr: [attack, 7, 6, 1] }, { sids: [{ id: "sid1", address: "$D400", model }] }));
      const arrangement = arrangeSidwave(doc);
      const { wav } = sidplayfp(t, sid, model);
      const { samples, sampleRate } = readWav(wav);
      const step = sampleRate / 500;
      const rms = (ms) => {
        const start = Math.round(ms * sampleRate / 1000);
        let sum = 0, squares = 0;
        for (let i = 0; i < step; i++) {
          const sample = samples[start + i] ?? 0;
          sum += sample;
          squares += sample * sample;
        }
        return Math.sqrt(Math.max(0, squares / step - (sum / step) ** 2));
      };
      const onsets = arrangement.voices[0].notes.map(({ start }) => {
        const ms = start * 1000 / arrangement.fps;
        const levels = Array.from({ length: 148 }, (_, i) => rms(ms + i - 48));
        const peak = Math.max(...levels.slice(50));
        // Find the rise after the hard restart silence, ignoring the prior note's release and SID DC offset.
        const quiet = levels.findIndex((level) => level < peak * 0.08);
        const onset = levels.findIndex((level, i) => quiet >= 0 && i > quiet && level > peak * 0.14);
        return onset < 0 ? Infinity : onset - 48;
      });
      t.diagnostic(`attack ${attack} onsets relative to scheduled gate (ms): ${onsets.join(", ")}`);
      assert.ok(onsets.every((ms) => ms >= -2 && ms < 1000 / arrangement.fps + attack * 4), `attack ${attack} onset delays (ms): ${onsets.join(", ")}`);
    }
  });
}

const reviewScore = `sidwave: 1.2
tempo: 150
meter: 3
mode: PAL
voices:
  - id: 1
    waveform: pulse
    patterns:
      vamp: {groove: [A4, E4, D4]}
      vamp2: {groove: [C5, G4, A4]}
  - id: 2
    patterns:
      drum: {groove: ["C3@lib:kick", "C3@lib:hat", E4]}
timeline:
  - section: Intro
    bars: 3
    layers: {v1: vamp vamp vamp2, v2: drum}
  - section: End
    bars: 1
    tempo: 100
    layers: {v1: vamp2, v2: "-"}
end: true
`;

test("review schedule uses section tempi, 3/4 and the compiled drum and sequence events", () => {
  const schedule = expectedSchedule(parseSidwave(reviewScore));
  assert.equal(schedule.percussion.length, 6);
  assert.equal(schedule.percussion.filter(({ start }) => start === 0).length, 1, "the library triangle kick is percussion");
  assert.equal(schedule.notes.length, 15, "the ordinary pulse note on the mixed drum layer stays pitched");
  const seconds = (number) => +number.toFixed(1);
  assert.deepEqual(schedule.bars.map(seconds), [0, 1.2, 2.4, 3.6, 5.4]);
  assert.deepEqual(schedule.sections.map(({ name, start, end }) => ({ name, start: seconds(start), end: seconds(end) })), [{ name: "Intro", start: 0, end: 3.6 }, { name: "End", start: 3.6, end: 5.4 }]);
});

test("review excludes library drum transients and retains unexplained spikes", () => {
  const schedule = expectedSchedule(parseSidwave(reviewScore));
  const sampleRate = 48000;
  const mono = new Float32Array(2 * sampleRate);
  mono[Math.round(0.085 * sampleRate)] = 0.9; // During the triangle kick's pitch sweep.
  mono[Math.round(0.310 * sampleRate)] = 0.9; // Between percussion events.
  const report = analyseQuality({ signal: { left: mono, right: mono, sampleRate }, schedule });
  assert.deepEqual(report.checks.glitches.metrics.times, [0.31]);
});

test("a remapped offline SID stem retains the arranged filter owner and sequenced note writes", () => {
  const source = reviewScore.replace("mode: PAL", `mode: PAL
sids:
  - {id: first, address: "$D400"}
  - {id: second, address: "$D420", filter: {owner: v4, route: [1]}}
instruments:
  bass: { waveform: pulse, filtertable: [{cutoff: 1000, resonance: 8, type: lowpass}] }`)
    .replace("id: 1", "id: 4\n    instrument: bass")
    .replaceAll("v1:", "v4:");
  const doc = parseSidwave(source);
  const arranged = arrangeSidwave(doc);
  const compiled = compileSidwaveToPrg(doc);
  const frames = Math.ceil(arranged.fps * 4);
  const { calls: full } = runPrg(compiled, frames);
  const { calls: stem } = runPsidWrites(compileSidwaveStem(doc, arranged, 1), frames);
  assert.deepEqual(stem.map(({ regs }) => [...regs.slice(0, 25)]),
    full.map(({ regs }) => [...regs.slice(0x20, 0x39)]));
});

test("a play-once echo releases before the final boundary without replaying its first note", () => {
  const song = score({ adsr: [0, 7, 6, 3], patterns: { A: { groove: ["A4", ...Array(7).fill("~")] } } });
  song.voices.push({ id: 2, echo: { voice: 1, delay: 8, volume: 0.5 } });
  const compiled = compileSidwaveToPrg(parseSidwave(song));
  const { calls } = runPrg(compiled, compiled.totalFrames + 1);
  const gate = (frame) => calls[frame].regs[11] & 1;
  assert.equal(gate(compiled.totalFrames - 2), 1);
  assert.equal(gate(compiled.totalFrames - 1), 0);
  assert.deepEqual(calls[compiled.totalFrames].writes, []);
});

test("cycle measurement starts the same CIA2 period fresh after a short hit", () => {
  const doc = parseSidwave(score({}, {
    samples: { rate: 5000, defs: { short: { hex: "a1" }, long: { hex: "0123456789abcdef".repeat(64) } },
      triggers: [{ sample: "short", at: [0] }, { sample: "long", at: [1] }] },
  }));
  const compiled = compileSidwaveToPrg(doc);
  const faults = [];
  emulate(doc, compiled, { loop: false, maxCalls: 4 }, (kind, detail) => faults.push([kind, detail]));
  assert.deepEqual(faults, []);
});

test("review runs without an explicit offset on a sequence score", { skip: !sidplayfpAvailable }, (t) => {
  const { sid } = compileDoc(reviewScore);
  const { dir, wav } = sidplayfp(t, sid, "8580");
  const song = path.join(dir, "score.yaml");
  const out = path.join(dir, "report.json");
  fs.writeFileSync(song, reviewScore);
  const script = fileURLToPath(new URL("../scripts/sidwave-review.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script, "--wav", wav, "--song", song, "--out", out], { encoding: "utf8" });
  assert.match(run.stderr, /song start found at -?\d+ ms/);
  const report = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(run.status, report.verdict === "FAIL" ? 1 : 0);
  assert.equal(report.checks.repetition.metrics.bars, 4);
  assert.deepEqual(Object.keys(report.checks.dynamics.metrics.sectionRmsDb), ["Intro", "End"]);
});
