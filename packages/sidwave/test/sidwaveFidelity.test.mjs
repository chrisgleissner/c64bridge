import test from "#test/runner";
import assert from "#test/assert";
import { analyse, expectedSchedule } from "../src/audio/sidwaveFidelity.js";
import { DEFAULT_MUSIC_SEED, generateSidwave } from "../src/audio/generateSidwave.js";
import { parseSidwave, midiToHz } from "../src/sidwave.js";

const SR = 47982.89;

/** Deterministic noise source. */
function rng(seed = 1) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000 * 2 - 1; };
}

/** Renders a schedule as stereo S16 PCM: square waves per note (pan by note.pan), noise bursts per percussion onset. */
function synth(schedule, { offset = 0, transpose = 0, drop = () => false, seconds, bleed = 0 } = {}) {
  const n = Math.ceil((seconds ?? schedule.durationSeconds + offset + 0.5) * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  schedule.notes.forEach((note, i) => {
    if (drop(note, i)) return;
    const f = note.hz * Math.pow(2, transpose / 12);
    const a = Math.round((note.start + offset) * SR), b = Math.round((note.start + note.duration + offset) * SR);
    const gl = note.pan === "right" ? bleed : 1, gr = note.pan === "left" ? bleed : 1;
    for (let k = a; k < Math.min(b, n); k += 1) {
      const s = Math.sin(2 * Math.PI * f * (k / SR)) >= 0 ? 0.12 : -0.12;
      L[k] += s * gl; R[k] += s * gr;
    }
  });
  const noise = rng();
  for (const p of schedule.percussion) {
    const a = Math.round((p.start + offset) * SR);
    for (let k = a; k < Math.min(a + Math.round(0.06 * SR), n); k += 1) {
      const v = noise() * 0.3 * (1 - (k - a) / (0.06 * SR));
      L[k] += v; R[k] += v;
    }
  }
  const pcm = new Int16Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    pcm[2 * i] = Math.round(Math.max(-1, Math.min(1, L[i])) * 32767);
    pcm[2 * i + 1] = Math.round(Math.max(-1, Math.min(1, R[i])) * 32767);
  }
  return pcm;
}

// Two voices on two SIDs (voice 0 on SID 0, voice 3 on SID 1) with distinct pitches, plus drum hits.
function handSchedule() {
  const notes = [];
  const a = [57, 60, 64, 67, 62, 65, 69, 72, 59, 63]; // SID 0
  const b = [69, 72, 76, 79, 74, 77, 81, 84, 71, 75]; // SID 1, offset pitches never equal to SID 0's
  for (let i = 0; i < 10; i += 1) {
    notes.push({ voice: 0, sid: 0, pan: "left", start: 0.3 + i * 0.4, duration: 0.34, hz: midiToHz(a[i]), alternates: [] });
    notes.push({ voice: 3, sid: 1, pan: "right", start: 0.3 + i * 0.4, duration: 0.34, hz: midiToHz(b[i]) * 1.0, alternates: [] });
  }
  const percussion = [0.5, 1.1, 1.7, 2.3, 2.9, 3.5].map((start) => ({ voice: 1, sid: 0, start }));
  notes.sort((x, y) => x.start - y.start);
  return { notes, percussion, durationSeconds: 4.4, voiceCount: 6, sidCount: 2 };
}

test("recovers a playback offset within 10 ms and reports full presence for faithful PCM", () => {
  const sch = handSchedule();
  for (const offset of [0.037, 0.121, 0.2]) {
    const rep = analyse(synth(sch, { offset }), SR, sch, { latencySearchMs: 400 });
    assert.ok(Math.abs(rep.offsetMs - offset * 1000) < 10, `offset ${rep.offsetMs} vs ${offset * 1000}`);
    assert.strictEqual(rep.pitched.expected, 20);
    assert.strictEqual(rep.pitched.rate, 1);
    assert.strictEqual(rep.percussion.rate, 1);
    assert.strictEqual(rep.perSid.length, 2);
  }
});

test("fails when notes are transposed by a semitone", () => {
  const sch = handSchedule();
  const rep = analyse(synth(sch, { offset: 0.05, transpose: 1 }), SR, sch, { latencySearchMs: 300 });
  assert.ok(rep.pitched.rate < 0.3, `rate ${rep.pitched.rate}`);
});

test("fails when notes are dropped, per voice and per SID", () => {
  const sch = handSchedule();
  const rep = analyse(synth(sch, { offset: 0.05, drop: (note, i) => note.sid === 1 && i % 4 === 1 }), SR, sch, { latencySearchMs: 300 });
  const sid0 = rep.perSid.find((s) => s.sid === 0);
  const sid1 = rep.perSid.find((s) => s.sid === 1);
  assert.strictEqual(sid0.rate, 1);
  assert.ok(sid1.rate <= 0.8, `sid1 ${sid1.rate}`);
  assert.ok(rep.pitched.rate < 0.9);
});

test("fails percussion when the noise bursts are missing", () => {
  const sch = handSchedule();
  const silentDrums = { ...sch, percussion: [] };
  const pcm = synth(silentDrums, { offset: 0.05, seconds: 5 });
  const rep = analyse(pcm, SR, sch, { latencySearchMs: 300 });
  assert.ok(rep.percussion.rate < 0.2, `percussion ${rep.percussion.rate}`);
});

test("measures per-side energy of notes scheduled on panned SIDs", () => {
  const sch = handSchedule();
  const rep = analyse(synth(sch, { offset: 0.05, bleed: 0.01 }), SR, sch, { latencySearchMs: 300 });
  assert.ok(rep.sides.left.separationDb > 30, `left ${rep.sides.left.separationDb}`);
  assert.ok(rep.sides.right.separationDb > 30, `right ${rep.sides.right.separationDb}`);
  assert.ok(rep.sides.left.left > rep.sides.left.right);
  assert.ok(rep.sides.right.right > rep.sides.right.left);
  assert.ok(rep.rms.left > 0 && rep.rms.right > 0);
  // Swapping the channels makes the separation negative.
  const swapped = synth(sch, { offset: 0.05 });
  for (let i = 0; i < swapped.length; i += 2) { const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t; }
  const bad = analyse(swapped, SR, sch, { latencySearchMs: 300 });
  assert.ok(bad.sides.left.separationDb < 0);
});

test("counts notes of the same pitch sounding at the same time once", () => {
  const sch = handSchedule();
  const twin = { ...sch.notes[0], voice: 6, sid: 2, pan: undefined };
  const withTwin = { ...sch, notes: [...sch.notes, twin].sort((x, y) => x.start - y.start) };
  const rep = analyse(synth(sch, { offset: 0.05 }), SR, withTwin, { latencySearchMs: 300 });
  assert.strictEqual(rep.pitched.expected, 20);
  assert.strictEqual(rep.notes.filter((n) => n.merged).length, 1);
});

test("expectedSchedule lists timed notes and drum onsets from a compiled song", () => {
  const { score } = generateSidwave({ root: "C3", preset: "classic", style: "chiptune", seed: DEFAULT_MUSIC_SEED, system: "PAL" });
  const doc = parseSidwave(score);
  const sch = expectedSchedule(doc, { pan: { 0: "left" } });
  assert.ok(sch.notes.length > 20);
  assert.ok(sch.percussion.length > 0);
  assert.ok(sch.notes.every((n) => n.duration > 0 && n.hz > 0 && n.sid === 0 && n.pan === "left"));
  assert.ok(sch.durationSeconds > 5);
  // Faithful synthesis of the real schedule is analysed as present (no pitch-coincidence filtering in the generator).
  const head = { ...sch, notes: sch.notes.filter((n) => n.start < 25), percussion: sch.percussion.filter((p) => p.start < 25) };
  const rep = analyse(synth(head, { offset: 0.08 }), SR, head, { latencySearchMs: 300 });
  const shifted = analyse(synth(head, { offset: 0.08, transpose: 1 }), SR, head, { latencySearchMs: 300 });
  assert.ok(shifted.pitched.rate < 0.4, `transposed rate ${shifted.pitched.rate}`);
  assert.ok(rep.pitched.expected > 10);
  assert.ok(Math.abs(rep.offsetMs - 80) < 10, `offset ${rep.offsetMs}`);
  assert.ok(rep.pitched.rate > 0.85, `rate ${rep.pitched.rate}`);
});
