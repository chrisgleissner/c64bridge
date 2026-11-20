import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ParsedSidwave } from "../sidwave.js";
import { arrangeSidwave, compileSidwaveToPrg, compileSidwaveToSid } from "../sidwaveCompiler.js";
import type { PanSide } from "./sidwaveFidelity.js";
import type { Stereo } from "./sidwaveSimilarity.js";

/**
 * Builds a document that keeps only the voices of SID `chip` and maps that SID to $D400, so the song can be
 * rendered by sidplayfp (at most 3 SIDs) one SID at a time. Voices are renumbered to the SID's channels 1..3
 * and the timeline layers are rekeyed the same way arrangeSidwave does per chip. Filter settings follow the
 * chip: the global filter_env belongs to the first SID only.
 *
 * The result uses the single-chip player path (version 1.1, volume 15, no per-SID filter, no turbo): the extended
 * player's PSID makes sidplayfp stop with "Illegal instruction", and the comparison does not depend on per-SID
 * volume or filter settings.
 */
export function restrictToSid(doc: ParsedSidwave, chip: number): ParsedSidwave {
  const sid = doc.sids[chip];
  if (!sid) throw new RangeError(`SID ${chip} is not declared (${doc.sids.length} SIDs)`);
  const idByChannel = new Map<number, number>();
  const voices = doc.voices.flatMap((voice) => {
    const slot = doc.voiceSlots.get(voice.id)!;
    if (Math.floor(slot / 3) !== chip) return [];
    const channel = (slot % 3) + 1;
    idByChannel.set(channel, voice.id);
    return [{ ...voice, id: channel }];
  });
  const timeline = doc.timeline.map((section) => ({
    ...section,
    layers: Object.fromEntries([...idByChannel].map(([channel, id]) => [`v${channel}`, section.layers[`v${id}`] ?? "-"])),
  }));
  const gfx = doc.song.global_fx as Record<string, unknown>;
  return {
    ...doc,
    version: "1.1",
    cpu: undefined,
    voices,
    timeline,
    sids: [{ id: sid.id, address: 0xd400, volume: 15, model: sid.model }],
    voiceSlots: new Map(voices.map(({ id }) => [id, id - 1])),
    song: { ...doc.song, global_fx: { reverb_sim: gfx.reverb_sim, filter_env: chip === 0 ? gfx.filter_env : undefined } },
  };
}

/** Pan side of each SID, from `pan` overrides, else centre. */
export function panOf(pan: Record<number, PanSide> | undefined, sid: number): PanSide {
  return pan?.[sid] ?? "center";
}

export interface RenderOptions {
  model: "6581" | "8580";
  sampleRate?: number;
  pan?: Record<number, PanSide>;
  /** Seconds to render per SID; default the song length. */
  seconds?: number;
  sidplayfp?: string;
  workDir?: string;
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
export function renderReference(doc: ParsedSidwave, options: RenderOptions): Stereo {
  const sampleRate = options.sampleRate ?? 48000;
  const bin = options.sidplayfp ?? "sidplayfp";
  const dir = options.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-ref-"));
  const arr = arrangeSidwave(doc);
  const seconds = options.seconds ?? arr.totalFrames / arr.fps;
  const renders: Array<{ pan: PanSide; samples: Float32Array }> = [];
  for (let chip = 0; chip < doc.sids.length; chip += 1) {
    const restricted = restrictToSid(doc, chip);
    const { prg } = compileSidwaveToPrg(restricted);
    const { sid } = compileSidwaveToSid(restricted, prg);
    const sidFile = path.join(dir, `sid${chip + 1}.sid`), wav = path.join(dir, `sid${chip + 1}.wav`);
    fs.writeFileSync(sidFile, sid);
    const run = spawnSync(bin, ["-m", `-m${options.model === "8580" ? "n" : "o"}f`, `-f${sampleRate}`, `-t${seconds.toFixed(3)}`, `-w${wav}`, sidFile], { encoding: "utf8" });
    if (run.error) throw new Error(`cannot run ${bin}: ${run.error.message}`);
    if (run.status !== 0 || !fs.existsSync(wav)) throw new Error(`${bin} failed for SID ${chip + 1}: ${run.stderr || run.stdout}`);
    const w = readWav(wav);
    const mono = w.channels === 1 ? w.samples : w.samples.filter((_, i) => i % w.channels === 0);
    renders.push({ pan: panOf(options.pan, chip), samples: mono });
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
  return { left, right, sampleRate: readSampleRate(dir, sampleRate) };
}

function readSampleRate(_dir: string, requested: number): number { return requested; }
