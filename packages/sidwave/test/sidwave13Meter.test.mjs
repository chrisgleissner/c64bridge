import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSidwave } from "../src/sidwave.js";
import { arrangeSidwave, compileSidwaveToPrg, sidwaveFrameRate } from "../src/sidwaveCompiler.js";
import { expectedSchedule } from "../src/audio/sidwaveFidelity.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sidwave-1.2");

const MIXED = `
sidwave: 1.3
tempo: 120
voices:
  - id: 1
    patterns:
      riff: { length: 0.5, groove: "C3 ~ ~ G3 ~ Bb3 ~ | C3 Eb3 F3 G3 ~ ~ ~" }
      four: { groove: "C3 E3 G3 C4" }
      six: { length: 0.5, groove: "C3 - - G3 - -" }
timeline:
  - { section: odd, bars: 2, meter: "7/8", layers: { v1: riff } }
  - { section: even, bars: 2, layers: { v1: four } }
  - { section: coda, bars: 1, meter: "6/8", layers: { v1: six } }
end: true
`;

test("SIDWAVE 1.2 documents compile to the same PRG bytes when they declare sidwave: 1.3", { timeout: 180_000 }, () => {
  for (const file of fs.readdirSync(fixtures).filter((name) => name.endsWith(".yaml"))) {
    const source = fs.readFileSync(path.join(fixtures, file), "utf8");
    if (!/^sidwave: 1\.2$/m.test(source)) continue;
    const old = parseSidwave(source);
    const next = parseSidwave(source.replace(/^sidwave: 1\.2$/m, "sidwave: 1.3"));
    assert.equal(next.version, "1.3");
    for (const loop of [false, true]) {
      assert.deepEqual(compileSidwaveToPrg(next, { loop }).prg, compileSidwaveToPrg(old, { loop }).prg, `${file} loop ${loop}`);
    }
  }
});

test("time signatures and section metres require sidwave: 1.3", () => {
  const base = { tempo: 120, voices: [{ id: 1, patterns: { a: { groove: ["C3"] } } }] };
  assert.throws(() => parseSidwave({ sidwave: 1.2, ...base, meter: "7/8", timeline: [{ bars: 1, layers: { v1: "a" } }] }),
    /\$\.meter: .*requires sidwave: 1\.3/);
  assert.throws(() => parseSidwave({ sidwave: 1.2, ...base, timeline: [{ bars: 1, meter: "6/8", layers: { v1: "a" } }] }),
    /\$\.timeline\[0\]\.meter: requires sidwave: 1\.3/);
  assert.throws(() => parseSidwave({ sidwave: 1.2, ...base, sections: { s: { bars: 1, meter: "5/4", layers: { v1: "a" } } }, timeline: ["s"] }),
    /\$\.sections\.s\.meter: requires sidwave: 1\.3/);
  // The old numeric metres keep working in 1.2, also when written as strings.
  assert.equal(parseSidwave({ sidwave: 1.2, ...base, meter: "3", timeline: [{ bars: 1, layers: { v1: "a" } }] }).song.meter, 3);
});

test("a metre accepts the listed signatures, numbers 3 and 4, and groups that add up to the numerator", () => {
  const doc = (meter) => parseSidwave({ sidwave: 1.3, tempo: 120, meter, voices: [{ id: 1, patterns: { a: { groove: ["C3"] } } }], timeline: [{ bars: 1, layers: { v1: "a" } }] });
  const beats = { "2/4": 2, "3/4": 3, "4/4": 4, "5/4": 5, "6/8": 3, "7/8": 3.5, "9/8": 4.5, "12/8": 6 };
  for (const [sig, value] of Object.entries(beats)) assert.equal(doc(sig).song.meter, value, sig);
  assert.deepEqual(doc(3).song.meterSig, { sig: "3/4", beats: 3, groups: [1, 1, 1] });
  assert.deepEqual(doc("7/8").song.meterSig.groups, [2, 2, 3]);
  assert.deepEqual(doc("5/4").song.meterSig.groups, [3, 2]);
  assert.deepEqual(doc("6/8").song.meterSig.groups, [3, 3]);
  assert.deepEqual(doc("9/8").song.meterSig.groups, [3, 3, 3]);
  assert.deepEqual(doc("12/8").song.meterSig.groups, [3, 3, 3, 3]);
  assert.deepEqual(doc({ sig: "7/8", groups: [3, 2, 2] }).song.meterSig, { sig: "7/8", beats: 3.5, groups: [3, 2, 2] });
  assert.throws(() => doc({ sig: "7/8", groups: [3, 3] }), /\$\.meter\.groups: the groups add up to 6; 7\/8 needs 7 eighths/);
  assert.throws(() => doc("5/8"), /\$\.meter: expected 3, 4 or one of/);
  assert.throws(() => doc({ sig: "7/8", group: [7] }), /\$\.meter\.group: unknown field/);
});

test("bars, bar lines and the timeline clock follow the metre of each section, counted in quarter notes", () => {
  const doc = parseSidwave(MIXED);
  const arr = arrangeSidwave(doc);
  // 2 bars of 7/8 (3.5 quarters), 2 bars of 4/4 and 1 bar of 6/8 (3 quarters).
  assert.deepEqual(arr.clock.barStarts, [0, 3.5, 7, 11, 15, 18]);
  assert.deepEqual(arr.clock.sections.map(({ startBeat, endBeat }) => [startBeat, endBeat]), [[0, 7], [7, 15], [15, 18]]);
  // A 7/8 bar at 120 quarter notes per minute lasts 1.75 s.
  const fps = sidwaveFrameRate("PAL");
  assert.equal(arr.voices[0].notes[3].start, Math.round(1.75 * fps));
  assert.deepEqual(arr.voices[0].notes.map((n) => n.path).slice(0, 8), ["bar 1 v1", "bar 1 v1", "bar 1 v1", "bar 2 v1", "bar 2 v1", "bar 2 v1", "bar 2 v1", "bar 3 v1"]);
  assert.equal(arr.voices[0].notes.at(-1).path, "bar 5 v1");
  const schedule = expectedSchedule(doc, { arrangement: arr });
  assert.deepEqual(schedule.bars, arr.clock.barStarts.map((beat) => arr.clock.frameAt(beat) / arr.fps));
  const report = compileSidwaveToPrg(doc, { loop: false }).arrangement;
  assert.match(report[0], /^1 odd bars 1-2 meter 7\/8 \(2\+2\+3\) /);
  assert.match(report[1], /^2 even bars 3-4 meter 4\/4 /);
  assert.match(report[2], /^3 coda bars 5-5 meter 6\/8 \(3\+3\) /);
});

test("a section without bars takes its length from the patterns in its own metre", () => {
  const doc = parseSidwave({
    sidwave: 1.3, tempo: 120,
    voices: [{ id: 1, patterns: { a: { length: 0.5, groove: "C3 D3 E3 F3 G3 A3 B3" } } }],
    sections: { s: { meter: "7/8", layers: { v1: "a*4" } } },
    timeline: ["s"],
  });
  assert.equal(doc.timeline[0].bars, 4);
});

test("a pattern's bar lines are checked against every metre it is played in", () => {
  const voices = [{ id: 1, patterns: { riff: { length: 0.5, bars: 2, groove: "C3 D3 E3 F3 G3 A3 B3 | C4 B3 A3 G3 F3 E3 D3" } } }];
  const ok = parseSidwave({ sidwave: 1.3, tempo: 120, voices, timeline: [{ section: "verse", bars: 2, meter: "7/8", layers: { v1: "riff" } }] });
  assert.equal(ok.timeline[0].meter.sig, "7/8");
  assert.throws(() => parseSidwave({ sidwave: 1.3, tempo: 120, voices, timeline: [
    { section: "verse", bars: 2, meter: "7/8", layers: { v1: "riff" } },
    { section: "chorus", bars: 2, layers: { v1: "riff" } },
  ] }), /\$\.voices\[0\]\.patterns\.riff: pattern riff: group 1 lasts 3\.5 beats; section "chorus" \(\$\.timeline\[1\]\) plays it in 4\/4, which needs 4 beats per bar/);
  // The bars total is checked in the metre too.
  const counted = [{ id: 1, patterns: { a: { length: 0.5, bars: 1, groove: "C3 D3 E3 F3 G3 A3" } } }];
  assert.equal(parseSidwave({ sidwave: 1.3, tempo: 120, voices: counted, timeline: [{ bars: 1, meter: "6/8", layers: { v1: "a" } }] }).timeline.length, 1);
  assert.throws(() => parseSidwave({ sidwave: 1.3, tempo: 120, voices: counted, timeline: [{ section: "x", bars: 1, meter: "7/8", layers: { v1: "a" } }] }),
    /pattern a lasts 3 beats; section "x" \(\$\.timeline\[0\]\) plays it in 7\/8, which needs 3\.5 beats for 1 bars/);
  // A pattern that no section plays is checked against the song metre.
  assert.throws(() => parseSidwave({ sidwave: 1.3, tempo: 120, meter: "6/8",
    voices: [{ id: 1, patterns: { used: { groove: ["C3"] }, spare: { groove: "C3 D3 | E3 F3" } } }],
    timeline: [{ bars: 1, layers: { v1: "used" } }] }), /patterns\.spare: pattern spare: group 1 lasts 2 beats; the song metre is 6\/8/);
});

test("swing, drum steps and level ramps over bars work in an x/8 metre", () => {
  const doc = parseSidwave({
    sidwave: 1.3, tempo: 100, swing: 0.6, kit: { k: "lib:kick", s: "lib:snare" },
    voices: [
      { id: 1, patterns: { d: { length: 0.25, drums: { steps: "k...s...k...s." } } } },
      { id: 2, patterns: { l: { length: 0.5, groove: "C4 D4 E4 F4 G4 A4 B4" } } },
    ],
    timeline: [{ bars: 2, meter: "7/8", level: { from: 4, to: 15, bars: 1 }, layers: { v1: "d", v2: "l" } }],
  });
  const arr = arrangeSidwave(doc);
  const clock = arr.clock;
  // Sixteenth swing: the second sixteenth of each pair is delayed, counted from the section start.
  assert.equal(clock.frameAt(3.25, true), clock.frameAt(3.25 + 0.2 * 0.25));
  assert.equal(clock.frameAt(3.5, true), clock.frameAt(3.5));
  // Every drum step is one sixteenth; two kicks per 7/8 bar.
  assert.deepEqual(arr.voices[0].notes.map((n) => n.beat), [0, 1, 2, 3, 3.5, 4.5, 5.5, 6.5]);
  // The level reaches its target after one 7/8 bar (3.5 beats) and holds.
  const lead = arr.voices[1].notes;
  const at = (beat) => lead.find((n) => n.beat === beat).sustain;
  assert.ok(at(0) < at(3));
  assert.equal(at(3.5), at(6.5));
});

test("metre groups are bookkeeping only: they add no accents and leave the bytes unchanged", () => {
  const doc = (groups) => parseSidwave({ sidwave: 1.3, tempo: 120, meter: { sig: "7/8", groups },
    voices: [{ id: 1, level: 10, patterns: { a: { length: 0.5, groove: "C4 D4 E4 F4 G4 A4 B4" } } }],
    timeline: [{ bars: 2, layers: { v1: "a" } }] });
  const notes = arrangeSidwave(doc([2, 2, 3])).voices[0].notes;
  assert.equal(new Set(notes.map((n) => n.sustain)).size, 1);
  assert.deepEqual(compileSidwaveToPrg(doc([2, 2, 3])).prg, compileSidwaveToPrg(doc([3, 2, 2])).prg);
});

test("sample bars and beats follow the metre of each section", () => {
  const doc = parseSidwave({
    sidwave: 1.3, tempo: 120, voices: [{ id: 1, patterns: { a: { groove: ["C3"] } } }],
    samples: { rate: 2000, defs: { k: { kit: "kick" } }, voices: [
      { sample: "k", bar: 2, beat: 1 },
      { sample: "k", bar: 3, beat: 2 },
      { pattern: { steps: "k.......", map: { k: "k" }, from_bar: 4, to_bar: 4 } },
    ] },
    timeline: [{ bars: 2, meter: "7/8", layers: { v1: "a" } }, { bars: 2, layers: { v1: "a" } }],
  });
  assert.deepEqual(doc.samples.triggers.map((t) => t.beat), [3.5, 8, 11]);
  assert.throws(() => parseSidwave({
    sidwave: 1.3, tempo: 120, voices: [{ id: 1, patterns: { a: { groove: ["C3"] } } }],
    samples: { rate: 2000, defs: { k: { kit: "kick" } }, voices: [{ sample: "k", bar: 1, beat: 4.5 }] },
    timeline: [{ bars: 1, meter: "7/8", layers: { v1: "a" } }],
  }), /\$\.samples\.voices\[0\]\.beat: 4.5 is above the maximum/);
});

test("every example in the SIDWAVE 1.3 chapter of the spec compiles, and the schema lists the metre", () => {
  const spec = fs.readFileSync(new URL("../data/sound/sidwave.md", import.meta.url), "utf8");
  const chapter = spec.slice(spec.indexOf("## SIDWAVE 1.3"), spec.indexOf("## Playable examples"));
  const examples = [...chapter.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(examples.length >= 1);
  for (const yaml of examples) assert.ok(compileSidwaveToPrg(parseSidwave(yaml)).prg.length > 0);
  const schema = JSON.parse(fs.readFileSync(new URL("../data/sound/sidwave.schema.json", import.meta.url), "utf8"));
  assert.ok(schema.properties.sidwave.enum.includes(1.3) && schema.properties.sidwave.enum.includes("1.3"));
  assert.ok(schema.$defs.section.properties.meter && schema.$defs.meter.oneOf[1].enum.includes("7/8"));
});

test("lint findings number bars in the metre of each section", () => {
  const doc = parseSidwave({
    sidwave: 1.3, tempo: 120,
    voices: [
      { id: 1, patterns: { odd: { length: 0.5, groove: "C4 - - - - - -" }, long: { bars: 3, groove: "C4 ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~" } } },
      { id: 2, patterns: { odd: { length: 0.5, groove: "E4 - - - - - -" }, clash: { groove: "C#4 ~ ~ ~" } } },
    ],
    timeline: [
      { bars: 2, meter: "7/8", layers: { v1: "odd", v2: "odd" } },
      // Bars 3-6 in 4/4 start at beats 7, 11, 15 and 19.
      { bars: 4, layers: { v1: "long long", v2: "clash" } },
    ],
  });
  const lint = compileSidwaveToPrg(doc, { loop: false }).lint;
  assert.equal(lint.find((f) => f.code === "SEQ-CUT").first, "bar 6 v1");
  assert.match(lint.find((f) => f.code === "CLASH").first, /^bar 3 v/);
});
