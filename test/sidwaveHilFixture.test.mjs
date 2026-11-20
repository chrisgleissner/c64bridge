import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareToReference } from "../src/audio/sidwaveSimilarity.js";

// 5 s excerpt of the first U64 hardware run (chiptune, seed 65, UltiSID) and of its sidplayfp 8580 rendering,
// mono 8 kHz. The capture is about 10 dB louder, with more bass and denser harmonics than the reference.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sidwave-hil");
const HALF_BAR = 120 / 130;

function wav(name) {
  const b = fs.readFileSync(path.join(dir, name));
  const n = (b.length - 44) / 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i += 1) x[i] = b.readInt16LE(44 + 2 * i) / 32768;
  return { left: x, right: x, sampleRate: b.readUInt32LE(24) };
}

/** Plays the signal faster by `ratio` (linear interpolation): all pitches move by that ratio. */
function resample(sig, ratio) {
  const n = Math.floor(sig.left.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = i * ratio, k = Math.floor(p), f = p - k;
    out[i] = sig.left[k] * (1 - f) + (sig.left[k + 1] ?? 0) * f;
  }
  return { left: out, right: out, sampleRate: sig.sampleRate };
}

const ref = wav("reference.wav"), cap = wav("capture.wav");
const fmt = (r) => JSON.stringify({ off: r.offsetMs, real: r.real, c: r.controls });

test("hardware excerpt passes against its sidplayfp reference with a margin over both controls", () => {
  const r = compareToReference(ref, cap, { latencySearchMs: 3000, halfBarSeconds: HALF_BAR });
  assert.ok(Math.abs(r.offsetMs - 50) < 15, `offset ${r.offsetMs}`);
  assert.ok(r.verdict.pass, fmt(r));
  assert.ok(r.real.chromaMedian >= Math.max(r.controls.transposedSemitone.chromaMedian, r.controls.shiftedHalfBar.chromaMedian) + 0.2, fmt(r));
  assert.ok(r.real.onset >= r.controls.shiftedHalfBar.onset + 0.2, fmt(r));
});

test("the hardware excerpt transposed by a semitone fails", () => {
  const r = compareToReference(ref, resample(cap, Math.pow(2, 1 / 12)), { latencySearchMs: 3000, halfBarSeconds: HALF_BAR });
  assert.ok(!r.verdict.pass, fmt(r));
});

test("the hardware excerpt played half a bar later than the allowed latency fails", () => {
  // The capture starts half a bar later than the 150 ms window allows, so the song cannot be aligned.
  const pad = new Float32Array(Math.round(HALF_BAR * cap.sampleRate));
  const late = { ...cap, left: Float32Array.from([...pad, ...cap.left]), right: Float32Array.from([...pad, ...cap.right]) };
  const r = compareToReference(ref, late, { latencySearchMs: 150, halfBarSeconds: HALF_BAR });
  assert.ok(!r.verdict.pass, fmt(r));
});
