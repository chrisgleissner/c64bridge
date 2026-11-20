import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { DEFAULT_MAX_READ_BYTES, resolveHostPath } from "./hostPaths.js";

const MAX_SAMPLES = 0x18000;
export const SAMPLE_KITS = ["kick", "snare", "clap", "hat", "tom", "zap"] as const;
const OSCILLATORS = ["sine", "triangle", "square", "saw", "noise"] as const;
type Oscillator = typeof OSCILLATORS[number];
export interface SampleLayer {
  osc: Oscillator;
  freq?: number | string;
  to?: number | string;
  ms?: number;
  gain?: number;
  duty?: number;
}
export interface PcmSynth extends Partial<SampleLayer> {
  layers?: SampleLayer[];
  notes?: string;
  formant?: "a" | "e" | "i" | "o" | "u";
  env?: { a?: number; d?: number; s?: number; r?: number };
  lp?: number;
  hp?: number;
  drive?: number;
  crush?: number | { bits?: number; rate?: number };
  seed?: number;
}
export interface SampleSource {
  synth?: PcmSynth;
  file?: string;
  file_rate?: number;
  b64?: string;
  base64?: string;
  hex?: string;
  kit?: typeof SAMPLE_KITS[number];
  loop?: boolean;
  dither?: "none" | "tpdf" | "shaped";
  gain_db?: number;
  trim?: boolean;
}
export interface SampleStats {
  source: "synth" | "file" | "b64" | "hex" | "kit";
  rate: number;
  duration: number;
  bytes: number;
  peak: number;
  rms: number;
  snrDb: number | null;
}
export interface RenderedSample {
  data: Uint8Array;
  sampleCount: number;
  stats: SampleStats;
  loop: boolean;
}
export const SAMPLE_SOURCE_KEYS = ["synth", "file", "file_rate", "b64", "base64", "hex", "kit", "loop", "dither", "gain_db", "trim"] as const;

function fields(raw: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} must be a mapping`);
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new Error(`Unknown ${label} field ${key}`);
  return raw as Record<string, unknown>;
}

function number(raw: unknown, label: string, min: number, max: number, fallback?: number): number {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) {
    throw new Error(`${label} must be a number in ${min}..${max}`);
  }
  return raw;
}

function integer(raw: unknown, label: string, min: number, max: number, fallback?: number): number {
  const value = number(raw, label, min, max, fallback);
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function hz(value: unknown, fallback = 440): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") return number(value, "frequency", 0.01, 100_000);
  const match = typeof value === "string" && /^([A-G])([#b]?)(-?\d)$/i.exec(value);
  if (!match) throw new Error(`Invalid frequency ${String(value)}. Use Hz or a note such as C4`);
  const semis: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const midi = (Number(match[3]) + 1) * 12 + semis[match[1]!.toUpperCase()]! +
    (match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0);
  return 440 * 2 ** ((midi - 69) / 12);
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function boundedCount(count: number): number {
  if (count > MAX_SAMPLES) {
    throw new Error(`Sample needs ${Math.ceil(count / 2)} packed bytes and cannot fit below $D000. Use a lower rate or a shorter sample`);
  }
  if (count < 1) throw new Error("Sample contains no audio frames");
  return count;
}

const FORMANTS = {
  a: [800, 1150, 2900], e: [400, 1750, 2600], i: [280, 2250, 2950],
  o: [480, 850, 2500], u: [300, 750, 2250],
};

function bandpass(freq: number, rate: number): (x: number) => number {
  const omega = 2 * Math.PI * freq / rate;
  const alpha = Math.sin(omega) / 12;
  const b = alpha / (1 + alpha);
  const a1 = 2 * Math.cos(omega) / (1 + alpha);
  const a2 = -(1 - alpha) / (1 + alpha);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = b * (x - x2) + a1 * y1 + a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

function envelope(t: number, duration: number, a: number, d: number, s: number, r: number): number {
  const level = (time: number) => time < a ? time / a : d > 0 && time < a + d
    ? 1 - (1 - s) * (time - a) / d : s;
  const release = Math.max(0, duration - r);
  return r > 0 && t >= release ? level(release) * (duration - t) / (duration - release) : level(t);
}

export function renderSynth(raw: unknown, rate: number): Float64Array {
  const layerKeys = ["osc", "freq", "to", "ms", "gain", "duty"];
  const spec = fields(raw, "synth", [...layerKeys, "layers", "notes", "formant", "env", "lp", "hp", "drive", "crush", "seed"]);
  const vowel = spec.formant;
  if (vowel !== undefined && (typeof vowel !== "string" || !Object.prototype.hasOwnProperty.call(FORMANTS, vowel))) {
    throw new Error("formant must be a, e, i, o or u");
  }
  if (spec.notes !== undefined && (typeof spec.notes !== "string" || !spec.notes.trim())) {
    throw new Error("notes must be a phrase such as C4:120 E4:120 r:60");
  }
  const notes = typeof spec.notes === "string" ? spec.notes.trim().split(/\s+/).map((part) => {
    const match = /^([A-G][#b]?-?\d|r):(\d+(?:\.\d+)?)$/i.exec(part);
    if (!match) throw new Error(`Invalid synth note ${part}. Use C4:120 or r:60`);
    const note = match[1]!;
    return { freq: note.toLowerCase() === "r" ? 0 : hz(note), ms: number(Number(match[2]), "note duration", 0.1, 120_000) };
  }) : undefined;
  const explicitLayers = spec.layers;
  if (explicitLayers !== undefined && (!Array.isArray(explicitLayers) || !explicitLayers.length || explicitLayers.length > 16)) {
    throw new Error("layers must contain 1..16 oscillators");
  }
  if (explicitLayers !== undefined && layerKeys.some((key) => spec[key] !== undefined)) {
    throw new Error("Use layers or top-level oscillator fields");
  }
  const layers = (Array.isArray(explicitLayers) ? explicitLayers : [Object.fromEntries(layerKeys.map((k) => [k, spec[k]]))]).map((entry) => {
    const layer = fields(entry, "layer", layerKeys);
    const osc = layer.osc ?? (vowel ? "square" : "sine");
    if (!OSCILLATORS.includes(osc as Oscillator)) throw new Error(`Unknown oscillator ${String(osc)}`);
    const freq = hz(layer.freq);
    return { osc, freq, to: hz(layer.to, freq), ms: layer.ms === undefined && notes ? Infinity : number(layer.ms, "ms", 0.1, 120_000, 160),
      gain: number(layer.gain, "gain", 0, 16, 1), duty: number(layer.duty, "duty", 0.01, 0.99, 0.5) };
  });
  const phrase = notes ?? [{ freq: undefined, ms: Math.max(...layers.map((l) => l.ms)) }];
  const duration = phrase.reduce((sum, n) => sum + n.ms, 0);
  const workRate = Math.max(16_000, rate * 4);
  boundedCount(Math.ceil(duration * rate / 1000));
  if (duration > 120_000) throw new Error("Synth duration exceeds 120 seconds");
  const audio = new Float64Array(Math.ceil(duration * workRate / 1000));
  const rand = random(integer(spec.seed, "seed", 0, 0xffffffff, 0x51d));
  const env = spec.env === undefined ? {} : fields(spec.env, "env", ["a", "d", "s", "r"]);
  const a = number(env.a, "attack", 0, 120_000, 0);
  const d = number(env.d, "decay", 0, 120_000, 0);
  const s = number(env.s, "sustain", 0, 1, 1);
  const r = number(env.r, "release", 0, 120_000, 0);
  let start = 0, elapsed = 0;
  for (const note of phrase) {
    elapsed += note.ms;
    const end = Math.min(audio.length, Math.round(elapsed * workRate / 1000));
    if (note.freq !== 0) for (const layer of layers) {
      let phase = 0;
      const length = Math.min(note.ms, layer.ms);
      const base = note.freq === undefined ? layer.freq : note.freq * layer.freq / layers[0]!.freq;
      for (let i = start; i < end; i++) {
        const t = (i - start) * 1000 / workRate;
        if (t >= length) break;
        phase = (phase + base * (layer.to / layer.freq) ** (t / length) / workRate) % 1;
        let value: number;
        switch (layer.osc) {
          case "noise": value = 2 * rand() - 1; break;
          case "triangle": value = 1 - 4 * Math.abs(phase - 0.5); break;
          case "square": value = phase < layer.duty ? 1 : -1; break;
          case "saw": value = 2 * phase - 1; break;
          default: value = Math.sin(2 * Math.PI * phase);
        }
        audio[i] = audio[i]! + value * layer.gain * envelope(t, length, a, d, s, r);
      }
    }
    start = end;
  }

  const formants = vowel ? FORMANTS[vowel as keyof typeof FORMANTS].map((f) => bandpass(f, workRate)) : [];
  const lp = spec.lp === undefined ? 0 : number(spec.lp, "lp", 1, 100_000);
  const hp = spec.hp === undefined ? 0 : number(spec.hp, "hp", 1, 100_000);
  const lpAlpha = 1 - Math.exp(-2 * Math.PI * lp / workRate);
  const hpAlpha = 1 - Math.exp(-2 * Math.PI * hp / workRate);
  const drive = number(spec.drive, "drive", 0, 32, 0);
  const crush = typeof spec.crush === "number" ? { bits: spec.crush } : spec.crush === undefined ? {} : fields(spec.crush, "crush", ["bits", "rate"]);
  const levels = 2 ** integer(crush.bits, "crush.bits", 1, 16, 16) - 1;
  const hold = Math.max(1, Math.round(workRate / number(crush.rate, "crush.rate", 1, 100_000, workRate)));
  let low = 0, dc = 0, held = 0;
  for (let i = 0; i < audio.length; i++) {
    let value = audio[i]!;
    if (formants.length) value = formants.reduce((sum, filter, j) => sum + filter(value) / (j + 1), 0);
    if (hp) { dc += hpAlpha * (value - dc); value -= dc; }
    if (lp) { low += lpAlpha * (value - low); value = low; }
    if (drive) value = Math.tanh(value * drive);
    if (i % hold === 0) held = crush.bits === undefined ? value : Math.round(value * levels) / levels;
    audio[i] = held;
  }
  return resamplePcm(audio, workRate, rate);
}

const DECIMATE_TAPS = Array.from({ length: 31 }, (_, i) => {
  const tap = i - 15;
  const sinc = tap === 0 ? 0.42 : Math.sin(Math.PI * tap * 0.42) / (Math.PI * tap);
  return [tap, sinc * (0.5 + 0.5 * Math.cos(Math.PI * tap / 15))] as const;
});
const DECIMATE_SUM = DECIMATE_TAPS.reduce((sum, [, weight]) => sum + weight, 0);

/** Windowed sinc low-pass with a fixed work limit, including for very high source rates. */
export function resamplePcm(input: Float64Array, from: number, to: number): Float64Array {
  const count = boundedCount(Math.max(1, Math.round(input.length * to / from)));
  if (from === to) return input;
  // At large ratios, halve the source rate in stages before the final sinc.
  // Dropping samples in these stages would fold high frequencies into the result.
  while (from > 16 * to) {
    const reduced = new Float64Array(Math.ceil(input.length / 2));
    for (let i = 0; i < reduced.length; i++) {
      const center = 2 * i;
      let sum = 0;
      for (const [tap, weight] of DECIMATE_TAPS) {
        sum += input[Math.max(0, Math.min(input.length - 1, center + tap))]! * weight;
      }
      reduced[i] = sum / DECIMATE_SUM;
    }
    input = reduced;
    from /= 2;
  }
  const output = new Float64Array(count);
  const cutoff = Math.min(1, to / from) * 0.9;
  const half = Math.ceil(12 / cutoff);
  for (let i = 0; i < output.length; i++) {
    const pos = i * from / to;
    let signal = 0, weight = 0;
    for (let j = Math.max(0, Math.ceil(pos - half)); j <= Math.min(input.length - 1, pos + half); j++) {
      const x = pos - j;
      const z = Math.PI * x * cutoff;
      const sinc = Math.abs(z) < 1e-8 ? 1 : Math.sin(z) / z;
      const w = sinc * (0.5 + 0.5 * Math.cos(Math.PI * x / half));
      signal += input[j]! * w;
      weight += w;
    }
    output[i] = weight ? signal / weight : 0;
  }
  return output;
}

const LEVELS = Float64Array.from({ length: 16 }, (_, i) => (2 * i - 15) / 15);
const clamp = (x: number, min: number, max: number) => Math.max(min, Math.min(max, x));

export function packNibbles(samples: Uint8Array): Uint8Array {
  const packed = new Uint8Array(Math.ceil(samples.length / 2));
  for (let i = 0; i < packed.length; i++) packed[i] = (samples[i * 2]! << 4) | (samples[i * 2 + 1] ?? 0);
  return packed;
}

export function unpackNibbles(data: Uint8Array, count = data.length * 2): Uint8Array {
  return Uint8Array.from({ length: count }, (_, i) => i & 1 ? data[i >> 1]! & 15 : data[i >> 1]! >> 4);
}

function metrics(input: Float64Array): { peak: number; rms: number } {
  let peak = 0, sum = 0;
  for (const x of input) { peak = Math.max(peak, Math.abs(x)); sum += x * x; }
  return { peak, rms: Math.sqrt(sum / input.length) };
}

export function quantizePcm(input: Float64Array, options: {
  dither?: SampleSource["dither"]; gainDb?: number; trim?: boolean; silenceLevel?: number;
} = {}) {
  boundedCount(input.length);
  const dc = input.reduce((sum, x) => sum + x, 0) / input.length;
  let centered = input.map((x) => x - dc);
  if (options.trim) {
    const threshold = Math.max(0.002, metrics(centered).peak * 0.01);
    let start = 0, end = centered.length;
    const quiet = (i: number) => Math.min(Math.abs(input[i]! - (options.silenceLevel ?? 0)), Math.abs(centered[i]!)) < threshold;
    while (start < end && quiet(start)) start++;
    while (end > start && quiet(end - 1)) end--;
    centered = start === end ? Float64Array.of(0) : centered.subarray(start, end);
  }
  const peak = metrics(centered).peak;
  const gain = options.gainDb === undefined ? (peak ? 1 / peak : 1) : 10 ** (options.gainDb / 20);
  const normalized = centered.map((x) => clamp(x * gain, -1, 1));
  const rand = random(0x1badb002);
  const dither = options.dither ?? "shaped";
  let error = 0, signal = 0, noise = 0;
  const samples = Uint8Array.from(normalized, (x) => {
    const triangular = dither === "none" ? 0 : rand() - rand();
    const target = (x + 1) * 7.5;
    const shaped = target + (dither === "shaped" ? 0.9 * error : 0);
    const level = Math.abs(x) === 1 ? target : clamp(Math.round(shaped + triangular * (dither === "shaped" ? 0.25 : 1)), 0, 15);
    error = shaped - level;
    signal += x * x;
    noise += (x - LEVELS[level]!) ** 2;
    return level;
  });
  return { samples, packed: packNibbles(samples), ...metrics(normalized),
    snrDb: signal && noise ? 10 * Math.log10(signal / noise) : null };
}

export function readPcmFile(file: string, fileRate?: number): { data: Float64Array; rate: number } {
  const path = resolveHostPath(file, { purpose: "read" });
  const bytes = readFileSync(path);
  if (bytes.length > DEFAULT_MAX_READ_BYTES) throw new Error("PCM file exceeds the host read size limit");
  const ext = extname(file).toLowerCase();
  if (ext === ".u8" || ext === ".s16") {
    const rate = integer(fileRate, "file_rate", 1, 0xffffffff);
    if (ext === ".s16" && bytes.length % 2) throw new Error("Incomplete .s16 sample");
    const data = ext === ".u8" ? Float64Array.from(bytes, (x) => (x - 128) / 128)
      : Float64Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readInt16LE(i * 2) / 32768);
    return { data, rate };
  }
  if (fileRate !== undefined) throw new Error("file_rate is only used for raw .u8 and .s16");
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Expected WAV, .u8 or .s16 sample file");
  }
  const end = 8 + bytes.readUInt32LE(4);
  if (end < 12 || end > bytes.length) throw new Error("Truncated WAV");
  let format: Buffer | undefined, payload: Buffer | undefined;
  for (let p = 12; p + 8 <= end;) {
    const id = bytes.toString("ascii", p, p + 4);
    const size = bytes.readUInt32LE(p + 4);
    if (p + 8 + size > end) throw new Error("Truncated WAV chunk");
    const chunk = bytes.subarray(p + 8, p + 8 + size);
    if (id === "fmt " && !format) format = chunk;
    if (id === "data" && !payload) payload = chunk;
    p += 8 + size + (size & 1);
  }
  if (!format || format.length < 16 || !payload) throw new Error("WAV needs fmt and data chunks");
  let encoding = format.readUInt16LE(0);
  const channels = format.readUInt16LE(2);
  const rate = format.readUInt32LE(4);
  const align = format.readUInt16LE(12);
  const bits = format.readUInt16LE(14);
  if (encoding === 0xfffe && format.length >= 40 &&
      format.subarray(26, 40).equals(Buffer.from("000000001000800000aa00389b71", "hex"))) {
    encoding = format.readUInt16LE(24);
  }
  if ((encoding !== 1 || ![8, 16, 24].includes(bits)) && (encoding !== 3 || bits !== 32)) {
    throw new Error("Unsupported WAV encoding. Use PCM 8/16/24-bit or float32");
  }
  if (![1, 2].includes(channels) || !rate || align !== bits / 8 * channels || payload.length % align) {
    throw new Error("Invalid mono/stereo WAV format or data length");
  }
  const data = new Float64Array(payload.length / align);
  for (let i = 0; i < data.length; i++) {
    let mix = 0;
    for (let c = 0; c < channels; c++) {
      const offset = i * align + c * bits / 8;
      const value = encoding === 3 ? payload.readFloatLE(offset) : bits === 8 ? (payload[offset]! - 128) / 128
        : payload.readIntLE(offset, bits / 8) / 2 ** (bits - 1);
      mix += Number.isFinite(value) ? value : 0;
    }
    data[i] = mix / channels;
  }
  return { data, rate };
}

function synthesizeSample(kit: typeof SAMPLE_KITS[number], rate: number): Float64Array {
  let noise = 0x5e71;
  let phase = 0;
  const seconds = kit === "kick" ? 0.17 : kit === "snare" ? 0.14 : kit === "clap" ? 0.11 : kit === "hat" ? 0.055 : kit === "tom" ? 0.22 : 0.12;
  return Float64Array.from({ length: Math.ceil(seconds * rate) }, (_, index) => {
    const t = index / rate;
    noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
    const random = noise / 0x80000000 - 1;
    phase += (kit === "kick" ? 45 + 155 * Math.exp(-t * 42) : kit === "tom" ? 70 + 90 * Math.exp(-t * 10) : kit === "zap" ? 120 + 1000 * Math.exp(-t * 28) : 172) / rate;
    const osc = Math.sin(phase * 2 * Math.PI);
    const clap = Math.exp(-t * 160) +
      (t >= 0.012 ? Math.exp(-(t - 0.012) * 140) : 0) +
      (t >= 0.026 ? Math.exp(-(t - 0.026) * 65) : 0);
    const signal = kit === "kick" ? osc * Math.exp(-t * 23) :
      kit === "tom" ? osc * Math.exp(-t * 16) : kit === "zap" ? osc * Math.exp(-t * 24) :
      kit === "hat" ? random * Math.exp(-t * 80) :
      kit === "snare" ? (0.76 * random + 0.24 * osc) * Math.exp(-t * 28) : random * clap;
    return signal;
  });
}

/** Shared by the score compiler and the host-only WAV preview. */
export function renderSample(raw: unknown, rate: number): RenderedSample {
  const spec = fields(raw, "sample", SAMPLE_SOURCE_KEYS);
  if (!Number.isInteger(rate) || rate < 16 || rate > 8000) throw new Error("rate must be an integer in 16..8000");
  const keys = ["synth", "file", "kit", "hex", "b64", "base64"] as const;
  const present = keys.filter((key) => spec[key] !== undefined);
  if (present.length !== 1) throw new Error("Provide exactly one of synth, file, kit, hex or b64 (alias base64)");
  const key = present[0]!;
  const source = key === "base64" ? "b64" : key;
  for (const flag of ["loop", "trim"]) if (spec[flag] !== undefined && typeof spec[flag] !== "boolean") {
    throw new Error(`${flag} must be a boolean`);
  }
  const dither = spec.dither as SampleSource["dither"];
  if (dither !== undefined && !["none", "tpdf", "shaped"].includes(dither)) throw new Error("dither must be none, tpdf or shaped");
  const gainDb = spec.gain_db === undefined ? undefined : number(spec.gain_db, "gain_db", -96, 48);
  if (key !== "file" && spec.file_rate !== undefined) throw new Error("file_rate requires file");
  let data: Uint8Array, sampleCount: number, peak: number, rms: number, snrDb: number | null;
  if (source === "hex" || source === "b64") {
    const encoded = spec[key];
    if (typeof encoded !== "string" || !encoded.trim()) throw new Error(`${key} must be a nonempty string`);
    if (source === "hex") {
      const hex = encoded.replace(/\s/g, "");
      if (!/^[0-9a-f]+$/i.test(hex)) throw new Error("Expected hexadecimal sample nibbles");
      sampleCount = boundedCount(hex.length);
      data = packNibbles(Uint8Array.from(hex, (ch) => Number.parseInt(ch, 16)));
    } else {
      const b64 = encoded.replace(/\s/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) {
        throw new Error("Expected base64-encoded packed nibbles");
      }
      data = Buffer.from(b64, "base64");
      sampleCount = boundedCount(data.length * 2);
    }
    if (dither !== undefined || gainDb !== undefined || spec.trim !== undefined) throw new Error("Conversion options require synth, file or kit");
    ({ peak, rms } = metrics(Float64Array.from(unpackNibbles(data, sampleCount), (x) => LEVELS[x]!)));
    snrDb = null;
  } else {
    let pcm: Float64Array;
    let silenceLevel = 0;
    if (source === "synth") pcm = renderSynth(spec.synth, rate);
    else if (source === "kit") {
      const kit = spec.kit as typeof SAMPLE_KITS[number];
      if (!SAMPLE_KITS.includes(kit)) throw new Error(`kit must be one of ${SAMPLE_KITS.join(", ")}`);
      pcm = resamplePcm(synthesizeSample(kit, 32_000), 32_000, rate);
    } else {
      if (typeof spec.file !== "string" || !spec.file) throw new Error("file must be a host path");
      const imported = readPcmFile(spec.file, spec.file_rate as number | undefined);
      if (!imported.data.length) throw new Error("Sample contains no audio frames");
      const dc = imported.data.reduce((sum, x) => sum + x, 0) / imported.data.length;
      silenceLevel = -dc;
      for (let i = 0; i < imported.data.length; i++) imported.data[i] = imported.data[i]! - dc;
      pcm = resamplePcm(imported.data, imported.rate, rate);
    }
    const result = quantizePcm(pcm, { dither, gainDb, trim: spec.trim === true, silenceLevel });
    ({ packed: data, peak, rms, snrDb } = result);
    sampleCount = result.samples.length;
  }
  return { data, sampleCount, loop: spec.loop === true, stats: { source, rate, duration: sampleCount / rate, bytes: data.length, peak, rms, snrDb } };
}

export function sampleWav(sample: RenderedSample): Buffer {
  const wav = Buffer.alloc(44 + sample.sampleCount * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sample.stats.rate, 24); wav.writeUInt32LE(sample.stats.rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
  unpackNibbles(sample.data, sample.sampleCount).forEach((level, i) => {
    wav.writeInt16LE(Math.round(LEVELS[level]! * 32767), 44 + i * 2);
  });
  return wav;
}
