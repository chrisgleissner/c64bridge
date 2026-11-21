// SIDWAVE 1.2 round 2: every lint code has a document that triggers it and one that does not. Findings are
// returned from the compile operations as `lint` (structured) and `warnings` (one line each).
import test from "#test/runner";
import assert from "#test/assert";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { parseSidwave } from "../src/sidwave.js";

const lint = (source) => compileSidwaveToPrg(parseSidwave(source)).lint.map((f) => f.code);
const has = (source, code) => lint(source).includes(code);

/** Single SID, tempo 125.31 (25 frames per beat... 24 calls per beat at 50.12 Hz) so TEMPO-GRID stays quiet by default. */
const doc = ({ tempo = 125.31, sid = "{ id: sid1, address: \"$D400\", model: \"8580\" }", instruments = "", voices, sections = "s: { bars: 1, layers: { v1: a } }", timeline = "[s]", extra = "" }) => `sidwave: 1.2
title: Lint
tempo: ${tempo}
${extra}sids: [${sid}]
instruments:
${instruments}voices:
${voices}
sections:
  ${sections}
timeline: ${timeline}
`;
const v1 = (groove, { inst = "p", extra = "", length = 1 } = {}) => `  - { id: 1, instrument: ${inst}, ${extra} patterns: { a: { length: ${length}, groove: "${groove}" } } }`;
const P = "  p: { waveform: pulse, adsr: [0, 4, 10, 4] }\n";

test("LEVEL-NOOP: level on a sustain-0 instrument, not on a sustaining one", () => {
  const inst = (sustain) => `  p: { waveform: pulse, adsr: [0, 4, ${sustain}, 4] }\n`;
  const make = (sustain) => doc({ instruments: inst(sustain), voices: v1("C4 - - -"), sections: "s: { bars: 1, level: mf, layers: { v1: a } }" });
  assert.ok(has(make(0), "LEVEL-NOOP"));
  assert.ok(!has(make(10), "LEVEL-NOOP"));
});

test("FLAT: a score whose sections have the same loudness is flagged, one with a build is not", () => {
  const voices = v1("C4 C4 C4 C4");
  const make = (levels) => doc({ instruments: P, voices, sections: `s1: { bars: 2, ${levels[0]}, layers: { v1: a } }\n  s2: { bars: 2, ${levels[1]}, layers: { v1: a } }`, timeline: "[s1, s2]" });
  assert.ok(has(make(["level: mf", "level: mf"]), "FLAT"));
  assert.ok(!has(make(["level: pp", "level: ff"]), "FLAT"));
});

test("REPEAT: more than 75% of the bars repeating an earlier bar is flagged", () => {
  const make = (bars) => doc({ instruments: P, voices: v1("C4 D4 E4 F4"), sections: `s: { bars: ${bars}, layers: { v1: a } }` });
  assert.ok(has(make(16), "REPEAT"));
  const varied = doc({ instruments: P, voices: `  - { id: 1, instrument: p, patterns: { a: { length: 1, transpositions: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], groove: "C4 D4 E4 F4" } } }`, sections: "s: { bars: 16, layers: { v1: a } }" });
  assert.ok(!has(varied, "REPEAT"));
});

test("VOL-STEP: a volume ramp with more steps than beats is flagged", () => {
  const make = (bars) => doc({ instruments: P, voices: v1("C4 - - -"), sections: `s: { bars: ${bars}, volume: { from: 0, to: 15 }, layers: { v1: a } }` });
  assert.ok(has(make(1), "VOL-STEP"), "15 steps in 4 beats");
  assert.ok(!has(make(8), "VOL-STEP"), "15 steps in 32 beats");
});

test("HR-GAP: all sounding voices restarting on the same beat for four beats is flagged", () => {
  const voices = [1, 2].map((id) => `  - { id: ${id}, instrument: p, patterns: { a: { length: 1, groove: "${id === 1 ? "C4 C4 C4 C4" : id === 2 ? "E4 E4 E4 E4" : ""}" } } }`).join("\n");
  const make = (second) => doc({ instruments: P, voices: voices.replace("E4 E4 E4 E4", second), sections: "s: { bars: 2, layers: { v1: a, v2: a } }" });
  assert.ok(has(make("E4 E4 E4 E4"), "HR-GAP"));
  assert.ok(!has(make("E4 ~ ~ ~"), "HR-GAP"), "one voice holds through the restarts");
});

test("HR-SHORT: a gate-off shorter than 32768 cycles is flagged; frames: 0 is not", () => {
  const make = (frames) => doc({ instruments: `  p: { waveform: pulse, adsr: [0, 4, 10, 4], hard_restart: { frames: ${frames} } }\n`, voices: v1("C4 C4 C4 C4") });
  assert.ok(has(make(1), "HR-SHORT"));
  assert.ok(!has(make(0), "HR-SHORT"));
  assert.ok(!has(make(2), "HR-SHORT"));
});

test("TABLE-CUT: a drum table cut by the next attack in more than a quarter of its uses is flagged", () => {
  const kit = "  k: { waveform: tri, adsr: [0, 9, 0, 0], wavetable: [{ note: E3, slide_to: G#1, frames: 12 }, { gate: false }] }\n";
  const make = (groove, length) => doc({ instruments: P + kit, voices: v1(groove, { inst: "k", length }) });
  const dense = "C3 C3 C3 C3 C3 C3 C3 C3 C3 C3 C3 C3 C3 C3 C3 C3";
  assert.ok(has(make(dense, 0.25), "TABLE-CUT"), "13-frame table at 6-frame spacing");
  assert.ok(!has(make("C3 - C3 -", 1), "TABLE-CUT"), "24-frame notes hold the table");
  const finding = compileSidwaveToPrg(parseSidwave(make(dense, 0.25))).lint.find((f) => f.code === "TABLE-CUT");
  assert.match(finding.message, /needs 13 frames but only \d+ are available/);
});

test("FILTER-SHARED: two voices with filter tables sounding together without an owner; FILTER-IGNORED with one", () => {
  const ft = "  f: { waveform: sawtooth, adsr: [0, 4, 10, 4], filtertable: [{ cutoff: 600, type: lowpass }, { add: 5, frames: 4 }] }\n";
  const two = (sid) => doc({ instruments: ft, sid, voices: [1, 2].map((id) => `  - { id: ${id}, instrument: f, patterns: { a: { length: 1, groove: "C3 C3 C3 C3" } } }`).join("\n"), sections: "s: { bars: 1, layers: { v1: a, v2: a } }" });
  assert.ok(has(two('{ id: sid1, address: "$D400", model: "8580" }'), "FILTER-SHARED"));
  const owned = lint(two('{ id: sid1, address: "$D400", model: "8580", filter: { owner: v1 } }'));
  assert.ok(!owned.includes("FILTER-SHARED") && owned.includes("FILTER-IGNORED"));
  const solo = doc({ instruments: ft, voices: v1("C3 C3 C3 C3", { inst: "f" }) });
  assert.ok(!has(solo, "FILTER-SHARED") && !has(solo, "FILTER-IGNORED"));
});

test("FILTER-MODEL: a filter without a declared SID model is flagged; Hz without a model is an error", () => {
  const ft = "  f: { waveform: sawtooth, adsr: [0, 4, 10, 4], filtertable: [{ cutoff: 600, type: lowpass }] }\n";
  const noModel = doc({ instruments: ft, sid: '{ id: sid1, address: "$D400" }', voices: v1("C3 C3 C3 C3", { inst: "f" }) });
  assert.ok(has(noModel, "FILTER-MODEL"));
  assert.ok(!has(doc({ instruments: ft, voices: v1("C3 C3 C3 C3", { inst: "f" }) }), "FILTER-MODEL"));
  const hz = ft.replace("cutoff: 600", "cutoff: 900Hz");
  assert.throws(() => compileSidwaveToPrg(parseSidwave(doc({ instruments: hz, sid: '{ id: sid1, address: "$D400" }', voices: v1("C3 C3 C3 C3", { inst: "f" }) }))), /declare sids\[\]\.model before using a cutoff in Hz/);
});

test("FILTER-BASS: a low-pass on the bass voice that settles above 2.5 kHz is flagged", () => {
  const make = (cut) => doc({ instruments: `  f: { waveform: sawtooth, adsr: [0, 4, 10, 4], filtertable: [{ cutoff: ${cut}, type: lowpass }] }\n`, voices: `  - { id: 1, role: bass, instrument: f, patterns: { a: { length: 1, groove: "C2 C2 C2 C2" } } }` });
  assert.ok(has(make("4kHz"), "FILTER-BASS"));
  assert.ok(!has(make("900Hz"), "FILTER-BASS"));
});

test("FILTER-MUTED: a low-pass cutoff below the fundamental for most of the note is flagged", () => {
  const make = (note) => doc({ instruments: "  f: { waveform: sawtooth, adsr: [0, 4, 10, 4], filtertable: [{ cutoff: 150Hz, type: lowpass }] }\n", voices: v1(`${note} ${note} ${note} ${note}`, { inst: "f" }) });
  assert.ok(has(make("A5"), "FILTER-MUTED"));
  assert.ok(!has(make("C2"), "FILTER-MUTED"));
});

test("FILTER-STEP: consecutive set steps of 2 frames or more jumping more than 100 units at resonance 10 or more", () => {
  const steps = (gap, res) => `[{ cutoff: 400, resonance: ${res}, type: lowpass, frames: 3 }, { cutoff: ${400 + gap}, frames: 3 }]`;
  const make = (gap, res) => doc({ instruments: `  f: { waveform: sawtooth, adsr: [0, 4, 10, 4], filtertable: ${steps(gap, res)} }\n`, voices: v1("C3 C3 C3 C3", { inst: "f" }) });
  assert.ok(has(make(200, 12), "FILTER-STEP"));
  assert.ok(!has(make(50, 12), "FILTER-STEP"));
  assert.ok(!has(make(200, 4), "FILTER-STEP"));
});

test("PW-EDGE: a pulse table leaving 5-95% duty is flagged", () => {
  const make = (set) => doc({ instruments: `  w: { waveform: pulse, adsr: [0, 4, 10, 4], pulsetable: [{ set: ${set} }, { add: 8, frames: 4 }] }\n`, voices: v1("C3 C3 C3 C3", { inst: "w" }) });
  assert.ok(has(make(0.02), "PW-EDGE"));
  assert.ok(!has(make(0.4), "PW-EDGE"));
});

test("ARP-FAST: a chord-arp tone shorter than one video frame is flagged at multispeed", () => {
  const make = (calls) => doc({ extra: "speed: 4\n", instruments: `  a: { waveform: pulse, adsr: [0, 4, 10, 4], wavetable: [{ note: "+0", calls: ${calls} }, { note: "+7", calls: ${calls} }], loop: 0 }\n`, voices: v1("C3 C3 C3 C3", { inst: "a" }), tempo: 100 });
  assert.ok(has(make(2), "ARP-FAST"));
  assert.ok(!has(make(4), "ARP-FAST"));
});

test("NO-BASS: eight bars without a note below C3 while two voices sound is flagged", () => {
  const voices = (low) => `  - { id: 1, instrument: p, patterns: { a: { length: 1, groove: "${low} ${low} ${low} ${low}" } } }\n  - { id: 2, instrument: p, patterns: { a: { length: 1, groove: "E4 E4 E4 E4" } } }`;
  const make = (low) => doc({ instruments: P, voices: voices(low), sections: "s: { bars: 8, layers: { v1: a, v2: a } }" });
  assert.ok(has(make("C4"), "NO-BASS"));
  assert.ok(!has(make("C2"), "NO-BASS"));
});

test("DUP: two voices playing the same notes at the same onsets for two bars is flagged; a detuned double is not", () => {
  const make = (extra) => doc({ instruments: P, voices: `${v1("C4 E4 G4 E4")}\n  - { id: 2, instrument: p, ${extra} patterns: { a: { length: 1, groove: "C4 E4 G4 E4" } } }`, sections: "s: { bars: 2, layers: { v1: a, v2: a } }" });
  assert.ok(has(make(""), "DUP"));
  assert.ok(!has(make("detune: 7,"), "DUP"));
});

test("CLASH: a minor second or minor ninth held together on a beat is flagged", () => {
  const make = (second) => doc({ instruments: P, voices: `${v1("C4 C4 C4 C4")}\n  - { id: 2, instrument: p, patterns: { a: { length: 1, groove: "${second} ${second} ${second} ${second}" } } }`, sections: "s: { bars: 1, layers: { v1: a, v2: a } }" });
  assert.ok(has(make("C#4"), "CLASH"));
  assert.ok(has(make("C#5"), "CLASH"), "minor ninth");
  assert.ok(!has(make("E4"), "CLASH"));
});

test("TEMPO-GRID: a sixteenth that is not a whole number of calls gives the two nearest exact tempos", () => {
  const make = (tempo) => doc({ tempo, instruments: P, voices: v1("C4 - - -") });
  const finding = compileSidwaveToPrg(parseSidwave(make(120))).lint.find((f) => f.code === "TEMPO-GRID");
  assert.match(finding.message, /use tempo [\d.]+ or [\d.]+ for an exact grid/);
  assert.ok(!has(make(125.31), "TEMPO-GRID"));
});

test("RINGSYNC-SRC: a sync note whose source channel changes pitch is flagged unless source_note is set", () => {
  const make = (source) => doc({ instruments: `  sy: { waveform: sawtooth, adsr: [0, 4, 10, 4], sync: true${source} }\n  q: { waveform: pulse, adsr: [0, 4, 10, 4] }\n`,
    voices: `  - { id: 1, instrument: q, patterns: { b: { length: 0.5, groove: "C3 E3 G3 C4 - - - -" } } }\n  - { id: 2, instrument: sy, patterns: { a: { length: 4, groove: "C4" } } }`, sections: "s: { bars: 1, layers: { v1: b, v2: a } }" });
  assert.ok(has(make(""), "RINGSYNC-SRC"));
  assert.ok(!has(make("") .replace("layers: { v1: b, v2: a }", "layers: { v2: a }"), "RINGSYNC-SRC"), "a still source");
});

test("ONE-SIDE: a bass part on a one-sided pan is flagged; center: true removes it", () => {
  const make = (center) => `sidwave: 1.2\ntitle: T\ntempo: 125.31\nsids: { layout: ultisid8, pan: wide }\ninstruments:\n${P}voices:\n  - { id: 1, role: bass, instrument: p, ${center} patterns: { a: { length: 1, groove: "C2 C2 C2 C2" } } }\nsections:\n  s: { bars: 1, layers: { v1: a } }\ntimeline: [s]\n`;
  assert.ok(has(make(""), "ONE-SIDE"));
  assert.ok(!has(make("center: true,"), "ONE-SIDE"));
});

test("DIGI-SHARED: samples and pitched voices on one SID are flagged", () => {
  const make = (sid) => doc({ instruments: P, voices: v1("C4 - - -"), extra: `samples: { rate: 4000, defs: { h: { hex: "fe" } }, triggers: [{ sample: h, sid: ${sid}, at: [0] }] }\n`, sid: '{ id: sid1, address: "$D400", model: "8580" }, { id: sid2, address: "$D420", model: "8580" }' });
  assert.ok(has(make("sid1"), "DIGI-SHARED"));
  assert.ok(!has(make("sid2"), "DIGI-SHARED"));
});

test("noise combined with another waveform in a wavetable is an error", () => {
  const make = (wave) => doc({ instruments: `  n: { waveform: noise, wavetable: [{ wave: ${wave} }] }\n`, voices: v1("C3 - - -", { inst: "n" }) });
  assert.throws(() => parseSidwave(make("noise+pulse")), /noise combined with another waveform/);
  assert.doesNotThrow(() => parseSidwave(make("noise")));
});

test("lint output is aggregated: at most 12 entries, each with code, count, first position and a message", () => {
  const entries = compileSidwaveToPrg(parseSidwave(doc({ instruments: P, voices: v1("C4 C4 C4 C4"), sections: "s: { bars: 8, layers: { v1: a } }" }))).lint;
  assert.ok(entries.length <= 12);
  for (const f of entries) {
    assert.deepEqual(Object.keys(f).sort(), ["code", "count", "first", "message"]);
    assert.ok(f.count >= 1 && f.message.length > 10);
  }
  const unique = new Set(entries.map((f) => f.code));
  assert.equal(unique.size, entries.length, "repeats are merged into one entry");
});

test("breathing room between attacks stays valid when voices share the beat", () => {
  const voices = `${v1("C4 C4 C4 C4")}
  - { id: 2, instrument: p, patterns: { a: { length: 0.5, groove: "- E4 - E4 - E4 - E4" } } }`;
  const source = doc({ instruments: P, voices, sections: "s: { bars: 2, layers: { v1: a, v2: a } }" });
  assert.ok(!has(source, "HR-GAP"));
});

test("a percussion transient inherits general section dynamics without a sustain warning", () => {
  const make = (extra) => doc({ instruments: P, voices: v1("C3 - - -", { inst: "lib:kick", extra }),
    sections: "s: { bars: 1, level: pp, layers: { v1: a } }" });
  assert.ok(!has(make(""), "LEVEL-NOOP"));
  assert.ok(has(make("level: 5,"), "LEVEL-NOOP"), "a targeted level cannot adjust sustain zero");
});

test("noise and kit hits never create a pitched semitone clash", () => {
  const make = (inst, instrument = P) => doc({
    voices: `${v1("C4 C4 C4 C4")}
  - { id: 2, instrument: ${inst}, patterns: { a: { length: 1, groove: "C#4 C#4 C#4 C#4" } } }`,
    instruments: instrument, sections: "s: { bars: 1, layers: { v1: a, v2: a } }",
  });
  assert.ok(!has(make("lib:kick"), "CLASH"));
  assert.ok(!has(make("noise", P + "  noise: { waveform: noise }\n"), "CLASH"));
  assert.ok(has(make("p"), "CLASH"));
});

test("a sync source can re-attack at the same oscillator pitch", () => {
  const make = (source) => doc({
    instruments: P + "  sync: { waveform: saw, sync: true }\n",
    voices: `${v1(source, { length: 0.5 })}
  - { id: 2, instrument: sync, patterns: { a: { length: 4, groove: "A4" } } }`,
    sections: "s: { bars: 1, layers: { v1: a, v2: a } }",
  });
  assert.ok(!has(make("C3 C3 - C3 C3 C3 C3 C3"), "RINGSYNC-SRC"));
  assert.ok(has(make("C3 D3 - C3 C3 C3 C3 C3"), "RINGSYNC-SRC"));
});

test("an opposite-pan unison copy centres a hard-panned part", () => {
  const make = (pan, copy) => doc({
    sid: `{ id: l, address: "$D400", pan: Left 5 }, { id: r, address: "$D420", pan: ${pan} }`,
    voices: v1("C2 C2 C2 C2", { extra: "role: bass," }) + (copy ? "\n  - { id: 4, unison: {voice: 1, detune: 0} }" : ""),
    instruments: P,
  });
  assert.ok(!has(make("Right 5", true), "ONE-SIDE"));
  assert.ok(has(make("Left 5", true), "ONE-SIDE"));
  assert.ok(has(make("Right 5", false), "ONE-SIDE"));
  const narrow = make("Right 2", false).replace("pan: Left 5", "pan: Left 2");
  assert.ok(!has(narrow, "ONE-SIDE"));
});
