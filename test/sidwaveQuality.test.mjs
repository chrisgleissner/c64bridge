import test from "#test/runner";
import assert from "#test/assert";
import { analyseQuality } from "../src/audio/sidwaveQuality.js";
import { parseSidwave } from "../src/sidwave.js";

const SR = 22050;
const note = (start, duration, hz, extra = {}) => ({ voice: 0, sid: 0, start, duration, hz, alternates: [], ...extra });
const sched = (notes, percussion = [], durationSeconds = 6) => ({ notes, percussion, durationSeconds, voiceCount: 3, sidCount: 1 });

/** Mono/stereo synthesis: sum of tones (with optional per-sample hook). */
function render(seconds, tones, { stereo = false, phaseFlip = false, bend = 0 } = {}) {
  const n = Math.round(seconds * SR), L = new Float32Array(n), R = new Float32Array(n);
  for (const t of tones) {
    const a = Math.round(t.start * SR), b = Math.min(n, Math.round((t.start + t.duration) * SR));
    let phase = 0;
    for (let i = a; i < b; i += 1) {
      const cents = bend * ((i - a) / (b - a));
      phase += (2 * Math.PI * t.hz * Math.pow(2, cents / 1200)) / SR;
      const v = (t.amp ?? 0.1) * Math.sin(phase);
      L[i] += v; R[i] += phaseFlip ? -v : stereo ? 0.5 * v : v;
    }
  }
  return { left: L, right: stereo || phaseFlip ? R : L.slice(), sampleRate: SR };
}
const bassAndMid = (seconds) => [{ start: 0, duration: seconds, hz: 110, amp: 0.2 }, { start: 0, duration: seconds, hz: 220, amp: 0.1 }, { start: 0, duration: seconds, hz: 1760, amp: 0.1 }];

test("clipping is counted and fails when it is long or frequent", () => {
  const s = render(2, [{ start: 0, duration: 2, hz: 200, amp: 3 }]);
  for (let i = 0; i < s.left.length; i += 1) { s.left[i] = Math.max(-1, Math.min(1, s.left[i])); s.right[i] = s.left[i]; }
  const r = analyseQuality({ signal: s });
  assert.strictEqual(r.checks.clipping.status, "FAIL");
  assert.ok(r.checks.clipping.metrics.longestRun >= 8);
  assert.strictEqual(analyseQuality({ signal: render(2, bassAndMid(2)) }).checks.clipping.status, "PASS");
});

test("a click is a glitch unless a scheduled onset explains it", () => {
  const notes = [note(0, 3, 220)];
  const base = render(3, [{ start: 0, duration: 3, hz: 220, amp: 0.1 }]);
  const click = (t) => { const i = Math.round(t * SR); for (let k = 0; k < 3; k += 1) { base.left[i + k] = 0.8; base.right[i + k] = 0.8; } };
  click(1.5);
  const r = analyseQuality({ signal: base, schedule: sched(notes, [], 3) });
  assert.notStrictEqual(r.checks.glitches.status, "PASS");
  assert.ok(r.checks.glitches.metrics.times.some((t) => Math.abs(t - 1.5) < 0.01));
  // The same click at a scheduled note start is excluded.
  const clean = render(3, [{ start: 0, duration: 3, hz: 220, amp: 0.1 }]);
  for (let k = 0; k < 3; k += 1) { clean.left[Math.round(1.5 * SR) + k] = 0.8; clean.right[Math.round(1.5 * SR) + k] = 0.8; }
  const ok = analyseQuality({ signal: clean, schedule: sched([note(0, 1.5, 220), note(1.5, 1.5, 220)], [], 3) });
  assert.strictEqual(ok.checks.glitches.status, "PASS");
});

test("silence inside a scheduled note is a dropout", () => {
  const s = render(3, [{ start: 0, duration: 1, hz: 220 }, { start: 1.2, duration: 1.8, hz: 220 }]);
  const r = analyseQuality({ signal: s, schedule: sched([note(0, 3, 220)], [], 3) });
  assert.notStrictEqual(r.checks.dropouts.status, "PASS");
  assert.ok(Math.abs(r.checks.dropouts.metrics.gaps[0].t - 1) < 0.02);
  // A gap where the score has no sounding note is not a dropout.
  const ok = analyseQuality({ signal: s, schedule: sched([note(0, 1, 220), note(1.2, 1.8, 220)], [], 3) });
  assert.strictEqual(ok.checks.dropouts.status, "PASS");
});

test("tonal balance flags a tinny signal and accepts one with bass", () => {
  const tinny = render(4, [{ start: 0, duration: 4, hz: 3000, amp: 0.1 }, { start: 0, duration: 4, hz: 3900, amp: 0.1 }]);
  const t = analyseQuality({ signal: tinny });
  assert.strictEqual(t.checks.tonalBalance.status, "FAIL");
  const good = analyseQuality({ signal: render(4, bassAndMid(4)) });
  assert.strictEqual(good.checks.tonalBalance.status, "PASS");
  assert.ok(Object.keys(good.checks.tonalBalance.metrics.octaveBandsDb).length === 8);
});

test("an out-of-phase stereo signal fails mono compatibility", () => {
  const r = analyseQuality({ signal: render(2, bassAndMid(2), { phaseFlip: true }) });
  assert.strictEqual(r.checks.stereo.status, "FAIL");
  assert.strictEqual(analyseQuality({ signal: render(2, bassAndMid(2)) }).checks.stereo.status, "SKIP");
  assert.strictEqual(analyseQuality({ signal: render(2, bassAndMid(2), { stereo: true }) }).checks.stereo.status, "PASS");
});

test("pitch stability measures deviation within long notes and skips modulated ones", () => {
  const tones = [{ start: 0.2, duration: 1.2, hz: 440 }];
  const steady = analyseQuality({ signal: render(2, tones), schedule: sched([note(0.2, 1.2, 440)], [], 2) });
  assert.strictEqual(steady.checks.pitchStability.status, "PASS");
  const bent = analyseQuality({ signal: render(2, tones, { bend: 120 }), schedule: sched([note(0.2, 1.2, 440)], [], 2) });
  assert.notStrictEqual(bent.checks.pitchStability.status, "PASS");
  const intended = analyseQuality({ signal: render(2, tones, { bend: 120 }), schedule: sched([note(0.2, 1.2, 440, { modulated: true })], [], 2) });
  assert.strictEqual(intended.checks.pitchStability.status, "SKIP");
});

const doc = parseSidwave({
  sidwave: "1.1", title: "t", tempo: 120, mode: "PAL", length_bars: 8,
  voices: [{ id: 1, waveform: "pulse", pulse_width: 0.5, adsr: [0, 4, 10, 2], patterns: { p: { type: "arpeggio", notes: ["C4"], length: 4 } } }],
  timeline: [{ section: "a", bars: 8, layers: { v1: "p" } }],
});

test("identical bars are flagged as a filler loop and varied bars are not; a constant level is flat", () => {
  const bar = 2;
  const loop = [], varied = [];
  const pitches = [220, 247, 262, 294, 330, 349, 392, 415];
  for (let i = 0; i < 8; i += 1) {
    loop.push({ start: i * bar, duration: 1.8, hz: 220, amp: 0.1 }, { start: i * bar + 1, duration: 0.9, hz: 330, amp: 0.1 });
    varied.push({ start: i * bar, duration: 1.8, hz: pitches[i], amp: 0.05 + 0.02 * i }, { start: i * bar + 1, duration: 0.9, hz: pitches[(i * 3) % 8] * 1.5, amp: 0.1 });
  }
  const a = analyseQuality({ signal: render(16, loop), doc, schedule: sched([], [], 16) });
  assert.strictEqual(a.checks.repetition.status, "FAIL");
  assert.strictEqual(a.checks.dynamics.status, "WARN");
  const b = analyseQuality({ signal: render(16, varied), doc, schedule: sched([], [], 16) });
  assert.strictEqual(b.checks.repetition.status, "PASS");
  assert.ok(b.checks.dynamics.metrics.sectionRangeDb > 3, JSON.stringify(b.checks.dynamics.metrics));
});

test("three-window pitch median removes one displaced peak and keeps sustained drift", () => {
  const rate = SR;
  const n = note(0, 2, 440);
  const signal = (end) => {
    let phase = 0;
    const left = Float32Array.from({ length: 2 * rate }, (_, i) => {
      const time = i / rate;
      const offset = time >= 0.99 && time < end ? 60 : 0;
      phase += 2 * Math.PI * 440 * 2 ** (offset / 1200) / rate;
      return 0.15 * Math.sin(phase);
    });
    return { left, right: left, sampleRate: rate };
  };
  const check = (end) => analyseQuality({ signal: signal(end), schedule: sched([n], [], 2) }).checks.pitchStability;
  assert.equal(check(1.065).status, "PASS");
  assert.equal(check(1.55).status, "FAIL");
});

test("dense multi-SID pitch review prioritises the declared lead over backing parts", () => {
  const pitchTrack = [note(0, 1.6, 440, { role: "lead" }), note(2, 1.6, 392, { voice: 4, sid: 1 })];
  const lead = render(4, [pitchTrack[0]]);
  const backing = render(4, [pitchTrack[1]], { bend: 120 });
  lead.left = lead.left.map((sample, i) => sample + backing.left[i]);
  lead.right = lead.left;
  const schedule = { ...sched(pitchTrack, [], 4), voiceCount: 12, sidCount: 4 };
  const verdict = analyseQuality({ signal: lead, schedule }).checks.pitchStability;
  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.metrics.notes, 1);
  const declared = { ...schedule, notes: pitchTrack.map((n, i) => ({ ...n, role: i ? "pad" : undefined })) };
  assert.notStrictEqual(analyseQuality({ signal: lead, schedule: declared }).checks.pitchStability.status, "PASS");
});

test("a sharp 41 Hz saw has periodic edges and still exposes an isolated click", () => {
  const left = Float32Array.from({ length: SR * 2 }, (_, i) => 0.07 * (2 * ((i * 41 / SR) % 1) - 1));
  const schedule = sched([note(0, 2, 41)], [], 2);
  const check = () => analyseQuality({ signal: { left, right: left, sampleRate: SR }, schedule }).checks.glitches.metrics;
  assert.equal(check().count, 0);
  left[Math.round(1.13 * SR)] = 0.99;
  const { times } = check();
  assert.equal(times.length, 1);
  assert.ok(Math.abs(times[0] - 1.13) < 0.002);
});

test("a percussion release tail explains a transient while silence between hits does not", () => {
  const left = new Float32Array(SR);
  left[Math.round(0.127 * SR)] = 0.8;
  left[Math.round(0.51 * SR)] = 0.8;
  const schedule = sched([], [{ voice: 2, sid: 0, start: 0, duration: 0.05, releaseSeconds: 0.09 }], 1);
  const { times } = analyseQuality({ signal: { left, right: left, sampleRate: SR }, schedule }).checks.glitches.metrics;
  assert.equal(times.length, 1);
  assert.ok(Math.abs(times[0] - 0.51) < 0.002);
});
