import test from "#test/runner";
import assert from "#test/assert";
import { parseSidwave } from "../src/sidwave.js";
import { arrangeSidwave } from "../src/sidwaveCompiler.js";

const make = (pattern, extra = {}) => ({
  sidwave: "1.0", tempo: 120, ...extra,
  voices: [{ id: 1, patterns: { A: pattern } }],
  timeline: [{ bars: 2, layers: { v1: "A" } }],
});

test("SIDWAVE numeric strings in pattern length and transpositions arrange like numbers (SOUND-1)", () => {
  const num = arrangeSidwave(parseSidwave(make({ groove: ["A4", "C5"], length: 2, transpositions: [5] }))).voices[0].notes;
  const str = arrangeSidwave(parseSidwave(make({ groove: ["A4", "C5"], length: "2", transpositions: ["5"] }))).voices[0].notes;
  assert.deepEqual(str, num);
  assert.equal(num[0].end, 50);
});

test("SIDWAVE numeric string reverb delay_frames behaves like a number and input is not mutated (SOUND-1)", () => {
  const mk = (d) => make({ groove: ["C4", "-"], length: 4 }, { global_fx: { reverb_sim: { depth: 0.5, delay_frames: d } } });
  const input = mk("5");
  const a = arrangeSidwave(parseSidwave(input));
  const b = arrangeSidwave(parseSidwave(mk(5)));
  assert.deepEqual(a.voices.map((v) => v.notes), b.voices.map((v) => v.notes));
  assert.equal(input.global_fx.reverb_sim.delay_frames, "5");
});

test("SIDWAVE unquoted ~ (YAML null) in a groove is a tie (SOUND-12)", () => {
  const yaml = "voices:\n  - id: 1\n    patterns:\n      A: { groove: [C4, ~, E4, \"-\"] }\ntimeline:\n  - { bars: 1, layers: { v1: A } }\n";
  const notes = arrangeSidwave(parseSidwave(yaml)).voices[0].notes;
  assert.equal(notes.length, 2);
  const quoted = arrangeSidwave(parseSidwave(yaml.replace("~,", '"~",'))).voices[0].notes;
  assert.deepEqual(notes, quoted);
});

test("SIDWAVE a dense song is rejected quickly with the size error (SOUND-17)", () => {
  const started = Date.now();
  assert.throws(
    () => arrangeSidwave(parseSidwave({
      sidwave: "1.0", tempo: 30,
      voices: [{ id: 1, patterns: { A: { groove: ["C4"], length: 0.05 } } }],
      timeline: [{ bars: 4096, layers: { v1: "A" } }],
    })),
    /more than 20000 notes.*past the \$D000 limit/,
  );
  assert.ok(Date.now() - started < 1500);
});
