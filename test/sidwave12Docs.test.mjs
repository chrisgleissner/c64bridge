// SIDWAVE 1.2 round 2: the spec, schema and filter model stay in step with the compiler.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import { compileDoc, gateOns, runPsid, voice } from "./helpers/sidwaveEmulator.mjs";
import { compileSidwaveToPrg, arrangeSidwave, sidwaveFrameRate } from "../src/sidwaveCompiler.js";
import { parseSidwave } from "../src/sidwave.js";
import { cutoffHz, resolveCutoff } from "../src/sidwaveFilterModel.js";

const spec = fs.readFileSync(new URL("../data/sound/sidwave.md", import.meta.url), "utf8");
const schema = JSON.parse(fs.readFileSync(new URL("../data/sound/sidwave.schema.json", import.meta.url), "utf8"));

test("the LLM quick reference is short and its skeleton compiles", () => {
  const section = spec.slice(spec.indexOf("## LLM Prompt Template"));
  assert.ok(section.split(/\s+/).length < 1100, "well under 1,500 tokens");
  const yaml = /```yaml\n([\s\S]*?)```/.exec(section)[1];
  const compiled = compileSidwaveToPrg(parseSidwave(yaml));
  assert.ok(compiled.arrangement.length === 6 && compiled.durationSeconds > 60);
});

test("the schema describes every 1.2 field of this round", () => {
  for (const key of ["kit", "sections", "loop_to", "accent", "end", "swing", "swing_unit"]) assert.ok(schema.properties[key], key);
  const defs = schema.$defs;
  assert.ok(defs.section.properties.levels && defs.section.properties.volume && defs.section.properties.filter && defs.section.properties.transpose);
  const layout = schema.properties.sids.oneOf[1];
  assert.equal(defs.sid.properties.filter.$ref, "#/$defs/sidFilter");
  assert.equal(layout.properties.overrides.additionalProperties.properties.filter.$ref, "#/$defs/sidFilter");
  assert.ok(defs.sidFilter.anyOf[1].properties.owner && defs.sidFilter.anyOf[1].properties.route);
  assert.ok(defs.echo.properties.delay_beats && defs.echo.properties.adsr);
  assert.ok(defs.instrument.properties.source_note);
  assert.ok(defs.pulsetable.oneOf[1].properties.reset && defs.filtertable.oneOf[1].properties.reset);
  assert.ok(defs.hz && defs.level && defs.filtertableStep.properties.calls);
  const voice = schema.properties.voices.items.properties;
  assert.ok(voice.digi && voice.level && voice.role && voice.center);
});

test("the spec documents every lint code, the filter curve source and the library version dependence", () => {
  for (const code of ["SEQ-CUT", "LOOP-TIE", "LEVEL-NOOP", "FLAT", "REPEAT", "VOL-STEP", "HR-GAP", "HR-SHORT", "TABLE-CUT", "FILTER-SHARED",
    "FILTER-IGNORED", "FILTER-MODEL", "FILTER-BASS", "FILTER-MUTED", "FILTER-STEP", "PW-EDGE", "ARP-FAST", "NO-BASS", "DUP", "CLASH",
    "TEMPO-GRID", "RINGSYNC-SRC", "ONE-SIDE", "DIGI-SHARED"]) assert.ok(spec.includes(`\`${code}\``), code);
  assert.match(spec, /f0_points_6581/);
  assert.match(spec, /1\.2 document gets the revised library drums|revised library drums/);
});

test("filter model: 8580 reaches 12.5 kHz, the 6581 table is non-linear, Hz round-trips to register units", () => {
  // reSID 0.16 f0_points_8580 / f0_points_6581 (filter.cc)
  assert.equal(cutoffHz(2047, "8580"), 12500);
  assert.equal(cutoffHz(1024, "8580"), 6500);
  assert.equal(cutoffHz(0, "8580"), 0);
  assert.equal(cutoffHz(0, "6581"), 220);
  assert.equal(cutoffHz(1023, "6581"), 6000);
  assert.equal(cutoffHz(1024, "6581"), 4600, "the 6581 curve has a discontinuity at 1024");
  const code = resolveCutoff("1.2kHz", "8580", "$");
  assert.ok(Math.abs(cutoffHz(code, "8580") - 1200) < 20);
  assert.notEqual(resolveCutoff("900Hz", "6581", "$"), resolveCutoff("900Hz", "8580", "$"), "the same Hz resolves per model");
  assert.equal(resolveCutoff(321, undefined, "$"), 321, "register values pass through");
});

test("lib:filter_bass resolves its Hz targets per model", () => {
  const make = (model) => `sidwave: 1.2\ntitle: T\ntempo: 125.31\nsids: [{ id: sid1, address: "$D400", model: "${model}" }]\nvoices: [{ id: 1, instrument: "lib:filter_bass", patterns: { a: { length: 1, groove: "C2 C2 C2 C2" } } }]\nsections: { s: { bars: 1, layers: { v1: a } } }\ntimeline: [s]\n`;
  const table = (model) => {
    const arr = arrangeSidwave(parseSidwave(make(model)));
    return arr.instruments[arr.voices[0].notes[0].inst].filtertable.steps.map((s) => s.value);
  };
  const a = table("8580");
  const b = table("6581");
  assert.ok(JSON.stringify(a) !== JSON.stringify(b), "the tables differ per model");
  assert.ok(Math.abs(cutoffHz(a[0], "8580") - 1200) < 20 && Math.abs(cutoffHz(a.at(-1), "8580") - 300) < 20);
});

test("pan presets: wide, narrow and omitted; the socket SID is centred", () => {
  const pans = (sids) => parseSidwave(`sidwave: 1.2\ntitle: T\ntempo: 120\nsids: ${sids}\nvoices: [{ id: 1, patterns: { a: { length: 1, groove: "C4" } } }]\nsections: { s: { bars: 1, layers: { v1: a } } }\ntimeline: [s]\n`).sids.map((s) => s.pan);
  assert.deepEqual(pans("{ layout: ultisid8, pan: wide }"), [...Array(4).fill("Left 5"), ...Array(4).fill("Right 5")]);
  assert.deepEqual(pans("{ layout: ultisid8, pan: narrow }").slice(3, 5), ["Left 3", "Right 3"]);
  assert.deepEqual(pans("{ layout: ultisid8 }"), Array(8).fill(undefined));
  assert.equal(pans("{ layout: ultisid8+socket1, pan: wide }")[8], "Center");
});

test("levels replace the section level per voice and the song accent defaults to 3", () => {
  const source = `sidwave: 1.2
title: T
tempo: 125.31
sids: [{ id: sid1, address: "$D400", model: "8580" }]
instruments: { p: { waveform: pulse, adsr: [0, 4, 12, 4] } }
voices:
  - { id: 1, instrument: p, patterns: { a: { length: 1, groove: "C4 D4! - -" } } }
  - { id: 2, instrument: p, patterns: { a: { length: 1, groove: "C3 - - -" } } }
sections: { s: { bars: 1, level: ff, levels: { v2: pp }, layers: { v1: a, v2: a } } }
timeline: [s]
`;
  const { sid } = compileDoc(source);
  const { states } = runPsid(sid, 80);
  const v1 = voice(states, 0);
  const v2 = voice(states, 1);
  const first = gateOns(v1)[0].frame;
  assert.equal(v1.sr[first] >> 4, 12, "ff leaves sustain 12");
  assert.equal(v1.sr[gateOns(v1)[1].frame] >> 4, 15, "an accent adds 3 and clamps at 15");
  assert.equal(v2.sr[gateOns(v2)[0].frame] >> 4, 3, "levels: { v2: pp } replaces the section level");
});

test("a section tempo ramp lengthens successive bars (ritardando) while the document total stays absolute", () => {
  const source = (tempo) => `sidwave: 1.2\ntitle: T\ntempo: 120\nsids: [{ id: sid1, address: "$D400" }]\nvoices: [{ id: 1, waveform: pulse, patterns: { a: { length: 1, groove: "C4 - - -" } } }]\nsections: { s: { bars: 6, tempo: ${tempo}, layers: { v1: a } } }\ntimeline: [s]\n`;
  const onsets = arrangeSidwave(parseSidwave(source("{ to: 60 }"))).voices[0].notes.map((n) => n.start);
  const gaps = onsets.slice(1).map((v, i) => v - onsets[i]);
  assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]), `bars get longer: ${gaps}`);
  assert.ok(gaps.at(-1) > 1.3 * gaps[0]);
  const fixed = arrangeSidwave(parseSidwave(source("96"))).voices[0].notes.map((n) => n.start);
  assert.equal(fixed[5], Math.round(5 * 4 * 60 / 96 * sidwaveFrameRate("PAL")));
});
