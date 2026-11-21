import type { ParsedSidwave } from "../sidwave.js";
import { expectedSchedule, fft, type ExpectedSchedule } from "./sidwaveFidelity.js";
import { chromaSequence, type Stereo } from "./sidwaveSimilarity.js";

/**
 * Objective quality gate for a rendering or a capture of a SIDWAVE song. Every check returns PASS, WARN or FAIL
 * with its metrics; thresholds are in DEFAULT_QUALITY_THRESHOLDS and are documented in doc/sidwave-hil.md.
 * With the score (schedule and document) and the time at which the song starts in the signal, the checks that depend
 * on scheduled events (glitches, dropouts, pitch stability, sections, bars) run too; without it they are SKIP.
 */

export type Status = "PASS" | "WARN" | "FAIL" | "SKIP";
export interface Check { status: Status; summary: string; metrics: Record<string, unknown> }

export interface QualityThresholds {
  clipLevel: number; clipRunWarn: number; clipRunFail: number; clipFractionFail: number;
  glitchRatio: number; glitchFloor: number; glitchExcludeMs: number; glitchWarn: number; glitchFail: number;
  dropoutMs: number; dropoutFloorDb: number; dropoutFail: number;
  bassBelowMidWarnDb: number; bassBelowMidFailDb: number; centroidWarnHz: number; centroidFailHz: number;
  fullnessWithinDb: number; fullnessBands: number; fullnessWarn: number; fullnessFail: number;
  bassBarFloorDb: number; bassBarWarn: number; bassBarFail: number;
  rmsLowDb: number; rmsHighDb: number; sectionFlatDb: number; lraFlatDb: number;
  repeatSimilarity: number; repeatWarn: number; repeatFail: number;
  monoLossWarnDb: number; monoLossFailDb: number;
  longNoteSeconds: number; detuneWarnCents: number; detuneFailCents: number;
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  clipLevel: 0.99, clipRunWarn: 3, clipRunFail: 8, clipFractionFail: 1e-4,
  glitchRatio: 12, glitchFloor: 0.02, glitchExcludeMs: 15, glitchWarn: 1, glitchFail: 6,
  dropoutMs: 30, dropoutFloorDb: -66, dropoutFail: 3,
  bassBelowMidWarnDb: 12, bassBelowMidFailDb: 20, centroidWarnHz: 2500, centroidFailHz: 3500,
  fullnessWithinDb: 15, fullnessBands: 3, fullnessWarn: 0.5, fullnessFail: 0.25,
  bassBarFloorDb: -60, bassBarWarn: 0.8, bassBarFail: 0.5,
  rmsLowDb: -30, rmsHighDb: -8, sectionFlatDb: 3, lraFlatDb: 3,
  repeatSimilarity: 0.95, repeatWarn: 0.75, repeatFail: 0.9,
  monoLossWarnDb: 3, monoLossFailDb: 6,
  longNoteSeconds: 0.3, detuneWarnCents: 15, detuneFailCents: 30,
};

export interface QualityInput {
  signal: Stereo;
  schedule?: ExpectedSchedule;
  doc?: ParsedSidwave;
  /** Time (s) at which the song starts in the signal. Default 0. */
  offsetSeconds?: number;
  thresholds?: Partial<QualityThresholds>;
}

export interface QualityReport {
  checks: Record<string, Check>;
  verdict: Status;
  analysedSeconds: { from: number; to: number };
}

const db = (x: number) => 10 * Math.log10(x + 1e-30);
const median = (v: ArrayLike<number>) => { const s = Array.from(v).sort((a, b) => a - b); const m = s.length >> 1; return s.length === 0 ? 0 : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const quantile = (v: number[], q: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]! : 0; };
const mk = (status: Status, summary: string, metrics: Record<string, unknown> = {}): Check => ({ status, summary, metrics });
const worst = (list: Status[]): Status => (list.includes("FAIL") ? "FAIL" : list.includes("WARN") ? "WARN" : list.every((s) => s === "SKIP") ? "SKIP" : "PASS");

function stft(x: Float64Array, sr: number, size: number, hopS: number, from: number, to: number) {
  const hop = Math.round(hopS * sr);
  const hann = new Float64Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const re = new Float64Array(size), im = new Float64Array(size);
  const frames: Array<{ t: number; power: Float64Array; rms: number }> = [];
  for (let s = Math.round(from * sr); s + size <= Math.min(x.length, Math.round(to * sr)); s += hop) {
    let e = 0;
    for (let i = 0; i < size; i += 1) { re[i] = x[s + i]! * hann[i]!; im[i] = 0; e += x[s + i]! ** 2; }
    fft(re, im);
    const power = new Float64Array(size / 2);
    for (let k = 0; k < size / 2; k += 1) power[k] = (re[k]! ** 2 + im[k]! ** 2) / (size * size);
    frames.push({ t: s / sr, power, rms: Math.sqrt(e / size) });
  }
  return frames;
}

const OCTAVES = [40, 80, 160, 320, 640, 1280, 2560, 5120, 10240];
function bandPowers(power: Float64Array, sr: number): number[] {
  const size = power.length * 2;
  return OCTAVES.slice(0, -1).map((lo, b) => {
    let sum = 0;
    for (let k = Math.ceil((lo * size) / sr); k < Math.min(power.length, Math.ceil((OCTAVES[b + 1]! * size) / sr)); k += 1) sum += power[k]!;
    return sum;
  });
}
function rangePower(power: Float64Array, sr: number, lo: number, hi: number): number {
  const size = power.length * 2;
  let sum = 0;
  for (let k = Math.ceil((lo * size) / sr); k < Math.min(power.length, Math.ceil((hi * size) / sr)); k += 1) sum += power[k]!;
  return sum;
}

/** 2nd-order Butterworth high-pass (RBJ biquad). */
function highpass(x: Float32Array | Float64Array, sr: number, hz: number): Float64Array {
  const w = (2 * Math.PI * hz) / sr, c = Math.cos(w), a = Math.sin(w) / (2 * Math.SQRT1_2);
  const b0 = (1 + c) / 2, b1 = -(1 + c), b2 = (1 + c) / 2, a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i += 1) {
    const v = (b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

export function analyseQuality(input: QualityInput): QualityReport {
  const th = { ...DEFAULT_QUALITY_THRESHOLDS, ...input.thresholds };
  const { signal, schedule, doc } = input;
  const sr = signal.sampleRate;
  const total = signal.left.length / sr;
  const offset = input.offsetSeconds ?? 0;
  const timing = doc && (!schedule?.bars || !schedule.sections) ? expectedSchedule(doc) : schedule;
  const boundaries = timing?.bars ?? [];
  const bars = Math.max(0, boundaries.length - 1);
  const songSeconds = timing?.durationSeconds ?? total - offset;
  const from = Math.max(0, offset), to = Math.min(total, offset + songSeconds);
  const stereo = signal.left.some((v, i) => v !== signal.right[i]);
  const mono = new Float64Array(signal.left.length).map((_, i) => (signal.left[i]! + signal.right[i]!) / 2);
  const a = Math.round(from * sr), b = Math.round(to * sr);
  const checks: Record<string, Check> = {};

  // ---- clipping
  {
    let count = 0, longest = 0, run = 0;
    for (const ch of [signal.left, signal.right]) {
      run = 0;
      for (let i = a; i < b; i += 1) {
        if (Math.abs(ch[i]!) >= th.clipLevel) { count += 1; run += 1; longest = Math.max(longest, run); } else run = 0;
      }
    }
    const frac = count / Math.max(1, 2 * (b - a));
    const status: Status = frac > th.clipFractionFail || longest >= th.clipRunFail ? "FAIL" : longest >= th.clipRunWarn ? "WARN" : "PASS";
    checks.clipping = mk(status, `${count} samples at or above ${th.clipLevel} full scale, longest run ${longest}`, { count, longestRun: longest, fraction: frac });
  }

  // ---- glitches
  if (!schedule) checks.glitches = mk("SKIP", "needs the score to exclude scheduled onsets");
  else {
    const exclude = th.glitchExcludeMs / 1000;
    const transients = [
      ...schedule.notes.filter((n) => n.bright).map((n) => [n.start - exclude, n.start + n.duration + 0.3] as const),
      ...schedule.percussion.map((p) => [p.start - exclude, p.start + (p.duration ?? 0) + 0.04 + exclude] as const),
    ];
    const events = schedule.notes.flatMap((n) => [n.start, n.start + n.duration]);
    const block = Math.round(0.001 * sr);
    const nBlocks = Math.floor((b - a) / block);
    const peaks = new Float64Array(nBlocks);
    for (const ch of [signal.left, signal.right]) {
      const hp = highpass(ch, sr, 3000);
      for (let i = 0; i < nBlocks; i += 1) { let m = 0; for (let k = 0; k < block; k += 1) m = Math.max(m, Math.abs(hp[a + i * block + k]!)); peaks[i] = Math.max(peaks[i]!, m); }
    }
    const found: Array<{ t: number; ratio: number; peak: number }> = [];
    for (let i = 0; i < nBlocks; i += 1) {
      const t = from + (i + 0.5) * 0.001;
      if (peaks[i]! < th.glitchFloor || t < from + 0.06) continue; // the first 60 ms are the player start-up
      const songTime = t - offset;
      if (events.some((event) => Math.abs(event - songTime) <= exclude)) continue;
      if (transients.some(([start, end]) => songTime >= start && songTime <= end)) continue;
      const win = Array.from(peaks.subarray(Math.max(0, i - 100), Math.min(nBlocks, i + 101)));
      const local = Math.max(median(win), 1e-6);
      if (peaks[i]! > th.glitchRatio * local) found.push({ t, ratio: peaks[i]! / local, peak: peaks[i]! });
    }
    // Spikes less than 80 ms apart (the per-frame zipper of a filter or pulse sweep is 20 ms) form one event.
    const merged: typeof found = [];
    for (const f of found) { const last = merged[merged.length - 1]; if (last && f.t - last.t < 0.08) { if (f.ratio > last.ratio) Object.assign(last, { ratio: f.ratio, peak: f.peak }); } else merged.push({ ...f }); }
    const status: Status = merged.length >= th.glitchFail ? "FAIL" : merged.length >= th.glitchWarn ? "WARN" : "PASS";
    checks.glitches = mk(status, `${merged.length} unexplained high-frequency spike(s) above ${th.glitchRatio}x the local median`, { count: merged.length, times: merged.slice(0, 30).map((m) => +(m.t - offset).toFixed(3)), worstRatio: merged.reduce((m, f) => Math.max(m, f.ratio), 0) });
  }

  // ---- dropouts
  if (!schedule) checks.dropouts = mk("SKIP", "needs the score");
  else {
    const floor = Math.pow(10, th.dropoutFloorDb / 20), block = Math.round(0.005 * sr);
    const sounding = schedule.notes.map((n) => [n.start + offset, n.start + n.duration + offset] as const);
    const covered = (t0: number, t1: number) => sounding.some(([s, e]) => s <= t0 && e >= t1);
    const gaps: Array<{ t: number; ms: number }> = [];
    let runStart = -1;
    const nb = Math.floor((b - a) / block);
    for (let i = 0; i <= nb; i += 1) {
      let silent = false;
      if (i < nb) { let e = 0; for (let k = 0; k < block; k += 1) e += mono[a + i * block + k]! ** 2; silent = Math.sqrt(e / block) < floor; }
      if (silent && runStart < 0) runStart = i;
      if (!silent && runStart >= 0) {
        const t0 = from + runStart * 0.005, t1 = from + i * 0.005;
        if (t0 >= from + 0.06 && (t1 - t0) * 1000 > th.dropoutMs && covered(t0 + 0.015, t1 - 0.015 < t0 + 0.015 ? t0 + 0.015 : t1 - 0.015)) gaps.push({ t: t0 - offset, ms: (t1 - t0) * 1000 });
        runStart = -1;
      }
    }
    const status: Status = gaps.length >= th.dropoutFail ? "FAIL" : gaps.length > 0 ? "WARN" : "PASS";
    checks.dropouts = mk(status, `${gaps.length} silent gap(s) over ${th.dropoutMs} ms while a note is scheduled`, { count: gaps.length, gaps: gaps.slice(0, 20).map((g) => ({ t: +g.t.toFixed(3), ms: Math.round(g.ms) })) });
  }

  // ---- spectra (tonal balance, fullness, bass continuity)
  const frames = stft(mono, sr, 4096, 0.1, from, to);
  const loud = frames.filter((f) => f.rms > 3e-3);
  {
    const avg = new Float64Array(2048);
    for (const f of loud) for (let k = 0; k < avg.length; k += 1) avg[k]! += f.power[k]! / Math.max(1, loud.length);
    const bands = bandPowers(avg, sr).map(db);
    const bass = db(rangePower(avg, sr, 40, 250)), mid = db(rangePower(avg, sr, 1000, 4000));
    const centroids = loud.map((f) => { let n = 0, d = 0; for (let k = 1; k < 2048; k += 1) { const hz = (k * sr) / 4096; if (hz < 40 || hz > 12000) continue; n += hz * f.power[k]!; d += f.power[k]!; } return d > 0 ? n / d : 0; });
    const centroid = median(centroids);
    const gap = mid - bass;
    const status: Status = gap > th.bassBelowMidFailDb || centroid > th.centroidFailHz ? "FAIL" : gap > th.bassBelowMidWarnDb || centroid > th.centroidWarnHz ? "WARN" : "PASS";
    const ref = Math.max(...bands);
    checks.tonalBalance = mk(status, `bass (40-250 Hz) is ${(-gap).toFixed(1)} dB relative to 1-4 kHz; median spectral centroid ${centroid.toFixed(0)} Hz`, {
      octaveBandsDb: Object.fromEntries(bands.map((v, i) => [`${OCTAVES[i]}-${OCTAVES[i + 1]}`, +(v - ref).toFixed(1)])), bassMinusMidDb: +(-gap).toFixed(1), medianCentroidHz: Math.round(centroid) });

    const full = loud.map((f) => { const bp = bandPowers(f.power, sr).map(db); const top = Math.max(...bp); return bp.filter((v) => v >= top - th.fullnessWithinDb).length >= th.fullnessBands; });
    const fraction = full.length ? full.filter(Boolean).length / full.length : 0;
    const fstatus: Status = fraction < th.fullnessFail ? "FAIL" : fraction < th.fullnessWarn ? "WARN" : "PASS";
    const metrics: Record<string, unknown> = { fractionOfFramesWithThreeBandsWithin15Db: +fraction.toFixed(3) };
    let bassStatus: Status = "PASS", barNote = "";
    if (bars) {
      let withBass = 0;
      for (let i = 0; i < bars; i += 1) {
        const inBar = frames.filter((f) => f.t >= offset + boundaries[i]! && f.t < offset + boundaries[i + 1]!);
        const p = Math.max(0, ...inBar.map((f) => rangePower(f.power, sr, 40, 250)));
        if (db(p) > th.bassBarFloorDb) withBass += 1;
      }
      const f = withBass / bars;
      metrics.fractionOfBarsWithBass = +f.toFixed(3);
      bassStatus = f < th.bassBarFail ? "FAIL" : f < th.bassBarWarn ? "WARN" : "PASS";
      barNote = `, bass in ${(f * 100).toFixed(0)} % of bars`;
    }
    checks.fullness = mk(worst([fstatus, bassStatus]), `${(fraction * 100).toFixed(0)} % of frames have 3 octave bands within ${th.fullnessWithinDb} dB${barNote}`, metrics);
  }

  // ---- dynamics
  {
    const win = Math.round(0.4 * sr), hop = Math.round(0.1 * sr);
    const levels: number[] = [];
    for (let s = a; s + win <= b; s += hop) { let e = 0; for (let i = 0; i < win; i += 1) e += mono[s + i]! ** 2; levels.push(db(e / win)); }
    const gated = levels.filter((v) => v > -60);
    const lra = gated.length ? quantile(gated, 0.95) - quantile(gated, 0.1) : 0;
    let e = 0, peak = 0;
    for (let i = a; i < b; i += 1) { e += mono[i]! ** 2; peak = Math.max(peak, Math.abs(signal.left[i]!), Math.abs(signal.right[i]!)); }
    const rmsDb = db(e / Math.max(1, b - a));
    const metrics: Record<string, unknown> = { rmsDbfs: +rmsDb.toFixed(1), crestDb: +(20 * Math.log10(peak + 1e-12) - rmsDb).toFixed(1), loudnessRangeDb: +lra.toFixed(1) };
    const problems: string[] = [];
    let status: Status = "PASS";
    if (rmsDb < th.rmsLowDb || rmsDb > th.rmsHighDb) { status = "WARN"; problems.push(`integrated level ${rmsDb.toFixed(1)} dBFS outside ${th.rmsLowDb}..${th.rmsHighDb}`); }
    if (timing?.sections) {
      let list = timing.sections;
      if (new Set(list.map((x) => x.name)).size < 2) {
        // One named section: judge 4-bar blocks instead.
        list = Array.from({ length: Math.ceil(bars / 4) }, (_, i) => ({ name: `bars ${4 * i + 1}-${Math.min(bars, 4 * i + 4)}`, start: boundaries[4 * i]!, end: boundaries[Math.min(bars, 4 * i + 4)]! }));
      }
      const secs = list.map((s) => { let en = 0, n = 0; for (let i = Math.max(a, Math.round((offset + s.start) * sr)); i < Math.min(b, Math.round((offset + s.end) * sr)); i += 1) { en += mono[i]! ** 2; n += 1; } return { ...s, rmsDb: db(en / Math.max(1, n)) }; });
      const per = new Map<string, number[]>();
      for (const s of secs) per.set(s.name, [...(per.get(s.name) ?? []), s.rmsDb]);
      const means = [...per].map(([name, v]) => [name, v.reduce((x, y) => x + y, 0) / v.length] as const);
      const range = means.length ? Math.max(...means.map((m) => m[1])) - Math.min(...means.map((m) => m[1])) : 0;
      metrics.sectionRmsDb = Object.fromEntries(means.map(([n, v]) => [n, +v.toFixed(1)]));
      metrics.sectionRangeDb = +range.toFixed(1);
      if (range < th.sectionFlatDb) { status = "WARN"; problems.push(`sections differ by only ${range.toFixed(1)} dB (flat arrangement)`); }
    } else if (lra < th.lraFlatDb) { status = "WARN"; problems.push(`loudness range ${lra.toFixed(1)} dB (flat)`); }
    checks.dynamics = mk(status, `RMS ${rmsDb.toFixed(1)} dBFS, crest ${(metrics.crestDb as number)} dB, loudness range ${lra.toFixed(1)} dB${problems.length ? "; " + problems.join("; ") : ""}`, metrics);
  }

  // ---- repetition
  if (!bars) checks.repetition = mk("SKIP", "needs the score for the bar length");
  else {
    const durations = boundaries.slice(1).map((end, i) => Math.max(0, end - boundaries[i]! - 0.3));
    const per = Math.floor(Math.min(...durations) / 0.2);
    const seq = durations.map((duration, i) => chromaSequence(signal,
      Array.from({ length: per }, (_, k) => offset + boundaries[i]! + k * duration / per)));
    const sim = (x: number, y: number) => { let s = 0, n = 0; for (let k = 0; k < per; k += 1) { const p = seq[x]![k], q = seq[y]![k]; if (!p || !q) continue; let d = 0; for (let j = 0; j < 12; j += 1) d += p[j]! * q[j]!; s += d; n += 1; } return n ? s / n : 0; };
    let repeated = 0;
    const firsts: number[] = [];
    for (let i = 1; i < bars; i += 1) { let best = 0; for (let j = 0; j < i; j += 1) best = Math.max(best, sim(i, j)); if (best > th.repeatSimilarity) repeated += 1; firsts.push(best); }
    const fraction = bars > 1 ? repeated / (bars - 1) : 0;
    const status: Status = fraction > th.repeatFail ? "FAIL" : fraction > th.repeatWarn ? "WARN" : "PASS";
    checks.repetition = mk(status, `${(fraction * 100).toFixed(0)} % of bars repeat an earlier bar (chroma similarity > ${th.repeatSimilarity})`, { bars, repeatedFraction: +fraction.toFixed(3), medianBestSimilarity: +median(firsts).toFixed(3) });
  }

  // ---- stereo
  if (!stereo) checks.stereo = mk("SKIP", "mono signal");
  else {
    let el = 0, er = 0, em = 0, es = 0;
    for (let i = a; i < b; i += 1) { const l = signal.left[i]!, r = signal.right[i]!; el += l * l; er += r * r; em += ((l + r) / 2) ** 2; es += ((l - r) / 2) ** 2; }
    const loss = db(em / ((el + er) / 2 + 1e-30));
    const metrics: Record<string, unknown> = { monoCompatibilityDb: +loss.toFixed(2), width: +Math.sqrt(es / (em + 1e-30)).toFixed(3) };
    if (timing?.sections) {
      metrics.widthPerSection = timing.sections.map((s) => { let m = 0, d = 0; for (let i = Math.max(a, Math.round((offset + s.start) * sr)); i < Math.min(b, Math.round((offset + s.end) * sr)); i += 1) { m += ((signal.left[i]! + signal.right[i]!) / 2) ** 2; d += ((signal.left[i]! - signal.right[i]!) / 2) ** 2; } return { section: s.name, width: +Math.sqrt(d / (m + 1e-30)).toFixed(3) }; });
    }
    const status: Status = -loss > th.monoLossFailDb ? "FAIL" : -loss > th.monoLossWarnDb ? "WARN" : "PASS";
    checks.stereo = mk(status, `mono sum keeps ${loss.toFixed(1)} dB of the average channel energy; side/mid width ${metrics.width}`, metrics);
  }

  // ---- pitch stability
  if (!schedule) checks.pitchStability = mk("SKIP", "needs the score");
  else {
    const long = schedule.notes.filter((n) => n.duration >= th.longNoteSeconds && !n.modulated && n.hz >= 100);
    const devs: number[] = [];
    const win = Math.round(0.15 * sr), hann = new Float64Array(win).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / win));
    const goertzel = (seg: Float64Array, hz: number) => { const c = 2 * Math.cos((2 * Math.PI * hz) / sr); let s1 = 0, s2 = 0; for (let i = 0; i < seg.length; i += 1) { const s = seg[i]! + c * s1 - s2; s2 = s1; s1 = s; } return s1 * s1 + s2 * s2 - c * s1 * s2; };
    const perNote: number[][] = [];
    const tracks: Array<{ t: number; hz: number; cents: number[] }> = [];
    for (const n of long) {
      const t0 = n.start + offset + 0.1 * n.duration + 0.05, t1 = n.start + offset + n.duration - 0.15; // the last 150 ms hold the release and the next note's attack
      const cents: number[] = [];
      for (let t = t0; t + 0.15 <= t1; t += 0.1) {
        const s = Math.round(t * sr);
        if (s < 0 || s + win > mono.length) continue;
        const seg = new Float64Array(win).map((_, i) => mono[s + i]! * hann[i]!);
        // Coarse grid (10 cents, +-300) finds the peak and the median level; a fine grid (2 cents) refines it.
        let best = -Infinity, bestC = 0;
        const levels: number[] = [];
        for (let c = -300; c <= 300; c += 10) { const p = goertzel(seg, n.hz * Math.pow(2, c / 1200)); levels.push(p); if (p > best) { best = p; bestC = c; } }
        if (best < 6 * median(levels) || Math.abs(bestC) > 100) continue; // no clear peak near the note (another voice, or the note is absent): not this check's subject
        let fine = -Infinity, fineC = bestC;
        for (let c = bestC - 10; c <= bestC + 10; c += 2) { const p = goertzel(seg, n.hz * Math.pow(2, c / 1200)); if (p > fine) { fine = p; fineC = c; } }
        bestC = fineC;
        cents.push(bestC);
      }
      cents.shift(); cents.pop(); // the first and last window sit on the attack/glide and the release
      if (cents.length >= 2) { perNote.push(cents); tracks.push({ t: +n.start.toFixed(2), hz: +n.hz.toFixed(1), cents }); }
    }
    if (perNote.length === 0) checks.pitchStability = mk("SKIP", "no long unmodulated note with a clear peak");
    else {
      const globalOffset = median(perNote.flatMap((c) => c));
      for (const cents of perNote) devs.push(Math.max(...cents.map((c) => Math.abs(c - globalOffset))));
      const p95 = quantile(devs, 0.95);
      const status: Status = p95 > th.detuneFailCents ? "FAIL" : p95 > th.detuneWarnCents ? "WARN" : "PASS";
      checks.pitchStability = mk(status, `${perNote.length} long notes: 95th percentile of the worst deviation within a note ${p95.toFixed(0)} cents (global tuning offset ${globalOffset.toFixed(0)} cents)`, { notes: perNote.length, tracks: tracks.slice(0, 40), p95WorstCents: p95, medianWorstCents: median(devs), globalOffsetCents: globalOffset });
    }
  }

  return { checks, verdict: worst(Object.values(checks).map((c) => c.status)), analysedSeconds: { from, to } };
}

export function formatQuality(report: QualityReport): string {
  const lines = Object.entries(report.checks).map(([name, c]) => `${c.status.padEnd(4)} ${name.padEnd(15)} ${c.summary}`);
  return [...lines, `VERDICT ${report.verdict}`].join("\n");
}
