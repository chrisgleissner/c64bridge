import { fft } from "./sidwaveFidelity.js";

/**
 * Model-independent comparison of a captured stereo signal with a reference rendering of the same song.
 * Chroma (pitch class) similarity and onset-envelope correlation do not depend on timbre or filter curve, which
 * differ between SID models. See doc/sidwave-hil.md.
 */

export interface Stereo { left: Float32Array | Float64Array; right: Float32Array | Float64Array; sampleRate: number }

export const FRAME_SECONDS = 0.1;
export const HOP_SECONDS = 0.05;
const ENV_HOP_SECONDS = 0.01;
/** A frame with less RMS than this (about -60 dBFS) in the reference is silence and is not scored. */
const SILENCE_RMS = 1e-3;

function mixMono(s: Stereo): Float64Array {
  const out = new Float64Array(s.left.length);
  for (let i = 0; i < out.length; i += 1) out[i] = (s.left[i]! + s.right[i]!) / 2;
  return out;
}

const pow2 = (n: number) => { let p = 1; while (p < n) p <<= 1; return p; };

/** Onset strength at 100 Hz: positive log-magnitude change between 20 ms frames, 60 Hz to 8 kHz. */
export function onsetEnvelope(x: Float64Array, sampleRate: number): Float64Array {
  const win = pow2(Math.round(0.02 * sampleRate));
  const hop = Math.round(ENV_HOP_SECONDS * sampleRate);
  const frames = Math.max(0, Math.floor((x.length - win) / hop) + 1);
  const hann = new Float64Array(win).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win));
  const re = new Float64Array(win), im = new Float64Array(win);
  const prev = new Float64Array(win / 2);
  const lo = Math.ceil((60 * win) / sampleRate), hi = Math.min(win / 2 - 1, Math.floor((8000 * win) / sampleRate));
  const out = new Float64Array(frames);
  for (let f = 0; f < frames; f += 1) {
    for (let i = 0; i < win; i += 1) { re[i] = x[f * hop + i]! * hann[i]!; im[i] = 0; }
    fft(re, im);
    let sum = 0;
    for (let k = lo; k <= hi; k += 1) {
      const l = Math.log1p((Math.hypot(re[k]!, im[k]!) / win) * 1000);
      if (f > 0) sum += Math.max(0, l - prev[k]!);
      prev[k] = l;
    }
    out[f] = sum;
  }
  // Light smoothing (3 frames) tolerates timing jitter of a few ms.
  return out.map((_, i) => ((out[i - 1] ?? 0) + 2 * out[i]! + (out[i + 1] ?? 0)) / 4);
}

/** Chroma vector (12 pitch classes, C = 0) of x[start .. start + FRAME_SECONDS], 60 Hz to 4 kHz, sqrt-compressed. */
function chromaAt(x: Float64Array, sampleRate: number, startSample: number, ctx: ChromaContext): Float64Array | null {
  const n = Math.round(FRAME_SECONDS * sampleRate);
  if (startSample < 0 || startSample + n > x.length) return null;
  const { size, hann, bins, re, im } = ctx;
  for (let i = 0; i < size; i += 1) { re[i] = i < n ? x[startSample + i]! * hann[i]! : 0; im[i] = 0; }
  let energy = 0;
  for (let i = 0; i < n; i += 1) energy += x[startSample + i]! * x[startSample + i]!;
  fft(re, im);
  const chroma = new Float64Array(12);
  // Only spectral peaks vote (broadband noise has none that stand out), each with its log magnitude above a floor.
  const mag = (k: number) => Math.hypot(re[k]!, im[k]!);
  let top = 0;
  for (const [k] of bins) top = Math.max(top, mag(k));
  for (const [k, pc] of bins) {
    const m = mag(k);
    if (m > mag(k - 1) && m >= mag(k + 1) && m > top * 0.01) chroma[pc] += Math.log1p((m / top) * 100) / Math.pow((k * ctx.hzPerBin) / 100, 0.75);
  }
  // Low partials count more than high ones (weight f^-0.75), so harmonics add less than fundamentals.
  // Remove the mean so a flat chroma (noise, dense harmonics) does not look similar to everything.
  const mean = chroma.reduce((a, b) => a + b, 0) / 12;
  const centred = chroma.map((v) => v - mean);
  const norm = Math.hypot(...centred);
  const out = norm > 0 ? centred.map((v) => v / norm) : centred;
  (out as Float64Array & { rms?: number }).rms = Math.sqrt(energy / n);
  return out;
}

interface ChromaContext { hzPerBin: number; size: number; hann: Float64Array; bins: Array<[number, number]>; re: Float64Array; im: Float64Array }

function chromaContext(sampleRate: number): ChromaContext {
  const n = Math.round(FRAME_SECONDS * sampleRate);
  const size = pow2(n * 2);
  const hann = new Float64Array(n).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const bins: Array<[number, number]> = [];
  for (let k = Math.ceil((60 * size) / sampleRate); k <= Math.floor((4000 * size) / sampleRate); k += 1) {
    const midi = 69 + 12 * Math.log2((k * sampleRate) / size / 440);
    bins.push([k, ((Math.round(midi) % 12) + 12) % 12]);
  }
  return { hzPerBin: sampleRate / size, size, hann: new Float64Array(size).map((_, i) => hann[i] ?? 0), bins, re: new Float64Array(size), im: new Float64Array(size) };
}

const cosine = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
};

const median = (v: number[]) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i += 1) { ma += a[i]!; mb += b[i]!; }
  ma /= n; mb /= n;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i += 1) { const x = a[i]! - ma, y = b[i]! - mb; d += x * y; na += x * x; nb += y * y; }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
}

/**
 * Offset (s) such that capture time = reference time + offset, from cross-correlating onset envelopes of
 * reference[fromS, toS) over lags -minS..maxS. Returns the offset and the correlation at the peak.
 */
export function alignEnvelopes(refEnv: Float64Array, capEnv: Float64Array, minOffsetS: number, maxOffsetS: number, fromS = 0, toS = Infinity): { offsetS: number; correlation: number } {
  const dt = ENV_HOP_SECONDS;
  const a = Math.max(0, Math.round(fromS / dt)), b = Math.min(refEnv.length, Math.round(toS / dt));
  let best = -Infinity, bestLag = 0;
  const lo = Math.round(minOffsetS / dt), hi = Math.round(maxOffsetS / dt);
  const scores: Record<number, number> = {};
  for (let lag = lo; lag <= hi; lag += 1) {
    const x: number[] = [], y: number[] = [];
    for (let i = a; i < b; i += 1) { const j = i + lag; if (j < 0 || j >= capEnv.length) continue; x.push(refEnv[i]!); y.push(capEnv[j]!); }
    if (x.length < 50) continue;
    const c = pearson(x, y);
    scores[lag] = c;
    if (c > best) { best = c; bestLag = lag; }
  }
  let frac = 0;
  const l = scores[bestLag - 1], r = scores[bestLag + 1];
  if (l !== undefined && r !== undefined) { const d = l - 2 * best + r; if (d !== 0) frac = (0.5 * (l - r)) / d; }
  return { offsetS: (bestLag + frac) * dt, correlation: best };
}

export interface CompareOptions {
  /** Capture may start up to this long before the reference starts (the capture is `offset` later). Default 4000. */
  latencySearchMs?: number;
  /** Capture may be at most this much earlier than the reference. Default 200. */
  earlyMs?: number;
  /** Half a bar in seconds, for the shift control. */
  halfBarSeconds: number;
  thresholds?: Partial<Thresholds>;
}

export interface Thresholds {
  /** Median per-frame chroma cosine. */
  chromaMedian: number;
  /** Pearson correlation of onset envelopes after alignment. */
  onset: number;
  /** The real score must exceed the highest control by this much, for both chroma and onset. */
  controlMargin: number;
  /** Maximum mean absolute difference of the left/right balance per frame, for songs with a panned reference. */
  balanceError: number;
}

/**
 * Calibrated on the generated chiptune song (seed 65): a 6581 rendering against an 8580 rendering of the same notes scores
 * chroma 0.65 / onset 0.80, the controls -0.25 (+1 semitone) and 0.11 / 0.15 (half-bar shift); synthetic square-vs-saw
 * copies score 0.87 / 0.96. See doc/sidwave-hil.md.
 */
export const DEFAULT_THRESHOLDS: Thresholds = { chromaMedian: 0.45, onset: 0.5, controlMargin: 0.2, balanceError: 0.3 };

export interface Score { chromaMedian: number; chromaAbove07: number; onset: number }

export interface SimilarityReport {
  offsetMs: number;
  alignment: { correlation: number; firstThirdOffsetMs: number; lastThirdOffsetMs: number; driftMs: number };
  real: Score;
  controls: { transposedSemitone: Score; shiftedHalfBar: Score };
  balance: { applicable: boolean; meanAbsError: number; referenceSpread: number };
  thresholds: Thresholds;
  verdict: { chroma: boolean; onset: boolean; margin: boolean; balance: boolean; pass: boolean };
  frames: number;
}

function features(sig: Stereo, mono: Float64Array, startTimes: number[]) {
  const ctx = chromaContext(sig.sampleRate);
  const n = Math.round(FRAME_SECONDS * sig.sampleRate);
  return startTimes.map((t) => {
    const s = Math.round(t * sig.sampleRate);
    const c = chromaAt(mono, sig.sampleRate, s, ctx);
    let l = 0, r = 0;
    if (c) for (let i = 0; i < n; i += 1) { l += sig.left[s + i]! ** 2; r += sig.right[s + i]! ** 2; }
    return c ? { chroma: c, rms: (c as Float64Array & { rms: number }).rms, l, r } : null;
  });
}

const rotate = (c: ArrayLike<number>, by: number) => Array.from({ length: 12 }, (_, i) => c[(i - by + 12) % 12]!);

function scoreFrames(refChroma: Array<ArrayLike<number> | null>, refRms: number[], capChroma: Array<ArrayLike<number> | null>): { median: number; above: number } {
  const sims: number[] = [];
  for (let i = 0; i < refChroma.length; i += 1) {
    if (!refChroma[i] || !capChroma[i] || refRms[i]! < SILENCE_RMS) continue;
    sims.push(cosine(refChroma[i]!, capChroma[i]!));
  }
  return { median: median(sims), above: sims.length ? sims.filter((s) => s > 0.7).length / sims.length : 0 };
}

function envCorrelation(refEnv: Float64Array, capEnv: Float64Array, offsetS: number, seconds: number): number {
  const lag = Math.round(offsetS / ENV_HOP_SECONDS);
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < Math.min(refEnv.length, Math.round(seconds / ENV_HOP_SECONDS)); i += 1) {
    const j = i + lag;
    if (j < 0 || j >= capEnv.length) continue;
    x.push(refEnv[i]!); y.push(capEnv[j]!);
  }
  return pearson(x, y);
}

/**
 * Compares `capture` with `reference` (both stereo). Steps: onset envelopes (100 Hz) are cross-correlated over the whole
 * reference to find the offset; the same is done on the first and last third to report drift. Chroma and onset
 * similarity are then computed on 100 ms frames every 50 ms of the aligned capture. Two controls are computed from the
 * reference itself against the capture: the reference with chroma moved by one semitone, and the reference shifted by
 * half a bar. The verdict needs the real score above the thresholds and above both controls by `controlMargin`.
 */
export function compareToReference(reference: Stereo, capture: Stereo, options: CompareOptions): SimilarityReport {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const refMono = mixMono(reference), capMono = mixMono(capture);
  const refEnv = onsetEnvelope(refMono, reference.sampleRate), capEnv = onsetEnvelope(capMono, capture.sampleRate);
  const duration = reference.left.length / reference.sampleRate;
  const min = -(options.earlyMs ?? 200) / 1000, max = (options.latencySearchMs ?? 4000) / 1000;
  const whole = alignEnvelopes(refEnv, capEnv, min, max);
  const first = alignEnvelopes(refEnv, capEnv, whole.offsetS - 0.2, whole.offsetS + 0.2, 0, duration / 3);
  const last = alignEnvelopes(refEnv, capEnv, whole.offsetS - 0.2, whole.offsetS + 0.2, (2 * duration) / 3, duration);
  const offsetS = whole.offsetS;

  const count = Math.max(0, Math.floor((duration - FRAME_SECONDS) / HOP_SECONDS));
  const refTimes = Array.from({ length: count }, (_, i) => i * HOP_SECONDS);
  const refF = features(reference, refMono, refTimes);
  const capF = features(capture, capMono, refTimes.map((t) => t + offsetS));
  const refChroma = refF.map((f) => f?.chroma ?? null), refRms = refF.map((f) => f?.rms ?? 0);
  const real = scoreFrames(refChroma, refRms, capF.map((f) => f?.chroma ?? null));

  // Control 1: the reference moved one semitone up against the (unchanged) capture.
  const rotated = scoreFrames(refChroma.map((c) => (c ? rotate(c, 1) : null)), refRms, capF.map((f) => f?.chroma ?? null));
  // Control 2: the capture compared half a bar later (equivalently, the reference shifted by half a bar).
  const shiftFrames = Math.round(options.halfBarSeconds / HOP_SECONDS);
  const shiftedChroma = capF.map((_, i) => capF[i + shiftFrames]?.chroma ?? null);
  const shifted = scoreFrames(refChroma, refRms, shiftedChroma);

  const score = (m: { median: number; above: number }, onset: number): Score => ({ chromaMedian: m.median, chromaAbove07: m.above, onset });
  const onsetReal = envCorrelation(refEnv, capEnv, offsetS, duration);
  const onsetRotated = onsetReal; // a pitch change does not move onsets; the chroma control carries that case
  const onsetShifted = envCorrelation(refEnv, capEnv, offsetS + options.halfBarSeconds, duration);

  // Balance: (L - R) / (L + R) per frame, compared where both frames are loud enough.
  const diffs: number[] = [], refBal: number[] = [];
  refF.forEach((rf, i) => {
    const cf = capF[i];
    if (!rf || !cf || rf.rms < SILENCE_RMS || cf.rms < SILENCE_RMS) return;
    const rb = (rf.l - rf.r) / (rf.l + rf.r + 1e-30), cb = (cf.l - cf.r) / (cf.l + cf.r + 1e-30);
    refBal.push(rb); diffs.push(Math.abs(rb - cb));
  });
  const sorted = refBal.map(Math.abs).sort((a, b) => a - b);
  const spread = sorted.length ? sorted[Math.floor(0.9 * (sorted.length - 1))]! : 0;
  const applicable = spread > 0.3; // 90th percentile of |balance|: the reference has clearly panned parts
  const balance = { applicable, meanAbsError: diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0, referenceSpread: spread };

  const controls = { transposedSemitone: score(rotated, onsetRotated), shiftedHalfBar: score(shifted, onsetShifted) };
  const chromaControl = Math.max(controls.transposedSemitone.chromaMedian, controls.shiftedHalfBar.chromaMedian);
  const onsetControl = onsetShifted;
  const verdict = {
    chroma: real.median >= thresholds.chromaMedian,
    onset: onsetReal >= thresholds.onset,
    margin: real.median >= chromaControl + thresholds.controlMargin && onsetReal >= onsetControl + thresholds.controlMargin,
    balance: !applicable || balance.meanAbsError <= thresholds.balanceError,
    pass: false,
  };
  verdict.pass = verdict.chroma && verdict.onset && verdict.margin && verdict.balance;
  return {
    offsetMs: offsetS * 1000,
    alignment: { correlation: whole.correlation, firstThirdOffsetMs: first.offsetS * 1000, lastThirdOffsetMs: last.offsetS * 1000, driftMs: (last.offsetS - first.offsetS) * 1000 },
    real: score(real, onsetReal),
    controls,
    balance,
    thresholds,
    verdict,
    frames: count,
  };
}
