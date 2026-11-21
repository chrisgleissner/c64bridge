import test from "#test/runner";
import assert from "#test/assert";
import { compareToReference } from "../src/audio/sidwaveSimilarity.js";
import { expectedSchedule } from "../src/audio/sidwaveFidelity.js";
import { restrictToSid } from "../src/audio/sidwaveReference.js";
import { DEFAULT_MUSIC_SEED, generateSidwave } from "../src/audio/generateSidwave.js";
import { parseSidwave } from "../src/sidwave.js";
import { arrangeSidwave } from "../src/sidwaveCompiler.js";

const SR = 44100;
const HALF_BAR = 240 / 130 / 2;
const CAP_SECONDS = 16;

function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000 * 2 - 1; }; }

/** Renders the schedule. `shape` is the oscillator: "square" (reference) or "saw" with a low-pass (capture timbre). */
function render(schedule, { shape, offset = 0, transpose = 0, shift = 0, seconds, pan = true, seed = 1 }) {
  const n = Math.ceil(seconds * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (const note of schedule.notes) {
    const f = note.hz * Math.pow(2, transpose / 12);
    const a = Math.round((note.start + offset + shift) * SR), b = Math.round((note.start + note.duration + offset + shift) * SR);
    const gl = pan && note.voice === 2 ? 0.1 : 1, gr = pan && note.voice === 2 ? 1 : pan ? 0.2 : 1;
    let lp = 0;
    for (let k = Math.max(0, a); k < Math.min(b, n); k += 1) {
      const ph = (f * (k / SR)) % 1;
      let s = shape === "square" ? (ph < 0.5 ? 0.12 : -0.12) : 0.12 * (2 * ph - 1);
      if (shape !== "square") { lp += 0.25 * (s - lp); s = lp * 2.5; }
      L[k] += s * gl; R[k] += s * gr;
    }
  }
  const noise = rng(seed);
  for (const p of schedule.percussion) {
    const a = Math.round((p.start + offset + shift) * SR);
    for (let k = Math.max(0, a); k < Math.min(a + Math.round(0.06 * SR), n); k += 1) {
      const v = noise() * 0.25 * (1 - (k - a) / (0.06 * SR));
      L[k] += v * 0.7; R[k] += v * 0.7;
    }
  }
  return { left: L, right: R, sampleRate: SR };
}

function song() {
  const { score } = generateSidwave({ root: "C3", preset: "classic", style: "chiptune", seed: DEFAULT_MUSIC_SEED, system: "PAL" });
  const sch = expectedSchedule(parseSidwave(score));
  return { ...sch, notes: sch.notes.filter((n) => n.start < CAP_SECONDS), percussion: sch.percussion.filter((p) => p.start < CAP_SECONDS) };
}

const opts = { latencySearchMs: 2000, halfBarSeconds: HALF_BAR };
const fmt = (r) => JSON.stringify({ off: r.offsetMs.toFixed(1), drift: r.alignment.driftMs.toFixed(1), real: r.real, c: r.controls, bal: r.balance });

test("faithful copy with another timbre, offset and stereo balance passes", () => {
  const sch = song();
  const ref = render(sch, { shape: "square", seconds: CAP_SECONDS, pan: true });
  const cap = render(sch, { shape: "saw", offset: 0.35, seconds: CAP_SECONDS + 1, pan: true, seed: 9 });
  const r = compareToReference(ref, cap, opts);
  if (process.env.SIDWAVE_DEBUG) console.log(fmt(r));
  assert.ok(Math.abs(r.offsetMs - 350) < 10, `offset ${r.offsetMs}`);
  assert.ok(Math.abs(r.alignment.driftMs) < 10);
  assert.ok(r.verdict.pass, fmt(r));
  assert.ok(r.balance.applicable);
});

test("a one-semitone transposition fails", () => {
  const sch = song();
  const ref = render(sch, { shape: "square", seconds: CAP_SECONDS });
  const cap = render(sch, { shape: "saw", offset: 0.2, transpose: 1, seconds: CAP_SECONDS + 1, seed: 9 });
  const r = compareToReference(ref, cap, opts);
  if (process.env.SIDWAVE_DEBUG) console.log("transposed", fmt(r));
  assert.ok(!r.verdict.pass, fmt(r));
  assert.ok(!r.verdict.chroma);
});

test("one voice played half a bar late scores clearly below a faithful copy", () => {
  const sch = song();
  const ref = render(sch, { shape: "square", seconds: CAP_SECONDS });
  const faithful = compareToReference(ref, render(sch, { shape: "saw", offset: 0.2, seconds: CAP_SECONDS + 2, seed: 9 }), opts);
  const late = { ...sch, notes: sch.notes.map((n) => (n.voice === 1 ? { ...n, start: n.start + HALF_BAR } : n)) };
  const r = compareToReference(ref, render(late, { shape: "saw", offset: 0.2, seconds: CAP_SECONDS + 2, seed: 9 }), opts);
  // Detection of a single late voice is weaker than of a whole wrong song; it is not a pass/fail case.
  assert.ok(r.real.chromaMedian < faithful.real.chromaMedian - 0.1, fmt(r));
});

test("the same notes with a time-shifted whole capture are only latency", () => {
  const sch = song();
  const ref = render(sch, { shape: "square", seconds: CAP_SECONDS });
  const r = compareToReference(ref, render(sch, { shape: "saw", offset: 0.2 + HALF_BAR, seconds: CAP_SECONDS + 2, seed: 9 }), opts);
  assert.ok(Math.abs(r.offsetMs - (200 + HALF_BAR * 1000)) < 10 && r.verdict.pass, fmt(r));
});

test("swapped stereo channels fail the balance check", () => {
  const sch = song();
  const ref = render(sch, { shape: "square", seconds: CAP_SECONDS });
  const cap = render(sch, { shape: "saw", offset: 0.2, seconds: CAP_SECONDS + 1, seed: 9 });
  const r = compareToReference(ref, { ...cap, left: cap.right, right: cap.left }, opts);
  assert.ok(r.balance.applicable && !r.verdict.balance && !r.verdict.pass, fmt(r));
});

test("unrelated music fails", () => {
  const sch = song();
  const other = { ...sch, notes: sch.notes.map((n, i) => ({ ...n, hz: n.hz * Math.pow(2, ((i * 5) % 7 - 3) / 12) })) };
  const ref = render(sch, { shape: "square", seconds: CAP_SECONDS });
  const cap = render(other, { shape: "saw", offset: 0.2, seconds: CAP_SECONDS + 1, seed: 9 });
  assert.ok(!compareToReference(ref, cap, opts).verdict.pass);
});

test("restrictToSid keeps only that SID's voices and maps it to $D400", () => {
  const voice = (id, note) => ({ id, waveform: "pulse", pulse_width: 0.5, adsr: [0, 4, 10, 2], patterns: { p: { type: "arpeggio", notes: [note], length: 4 } } });
  const doc = parseSidwave({
    sidwave: "1.2", title: "t", tempo: 120, mode: "PAL", length_bars: 1,
    sids: [{ id: "a", address: "$D400" }, { id: "b", address: "$D420", volume: 9 }],
    voices: [voice(1, "C3"), voice(2, "E3"), voice(3, "G3"), voice(4, "C5"), voice(5, "E5")],
    timeline: [{ section: "s", bars: 1, layers: { v1: "p", v2: "p", v3: "p", v4: "p", v5: "p" } }],
  });
  const second = restrictToSid(doc, 1);
  assert.strictEqual(second.chips.length, 1);
  assert.strictEqual(second.chips[0].address, 0xd400);
  assert.strictEqual(second.chips[0].volume, 9);
  assert.equal(second.softVolume, true);
  const full = arrangeSidwave(doc), part = second;
  const midis = (a) => a.voices.map((v) => v.notes.map((n) => n.midi));
  assert.deepEqual(midis(part).slice(0, 2), midis(full).slice(3, 5));
  assert.strictEqual(part.voices.length, 3);
  assert.strictEqual(restrictToSid(doc, 0).voices.length, 3);
  assert.throws(() => restrictToSid(doc, 2), /not declared/);
});
