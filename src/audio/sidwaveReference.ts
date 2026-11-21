import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ParsedSidwave } from "../sidwave.js";
import { arrangeSidwave, compileSidwaveStem, projectSidwaveStem, type Arrangement } from "../sidwaveCompiler.js";
import type { PanSide } from "./sidwaveFidelity.js";
import type { Stereo } from "./sidwaveSimilarity.js";

/** Restrict the resolved note streams, including cross-SID copies, to one SID. */
export function restrictToSid(doc: ParsedSidwave, chip: number, arrangement = arrangeSidwave(doc)): Arrangement {
  return projectSidwaveStem(doc, arrangement, chip);
}

/** Pan side of each SID, from `pan` overrides, else centre. */
export function panOf(pan: Record<number, PanSide> | undefined, sid: number, setting?: string): PanSide {
  return pan?.[sid] ?? (setting?.startsWith("Left") ? "left" : setting?.startsWith("Right") ? "right" : "center");
}

export interface RenderOptions {
  model: "6581" | "8580";
  sampleRate?: number;
  pan?: Record<number, PanSide>;
  /** Seconds to render per SID; default the song length. */
  seconds?: number;
  sidplayfp?: string;
  workDir?: string;
  arrangement?: Arrangement;
}

export function readWav(file: string): { samples: Float32Array; channels: number; sampleRate: number } {
  const buf = fs.readFileSync(file);
  let pos = 12, channels = 1, sampleRate = 44100, bits = 16;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4), size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") { channels = buf.readUInt16LE(pos + 10); sampleRate = buf.readUInt32LE(pos + 12); bits = buf.readUInt16LE(pos + 22); }
    if (id === "data") {
      if (bits !== 16) throw new Error(`unsupported WAV sample size ${bits}`);
      const n = Math.floor(Math.min(size, buf.length - pos - 8) / 2);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i += 1) samples[i] = buf.readInt16LE(pos + 8 + 2 * i) / 32768;
      return { samples, channels, sampleRate };
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${file}`);
}

/**
 * Renders the song with sidplayfp, one PSID per SID (so songs with more than three SIDs work and 2SID/3SID PSID
 * support is not needed), with the SID model forced, and mixes the renders into a stereo reference using each
 * SID's pan side. Mono renders are mixed at unit gain to the left, right, or both channels at 1/sqrt(2).
 */
export function renderReference(doc: ParsedSidwave, options: RenderOptions): Stereo & { warnings: string[] } {
  const warnings = doc.samples
    ? ["The sidplayfp reference omits CIA2 NMI digi samples. Use a VICE PRG capture to listen to the sample parts."]
    : [];
  const sampleRate = options.sampleRate ?? 48000;
  const bin = options.sidplayfp ?? "sidplayfp";
  const dir = options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-ref-"));
  const arr = options.arrangement ?? arrangeSidwave(doc);
  const seconds = options.seconds ?? arr.totalFrames / arr.fps;
  const renders: Array<{ pan: PanSide; samples: Float32Array }> = [];
  try {
    for (let chip = 0; chip < doc.sids.length; chip += 1) {
      const sid = compileSidwaveStem(doc, arr, chip);
      const sidFile = path.join(dir, `sid${chip + 1}.sid`), wav = path.join(dir, `sid${chip + 1}.wav`);
      fs.writeFileSync(sidFile, sid);
      const run = spawnSync(bin, ["-m", `-m${options.model === "8580" ? "n" : "o"}f`, `-f${sampleRate}`, `-t${seconds.toFixed(3)}`, `-w${wav}`, sidFile], { encoding: "utf8" });
      if (run.error) throw new Error(`cannot run ${bin}: ${run.error.message}`);
      if (run.status !== 0 || !fs.existsSync(wav)) throw new Error(`${bin} failed for SID ${chip + 1}: ${run.stderr || run.stdout}`);
      const w = readWav(wav);
      const mono = w.channels === 1 ? w.samples : w.samples.filter((_, i) => i % w.channels === 0);
      renders.push({ pan: panOf(options.pan, chip, doc.sids[chip]?.pan), samples: mono });
    }
  } finally {
    if (!options.workDir) fs.rmSync(dir, { recursive: true, force: true });
  }
  const length = Math.max(...renders.map((r) => r.samples.length));
  const left = new Float32Array(length), right = new Float32Array(length);
  const c = Math.SQRT1_2;
  for (const r of renders) {
    const gl = r.pan === "left" ? 1 : r.pan === "right" ? 0 : c, gr = r.pan === "right" ? 1 : r.pan === "left" ? 0 : c;
    for (let i = 0; i < r.samples.length; i += 1) { left[i] += r.samples[i]! * gl; right[i] += r.samples[i]! * gr; }
  }
  // Keep the mix inside full scale without changing balance.
  let peak = 0;
  for (let i = 0; i < length; i += 1) peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
  if (peak > 1) for (let i = 0; i < length; i += 1) { left[i] /= peak; right[i] /= peak; }
  return { left, right, sampleRate, warnings };
}
