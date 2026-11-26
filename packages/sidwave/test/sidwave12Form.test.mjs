// SIDWAVE 1.2 round 2: arrangement (pattern text, sequences, named sections, timeline, loop_to), acceptance
// fixtures A1 to A3, and the stream-subroutine memory fixture. Register writes come from the 6502 emulator.
import test from "#test/runner";
import assert from "#test/assert";
import { compileDoc, gateOns, playDoc, runPsid, voice } from "./helpers/sidwaveEmulator.mjs";
import { SKELETON } from "./helpers/sidwave12Fixtures.mjs";
import { arrangeSidwave, compileSidwaveToPrg, SIDWAVE_MEMORY_END, sidwaveFrameRate } from "../src/sidwaveCompiler.js";
import { parseSidwave, SidwaveValidationError } from "../src/sidwave.js";

const head = (extra = "") => `sidwave: 1.2\ntitle: T\ntempo: 120\n${extra}sids: [{ id: sid1, address: "$D400", model: "8580" }]\n`;
const one = (groove, { bars, length = 0.25, extra = "", section = "bars: 1" } = {}) => `${head(extra)}instruments: { p: { waveform: pulse, adsr: [0, 4, 10, 4] } }
voices: [{ id: 1, instrument: p, patterns: { a: { length: ${length}, ${bars ? `bars: ${bars}, ` : ""}groove: ${JSON.stringify(groove)} } } }]
sections: { s: { ${section}, layers: { v1: a } } }
timeline: [s]
`;
const notesOf = (source) => arrangeSidwave(parseSidwave(source)).voices[0].notes;
const throwsAt = (source, pattern) => assert.throws(() => compileSidwaveToPrg(parseSidwave(source)), pattern);

test("pattern text: groove accepts a space-separated string and rests do not need quoting", () => {
  const notes = notesOf(one("C4 - E4 ~ G4 - - -", { length: 0.5 }));
  assert.deepEqual(notes.map((n) => n.midi), [60, 64, 67]);
  assert.equal(notes[1].end - notes[1].start > notes[0].end - notes[0].start, true, "the tie extends E4");
});

test("pattern text: every bar of a '|' pattern must last one bar, and bars: N is checked", () => {
  assert.throws(() => parseSidwave(one("C4 C4 C4 C4 | C4 C4 C4", { length: 1, section: "bars: 2" })), /group 2 lasts 3 beats; expected 4/);
  assert.throws(() => parseSidwave(one("C4 C4 C4 C4 | C4 C4 C4 C4", { length: 1, bars: 3, section: "bars: 2" })), /pattern lasts 8 beats; expected 12/);
  assert.doesNotThrow(() => parseSidwave(one("C4 C4 C4 C4 | C4 C4 C4 C4", { length: 1, bars: 2, section: "bars: 2" })));
  const error = (() => { try { parseSidwave(one("C4 C4 C4 C4 | C4", { length: 1 })); } catch (e) { return e; } })();
  assert.ok(error instanceof SidwaveValidationError && /patterns\.a/.test(error.message), "names the pattern");
});

test("pattern text: unknown motif words are rejected in 1.2 and ignored in 1.1", () => {
  const motif = (version) => `sidwave: ${version}\ntitle: T\ntempo: 120\nvoices: [{ id: 1, patterns: { a: { motif: "pad C4 E4 G4 -", length: 1 } } }]\ntimeline: [{ bars: 1, layers: { v1: a } }]\n`;
  assert.doesNotThrow(() => parseSidwave(motif("1.1")));
  assert.throws(() => parseSidwave(motif("1.2")), /unrecognised motif token "pad"/);
});

test("pattern text: a slur makes every note after the first legato, across a bar line", () => {
  const notes = notesOf(one("(C4 D4 E4 F4 | G4) A4 - -", { length: 1, section: "bars: 2" }));
  assert.deepEqual(notes.map((n) => !!n.legato), [false, true, true, true, true, false]);
  assert.throws(() => parseSidwave(one("(C4 (D4) E4)", { length: 1 })), /slurs cannot nest/);
});

test("pattern text: ! raises the level by the song accent and / is a portamento of 3 frames by default", () => {
  const withAccent = notesOf(one("C4 D4! - -", { length: 1, extra: "accent: 5\n" }).replace("{ waveform: pulse, adsr: [0, 4, 10, 4] }", "{ waveform: pulse, adsr: [0, 4, 8, 4] }"));
  assert.equal(withAccent[0].sustain, undefined, "unmarked notes keep the instrument sustain");
  assert.equal(withAccent[1].sustain, 13, "8 + accent 5");
  const glide = notesOf(one("C4 /G4 - -", { length: 1 }));
  assert.equal(glide[1].portamento, 3);
  assert.equal(glide[1].glideFrom, undefined);
  assert.throws(() => parseSidwave(one("C4 D4!x", { length: 1 })), /invalid note token/);
  assert.equal(notesOf(one("/G4!@p - - -", { length: 1 }))[0].sustain, 13, "decorations combine: /NOTE!@inst");
});

test("pattern text: kit tokens play the kit instrument at C3 and are exempt from transposition", () => {
  const source = `${head("kit: { k: lib:kick, s: lib:snare }\n")}instruments: { p: { waveform: pulse } }
voices: [{ id: 1, instrument: p, patterns: { a: { length: 1, groove: "k C4 s C4" } } }]
sections: { s1: { bars: 1, layers: { v1: a } } }
timeline: ["s1+5"]
`;
  const notes = notesOf(source);
  assert.deepEqual(notes.map((n) => n.midi), [48, 65, 48, 65], "kit notes stay at C3, pitched notes move by 5");
  const bad = source.replace("k: lib:kick", "c: lib:kick").replace("k C4", "c C4");
  assert.throws(() => parseSidwave(bad), /one-letter key that is not a note, chord, rest or tie/);
  const drums = `${head("kit: { k: lib:kick, s: lib:snare }\n")}voices: [{ id: 1, patterns: { a: { drums: { steps: "k.s." }, length: 1 } } }]
sections: { s1: { bars: 1, layers: { v1: a } } }
timeline: [s1]
`;
  assert.deepEqual(notesOf(drums).length, 2, "drums.steps uses the top-level kit");
});

test("sequences: refs repeat, '-' rests one bar, groups nest one level and the sequence loops in the section", () => {
  const source = `${head()}voices:
  - { id: 1, waveform: pulse, patterns: { a: { length: 1, groove: "C4 C4 C4 C4" }, b: { length: 1, groove: "G4 G4 G4 G4" } } }
sections:
  s: { bars: 8, layers: { v1: "a*2 - (b a)*2" } }
timeline: [s]
`;
  const notes = notesOf(source);
  const bars = [...new Set(notes.map((n) => Math.floor(n.beat / 4)))];
  assert.deepEqual(bars, [0, 1, 3, 4, 5, 6, 7], "a a - b a b a, then the sequence restarts and the last bar plays a");
  assert.deepEqual(notes.filter((n) => n.beat % 4 === 0).map((n) => n.midi), [60, 60, 67, 60, 67, 60, 60]);
  assert.throws(() => parseSidwave(source.replace('"a*2 - (b a)*2"', '"a– b"')), /use a section level ramp to fade a sequence/);
  assert.throws(() => parseSidwave(source.replace('"a*2 - (b a)*2"', '"(a (b a)*2)*2"')), /invalid sequence|nested/);
});

test("sequences: an item cut by the section end is reported as SEQ-CUT and a fitting one is not", () => {
  const make = (bars) => `${head()}voices: [{ id: 1, waveform: pulse, patterns: { a: { length: 1, groove: "C4 C4 C4 C4 | C4 C4 C4 C4" } } }]
sections: { s: { bars: ${bars}, layers: { v1: "a a" } } }
timeline: [s]
`;
  assert.ok(compileSidwaveToPrg(parseSidwave(make(3))).lint.some((f) => f.code === "SEQ-CUT"));
  assert.ok(!compileSidwaveToPrg(parseSidwave(make(4))).lint.some((f) => f.code === "SEQ-CUT"));
});

test("sequences: transpositions keep cycling per repetition and add to the reference transposition", () => {
  const source = `${head()}voices: [{ id: 1, waveform: pulse, patterns: { a: { length: 1, transpositions: [0, 2], groove: "C4 - - -" } } }]
sections: { s: { bars: 4, layers: { v1: "a+12*3 a" } } }
timeline: [s]
`;
  assert.deepEqual(notesOf(source).map((n) => n.midi), [72, 74, 72, 62], "0, 2, 0 on the repeats, then 2 on the next pass");
});

test("timeline: named sections, name+N*count, use with layer overrides, transpose and inferred bars", () => {
  const source = `${head()}voices:
  - { id: 1, waveform: pulse, patterns: { a: { length: 1, groove: "C4 - - -" } } }
  - { id: 2, waveform: pulse, patterns: { b: { length: 1, groove: "G3 - - -" } } }
sections:
  x: { layers: { v1: "a a", v2: b } }
  y: { bars: 2, layers: { v1: a, v2: b } }
timeline: ["x*2", "y+2", { use: y, transpose: -3, layers: { v2: "-" } }]
`;
  const doc = parseSidwave(source);
  assert.deepEqual(doc.timeline.map((s) => s.bars), [2, 2, 2, 2], "x has no bars: the longest layer pass is 2 bars");
  const arr = arrangeSidwave(doc);
  assert.deepEqual(arr.voices[0].notes.map((n) => n.midi), [60, 60, 60, 60, 62, 62, 57, 57]);
  assert.deepEqual(arr.voices[1].notes.map((n) => n.midi), [55, 55, 55, 55, 57, 57], "v2 is silenced in the last entry");
  assert.throws(() => parseSidwave(source.replace('"y+2"', '"nope"')), /unknown section nope/);
});

test("timeline: section level, volume and filter apply to that entry only", () => {
  const source = `${head()}instruments: { p: { waveform: pulse, adsr: [0, 4, 10, 4] } }
voices: [{ id: 1, instrument: p, patterns: { a: { length: 1, groove: "C4 C4 C4 C4" } } }]
sections: { quiet: { bars: 1, level: pp, layers: { v1: a } }, loud: { bars: 1, layers: { v1: a } } }
timeline: [quiet, loud]
`;
  const notes = notesOf(source);
  assert.deepEqual([notes[0].sustain, notes[4].sustain], [3, undefined], "pp does not carry into the next entry");
});

test("loop_to: loops to the named section, is exclusive with end and length_bars, and re-emits the entry state", () => {
  const source = `${head()}instruments: { p: { waveform: pulse, adsr: [0, 4, 10, 4] } }
voices: [{ id: 1, instrument: p, patterns: { a: { length: 1, groove: "C4 D4 E4 F4" }, b: { length: 1, groove: "G4 A4 B4 C5" } } }]
sections: { i: { bars: 2, layers: { v1: a } }, m: { bars: 2, level: pp, layers: { v1: b } } }
timeline: [i, m]
loop_to: m
`;
  const { compiled, sid } = compileDoc(source);
  assert.equal(compiled.loopTo, 2);
  const { states } = runPsid(sid, compiled.totalFrames + 120);
  const v = voice(states, 0);
  const frameAtBar = (bar) => Math.round(bar * 4 * 0.5 * sidwaveFrameRate("PAL"));
  const first = gateOns(v).filter((o) => o.frame >= frameAtBar(2) && o.frame < frameAtBar(2) + 100);
  const again = gateOns(v).filter((o) => o.frame >= compiled.totalFrames && o.frame < compiled.totalFrames + 100);
  assert.ok(first.length >= 3 && again.length >= 3);
  assert.deepEqual(again.slice(0, 3).map((o) => o.freq), first.slice(0, 3).map((o) => o.freq), "the loop pass plays section m, not i");
  assert.equal(v.sr[again[0].frame] >> 4, v.sr[first[0].frame] >> 4, "the level of the entry is replayed");
  assert.throws(() => parseSidwave(source + "end: true\n"), /mutually exclusive/);
  assert.throws(() => parseSidwave(source.replace("loop_to: m", "loop_to: zz")), /unknown timeline section/);
});

test("loop_to: a tie at the loop target with a different predecessor is reported as LOOP-TIE", () => {
  const make = (last) => `${head()}voices: [{ id: 1, waveform: pulse, patterns: { a: { length: 1, groove: "C4 C4 C4 C4" }, t: { length: 1, groove: "~ ~ ~ ~" }, e: { length: 1, groove: "${last} - - -" } } }]
sections: { i: { bars: 1, layers: { v1: a } }, m: { bars: 1, layers: { v1: t } }, z: { bars: 1, layers: { v1: e } } }
timeline: [i, m, z]
loop_to: m
`;
  assert.ok(compileSidwaveToPrg(parseSidwave(make("G4"))).lint.some((f) => f.code === "LOOP-TIE"));
  assert.ok(!compileSidwaveToPrg(parseSidwave(make("C4"))).lint.some((f) => f.code === "LOOP-TIE"));
});

test("arrangement report lists form, time, level and estimated loudness per timeline entry", () => {
  const compiled = compileSidwaveToPrg(parseSidwave(SKELETON));
  assert.equal(compiled.arrangement.length, 6);
  assert.match(compiled.arrangement[2], /^3 chorus bars 13-20 0:23-0:38 level ff est -?\d+\.\d dB v1,v2,v3$/);
  assert.match(compiled.arrangement[5], /level mf>pp/);
  assert.ok(compiled.durationSeconds > 76 && compiled.durationSeconds < 79);
  assert.equal(compiled.streamBytes.length, 3);
});

/** A1: three voices, one SID, 96 bars in at most 6,000 bytes of YAML. */
export const A1 = `sidwave: 1.2
title: Long form
tempo: 118
sids: [{ id: sid1, address: "$D400", model: "8580", filter: { owner: v1, route: [1] } }]
kit: { k: lib:kick, s: lib:snare, h: lib:hat }
instruments:
  bass: { waveform: sawtooth, adsr: [0, 6, 9, 2], hard_restart: { test: true }, filtertable: [{ cutoff: 800Hz, resonance: 10, type: lowpass }, { add: -30, frames: 12 }] }
  lead: { waveform: pulse, adsr: [1, 5, 11, 5], pulsetable: { reset: false, loop: 1, steps: [{ set: 0.3 }, { add: 20, frames: 24 }, { add: -20, frames: 24 }] } }
  pad: { waveform: triangle, adsr: [4, 6, 12, 8], legato: true }
voices:
  - id: 1
    role: bass
    instrument: bass
    patterns:
      a: { length: 0.25, groove: "k A1 A1 A2 s A1 A2 A1 k A1 A1 A2 s A1 G1 G2 | k F1 F1 F2 s F1 F2 F1 k G1 G1 G2 s G1 A1 G1" }
      f: { length: 0.25, groove: "k A1 A1 A2 s A1 A2 A1 k A1 s s k s s s" }
      d: { length: 1, groove: "k - s - | k - s h" }
  - id: 2
    role: pad
    instrument: pad
    level: 9
    patterns:
      p1: { length: 4, groove: "A3 F3" }
      p2: { length: 4, groove: "C3 G3" }
  - id: 3
    role: lead
    instrument: lead
    patterns:
      m1: { length: 0.5, groove: "(A4 C5 E5) ~ D5! ~ (C5 B4) | A4 ~ ~ ~ - - E4 G4 | (E5 D5 C5) ~ B4! ~ (A4 G4) | A4 ~ ~ ~ ~ ~ ~ ~" }
      m2: { length: 0.5, groove: "E5 ~ D5 C5 B4 ~ A4 ~ | G4 ~ A4 B4 C5 ~ ~ ~" }
sections:
  intro:  { bars: 8, level: mp, volume: { from: 9, to: 15 }, layers: { v1: d, v2: p1 } }
  verse:  { bars: 16, level: mf, filter: { cutoff: { from: -100, to: 150 } }, layers: { v1: "a*3 f", v2: "p1 p2", v3: "m1 m2" } }
  chorus: { bars: 16, level: ff, filter: { cutoff: { from: 150, to: 400 } }, layers: { v1: "a*3 f", v2: "p2 p1", v3: "m1+12 m2+12" } }
  bridge: { bars: 8, level: p, layers: { v2: "p1 p2", v3: m2 } }
timeline: [intro, verse, chorus, bridge, "verse+2", "chorus+2", { use: bridge, level: { from: mp, to: pp } }, intro]
loop_to: verse
`;

test("A1: a 3-voice 96-bar piece is at most 6,000 bytes of YAML, fits below $D000 and loops to its second section", () => {
  assert.ok(Buffer.byteLength(A1) <= 6000, `${Buffer.byteLength(A1)} bytes`);
  const doc = parseSidwave(A1);
  assert.equal(doc.song.length_bars, 96);
  const { compiled, sid } = compileDoc(A1);
  assert.ok(compiled.endAddress < SIDWAVE_MEMORY_END, "fits below $D000");
  assert.equal(compiled.loopTo, 2);
  const bass = voice(runPsid(sid, compiled.totalFrames + 400).states, 0);
  const bar = (n) => Math.round(n * 4 * 60 / 118 * sidwaveFrameRate("PAL"));
  const first = gateOns(bass).filter((o) => o.frame >= bar(8) && o.frame < bar(8) + 200).map((o) => o.freq);
  const again = gateOns(bass).filter((o) => o.frame >= compiled.totalFrames && o.frame < compiled.totalFrames + 200).map((o) => o.freq);
  assert.ok(first.length > 5);
  assert.deepEqual(again.slice(0, first.length), first, "after the last entry the piece restarts at the verse");
  console.log(`A1: ${Buffer.byteLength(A1)} YAML bytes, streamBytes ${compiled.streamBytes}, worst case ${compiled.worstCaseCyclesPerCall} cycles, turbo ${compiled.requiresTurbo}`);
});

/** A2: 24 voices on an 8-SID layout, 64 bars, every voice repeats 2-bar patterns. */
export function a2Document(tempo = 125, notesPerBar = 8) {
  const scale = ["C3", "D3", "E3", "G3", "A3", "C4", "D4", "E4"];
  const voices = Array.from({ length: 24 }, (_, i) => {
    const v = i + 1;
    const groove = Array.from({ length: notesPerBar * 2 }, (_, k) => scale[(k * (v % 5 + 1) + v) % 8]).join(" ");
    return `  - { id: ${v}, waveform: ${["pulse", "sawtooth", "triangle"][v % 3]}, adsr: [0, 4, 7, 3], patterns: { p: { length: ${4 / notesPerBar}, groove: "${groove}" } } }`;
  });
  const layers = Array.from({ length: 24 }, (_, i) => `v${i + 1}: "p*32"`).join(", ");
  return `sidwave: 1.2\ntitle: A2\ntempo: ${tempo}\ncpu: turbo\nsids: { layout: ultisid8 }\nvoices:\n${voices.join("\n")}\nsections:\n  main: { bars: 64, layers: { ${layers} } }\ntimeline: [main]\n`;
}

test("A2: 24 voices of 2-bar patterns over 64 bars fit below $D000 with stream subroutines, and streamBytes is reported per voice", () => {
  const source = a2Document();
  const flat = compileSidwaveToPrg(parseSidwave(a2Document(120, 4)), { compress: false });
  const flatSize = flat.streamBytes.reduce((a, b) => a + b);
  const packed = compileSidwaveToPrg(parseSidwave(source));
  assert.equal(packed.streamBytes.length, 24);
  assert.ok(packed.endAddress < SIDWAVE_MEMORY_END);
  assert.throws(() => compileSidwaveToPrg(parseSidwave(source), { compress: false }), /past the \$D000 limit/, "flat streams do not fit");
  assert.ok(packed.streamBytes.every((n) => n < 1500), `per voice: ${packed.streamBytes}`);
  assert.ok(flatSize > 20_000);
  console.log(`A2: ${packed.streamBytes.reduce((a, b) => a + b)} stream bytes in 24 voices (flat 4 notes/bar: ${flatSize}), ${packed.bytesBelowD000} bytes below $D000, worst case ${packed.worstCaseCyclesPerCall} cycles`);
});

test("A3: after 128 bars every voice's bar-128 onset falls on the same player call, computed from the absolute beat", () => {
  const voices = Array.from({ length: 6 }, (_, i) => `  - { id: ${i + 1}, waveform: pulse, patterns: { a: { length: 1, groove: "C4 - E4 -" } } }`).join("\n");
  const source = `sidwave: 1.2\ntitle: Drift\ntempo: 123\nsids: [{ id: sid1, address: "$D400" }, { id: sid2, address: "$D420" }]\nvoices:\n${voices}\nsections:\n  main: { bars: 128, layers: { ${Array.from({ length: 6 }, (_, i) => `v${i + 1}: a`).join(", ")} } }\ntimeline: [main]\n`;
  const arr = arrangeSidwave(parseSidwave(source));
  const fps = sidwaveFrameRate("PAL");
  const expected = Math.round(127 * 4 * 60 / 123 * fps);
  const onsets = arr.voices.map((v) => v.notes.find((n) => Math.abs(n.beat - 127 * 4) < 1e-9).start);
  assert.deepEqual(onsets, Array(6).fill(expected), "all six voices start bar 128 on the same call");
  assert.notEqual(expected, 127 * Math.round(4 * 60 / 123 * fps), "an accumulated-rounding clock would differ");
  const compiled = compileSidwaveToPrg(parseSidwave(source));
  assert.equal(compiled.totalFrames, Math.round(128 * 4 * 60 / 123 * fps));
});
