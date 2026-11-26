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

/**
 * Left and right gains of an Ultimate 64 mixer pan setting ("Left 5" .. "Center" .. "Right 5"). The firmware maps
 * the 11 settings to pan_ctrl = { 0, 40, 79, 116, 150, 181, 207, 228, 243, 253, 256 } (/256) and applies
 * pan_ctrl[10 - index] and pan_ctrl[index] to the two channels, index 0 being "Left 5" (1541ultimate
 * software/u64/u64_config.cc, U64Config::setMixer, which names the first value vol_right). On the device a "Left 5"
 * SID is absent on the right channel (data/ultimate/multisid.md), so pan_ctrl[10 - index] is the left gain.
 * Returns undefined for any other text.
 */
export function panGains(setting: string | undefined): [number, number] | undefined {
  const PAN_CTRL = [0, 40, 79, 116, 150, 181, 207, 228, 243, 253, 256];
  const m = /^(?:(Left|Right) ([1-5])|Center)$/.exec(setting?.trim() ?? "");
  if (!m) return undefined;
  const index = m[1] === "Left" ? 5 - Number(m[2]) : m[1] === "Right" ? 5 + Number(m[2]) : 5;
  return [PAN_CTRL[10 - index]! / 256, PAN_CTRL[index]! / 256];
}

export interface RenderOptions {
  model: "6581" | "8580";
  /** Use each SID's declared model instead of forcing `model` across all stems. */
  useScoreModels?: boolean;
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
 * support is not needed), with the SID model forced, and mixes the renders into a stereo reference. A SID's mixer pan
 * setting is applied with the Ultimate 64 pan law (panGains); an explicit `pan` side mixes at unit gain to the left
 * or right channel, or to both at 1/sqrt(2).
 */
export function renderReference(doc: ParsedSidwave, options: RenderOptions): Stereo & { warnings: string[] } {
  const warnings = doc.samples
    ? ["The sidplayfp reference omits CIA2 NMI digi samples. Use a VICE PRG capture to listen to the sample parts."]
    : [];
  const sampleRate = options.sampleRate ?? 48000;
  const bin = options.sidplayfp ?? "sidplayfp";
  const dir = options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-ref-"));
  const arr = options.arrangement ?? arrangeSidwave(doc);
  // sidplayfp's -t parser accepts whole seconds and truncates decimal values, which can cut the final score frames.
  const seconds = Math.ceil(options.seconds ?? arr.totalFrames / arr.fps);
  const renders: Array<{ gains: [number, number]; samples: Float32Array }> = [];
  try {
    for (let chip = 0; chip < doc.sids.length; chip += 1) {
      const sid = compileSidwaveStem(doc, arr, chip);
      const sidFile = path.join(dir, `sid${chip + 1}.sid`), wav = path.join(dir, `sid${chip + 1}.wav`);
      fs.writeFileSync(sidFile, sid);
      const model = options.useScoreModels ? doc.sids[chip]?.model ?? options.model : options.model;
      const run = spawnSync(bin, ["-m", `-m${model === "8580" ? "n" : "o"}f`, `-f${sampleRate}`, `-t${seconds}`, `-w${wav}`, sidFile], { encoding: "utf8" });
      if (run.error) throw new Error(`cannot run ${bin}: ${run.error.message}`);
      if (run.status !== 0 || !fs.existsSync(wav)) throw new Error(`${bin} failed for SID ${chip + 1}: ${run.stderr || run.stdout}`);
      const w = readWav(wav);
      const mono = w.channels === 1 ? w.samples : w.samples.filter((_, i) => i % w.channels === 0);
      // An explicit `pan` side wins; otherwise the SID's mixer setting is applied with the firmware pan law.
      const side = options.pan?.[chip];
      const gains = side === undefined ? panGains(doc.sids[chip]?.pan) : undefined;
      const sideGains = (p: PanSide): [number, number] => p === "left" ? [1, 0] : p === "right" ? [0, 1] : [Math.SQRT1_2, Math.SQRT1_2];
      renders.push({ gains: gains ?? sideGains(panOf(options.pan, chip, doc.sids[chip]?.pan)), samples: mono });
    }
  } finally {
    if (!options.workDir) fs.rmSync(dir, { recursive: true, force: true });
  }
  const length = Math.max(...renders.map((r) => r.samples.length));
  const left = new Float32Array(length), right = new Float32Array(length);
  for (const r of renders) {
    const [gl, gr] = r.gains;
    for (let i = 0; i < r.samples.length; i += 1) { left[i] += r.samples[i]! * gl; right[i] += r.samples[i]! * gr; }
  }
  // Keep the mix inside full scale without changing balance.
  let peak = 0;
  for (let i = 0; i < length; i += 1) peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
  if (peak > 1) for (let i = 0; i < length; i += 1) { left[i] /= peak; right[i] /= peak; }
  return { left, right, sampleRate, warnings };
}
