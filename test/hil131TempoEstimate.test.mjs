import test from "#test/runner";
import assert from "#test/assert";
import { analyzePcmForTest } from "../src/audio/record_and_analyze_audio.js";

const RATE = 44100;

/** Square wave that steps through `notes` (Hz), each held for `stepSeconds`, for `seconds`. */
function steppedSquare(notes, stepSeconds, seconds) {
  const out = new Float32Array(Math.round(RATE * seconds));
  let phase = 0;
  for (let i = 0; i < out.length; i += 1) {
    const hz = notes[Math.floor(i / RATE / stepSeconds) % notes.length];
    phase = (phase + hz / RATE) % 1;
    out[i] = phase < 0.5 ? 0.4 : -0.4;
  }
  return out;
}

test("HIL131-6 a chip arpeggio does not produce a tempo of thousands of BPM", async () => {
  // C major arpeggio, one note every 3 PAL frames (60 ms), as SIDWAVE 1.1 chip_arp instruments play it.
  const result = await analyzePcmForTest(steppedSquare([261.63, 329.63, 392.0], 0.06, 3), RATE);
  const bpm = result.analysis.global_metrics.detected_bpm;
  assert.ok(bpm === null || (bpm >= 30 && bpm <= 300), `detected_bpm ${bpm}`);
});

test("HIL131-6 a melody with one note per beat at 120 BPM still reports about 120 BPM", async () => {
  const result = await analyzePcmForTest(steppedSquare([261.63, 293.66, 329.63, 349.23, 392.0, 440.0], 0.5, 6), RATE);
  const bpm = result.analysis.global_metrics.detected_bpm;
  assert.ok(bpm !== null && Math.abs(bpm - 120) <= 6, `detected_bpm ${bpm}`);
});
