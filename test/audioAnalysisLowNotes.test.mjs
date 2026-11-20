import test from "#test/runner";
import assert from "#test/assert";
import { analyzePcmForTest, analyzeStereoStream } from "../src/audio/record_and_analyze_audio.js";

const SR = 47983;
function tri(freq, seconds) {
  const out = new Float32Array(Math.floor(SR * seconds));
  for (let i = 0; i < out.length; i += 1) out[i] = 0.5 * (4 * Math.abs(((i / SR) * freq) % 1 - 0.5) - 1);
  return out;
}
function sine(freq, seconds) {
  const out = new Float32Array(Math.floor(SR * seconds));
  for (let i = 0; i < out.length; i += 1) out[i] = 0.5 * Math.sin(2 * Math.PI * freq * i / SR);
  return out;
}
const notesOf = (res) => res.analysis.voices[0].detected_notes.filter((n) => n.note).map((n) => n.note);

test("analysis detects bass notes below 100 Hz (SOUND-2)", async () => {
  for (const [freq, name] of [[65.41, "C2"], [82.41, "E2"], [55, "A1"]]) {
    const res = await analyzePcmForTest(tri(freq, 0.6), SR);
    assert.ok(notesOf(res).includes(name), `${name}: ${JSON.stringify(res.analysis.voices[0].detected_notes)}`);
  }
});

test("analysis of an in-range note still reports one A4 segment (SOUND-2)", async () => {
  const res = await analyzePcmForTest(sine(440, 0.6), SR);
  assert.deepEqual(notesOf(res), ["A4"]);
});

test("deviation is measured against every pitch the score sounds: motifs, layer transposes, arpeggios (SOUND-3)", async () => {
  const expected = {
    sidwave: "1.0",
    voices: [{ id: 1, patterns: { A: { groove: ["C4"] }, B: { motif: "E4 G4" }, C: { type: "arpeggio", notes: ["C3", "E3"], frame_rate: 2 } } }],
    timeline: [{ bars: 1, layers: { v1: "B^" } }],
  };
  // G5 = G4 transposed up an octave by the layer reference
  const g5 = await analyzePcmForTest(sine(783.99, 0.6), SR, expected);
  assert.ok(Math.abs(g5.analysis.voices[0].detected_notes[0].deviation_cents) < 5, JSON.stringify(g5.analysis.voices[0].detected_notes));
  const arp = {
    sidwave: "1.0",
    voices: [{ id: 1, patterns: { C: { type: "arpeggio", notes: ["C3", "E3"], frame_rate: 2 } } }],
    timeline: [{ bars: 1, layers: { v1: "C" } }],
  };
  const e3 = await analyzePcmForTest(sine(164.81, 0.6), SR, arp);
  assert.ok(Math.abs(e3.analysis.voices[0].detected_notes[0].deviation_cents) < 5, JSON.stringify(e3.analysis.voices[0].detected_notes));
});

test("analysis reports one mixed-output entry instead of three voices (SOUND-13)", async () => {
  const res = await analyzePcmForTest(sine(440, 0.6), SR);
  assert.equal(res.analysis.voices.length, 1);
  assert.equal(res.analysis.voices[0].id, 0);
  assert.ok(/mixed/.test(res.analysis.voices[0].source));
});

test("analysis stops at an abort signal instead of finishing synchronously (SOUND-5)", async () => {
  const controller = new AbortController();
  const stereo = new Int16Array(SR * 2 * 8);
  for (let i = 0; i < SR * 8; i += 1) stereo[2 * i] = Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / SR));
  const pending = analyzeStereoStream(stereo, SR, undefined, controller.signal);
  setImmediate(() => controller.abort());
  await assert.rejects(pending, (error) => error?.name === "AbortError");
});

test("analysis lets other work run while it processes a long capture (SOUND-5)", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  await analyzePcmForTest(sine(440, 3), SR);
  clearInterval(timer);
  assert.ok(ticks > 0, "the event loop never ran during the analysis");
});
