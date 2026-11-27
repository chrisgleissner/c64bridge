// WAV reading and writing, and loudness measurement and normalisation with ffmpeg.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

export const TARGET_LUFS = -16;
export const PEAK_CEILING_DBTP = -1.5;

export function ffmpeg(args, { input } = {}) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed:\n${result.stderr?.slice(-3000)}`);
  return result.stderr;
}

/** 16 bit PCM WAV as { rate, channels, samples: Int16Array }. */
export function readWav(file) {
  const bytes = fs.readFileSync(file);
  let offset = 12;
  let rate = 44100;
  let channels = 1;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      channels = bytes.readUInt16LE(offset + 10);
      rate = bytes.readUInt32LE(offset + 12);
      if (bytes.readUInt16LE(offset + 22) !== 16) throw new Error(`${file}: expected 16 bit samples`);
    }
    if (id === "data") {
      // VICE leaves the size at 0 when it cannot rewrite the header; take the rest of the file then.
      const length = size > 0 ? Math.min(size, bytes.length - offset - 8) : bytes.length - offset - 8;
      const samples = new Int16Array(length >> 1);
      for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readInt16LE(offset + 8 + i * 2);
      return { rate, channels, samples };
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error(`${file}: no data chunk`);
}

export function writeWav(file, { rate, channels, samples }) {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + samples.length * 2, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(samples.length * 2, 40);
  fs.writeFileSync(file, Buffer.concat([head, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]));
}

/** Integrated loudness (LUFS), loudness range (LU) and true peak (dBTP) according to EBU R 128. */
export function measure(file) {
  const log = ffmpeg(["-i", file, "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const summary = log.slice(log.lastIndexOf("Summary:"));
  const value = (label) => Number(new RegExp(`${label}:\\s+(-?[0-9.]+|-inf)`).exec(summary)?.[1] ?? Number.NaN);
  return { lufs: value("I"), range: value("LRA"), truePeak: value("Peak") };
}

/**
 * The filter chain that brings a recording to the target loudness. The SID output has a DC offset and sharp
 * transients, so it is first high-pass filtered at 20 Hz. The level then changes by one constant gain; only when
 * that gain would exceed the peak ceiling, a limiter holds the transients below it.
 */
export function normaliseFilter(file, { extra = [] } = {}) {
  const prepared = ["highpass=f=20", ...extra];
  const log = ffmpeg(["-i", file, "-map", "0:a", "-af", [...prepared, "ebur128=peak=true"].join(","), "-f", "null", "-"]);
  const summary = log.slice(log.lastIndexOf("Summary:"));
  const lufs = Number(/I:\s+(-?[0-9.]+)/.exec(summary)[1]);
  const peak = Number(/Peak:\s+(-?[0-9.]+)/.exec(summary)[1]);
  const gain = TARGET_LUFS - lufs;
  const limited = peak + gain > PEAK_CEILING_DBTP;
  const chain = [...prepared, `volume=${gain.toFixed(2)}dB`];
  // The limiter works on samples: run it at 4 x the rate so that peaks between samples are limited too.
  if (limited) chain.push("aresample=176400", `alimiter=limit=${(10 ** ((PEAK_CEILING_DBTP - 0.3) / 20)).toFixed(4)}:attack=2:release=60:level=false`, "aresample=44100");
  return { filter: chain.join(","), gainDb: Number(gain.toFixed(2)), limitedDb: limited ? Number((peak + gain - PEAK_CEILING_DBTP).toFixed(2)) : 0 };
}

/** RMS level in dBFS of the samples between two times in seconds. */
export function rmsDb({ rate, channels, samples }, from, to) {
  const start = Math.max(0, Math.floor(from * rate) * channels);
  const end = Math.min(samples.length, Math.ceil(to * rate) * channels);
  if (end <= start) return -Infinity;
  let sum = 0;
  let square = 0;
  for (let i = start; i < end; i += 1) {
    sum += samples[i];
    square += samples[i] * samples[i];
  }
  const n = end - start;
  const variance = Math.max(0, square / n - (sum / n) ** 2); // without the DC offset of the SID
  return 10 * Math.log10(variance / (32768 * 32768));
}

/** The time of the first sound after the silence at the start of a recording. */
export function onset(wav, threshold = -45) {
  for (let t = 0; t < wav.samples.length / wav.rate / wav.channels; t += 0.005) if (rmsDb(wav, t, t + 0.005) > threshold) return t;
  return undefined;
}
