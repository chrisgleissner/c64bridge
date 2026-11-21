import test from "#test/runner";
import assert from "#test/assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emulate } from "./helpers/sidwaveFuzzKit.mjs";
import { compileDoc, runPrg, runPsidWrites } from "./helpers/sidwaveEmulator.mjs";
import { midiToHz, noteNameToMidi, parseSidwave } from "../src/sidwave.js";
import { arrangeSidwave, compileSidwaveStem, compileSidwaveToPrg, hzToSidFrequency } from "../src/sidwaveCompiler.js";
import { analyseQuality } from "../src/audio/sidwaveQuality.js";
import { expectedSchedule } from "../src/audio/sidwaveFidelity.js";
import { readWav, renderReference, restrictToSid } from "../src/audio/sidwaveReference.js";

import { readSidwaveExample } from "../src/sidwaveExamples.js";

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
  const { times } = report.checks.glitches.metrics;
  assert.equal(times.length, 1);
  assert.ok(Math.abs(times[0] - 0.31) < 0.002);
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

test("a bend reaches its target through ties across a section boundary", () => {
  const bend = { note: "A4", bend: { to: "B4", frames: 36 } };
  const song = score({ patterns: { A: { groove: ["-", "-", "-", bend] }, B: { groove: ["~", "~", "-", "-"] } } }, {
    timeline: [{ bars: 1, layers: { v1: "A" } }, { bars: 1, layers: { v1: "B" } }],
  });
  const { sid, doc } = compileDoc(song);
  const { start, end } = arrangeSidwave(doc).voices[0].notes[0];
  const { calls } = runPsidWrites(sid, end);
  const freqAt = (frame) => calls[frame].regs[0] | calls[frame].regs[1] << 8;
  const frequency = (name) => hzToSidFrequency(midiToHz(noteNameToMidi(name)), "PAL");
  assert.equal(freqAt(start), frequency("A4"));
  assert.ok(freqAt(start + 20) < frequency("B4"));
  assert.equal(freqAt(start + 36), frequency("B4"));
  assert.ok(calls.slice(start, start + 37).every(({ regs }) => (regs[4] & 1) === 1));
  song.voices[0].patterns.B.groove[0] = "-";
  assert.throws(() => compileDoc(song), /must reach its target during the note/);
});

test("layout overrides give the correct physical SID its filter owner and routing", () => {
  const song = score({}, {
    sids: { layout: "ultisid8", overrides: { sid5: { model: "8580", filter: { owner: "v13", route: [1, 2] } } } },
    instruments: { p: { waveform: "pulse", filtertable: [{ cutoff: "900Hz", resonance: 8 }] } },
    voices: [{ id: 13, instrument: "p", patterns: { A: { groove: ["C4", "~", "~", "~"] } } }],
    timeline: [{ bars: 1, layers: { v13: "A" } }],
  });
  const doc = parseSidwave(song);
  const { calls: [{ regs }] } = runPrg(compileSidwaveToPrg(doc), 1);
  assert.equal(regs[0x37], 0x83, "owner resonance and routes at $D437");
  assert.equal(regs[0x17], 0, "first SID filter");
  song.sids.overrides.sid5.filter.owner = "v1";
  assert.throws(() => parseSidwave(song), /sids.overrides.sid5.filter.owner.*this SID/);
});

test("the documented phase-reset unison mirrors a bass without a reserved channel", () => {
  const spec = fs.readFileSync(new URL("../data/sound/sidwave.md", import.meta.url), "utf8");
  const example = spec.match(/When every channel is scored[\s\S]*?```yaml\n([\s\S]*?)```/)?.[1];
  assert.ok(example);
  const original = parseSidwave(example);
  const { notes } = arrangeSidwave(original).voices[0];
  const { calls } = runPrg(compileSidwaveToPrg(original), notes[1].start + 1);
  const { regs: reset } = calls[notes[1].start - 2];
  assert.equal(reset[4] & 9, 8);
  assert.equal(reset[0x24] & 9, 8);
  const { regs } = calls[notes[1].start];
  assert.deepEqual(regs.slice(0, 7), regs.slice(0x20, 0x27));
});

test("pitch review excludes unmodulated-looking sync notes and silent gate-off sources", () => {
  const sampleRate = 12000;
  const left = Float32Array.from({ length: sampleRate * 3 }, (_, i) =>
    0.1 * Math.sin(2 * Math.PI * 447 * i / sampleRate));
  for (const effect of ["sync", "ring"]) {
    const song = score({}, {
      instruments: {
        mod: { waveform: "triangle", [effect]: true, source_note: "+12" },
        silent: { waveform: "triangle", wavetable: [{ gate: false }] },
      },
      voices: [
        { id: 2, instrument: "mod", patterns: { A: { length: 4, groove: ["A4"] } } },
        { id: 3, instrument: "silent", patterns: { A: { length: 4, groove: ["E4"] } } },
      ],
      timeline: [{ bars: 2, layers: { v2: "A", v3: "A" } }],
    });
    const schedule = expectedSchedule(parseSidwave(song));
    assert.ok(schedule.notes.length > 0);
    assert.ok(schedule.notes.every((note) => note.voice === 1 && note.inharmonic));
    const report = analyseQuality({ signal: { left, right: left, sampleRate }, schedule });
    assert.equal(report.checks.pitchStability.status, "SKIP");
  }
});

for (const name of ["ultisid_orchestra", "wall_of_sid"]) {
  test(`reference renders all resolved stems of ${name} with their 1.2 levels`, { skip: !sidplayfpAvailable }, () => {
    const doc = parseSidwave(readSidwaveExample(name));
    const arrangement = arrangeSidwave(doc);
    const slots = doc.voices.filter((voice) => voice.unison || voice.echo).map((voice) => doc.voiceSlots.get(voice.id));
    assert.ok(slots.length > 0);
    for (const slot of slots) {
      const chip = Math.floor(slot / 3);
      const stem = restrictToSid(doc, chip, arrangement);
      assert.equal(stem.softVolume, true);
      assert.equal(stem.chips[0].volume, doc.sids[chip].volume);
      assert.deepEqual(stem.voices[slot % 3].notes, arrangement.voices[slot].notes);
      assert.ok(stem.voices[slot % 3].notes.length);
    }
    const rendered = renderReference(doc, { model: "8580", arrangement, sampleRate: 12000, seconds: 1 });
    for (const channel of [rendered.left, rendered.right]) assert.ok(channel.some((sample) => Math.abs(sample) > 0.005));
    assert.ok(rendered.left.some((sample, i) => sample !== rendered.right[i]));
    assert.deepEqual(rendered.warnings, []);
  });
}

test("the sample reference reports that CIA2 playback is omitted", { skip: !sidplayfpAvailable }, () => {
  const doc = parseSidwave(readSidwaveExample("digi_groove"));
  const reference = renderReference(doc, { model: "8580", sampleRate: 12000, seconds: 1 });
  assert.match(reference.warnings.join(" "), /omits CIA2 NMI digi samples.*VICE/);
});

test("a saw bass render has no glitches and still exposes an injected click", { skip: !sidplayfpAvailable }, (t) => {
  const { doc, sid } = compileDoc(score({ waveform: "saw", adsr: [0, 7, 9, 2], patterns: {
    A: { groove: ["A1", "~", "~", "~", "G1", "~", "~", "~"] },
  } }));
  const { wav } = sidplayfp(t, sid, "8580");
  const { samples: left, sampleRate } = readWav(wav);
  const schedule = expectedSchedule(doc);
  const check = () => analyseQuality({ signal: { left, right: left, sampleRate }, schedule }).checks.glitches.metrics;
  assert.deepEqual(check().times, []);
  const click = Math.round(1.13 * sampleRate);
  left[click] = left[click] > 0 ? -0.99 : 0.99;
  const { times } = check();
  assert.equal(times.length, 1);
  assert.ok(Math.abs(times[0] - 1.13) < 0.002);
});

test("review masks a compiled wavetable change on any voice, rather than the whole note", () => {
  const doc = parseSidwave(score({}, {
    instruments: { p: { waveform: "pulse", wavetable: [{ frames: 30 }, { wave: "saw" }] } },
    voices: [{ id: 2, instrument: "p", patterns: { A: { length: 4, groove: ["C4"] } } }],
    timeline: [{ bars: 1, layers: { v2: "A" } }],
  }));
  const schedule = expectedSchedule(doc);
  const transition = schedule.changes.find((time) => time > 0.5 && time < 0.7);
  assert.ok(transition);
  const sampleRate = 48000;
  const left = new Float32Array(sampleRate * 2);
  left[Math.round(transition * sampleRate)] = 0.9;
  left[Math.round(1.13 * sampleRate)] = 0.9;
  const report = analyseQuality({ signal: { left, right: left, sampleRate }, schedule });
  const { times } = report.checks.glitches.metrics;
  assert.equal(times.length, 1);
  assert.ok(Math.abs(times[0] - 1.13) < 0.002);
});
