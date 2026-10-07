import { parseSidwave, midiToHz, noteNameToMidi } from "../sidwave.js";

// Minimal ambient types for dynamic imports
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = any;

export interface RecordAndAnalyzeParams {
  durationSeconds: number;
  expectedSidwave?: unknown;
}

export interface DetectedNote {
  note: string | null;
  frequency: number | null;
  duration_ms: number;
  deviation_cents?: number;
  uncertain?: boolean;
}

export interface VoiceAnalysis {
  id: number;
  detected_notes: DetectedNote[];
  average_deviation: number | null;
}

export interface AnalysisResult {
  sidwave: number;
  analysis: {
    source: "microphone" | "ultimate-stream";
    durationSeconds: number;
    voices: VoiceAnalysis[];
    global_metrics: {
      average_pitch_deviation: number | null;
      detected_bpm: number | null;
      average_rms: number | null;
      max_rms: number | null;
    };
  };
}

export function normalizeAudioDuration(durationSeconds: number): number {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration)) {
    throw new Error("durationSeconds must be a number");
  }
  return Math.max(0.5, Math.min(120, duration));
}

export async function recordAndAnalyzeAudio(params: RecordAndAnalyzeParams): Promise<AnalysisResult> {
  const duration = normalizeAudioDuration(params.durationSeconds);

  // Capture PCM from default microphone using naudiodon (PortAudio)
  const sampleRate = 44100;
  const channelCount = 1;

  let portAudio: AnyFn;
  try {
    // Use non-literal specifier to avoid TS resolution during tests when module isn't present
    const naModule = "naudiodon" as unknown as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    portAudio = await import(naModule as any);
  } catch (e) {
    throw new Error(
      "Audio backend not available. Please install 'naudiodon' dependencies (PortAudio). No external CLI tools are required."
    );
  }

  const input = new portAudio.AudioIO({
    inOptions: {
      channelCount,
      sampleFormat: portAudio.SampleFormat16Bit,
      sampleRate,
      deviceId: -1,
      closeOnError: true,
    },
  });

  const chunks: Buffer[] = [];
  input.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    try {
      input.start();
    } catch (err) {
      reject(err);
      return;
    }
    setTimeout(() => {
      try {
        // Some versions expose quit(); others expose stop(). Try both safely.
        if (typeof input.quit === "function") input.quit();
        else if (typeof input.stop === "function") input.stop();
      } catch {}
      resolve();
    }, Math.round(duration * 1000));
  });

  const pcm16 = Buffer.concat(chunks);
  const float32 = convertInt16ToFloat32(pcm16);

  const analysis = await analyzePcm(float32, sampleRate, "microphone", params.expectedSidwave);
  return analysis;
}

/**
 * Analyzes interleaved 16-bit stereo PCM captured from the Ultimate audio stream.
 *
 * The stream carries a large constant offset per channel even when silent
 * (for example left 26900, right 20000). The mean of each channel is removed
 * before analysis; otherwise the RMS measures the offset instead of the audio level.
 * Analyze channel energy separately, since a mono mix can cancel opposite-phase
 * audio and falsely verify silence. Pitch and level follow the louder channel in each window.
 */
export async function analyzeStereoStream(
  interleaved: Int16Array,
  sampleRate: number,
  expectedSidwave?: unknown,
): Promise<AnalysisResult> {
  const [left, right] = stereoToCenteredChannels(interleaved);
  return analyzePcm(left, sampleRate, "ultimate-stream", expectedSidwave, right);
}

function stereoToCenteredChannels(interleaved: Int16Array): [Float32Array, Float32Array] {
  const frames = Math.floor(interleaved.length / 2);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  if (frames === 0) {
    return [left, right];
  }
  let leftSum = 0;
  let rightSum = 0;
  for (let i = 0; i < frames; i += 1) {
    leftSum += interleaved[i * 2]!;
    rightSum += interleaved[i * 2 + 1]!;
  }
  const leftMean = leftSum / frames;
  const rightMean = rightSum / frames;
  for (let i = 0; i < frames; i += 1) {
    left[i] = (interleaved[i * 2]! - leftMean) / 32768;
    right[i] = (interleaved[i * 2 + 1]! - rightMean) / 32768;
  }
  return [left, right];
}

export function stereoToCenteredMono(interleaved: Int16Array): Float32Array {
  const [left, right] = stereoToCenteredChannels(interleaved);
  for (let i = 0; i < left.length; i += 1) left[i] = (left[i]! + right[i]!) / 2;
  return left;
}

function convertInt16ToFloat32(buf: Buffer): Float32Array {
  const len = Math.floor(buf.length / 2);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    const v = buf.readInt16LE(i * 2);
    out[i] = v / 32768;
  }
  return out;
}

async function analyzePcm(
  signal: Float32Array,
  sampleRate: number,
  source: AnalysisResult["analysis"]["source"],
  expectedSidwave?: unknown,
  secondChannel?: Float32Array,
): Promise<AnalysisResult> {
  let Pitchfinder: AnyFn;
  let Meyda: AnyFn | null = null;
  try {
    Pitchfinder = (await import("pitchfinder")).default ?? (await import("pitchfinder"));
  } catch (e) {
    throw new Error("Missing dependency: pitchfinder");
  }
  try {
    // meyda exports default in recent versions
    const m = await import("meyda");
    Meyda = (m as any).default ?? m;
  } catch (e) {
    // Optional: fall back to manual RMS if meyda is unavailable in environment
    Meyda = null;
  }

  const windowSize = 2048;
  const hopSize = 512;
  const yin: AnyFn = Pitchfinder.YIN({ sampleRate });

  const frames: Array<{ t0: number; t1: number; freq: number | null; rms: number }> = [];

  for (let i = 0; i + windowSize <= signal.length; i += hopSize) {
    let win = signal.subarray(i, i + windowSize);
    let rms = computeRms(win, Meyda, sampleRate, windowSize);
    if (secondChannel) {
      const otherWin = secondChannel.subarray(i, i + windowSize);
      const otherRms = computeRms(otherWin, Meyda, sampleRate, windowSize);
      if (otherRms > rms) {
        rms = otherRms;
        win = otherWin;
      }
    }
    const minRms = 0.01; // simple noise gate
    let freq: number | null = null;
    if (rms >= minRms) {
      try {
        // pitchfinder's YIN seeds its difference sum with 1, making low-level
        // normalized PCM produce spurious ultrasonic pitches. Normalize only
        // the detector input; RMS and the noise gate retain the original level.
        let peak = 0;
        for (const value of win) peak = Math.max(peak, Math.abs(value));
        const pitchInput = peak > 0 ? Float32Array.from(win, (value) => value / peak) : win;
        const f = yin(pitchInput);
        if (Number.isFinite(f) && f > 20 && f < 8000) freq = f;
      } catch {}
    }
    frames.push({ t0: i / sampleRate, t1: (i + windowSize) / sampleRate, freq, rms });
  }

  const segments = groupSegments(frames, sampleRate);
  const rmsValues = frames
    .map((f) => (Number.isFinite(f.rms) ? Math.max(0, Number(f.rms)) : 0))
    .filter((v) => Number.isFinite(v));
  const averageRmsRaw = rmsValues.length ? rmsValues.reduce((acc, v) => acc + v, 0) / rmsValues.length : 0;
  const maxRmsRaw = rmsValues.length ? Math.max(...rmsValues) : 0;
  const averageRms = rmsValues.length ? round(averageRmsRaw, 0.0001) : 0;
  const maxRms = rmsValues.length ? round(maxRmsRaw, 0.0001) : 0;

  // Map to detected notes with deviations
  let expected: ReturnType<typeof parseSidwave> | undefined;
  if (expectedSidwave) {
    try {
      expected = parseSidwave(expectedSidwave as any);
    } catch {
      expected = undefined;
    }
  }

  const expectedMidiSet = extractExpectedMidiSet(expected);

  const detected_notes: DetectedNote[] = segments.map((seg) => {
    if (seg.freq == null) {
      return { note: null, frequency: null, duration_ms: Math.round(seg.duration * 1000), uncertain: true };
    }
    const midiMeasured = Math.round(69 + 12 * Math.log2(seg.freq / 440));
    let deviation_cents: number;
    if (expectedMidiSet && expectedMidiSet.length) {
      const nearest = expectedMidiSet.reduce(
        (best, m) => {
          const hz = midiToHz(m);
          const cents = 1200 * Math.log2(seg.freq! / hz);
          const d = Math.abs(cents);
          return d < best.dist ? { midi: m, dist: d, cents } : best;
        },
        { midi: midiMeasured, dist: Infinity, cents: 0 },
      );
      deviation_cents = nearest.cents;
    } else {
      const noteHz = midiToHz(midiMeasured);
      deviation_cents = 1200 * Math.log2(seg.freq / noteHz);
    }
    const name = midiToName(midiMeasured);
    return {
      note: name,
      frequency: round(seg.freq, 0.1),
      duration_ms: Math.round(seg.duration * 1000),
      deviation_cents: round(deviation_cents, 0.1),
    };
  });

  // Basic BPM estimate from note change intervals
  const onsetsSec: number[] = [];
  let lastName: string | null = null;
  let lastStart: number | null = null;
  for (const seg of segments) {
    const name = seg.freq ? midiToName(Math.round(69 + 12 * Math.log2(seg.freq / 440))) : null;
    if (name && name !== lastName) {
      onsetsSec.push(seg.t0);
      lastName = name;
      lastStart = seg.t0;
    }
  }
  const ioi: number[] = [];
  for (let i = 1; i < onsetsSec.length; i += 1) ioi.push(onsetsSec[i]! - onsetsSec[i - 1]!);
  const medianIoi = ioi.length ? median(ioi) : null;
  const detected_bpm = medianIoi ? (60 / medianIoi) : null;

  const avgDev = average(
    detected_notes
      .map((n) => (n && typeof n.deviation_cents === "number" ? Math.abs(n.deviation_cents) : null))
      .filter((x): x is number => x != null),
  );

  const voices: VoiceAnalysis[] = [
    { id: 1, detected_notes, average_deviation: avgDev },
    { id: 2, detected_notes: [], average_deviation: null },
    { id: 3, detected_notes: [], average_deviation: null },
  ];

  return {
    sidwave: 1.0,
    analysis: {
      source,
      durationSeconds: signal.length / sampleRate,
      voices,
      global_metrics: {
        average_pitch_deviation: avgDev,
        detected_bpm: detected_bpm ? round(detected_bpm, 0.1) : null,
        average_rms: rmsValues.length ? averageRms : null,
        max_rms: rmsValues.length ? maxRms : null,
      },
    },
  };
}

// Test-only helper: bypasses microphone capture and analyzes provided PCM buffer.
export async function analyzePcmForTest(
  signal: Float32Array,
  sampleRate: number,
  expectedSidwave?: unknown,
): Promise<AnalysisResult> {
  return analyzePcm(signal, sampleRate, "microphone", expectedSidwave);
}

function groupSegments(
  frames: Array<{ t0: number; t1: number; freq: number | null; rms: number }>,
  _sampleRate: number,
): Array<{ t0: number; t1: number; duration: number; freq: number | null }> {
  const segments: Array<{ t0: number; t1: number; duration: number; freq: number | null }> = [];
  let cur: { t0: number; t1: number; freq: number | null } | null = null;
  const freqTolCents = 35; // merge if within ~1/3 semitone

  for (const f of frames) {
    if (!cur) {
      cur = { t0: f.t0, t1: f.t1, freq: f.freq };
      continue;
    }
    if (f.freq == null && cur.freq == null) {
      cur.t1 = f.t1;
      continue;
    }
    if (f.freq != null && cur.freq != null) {
      const cents = 1200 * Math.log2(f.freq / cur.freq);
      if (Math.abs(cents) <= freqTolCents) {
        // same note region
        cur.t1 = f.t1;
        // slight running average to stabilise
        cur.freq = 0.9 * cur.freq + 0.1 * f.freq;
        continue;
      }
    }
    segments.push({ t0: cur.t0, t1: cur.t1, duration: cur.t1 - cur.t0, freq: cur.freq });
    cur = { t0: f.t0, t1: f.t1, freq: f.freq };
  }
  if (cur) segments.push({ t0: cur.t0, t1: cur.t1, duration: cur.t1 - cur.t0, freq: cur.freq });
  return segments.filter((s) => s.duration > 0.01);
}

function midiToName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const n = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return `${names[n]}${oct}`;
}

function round(n: number, step = 1): number {
  return Math.round(n / step) * step;
}

function median(xs: number[]): number {
  const a = xs.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

function average(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.reduce((acc, v) => acc + v, 0);
  return s / xs.length;
}

function extractExpectedMidiSet(expected?: ReturnType<typeof parseSidwave>): number[] | null {
  if (!expected) return null;
  const set = new Set<number>();
  for (const v of expected.voices ?? []) {
    const p = v.patterns ?? {} as Record<string, any>;
    for (const name of Object.keys(p)) {
      const pat = (p as any)[name];
      const notes: string[] | undefined = Array.isArray(pat?.notes) ? pat.notes : Array.isArray(pat?.groove) ? pat.groove : undefined;
      if (!notes) continue;
      for (const n of notes) {
        const m = noteNameToMidiSafe(n);
        if (typeof m === "number") set.add(m);
      }
    }
  }
  return Array.from(set.values()).sort((a, b) => a - b);
}

function noteNameToMidiSafe(note: string): number | undefined {
  try {
    // noteNameToMidi is imported indirectly via sidwave types; fallback if missing
    const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec((note || "").trim());
    if (!m) return undefined;
    const letter = m[1].toUpperCase();
    const accidental = m[2];
    const octave = Number(m[3]);
    const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    let semi = base[letter] ?? 0;
    if (accidental === "#") semi += 1;
    if (accidental === "b") semi -= 1;
    const midi = (octave + 1) * 12 + semi;
    return midi;
  } catch {
    return undefined;
  }
}

function computeRms(win: Float32Array, Meyda: AnyFn | null, sampleRate: number, bufferSize: number): number {
  try {
    if (Meyda && typeof Meyda.extract === "function") {
      // Rectangular windows give plain sample RMS. Restore Meyda's shared setting
      // synchronously so other consumers retain their window configuration.
      const previousWindow = Meyda.windowingFunction;
      try {
        Meyda.windowingFunction = "rect";
        const features = Meyda.extract(["rms"], win, { sampleRate, bufferSize });
        const val = Number(features?.rms ?? 0);
        if (Number.isFinite(val)) return val;
      } finally {
        Meyda.windowingFunction = previousWindow;
      }
    }
  } catch {}
  // fallback
  let sum = 0;
  for (let i = 0; i < win.length; i += 1) sum += win[i]! * win[i]!;
  return Math.sqrt(sum / Math.max(1, win.length));
}
