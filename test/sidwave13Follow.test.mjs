import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import { parseSidwave } from "../src/sidwave.js";
import { arrangeSidwave, compileSidwaveToPrg, hzToSidFrequency } from "../src/sidwaveCompiler.js";
import { midiToHz } from "../src/sidwave.js";
import { playDoc } from "./helpers/sidwaveEmulator.mjs";

const CANON = `
sidwave: 1.3
tempo: 120
kit: { k: lib:kick }
instruments:
  lead: { waveform: sawtooth, adsr: [1, 4, 10, 4] }
  soft: { waveform: triangle, adsr: [2, 4, 12, 6] }
voices:
  - id: 1
    instrument: lead
    level: 12
    patterns: { m: { length: 0.5, groove: "k E4 G4 A4! (B4 C5) Am@arp -" } }
  - { id: 2, follow: { voice: 1, delay_beats: 1, transpose: 7, instrument: soft, level: 8 } }
  - { id: 3, follow: { voice: 1, delay: 6, transpose: -12 } }
timeline: [{ bars: 2, level: mf, layers: { v1: m } }]
end: true
`;

test("follow requires sidwave: 1.3 and checks its fields", () => {
  const voices = (follow, extra = {}) => [{ id: 1, patterns: { a: { groove: ["C4"] } } }, { id: 2, follow, ...extra }];
  const doc = (version, follow, extra) => ({ sidwave: version, tempo: 120, voices: voices(follow, extra), timeline: [{ bars: 1, layers: { v1: "a" } }] });
  assert.throws(() => parseSidwave(doc(1.2, { voice: 1, transpose: 7 })), /\$\.voices\[1\]\.follow: requires sidwave: 1\.3/);
  assert.throws(() => parseSidwave(doc(1.3, { voice: 1, transpose: { diatonic: 3, key: "E minor" } })),
    /\$\.voices\[1\]\.follow\.transpose: diatonic transposition is not supported/);
  assert.throws(() => parseSidwave(doc(1.3, { voice: 1, delay: 3, delay_beats: 1 })), /\$\.voices\[1\]\.follow: use delay or delay_beats/);
  assert.throws(() => parseSidwave(doc(1.3, { voice: 2 })), /follow\.voice: a voice cannot follow itself/);
  assert.throws(() => parseSidwave(doc(1.3, { voice: 1, instrument: "missing" })), /\$\.voices\[1\]\.follow\.instrument: instrument "missing" is not defined/);
  assert.throws(() => parseSidwave(doc(1.3, { voice: 1 }, { echo: { voice: 1, delay: 3, volume: 0.5 } })), /choose follow, echo or unison/);
  assert.throws(() => parseSidwave(doc(1.3, { voice: 1 }, { level: 9 })), /\$\.voices\[1\]\.level: a follower takes level inside follow/);
  assert.throws(() => parseSidwave(doc(1.3, { voice: 1 }, { patterns: { b: { groove: ["C4"] } } })), /has no patterns/);
  assert.throws(() => parseSidwave(doc(1.3, { voice: 1, transpose: 49 })), /transpose: 49 is above the maximum 48/);
});

test("a follower plays the source's pitched notes later and transposed, with its own instrument and level", () => {
  const arr = arrangeSidwave(parseSidwave(CANON));
  const [lead, fifth, octave] = arr.voices.map((v) => v.notes);
  const pitched = lead.filter((n) => !n.percussion);
  assert.equal(lead.length - pitched.length, 2, "the kick tokens are not copied");
  assert.equal(fifth.length, pitched.length);
  for (const [i, n] of pitched.entries()) {
    // One beat at 120 BPM is half a second.
    assert.equal(fifth[i].start, arr.clock.frameAt(n.beat + 1, true));
    assert.equal(fifth[i].end - fifth[i].start, n.end - n.start);
    assert.equal(fifth[i].midi, n.midi + 7);
    assert.equal(!!fifth[i].legato, !!n.legato);
    assert.equal(octave[i].start, n.start + 6);
    assert.equal(octave[i].midi, n.midi - 12);
  }
  const soft = arr.instruments[fifth[0].inst];
  assert.equal(soft.wave & 0xf0, 0x10, "the follower's own triangle instrument");
  assert.equal(soft.ad, 0x24);
  // Sustain 12 x level 8/15 x section mf 10/15 = 4.3, plus the accent of 3 on A4!.
  assert.deepEqual(fifth.slice(0, 3).map((n) => n.sustain), [4, 4, 7]);
  // Without an instrument or level the follower keeps the source's sustain and instrument shape.
  assert.deepEqual(octave.map((n) => n.sustain), pitched.map((n) => n.sustain));
  assert.equal(arr.instruments[octave[0].inst].ad, arr.instruments[pitched[0].inst].ad);
  // The chord arpeggio keeps its tones with the follower's instrument.
  const chord = fifth.find((n) => arr.instruments[n.inst].wavetable?.length);
  assert.deepEqual(arr.instruments[chord.inst].wavetable.map((step) => step.note), ["+0", "+3", "+7"]);
  assert.equal(chord.midi, 57 + 7);
  assert.equal(fifth[4].path, "bar 1 v2");
  assert.equal(fifth[5].path, "bar 2 v2", "a delay in beats moves the bar of the copy");
});

test("the player sounds the follower's transposed notes at the delayed calls", () => {
  const run = playDoc(CANON, 220);
  const doc = parseSidwave(CANON);
  const arr = arrangeSidwave(doc);
  const voice2 = (call) => run.calls[call].regs[7] | (run.calls[call].regs[8] << 8);
  for (const n of arr.voices[1].notes.filter((note) => !arr.instruments[note.inst].wavetable?.length && !note.legato).slice(0, 4)) {
    assert.equal(voice2(n.start + 1), hzToSidFrequency(midiToHz(n.midi), "PAL"));
  }
});

test("notes that a follower moves out of the playable range are rejected with a path", () => {
  const source = (transpose) => ({ sidwave: 1.3, tempo: 120,
    voices: [{ id: 1, patterns: { a: { groove: "C4 G7" } } }, { id: 2, follow: { voice: 1, transpose } }],
    timeline: [{ bars: 1, layers: { v1: "a" } }] });
  assert.throws(() => arrangeSidwave(parseSidwave(source(5))), /\$\.voices\.v2\.follow\.transpose: G7 at bar 1 v1 becomes C8, outside the playable range C0\.\.A#7 on PAL/);
  assert.throws(() => arrangeSidwave(parseSidwave({ ...source(-48), voices: [{ id: 1, patterns: { a: { groove: "C3" } } }, { id: 2, follow: { voice: 1, transpose: -48 } }] })),
    /C3 at bar 1 v1 becomes C-1, outside/);
  assert.equal(arrangeSidwave(parseSidwave(source(3))).voices[1].notes[1].midi, 106);
});

test("a follower's delay counts frames at any speed, detune adds cents and the end waits for the copy", () => {
  const doc = (follow) => parseSidwave({ sidwave: 1.3, tempo: 100, speed: 2,
    instruments: { long: { adsr: [0, 4, 10, 9] } },
    sids: [{ id: "a", address: "$D400" }, { id: "b", address: "$D420" }],
    voices: [{ id: 1, patterns: { a: { length: 2, groove: "C4 E4" } } }, { id: 4, follow }],
    timeline: [{ bars: 1, layers: { v1: "a" } }], end: { release: true } });
  const plain = arrangeSidwave(doc({ voice: 1, transpose: 12 }));
  const late = arrangeSidwave(doc({ voice: 1, delay: 10, transpose: 12, detune: -8, instrument: "long" }));
  assert.equal(late.voices[3].notes[0].start, plain.voices[3].notes[0].start + 20);
  assert.equal(late.tuning[3], -8);
  const last = late.voices[3].notes.at(-1);
  const source = late.voices[0].notes.at(-1);
  assert.equal(last.end - last.start, source.end - source.start, "the last copied note is not cut");
  assert.ok(late.totalFrames > last.end, "the release tail follows the copy");
});

test("the 1.3 spec, the schema and a compiled canon describe the follower", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../data/sound/sidwave.schema.json", import.meta.url), "utf8"));
  const follow = schema.$defs.follow.properties;
  for (const key of ["voice", "delay", "delay_beats", "transpose", "instrument", "level", "detune"]) assert.ok(follow[key], key);
  assert.equal(schema.properties.voices.items.properties.follow.$ref, "#/$defs/follow");
  const result = compileSidwaveToPrg(parseSidwave(CANON), { loop: false });
  assert.match(result.arrangement[0], / v1,v2,v3$/);
});

test("followers chain, skip drum voices and reject an instrument whose hard restart does not fit", () => {
  const arr = arrangeSidwave(parseSidwave({ sidwave: 1.3, tempo: 120,
    voices: [
      { id: 1, patterns: { a: { groove: "C4 E4 G4 C5" } } },
      { id: 2, follow: { voice: 1, transpose: 4 } },
      { id: 3, follow: { voice: 2, delay: 3, transpose: 3 } },
    ],
    timeline: [{ bars: 1, layers: { v1: "a" } }] }));
  assert.deepEqual(arr.voices[2].notes.map((n) => n.midi), [67, 71, 74, 79]);
  const drums = arrangeSidwave(parseSidwave({ sidwave: 1.3, tempo: 120,
    voices: [{ id: 1, role: "drums", patterns: { a: { groove: "C4 E4" } } }, { id: 2, follow: { voice: 1 } }],
    timeline: [{ bars: 1, layers: { v1: "a" } }] }));
  assert.equal(drums.voices[1].notes.length, 0);
  assert.throws(() => arrangeSidwave(parseSidwave({ sidwave: 1.3, tempo: 120,
    instruments: { slow: { hard_restart: { frames: 8 } } },
    voices: [{ id: 1, patterns: { a: { length: 0.25, groove: "C4 D4 E4 F4" } } }, { id: 2, follow: { voice: 1, instrument: "slow" } }],
    timeline: [{ bars: 1, layers: { v1: "a" } }] })), /\$\.voices\.v2\.follow\.instrument: bar 1 v2 follows the previous note after 6 calls; the instrument's hard restart needs more than 8/);
});
