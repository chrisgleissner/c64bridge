import { midiToHz, type ParsedSidwave } from "../sidwave.js";
import { arrangeSidwave, SIDWAVE_HARD_RESTART_FRAMES } from "../sidwaveCompiler.js";

/**
 * Fidelity analysis of a captured Ultimate audio stream against the SIDWAVE schedule.
 * See doc/sidwave-hil.md for the method and its limits.
 */

export type PanSide = "left" | "right" | "center";

export interface ScheduledNote {
  /** Global voice index: sid * 3 + (channel - 1). */
  voice: number;
  sid: number;
  pan?: PanSide;
  start: number;
  duration: number;
  hz: number;
  /** Extra fundamentals accepted for arpeggios (the note counts as present when any of them is). */
  alternates: number[];
  /** The pitch moves on purpose during the note (vibrato, slide, portamento, arpeggio, wavetable). */
  modulated?: boolean;
  /** Ring modulation, hard sync or a wavetable: the note is meant to have strong high partials and transients. */
  bright?: boolean;
}

export interface PercussionOnset {
  voice: number;
  sid: number;
  start: number;
  /** Time until the gate closes (s). */
  duration?: number;
}

export interface ExpectedSchedule {
  notes: ScheduledNote[];
  percussion: PercussionOnset[];
  durationSeconds: number;
  voiceCount: number;
  sidCount: number;
}

export interface ScheduleOptions {
  /** Pan side per SID index, for SIDs whose pan is set in the Audio Mixer. Overrides a `pan` field on the SID entry. */
  pan?: Record<number, PanSide>;
}

/**
 * Lists every pitched note and every percussion onset the player will produce.
 * A note sounds from its start frame until its gate-off frame, which is the earlier of the arranged end and the
 * hard restart frame (SIDWAVE_HARD_RESTART_FRAMES before the next note on the same voice). Times are
 * frame / fps, where fps is the video frame rate times `speed` (player calls per second).
 * Instruments with a noise waveform are percussion; the schedule keeps only their onsets.
 */
export function expectedSchedule(doc: ParsedSidwave, options: ScheduleOptions = {}): ExpectedSchedule {
  const arr = arrangeSidwave(doc);
  const notes: ScheduledNote[] = [];
  const percussion: PercussionOnset[] = [];
  arr.voices.forEach((voice, v) => {
    const sid = Math.floor(v / 3);
    const pan = options.pan?.[sid] ?? ((doc.sids[sid] as { pan?: PanSide } | undefined)?.pan);
    for (let i = 0; i < voice.notes.length; i += 1) {
      const n = voice.notes[i]!;
      const inst = arr.instruments[n.inst]!;
      const start = n.start / arr.fps;
      const next = voice.notes[i + 1];
      const nextStart = next?.start ?? voice.notes[0]!.start + arr.totalFrames;
      const hr = Math.max(n.start + 1, nextStart - SIDWAVE_HARD_RESTART_FRAMES);
      const continues = next?.legato && next.start === n.end;
      const gateOff = continues ? n.end : Math.min(n.end, hr);
      if ((inst.wave & 0xf0) === 0x80) {
        percussion.push({ voice: v, sid, start, duration: (gateOff - n.start) / arr.fps });
        continue;
      }
      const alternates = inst.arp.length > 0 ? inst.arp.map((o) => midiToHz(n.midi + o)) : [];
      const modulated = alternates.length > 0 || !!n.portamento || inst.vibRate !== 0 || inst.slideSemis !== 0 || !!inst.wavetable?.length;
      notes.push({ voice: v, sid, pan, start, duration: (gateOff - n.start) / arr.fps, hz: midiToHz(n.midi), alternates, modulated, bright: !!inst.ring || !!inst.sync || !!inst.wavetable?.length });
    }
  });
  notes.sort((a, b) => a.start - b.start);
  percussion.sort((a, b) => a.start - b.start);
  return { notes, percussion, durationSeconds: arr.totalFrames / arr.fps, voiceCount: arr.voices.length, sidCount: Math.ceil(arr.voices.length / 3) };
}

// ---------------------------------------------------------------------------
// Signal helpers

export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = i + k, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Goertzel power of a (pre-windowed) segment at `hz`, normalised by segment length squared. */
function goertzel(x: Float64Array, hz: number, sampleRate: number): number {
  const w = (2 * Math.PI * hz) / sampleRate;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i += 1) { const s = x[i]! + c * s1 - s2; s2 = s1; s1 = s; }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (x.length * x.length);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const STFT_WINDOW = 512;
const STFT_HOP = 128;
/** HF band for percussion (noise is broadband; the square/saw fundamentals of a SID song are mostly below this). */
const HF_CUTOFF_HZ = 4000;

interface Stft {
  hopSeconds: number;
  /** Time (s) of the centre of frame i is (i * hop + window / 2) / sampleRate. */
  flux: Float64Array;
  hf: Float64Array;
  centreOffset: number;
}

function stft(mono: Float64Array, sampleRate: number): Stft {
  const frames = Math.max(0, Math.floor((mono.length - STFT_WINDOW) / STFT_HOP) + 1);
  const hann = new Float64Array(STFT_WINDOW).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / STFT_WINDOW));
  const re = new Float64Array(STFT_WINDOW), im = new Float64Array(STFT_WINDOW);
  const bins = STFT_WINDOW / 2;
  const prev = new Float64Array(bins);
  const flux = new Float64Array(frames), hf = new Float64Array(frames);
  const hfBin = Math.ceil((HF_CUTOFF_HZ * STFT_WINDOW) / sampleRate);
  for (let f = 0; f < frames; f += 1) {
    for (let i = 0; i < STFT_WINDOW; i += 1) { re[i] = mono[f * STFT_HOP + i]! * hann[i]!; im[i] = 0; }
    fft(re, im);
    let sum = 0, high = 0;
    for (let k = 1; k < bins; k += 1) {
      const mag = Math.hypot(re[k]!, im[k]!) / STFT_WINDOW;
      const l = Math.log1p(mag * 1000);
      if (f > 0) sum += Math.max(0, l - prev[k]!);
      prev[k] = l;
      if (k >= hfBin) high += mag * mag;
    }
    flux[f] = sum; hf[f] = high;
  }
  return { hopSeconds: STFT_HOP / sampleRate, flux, hf, centreOffset: STFT_WINDOW / 2 / sampleRate };
}

export interface FidelityOptions {
  /** Largest playback start offset to search (ms). The search covers 0..latencySearchMs. */
  latencySearchMs: number;
  /** Detection threshold of the target/neighbourhood ratio in dB (default 6). */
  thresholdDb?: number;
  /**
   * Smallest sine amplitude (full scale = 1) that can count as a note; it sets a minimum for the neighbourhood level,
   * so leakage over digital silence is not read as a tone. Default 0.002 (about -54 dBFS).
   */
  minAmplitude?: number;
  /** Percussion onset match tolerance in ms (default 30). */
  percussionToleranceMs?: number;
}

export const DEFAULT_THRESHOLD_DB = 6;
/**
 * A Hann window of length T has a main lobe 2 / T Hz wide on each side. A note is only judged when that stays below
 * about a third of a semitone (0.02 f): T >= 30 / f seconds. Shorter low notes are reported as unresolved.
 */
export const RESOLUTION_CYCLES = 30;

export interface RateEntry { expected: number; present: number; rate: number }

export interface NoteResult {
  voice: number; sid: number; start: number; hz: number;
  ratioDb: number; present: boolean;
  /** True when another voice sounds the same pitch at the same time; this note is not counted. */
  merged: boolean;
  /** The analysis window is too short to separate the note from a semitone away (shorter than MIN_PERIODS_RESOLUTION / hz); not counted. */
  unresolved?: boolean;
  skipped?: "outside-capture";
}

export interface SideEnergy {
  /** Summed fundamental power of notes scheduled on this side, in the left and right channel. */
  left: number; right: number;
  /** 10 log10(wanted-channel / other-channel); null when either is zero. */
  separationDb: number | null;
  notes: number;
}

export interface FidelityReport {
  offsetMs: number;
  /** Normalised cross-correlation peak, 0..1, as a confidence for the offset. */
  offsetConfidence: number;
  thresholdDb: number;
  pitched: RateEntry;
  /** Pitched notes that were not judged (see NoteResult.unresolved), and notes beyond the end of the capture. */
  unjudged: { unresolved: number; outsideCapture: number };
  perVoice: Array<RateEntry & { voice: number }>;
  perSid: Array<RateEntry & { sid: number }>;
  percussion: RateEntry;
  rms: { left: number; right: number };
  sides: Partial<Record<"left" | "right", SideEnergy>>;
  notes: NoteResult[];
}

const rate = (expected: number, present: number): RateEntry => ({ expected, present, rate: expected === 0 ? 1 : present / expected });

function toFloat(pcm: Int16Array | Float32Array | Float64Array): Float64Array {
  const out = new Float64Array(pcm.length);
  const scale = pcm instanceof Int16Array ? 1 / 32768 : 1;
  for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i]! * scale;
  return out;
}

/**
 * Compares captured interleaved stereo PCM with the schedule.
 *
 * Offset: the onset strength (log-spectral flux, 512-sample Hann frames, 128-sample hop) of the mono capture is
 * cross-correlated with a train of triangular pulses (width +-12 ms) at every scheduled onset, over lags 0..latencySearchMs.
 * The peak is refined by parabolic interpolation.
 *
 * Pitched notes: for each note the middle 60% of the sounding time is windowed (Hann, at least 40 ms, at most 500 ms). For the fundamental and the next two harmonics
 * the Goertzel power is the maximum over -20, 0 and +20 cents. It is divided by the median Goertzel power on a 20-cent
 * grid within +-2 semitones of that harmonic, excluding +-30 cents. The note ratio is the summed target power over the
 * summed median power, where each median is at least the level of a sine of minAmplitude. A note is present when both this
 * ratio and the fundamental's own ratio exceed thresholdDb (default 6 dB).
 *
 * Notes of different voices with the same pitch (within 50 cents) and overlapping in time are counted once (the first
 * one in schedule order; the others are marked merged and left out of every rate). Arpeggio notes are present when
 * any of their pitches is.
 *
 * Percussion: an onset matches when the energy above 4 kHz inside +-tolerance of the expected time exceeds
 * 4 times (6 dB) the median level of the preceding 100 ms and 1e-6 absolute (about -60 dBFS).
 */
export function analyse(
  stereoPcm: Int16Array | Float32Array | Float64Array,
  sampleRate: number,
  schedule: ExpectedSchedule,
  options: FidelityOptions,
): FidelityReport {
  const thresholdDb = options.thresholdDb ?? DEFAULT_THRESHOLD_DB;
  const tolS = (options.percussionToleranceMs ?? 30) / 1000;
  const pairs = Math.floor(stereoPcm.length / 2);
  const all = toFloat(stereoPcm);
  const left = new Float64Array(pairs), right = new Float64Array(pairs), mono = new Float64Array(pairs);
  let sl = 0, sr = 0;
  for (let i = 0; i < pairs; i += 1) {
    left[i] = all[2 * i]!; right[i] = all[2 * i + 1]!; mono[i] = (left[i]! + right[i]!) / 2;
    sl += left[i]! * left[i]!; sr += right[i]! * right[i]!;
  }
  const rms = { left: Math.sqrt(sl / Math.max(1, pairs)), right: Math.sqrt(sr / Math.max(1, pairs)) };

  // ---- offset
  const spec = stft(mono, sampleRate);
  const hop = spec.hopSeconds;
  const nFrames = spec.flux.length;
  const train = new Float64Array(Math.ceil((schedule.durationSeconds + 0.5) / hop) + 1);
  const halfWidth = 0.012 / hop;
  const onsets = [...schedule.notes.map((n) => n.start), ...schedule.percussion.map((p) => p.start)];
  for (const t of onsets) {
    const c = t / hop;
    for (let i = Math.max(0, Math.floor(c - halfWidth)); i <= Math.min(train.length - 1, Math.ceil(c + halfWidth)); i += 1) {
      train[i] = Math.max(train[i]!, 1 - Math.abs(i - c) / halfWidth);
    }
  }
  // Frame i holds the onset when its centre is about at the onset, so frame time = i * hop + centreOffset.
  // Observed flux is also referenced to frame start by subtracting centreOffset below.
  const maxLag = Math.round(options.latencySearchMs / 1000 / hop);
  const meanFlux = spec.flux.reduce((a, b) => a + b, 0) / Math.max(1, nFrames);
  const obs = spec.flux.map((v) => v - meanFlux);
  const corr = new Float64Array(maxLag + 1);
  let trainNorm = 0;
  for (const v of train) trainNorm += v * v;
  const obsEnergy = obs.reduce((a, b) => a + b * b, 0);
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i < train.length; i += 1) {
      const j = i + lag;
      if (j >= nFrames) break;
      sum += train[i]! * obs[j]!;
    }
    corr[lag] = sum;
  }
  let best = 0;
  for (let lag = 1; lag <= maxLag; lag += 1) if (corr[lag]! > corr[best]!) best = lag;
  let frac = 0;
  if (best > 0 && best < maxLag) {
    const a = corr[best - 1]!, b = corr[best]!, c = corr[best + 1]!;
    const d = a - 2 * b + c;
    if (d !== 0) frac = (0.5 * (a - c)) / d;
  }
  // A flux peak at frame f marks an onset inside the window [f*hop, f*hop + window); the strongest flux occurs when
  // the onset is near a quarter of the window in, so remove that bias from the lag.
  const onsetBias = spec.centreOffset / 2;
  const offsetS = Math.max(0, (best + frac) * hop - onsetBias);
  const offsetConfidence = trainNorm > 0 && obsEnergy > 0 ? Math.max(0, corr[best]! / Math.sqrt(trainNorm * obsEnergy)) : 0;

  // ---- pitched notes
  const centsRatio = (c: number) => Math.pow(2, c / 1200);
  const nyquist = sampleRate / 2;
  const hannCache = new Map<number, Float64Array>();
  const hannOf = (n: number) => {
    let w = hannCache.get(n);
    if (!w) { w = new Float64Array(n).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n)); hannCache.set(n, w); }
    return w;
  };

  function segmentFor(ch: Float64Array, note: ScheduledNote): Float64Array | null {
    const t0 = note.start + offsetS;
    const dur = note.duration;
    const len = Math.min(0.5, Math.max(0.04, dur * 0.6));
    const mid = t0 + dur / 2;
    const a = Math.round((mid - len / 2) * sampleRate);
    const n = Math.round(len * sampleRate);
    if (a < 0 || a + n > ch.length) return null;
    const w = hannOf(n);
    const seg = new Float64Array(n);
    for (let i = 0; i < n; i += 1) seg[i] = ch[a + i]! * w[i]!;
    return seg;
  }

  // Hann-windowed Goertzel power (normalised by length) of a sine of amplitude A is (A / 4)^2.
  const minPower = Math.pow((options.minAmplitude ?? 0.002) / 4, 2);

  function powers(seg: Float64Array, hz: number): { target: number; floor: number; fundamentalDb: number } {
    let target = 0, floor = 0, fundamentalDb = -Infinity;
    for (const h of [1, 2, 3]) {
      const f = hz * h;
      if (f * centsRatio(200) >= nyquist) break;
      let t = 0;
      for (const c of [-20, 0, 20]) t = Math.max(t, goertzel(seg, f * centsRatio(c), sampleRate));
      const around: number[] = [];
      for (let c = -200; c <= 200; c += 20) if (Math.abs(c) > 30) around.push(goertzel(seg, f * centsRatio(c), sampleRate));
      const level = Math.max(median(around), minPower);
      if (h === 1) fundamentalDb = 10 * Math.log10((t + 1e-30) / level);
      target += t;
      floor += level;
    }
    return { target, floor, fundamentalDb };
  }

  const results: NoteResult[] = [];
  const anySide = schedule.notes.some((n) => n.pan === "left" || n.pan === "right");
  const sides: Record<"left" | "right", { left: number; right: number; notes: number }> = {
    left: { left: 0, right: 0, notes: 0 }, right: { left: 0, right: 0, notes: 0 },
  };
  const accepted: Array<{ hz: number; t0: number; t1: number }> = [];
  for (const note of schedule.notes) {
    const t0 = note.start, t1 = note.start + note.duration;
    const merged = accepted.some((o) => Math.abs(1200 * Math.log2(o.hz / note.hz)) < 50 && o.t0 < t1 && t0 < o.t1);
    const seg = segmentFor(mono, note);
    if (!seg) {
      results.push({ voice: note.voice, sid: note.sid, start: note.start, hz: note.hz, ratioDb: -Infinity, present: false, merged, skipped: "outside-capture" });
      continue;
    }
    if (!merged && seg.length / sampleRate < RESOLUTION_CYCLES / note.hz) {
      results.push({ voice: note.voice, sid: note.sid, start: note.start, hz: note.hz, ratioDb: NaN, present: false, merged: false, unresolved: true });
      continue;
    }
    if (merged) {
      results.push({ voice: note.voice, sid: note.sid, start: note.start, hz: note.hz, ratioDb: NaN, present: false, merged });
      continue;
    }
    accepted.push({ hz: note.hz, t0, t1 });
    let bestDb = -Infinity;
    for (const hz of [note.hz, ...note.alternates]) {
      const { target, floor, fundamentalDb } = powers(seg, hz);
      const db = 10 * Math.log10((target + 1e-30) / (floor + 1e-30));
      // The fundamental must clear the threshold by itself, so a harmonic of another voice cannot stand in for it.
      bestDb = Math.max(bestDb, Math.min(db, fundamentalDb));
    }
    results.push({ voice: note.voice, sid: note.sid, start: note.start, hz: note.hz, ratioDb: bestDb, present: bestDb > thresholdDb, merged });
    if (anySide && (note.pan === "left" || note.pan === "right")) {
      const sl2 = segmentFor(left, note), sr2 = segmentFor(right, note);
      if (sl2 && sr2) {
        // Fundamental only: another side's note can sit on a harmonic of this one.
        const fundamental = (seg2: Float64Array) => Math.max(...[-20, 0, 20].map((c) => goertzel(seg2, note.hz * centsRatio(c), sampleRate)));
        sides[note.pan].left += fundamental(sl2);
        sides[note.pan].right += fundamental(sr2);
        sides[note.pan].notes += 1;
      }
    }
  }

  const counted = results.filter((r) => !r.merged && !r.unresolved && !r.skipped);
  const group = <K extends "voice" | "sid">(key: K) => {
    const keys = [...new Set(counted.map((r) => r[key]))].sort((a, b) => a - b);
    return keys.map((k) => {
      const rs = counted.filter((r) => r[key] === k);
      return { [key]: k, ...rate(rs.length, rs.filter((r) => r.present).length) };
    });
  };
  const sideOut: FidelityReport["sides"] = {};
  for (const side of ["left", "right"] as const) {
    const s = sides[side];
    if (s.notes === 0) continue;
    const wanted = s[side], other = side === "left" ? s.right : s.left;
    sideOut[side] = { left: s.left, right: s.right, notes: s.notes, separationDb: wanted > 0 && other > 0 ? 10 * Math.log10(wanted / other) : null };
  }

  // ---- percussion
  let matched = 0;
  const hfFloor = 1e-6;
  const frameTime = (i: number) => i * hop + spec.centreOffset;
  for (const p of schedule.percussion) {
    const t = p.start + offsetS;
    const lo = Math.max(0, Math.floor((t - tolS - spec.centreOffset) / hop));
    const hi = Math.min(nFrames - 1, Math.ceil((t + tolS - spec.centreOffset) / hop));
    let peak = 0;
    for (let i = lo; i <= hi; i += 1) peak = Math.max(peak, spec.hf[i]!);
    const preHi = Math.max(0, Math.floor((t - tolS - 0.01 - spec.centreOffset) / hop));
    const preLo = Math.max(0, preHi - Math.round(0.1 / hop));
    const pre = median(Array.from(spec.hf.subarray(preLo, preHi + 1)));
    if (hi >= lo && peak > hfFloor && peak > 4 * pre) matched += 1;
    void frameTime;
  }

  return {
    offsetMs: offsetS * 1000,
    offsetConfidence,
    thresholdDb,
    unjudged: { unresolved: results.filter((r) => r.unresolved).length, outsideCapture: results.filter((r) => r.skipped).length },
    pitched: rate(counted.length, counted.filter((r) => r.present).length),
    perVoice: group("voice") as FidelityReport["perVoice"],
    perSid: group("sid") as FidelityReport["perSid"],
    percussion: rate(schedule.percussion.length, matched),
    rms,
    sides: sideOut,
    notes: results,
  };
}
