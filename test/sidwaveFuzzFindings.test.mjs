// Minimized regressions from test/sidwaveFuzz.test.mjs. See /home/chris/.c64bridge/h7/fuzz-findings.md for F1–F13.
import test from "#test/runner";
import assert from "#test/assert";
import { compileSidwaveToPrg, compileSidwaveToSid } from "../src/sidwaveCompiler.js";
import { parseFilterMod, parseSidwave, SidwaveValidationError } from "../src/sidwave.js";
import { exercise, noteName } from "./helpers/sidwaveFuzzKit.mjs";

const oneNote = (extra = {}) => ({
  sidwave: "1.1",
  ...extra,
  voices: [{ id: 1, patterns: { A: { groove: ["C3"] } } }],
  timeline: [{ bars: 1, layers: { v1: "A" } }],
});
const withInstrument = (instrument, version = "1.1") => ({
  sidwave: version,
  instruments: { x: instrument },
  voices: [{ id: 1, instrument: "x", patterns: { A: { groove: ["C3", "E3"] } } }],
  timeline: [{ bars: 1, layers: { v1: "A" } }],
});

/** Parsing must throw a SidwaveValidationError whose path starts with `path`. */
function assertRejectedAt(input, path) {
  let error;
  try { parseSidwave(input); } catch (e) { error = e; }
  assert.ok(error, `the document was accepted; expected a rejection at ${path}`);
  assert.ok(error instanceof SidwaveValidationError, `expected SidwaveValidationError, got ${error?.constructor?.name}: ${String(error?.message).slice(0, 120)}`);
  assert.ok(error.path.startsWith(path), `expected a path starting with ${path}, got ${error.path}`);
}

// F1 -------------------------------------------------------------------------------------------------------------

test("F1: the loop wrap call of a one-note song stays within worstCaseCyclesPerCall", () => {
  const result = exercise(oneNote(), { loop: true, maxCalls: 200, checkPsid: false });
  assert.equal(result.outcome, "played");
  assert.ok(result.stats.maxCycles <= result.stats.estimate, `a play call took ${result.stats.maxCycles} cycles, the compiler estimate is ${result.stats.estimate}`);
});

// F2 -------------------------------------------------------------------------------------------------------------

test("F2: a note start with pattern vibrato stays within worstCaseCyclesPerCall", () => {
  const doc = { sidwave: "1.2", voices: [{ id: 1, patterns: { A: { groove: ["C3"], fx: { vibrato: { depth: 1, rate: 1 } } } } }], timeline: [{ bars: 1, layers: { v1: "A" } }] };
  const result = exercise(doc, { loop: false, maxCalls: 200, checkPsid: false });
  assert.equal(result.outcome, "played");
  assert.ok(result.stats.maxCycles <= result.stats.estimate, `a play call took ${result.stats.maxCycles} cycles, the compiler estimate is ${result.stats.estimate}`);
});

test("F2: two voices with vibrato, a drum kit and transposition stay within worstCaseCyclesPerCall", () => {
  const doc = {
    sidwave: 1.2,
    voices: [
      { id: 2, patterns: { A: { motif: "A", fx: { vibrato: { depth: 1, rate: 1 } } } } },
      { id: 3, patterns: { C: { drums: { kit: { k: "lib:chip_arp_minor", s: "lib:octave_bass" }, steps: ".s.k." } } } },
    ],
    timeline: [{ bars: 1, layers: { v2: "A+5" } }, { bars: 1, layers: { v3: "C-" } }],
    length_bars: 5,
  };
  const result = exercise(doc, { loop: true, maxCalls: 800, checkPsid: false });
  assert.equal(result.outcome, "played");
  assert.ok(result.stats.maxCycles <= result.stats.estimate, `a play call took ${result.stats.maxCycles} cycles, the compiler estimate is ${result.stats.estimate}`);
});

// F3 -------------------------------------------------------------------------------------------------------------

test("F3a: instrument adsr values outside 0..15 are rejected with a path", () => {
  assertRejectedAt(withInstrument({ adsr: [99, 0, 0, 0] }), "$.instruments.x.adsr");
});
test("F3a: instrument adsr values that are negative, fractional or not numbers are rejected with a path", () => {
  for (const adsr of [[-1, 2, 3, 4], [1.5, 0, 0, 0], ["x", 0, 0, 0], [null, null, null, null]]) assertRejectedAt(withInstrument({ adsr }), "$.instruments.x.adsr");
});
test("F3b: instrument pulse_width outside 1..4094 or 0..1 is rejected with a path", () => {
  for (const pulse_width of [99999, -5, "x", 0]) assertRejectedAt(withInstrument({ pulse_width }), "$.instruments.x.pulse_width");
});
test("F3b: an out-of-range instrument pulse_width never writes bits 4-7 of the pulse width high register", () => {
  const result = exercise(withInstrument({ pulse_width: 99999 }), { loop: false, maxCalls: 30, checkPsid: false });
  assert.deepEqual(result.faults.filter((f) => f.kind === "register-reserved-bits-set"), []);
});
test("F3c: a non-string instrument waveform is rejected by the parser, not by a TypeError in the compiler", () => {
  for (const waveform of [[], 7, null]) assertRejectedAt(withInstrument({ waveform }), "$.instruments.x.waveform");
});
test("F3c: an unknown instrument waveform name is rejected like a voice waveform", () => {
  assertRejectedAt(withInstrument({ waveform: "banana" }), "$.instruments.x.waveform");
});
test("F3d: instrument vibrato must be a mapping with depth and rate in the documented ranges", () => {
  for (const vibrato of ["x", {}, { depth: -5, rate: -1 }, { depth: 1e9, rate: 1e9 }, { depth: 5, rate: 5, delay: -3 }]) assertRejectedAt(withInstrument({ vibrato }), "$.instruments.x.vibrato");
});
test("F3e: instrument slide must be a mapping with a non-zero depth in +-24 and speed 1..255", () => {
  for (const slide of ["x", {}, { depth: 1e6, speed: 0 }, { depth: 3, speed: 0 }]) assertRejectedAt(withInstrument({ slide }), "$.instruments.x.slide");
});
test("F3f: instrument ring and sync must be booleans", () => {
  assertRejectedAt(withInstrument({ ring: "yes" }), "$.instruments.x.ring");
  assertRejectedAt(withInstrument({ sync: 5 }), "$.instruments.x.sync");
});
test("F3g: instrument loop without a wavetable, or outside the table, is rejected", () => {
  for (const loop of [99, -1]) assertRejectedAt(withInstrument({ loop }), "$.instruments.x.loop");
});

// F4 -------------------------------------------------------------------------------------------------------------

const nested = (depth) => { let v = []; for (let i = 0; i < depth; i++) v = [v]; return v; };

test("F4: a deeply nested array in a scalar field is rejected with a path, not a RangeError", () => {
  for (const field of ["title", "author", "mode", "tempo", "sidwave", "meter", "speed"]) {
    assertRejectedAt({ ...oneNote(), [field]: nested(20_000) }, `$.${field}`);
  }
});
test("F4: a deeply nested array in a voice name or a timeline layer is rejected with a path", () => {
  const doc = oneNote();
  doc.voices[0].name = nested(20_000);
  assertRejectedAt(doc, "$.voices[0].name");
  const doc2 = oneNote();
  doc2.timeline[0].layers.v1 = nested(20_000);
  assertRejectedAt(doc2, "$.timeline[0].layers.v1");
});

// F5 -------------------------------------------------------------------------------------------------------------

test("F5: a timeline with a million sections is rejected within 1 second", () => {
  const doc = oneNote();
  doc.timeline = Array.from({ length: 1_000_000 }, () => ({ bars: 1, layers: { v1: "A" } }));
  // CPU time of this process, so that load from other processes does not decide the result.
  const started = process.cpuUsage();
  assertRejectedAt(doc, "$.timeline");
  const used = process.cpuUsage(started);
  const ms = (used.user + used.system) / 1000;
  assert.ok(ms < 1000, `parsing took ${Math.round(ms)} ms`);
});

// F6 -------------------------------------------------------------------------------------------------------------

test("F6: hard_restart in a 1.0 or 1.1 document still parses as in 1.3.1 and is reported as ignored", () => {
  for (const version of ["1.0", "1.1"]) {
    const doc = parseSidwave(withInstrument({ hard_restart: { frames: 3, adsr: [1, 1, 1, 1], test: true } }, version));
    assert.deepEqual(doc.ignoredFields, ["$.instruments.x.hard_restart"]);
    assert.ok(compileSidwaveToPrg(doc).warnings.some((w) => /hard_restart has no effect before sidwave: 1\.2/.test(w)));
  }
});

test("F7: validation messages do not repeat an unbounded input value", () => {
  const doc = oneNote();
  doc.tempo = "x".repeat(1_000_000);
  let error;
  try { parseSidwave(doc); } catch (e) { error = e; }
  assert.ok(error instanceof SidwaveValidationError);
  assert.ok(error.message.length <= 1000, `the message has ${error.message.length} characters`);
  const doc2 = oneNote();
  doc2.timeline[0].layers.v1 = "A".repeat(1_000_000);
  try { parseSidwave(doc2); error = undefined; } catch (e) { error = e; }
  assert.ok(error.message.length <= 1000, `the message has ${error.message.length} characters`);
});

// F8 -------------------------------------------------------------------------------------------------------------

test("F8: a title, author or section name that is a list or mapping is rejected instead of being turned into text", () => {
  assertRejectedAt({ ...oneNote(), title: ["a", "b"] }, "$.title");
  assertRejectedAt({ ...oneNote(), title: { a: 1 } }, "$.title");
  assertRejectedAt({ ...oneNote(), author: { a: 1 } }, "$.author");
  const doc = oneNote();
  doc.timeline[0].section = { x: 1 };
  assertRejectedAt(doc, "$.timeline[0].section");
});

// F9 -------------------------------------------------------------------------------------------------------------

test("F9: a timeline layer that names Object.prototype members is rejected by the parser with the pattern name", () => {
  for (const name of ["constructor", "toString", "hasOwnProperty"]) {
    const doc = oneNote();
    doc.timeline[0].layers.v1 = name;
    assertRejectedAt(doc, "$.timeline[0].layers.v1");
  }
});
test("F9: a voice instrument that names an Object.prototype member is rejected by the parser", () => {
  for (const name of ["toString", "constructor", "valueOf"]) {
    const doc = oneNote();
    doc.voices[0].instrument = name;
    assertRejectedAt(doc, "$.voices[0].instrument");
  }
});
test("F9: an instrument or pattern named __proto__ works like any other name", () => {
  const doc = JSON.parse('{"sidwave":"1.1","instruments":{"__proto__":{"waveform":"saw"}},"voices":[{"id":1,"instrument":"__proto__","patterns":{"A":{"groove":["C3"]}}}],"timeline":[{"bars":1,"layers":{"v1":"A"}}]}');
  doc.voices[0].patterns = JSON.parse('{"__proto__":{"groove":["C3"]}}');
  doc.timeline[0].layers.v1 = "__proto__";
  assert.ok(compileSidwaveToPrg(parseSidwave(doc)).totalFrames > 0);
});

// F10 ------------------------------------------------------------------------------------------------------------

test("F10: control characters in the title and author do not reach the PSID header", () => {
  const parsed = parseSidwave({ ...oneNote(), title: "A\u0000B\u0007C\nD", author: "X\u0000Y" });
  const { sid } = compileSidwaveToSid(parsed, compileSidwaveToPrg(parsed).prg);
  for (const [name, offset] of [["title", 0x16], ["author", 0x36]]) {
    const bytes = [...sid.subarray(offset, offset + 32)];
    const text = bytes.slice(0, bytes.indexOf(0) < 0 ? 32 : bytes.indexOf(0));
    assert.ok(text.every((b) => b >= 0x20), `${name} contains control bytes`);
    assert.ok(bytes.slice(text.length).every((b) => b === 0) && bytes.filter((b) => b === 0).length === 32 - text.length, `${name} has a NUL inside the text`);
  }
  assert.match(sid.subarray(0x16, 0x16 + 32).toString("latin1"), /^A.*B.*C.*D/s, "the title keeps its printable characters");
});

// F11 ------------------------------------------------------------------------------------------------------------

test("F11: a song that cannot fit below $D000 is refused within 4 CPU seconds even at 30 voices and 4096 bars", () => {
  const voices = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, patterns: { A: { groove: ["C3", "-"] } } }));
  const doc = { sidwave: "1.2", tempo: 140, sids: { layout: "ultisid8+sockets" }, voices, timeline: [{ bars: 4096, layers: Object.fromEntries(voices.map((v) => [`v${v.id}`, "A"])) }] };
  const parsed = parseSidwave(doc);
  const started = performance.now();
  assert.throws(() => compileSidwaveToPrg(parsed), (error) => error instanceof SidwaveValidationError && /\$D000/.test(error.message));
  const ms = performance.now() - started;
  // Before the fix the refusal took 7 s or more; measured 1.0-1.9 CPU s after it on this machine.
  assert.ok(ms < 4000, `the refusal took ${Math.round(ms)} ms of CPU time`);
});

// F12 ------------------------------------------------------------------------------------------------------------

test("F12: filter_mod with a numeric string sweep keeps its duration key", () => {
  assert.deepEqual(parseFilterMod({ sweep: "500", beats: 8 }, "$"), parseFilterMod({ sweep: 500, beats: 8 }, "$"));
  assert.throws(() => parseFilterMod({ sweep: "+500 over 8 steps", beats: 4 }, "$.fx"), /\$\.fx.*duration/);
});

test("F12: a document with filter_mod { sweep: 100, beats: 2 } compiles to the same bytes when the numbers are written as strings", () => {
  const doc = (sweep, beats) => ({ voices: [{ id: 3, patterns: { A: { notes: ["Eb3"], fx: { filter_mod: { sweep, beats } } } } }], timeline: [{ bars: 1, layers: { v3: "A" } }] });
  const numbers = compileSidwaveToPrg(parseSidwave(doc(100, 2))).prg;
  const strings = compileSidwaveToPrg(parseSidwave(doc("100", "2"))).prg;
  assert.ok(numbers.equals(strings), "the PRG differs between numbers and numeric strings");
});

// F13 ------------------------------------------------------------------------------------------------------------

test("F13: synth sample fields accept numeric strings like every other numeric field", () => {
  const doc = (layer) => ({ sidwave: "1.2", samples: { rate: 4000, defs: { d0: { synth: { layers: [layer] } } }, voices: [{ sample: "d0", at: [0] }] }, voices: [], timeline: [{ bars: 1, layers: {} }] });
  for (const layer of [{ osc: "sine", freq: "440", ms: 50 }, { osc: "sine", freq: 440, ms: "50" }, { osc: "sine", freq: 440, ms: 50, gain: "0.5" }, { osc: "square", freq: 440, ms: 50, duty: "0.5" }]) {
    assert.doesNotThrow(() => parseSidwave(doc(layer)), `rejected: ${JSON.stringify(layer)}`);
  }
});

// F14: a legacy one-shot still processes all three slots, even with no notes.
test("F14: three idle legacy channels stay within the one-shot cycle bound", () => {
  const result = exercise({ voices: [{ id: 1 }], timeline: [{ bars: 1 }] },
    { loop: false, maxCalls: 200, checkPsid: false });
  assert.equal(result.outcome, "played");
  assert.ok(result.stats.maxCycles <= result.stats.estimate, `measured ${result.stats.maxCycles}, estimated ${result.stats.estimate}`);
});

// F15: the R2 numeric-string variant of an indexed loop target is equivalent.
test("F15: loop_to accepts a numeric string as a timeline index", () => {
  const doc = { ...oneNote(), sidwave: "1.2" };
  doc.timeline.push({ bars: 1, layers: { v1: "A" } });
  const compile = (loop_to) => compileSidwaveToPrg(parseSidwave({ ...doc, loop_to }));
  assert.equal(compile("2").loopTo, 2);
  assert.ok(compile("2").prg.equals(compile(2).prg));
});

// F16: the 512-bar growth case spent most of its time comparing disjoint notes in CLASH.
test("F16: dense 512-bar score compiles without a quadratic clash scan", { timeout: 30_000 }, () => {
  const voices = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, patterns: {
    A: { length: 0.5, groove: Array.from({ length: 64 }, (_, j) => noteName(36 + (j * (i + 3)) % 30)) },
  } }));
  const doc = parseSidwave({ sidwave: "1.2", tempo: 140, sids: { layout: "ultisid8+sockets" },
    voices, timeline: [{ bars: 512, layers: Object.fromEntries(voices.map(({ id }) => [`v${id}`, "A"])) }],
  });
  const started = performance.now();
  const compiled = compileSidwaveToPrg(doc, { loop: false });
  assert.ok(compiled.bytesBelowD000 > 0);
  const ms = performance.now() - started;
  assert.ok(ms < 15_000, `the 512-bar compile took ${Math.round(ms)} ms`);
});
