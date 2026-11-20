/*
C64 Bridge - SIDWAVE Parser and Types
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { Buffer } from 'node:buffer';
import pkg from 'yaml';
const { parse: yamlParse } = pkg;

export type SystemMode = "PAL" | "NTSC";

export interface SidwaveSongMeta {
  title?: string;
  author?: string;
  tempo?: number; // BPM
  mode?: SystemMode;
  length_bars?: number;
  global_fx?: Record<string, unknown>;
}

export type Waveform = "pulse" | "sawtooth" | "saw" | "triangle" | "tri" | "noise";

export interface SidwavePatternCommon {
  /** Duration of each entry in beats (quarter notes). Defaults to 1. */
  length?: number;
  /** Semitone transposition applied to successive repetitions of the pattern within a section. */
  transpositions?: number[];
  fx?: Record<string, unknown>;
}

export interface SidwavePatternArp extends SidwavePatternCommon {
  type?: "arpeggio";
  notes: string[];
  /** Frames per arpeggio note. When set, the notes are cycled as a fast chord arpeggio. */
  frame_rate?: number;
}

export interface SidwavePatternMotif extends SidwavePatternCommon {
  motif?: string;
  /** Reference note for integer motif tokens and the octave of chord symbols. Defaults to C3. */
  root?: string;
}

export interface SidwavePatternGroove extends SidwavePatternCommon {
  groove: Array<string | SidwaveGrooveNote | SidwaveChord>;
}

export interface SidwaveGrooveNote {
  note: string;
  inst?: string;
  len?: number;
  legato?: boolean;
  portamento?: number;
  slide_from?: string;
  bend?: { to: string | number; frames: number };
  gate_off?: number;
}

export interface SidwaveChord {
  chord: string;
  arp?: string;
  speed?: number;
  inst?: string;
  len?: number;
}

export interface SidwaveEcho {
  voice: number;
  delay: number;
  volume: number;
  detune?: number;
}

export interface SidwaveUnison {
  voice: number;
  detune: number;
}

export interface SidwaveSampleSource {
  sid: string | number;
  at: number[];
  hex?: string;
  base64?: string;
  kit?: "kick" | "snare" | "clap";
}

export interface SidwaveSamples {
  rate: number;
  voices: Array<{ chip: number; at: number[]; data: Uint8Array }>;
}

export interface SidwavePatternDrums extends SidwavePatternCommon {
  drums: { kit: Record<string, string>; steps: string };
}

export type SidwavePattern = SidwavePatternDrums | SidwavePatternArp | SidwavePatternMotif | SidwavePatternGroove;

export interface SidwaveVoice {
  id: number; // 1..30
  name?: string;
  waveform?: Waveform;
  detune?: number;
  pulse_width?: number;
  adsr?: [number, number, number, number];
  instrument?: string;
  echo?: SidwaveEcho;
  unison?: SidwaveUnison;
  patterns?: Record<string, SidwavePattern>;
}

export interface SidwaveTimelineSection {
  section?: string;
  bars: number;
  tempo?: number;
  swing?: number;
  layers: Record<string, string>;
}

type SidModel = "6581" | "8580";
interface SidFilter {
  filter_env?: Record<string, unknown>;
  filter_mod?: FilterModSpec;
}

interface SidMapEntry {
  id: string;
  address: number;
  volume: number;
  pan?: string;
  model?: SidModel;
  filter?: SidFilter;
}

type SidLayout = "ultisid8" | "ultisid8+socket1" | "ultisid8+sockets";
type SidVoiceFields = Omit<SidwaveVoice, "id">;
type SidVoiceSource = SidVoiceFields & (
  { id: number; sid?: never; channel?: never } |
  { id?: number; sid: string | number; channel: number }
);

export interface SidwaveDocument {
  sidwave?: number | string;
  title?: string;
  author?: string;
  tempo?: number;
  mode?: SystemMode;
  length_bars?: number;
  global_fx?: Record<string, unknown>;
  speed?: number;
  meter?: 3 | 4;
  cpu?: "turbo";
  samples?: { rate: number; voices: SidwaveSampleSource[] };
  sids?: Array<{
    id: string | number;
    address: string;
    pan?: string;
    model?: SidModel;
    volume?: number;
    filter?: Record<string, unknown>;
  }> | { layout: SidLayout; overrides?: Record<string, { pan?: string; volume?: number }> };
  instruments?: Record<string, Record<string, unknown>>;
  voices?: SidVoiceSource[];
  timeline?: SidwaveTimelineSection[];
  // Legacy CPG compatibility
  song?: {
    title?: string;
    author?: string;
    tempo?: number;
    mode?: SystemMode;
    length_bars?: number;
    global_fx?: Record<string, unknown>;
  };
}

export interface ParsedSidwave {
  version: "1.0" | "1.1" | "1.2";
  song: Required<Pick<SidwaveSongMeta, "title" | "tempo" | "mode">> & {
    author?: string;
    length_bars: number;
    meter: 3 | 4;
    global_fx: Record<string, unknown>;
  };
  voices: SidwaveVoice[];
  instruments: Record<string, Record<string, any>>;
  speed: number;
  cpu?: "turbo";
  sids: SidMapEntry[];
  samples?: SidwaveSamples;
  /** Zero based physical voice slot for each declared voice ID. */
  voiceSlots: Map<number, number>;
  timeline: SidwaveTimelineSection[];
}

/** Raised for SIDWAVE documents that cannot be played as written. The message names the offending path. */
export class SidwaveValidationError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`Invalid SIDWAVE at ${path}: ${detail}`);
    this.name = "SidwaveValidationError";
  }
}

export const SIDWAVE_TEMPO_RANGE = { min: 30, max: 220 } as const;
/** MIDI numbers of C0 and B7, the note range of the player's frequency table. */
export const SIDWAVE_NOTE_RANGE = { min: 12, max: 107 } as const;

const TOP_LEVEL_KEYS = new Set(["sidwave", "title", "author", "tempo", "mode", "length_bars", "global_fx", "voices", "timeline", "instruments", "speed", "meter", "sids", "cpu", "samples"]);
const LEGACY_KEYS = new Set(["song", "voices", "timeline"]);
const LEGACY_SONG_KEYS = new Set(["title", "author", "tempo", "mode", "length_bars", "global_fx"]);
const VOICE_KEYS = new Set(["id", "sid", "channel", "name", "waveform", "pulse_width", "adsr", "patterns", "instrument", "echo", "unison", "detune"]);
const ARP_KEYS = new Set(["type", "notes", "frame_rate", "length", "transpositions", "fx"]);
const GROOVE_KEYS = new Set(["groove", "drums", "length", "transpositions", "fx"]);
const MOTIF_KEYS = new Set(["motif", "root", "length", "transpositions", "fx"]);
/** Upper bound for bars per section, summed timeline bars and length_bars; keeps arranging well under a second. */
const MAX_SIDWAVE_BARS = 4096;
const SECTION_KEYS = new Set(["section", "bars", "layers", "tempo", "swing"]);
const PATTERN_FX_KEYS = new Set(["vibrato", "pwm_sweep", "slide", "filter_mod"]);
const GLOBAL_FX_KEYS = new Set(["reverb_sim", "filter_env"]);
const WAVEFORMS = new Set(["pulse", "sawtooth", "saw", "triangle", "tri", "noise"]);

export function parseSidwave(input: string | object): ParsedSidwave {
  let obj: any;
  if (typeof input === "string") {
    try {
      obj = yamlParse(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = /BLOCK_IN_FLOW|Block collections are not allowed within flow/.test(message)
        ? " A bare '-' inside a flow map such as '{ v2: - }' is YAML list syntax; quote it as '\"-\"'."
        : "";
      throw new SidwaveValidationError("$", `YAML/JSON could not be parsed: ${message.split("\n")[0]}.${hint}`);
    }
  } else {
    obj = input;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new SidwaveValidationError("$", "expected a mapping with voices and timeline");
  }

  // Detect legacy CPG shape (song: {...}) vs SIDWAVE top-level fields.
  const legacy = obj.song !== undefined;
  if (legacy) {
    checkKeys(obj, LEGACY_KEYS, "$", "legacy documents with a 'song' block may only contain song, voices and timeline");
    if (!isPlainObject(obj.song)) throw new SidwaveValidationError("$.song", "expected a mapping");
    checkKeys(obj.song, LEGACY_SONG_KEYS, "$.song");
  } else {
    checkKeys(obj, TOP_LEVEL_KEYS, "$");
    if (obj.sidwave !== undefined && !["1", "1.0", "1.1", "1.2"].includes(String(obj.sidwave))) {
      throw new SidwaveValidationError("$.sidwave", `unsupported version ${JSON.stringify(obj.sidwave)}; use 1.0, 1.1 or 1.2`);
    }
  }
  const modern = obj.sidwave === 1.2 || obj.sidwave === "1.2";
  const header = (legacy ? obj.song : obj) as Record<string, unknown>;
  const headerPath = legacy ? "$.song" : "$";

  const title = header.title === undefined ? "Untitled" : String(header.title);
  const author = header.author === undefined ? undefined : String(header.author);
  const tempo = parseTempo(header.tempo, `${headerPath}.tempo`);
  const mode = parseMode(header.mode, `${headerPath}.mode`);
  const global_fx = parseGlobalFx(header.global_fx, `${headerPath}.global_fx`);

  if (!Array.isArray(obj.voices) || (obj.voices.length === 0 && obj.samples === undefined)) {
    throw new SidwaveValidationError("$.voices", "missing voices (expected a list of 1 to 30 voices)");
  }
  const sids = normalizeSids(obj.sids);
  const samples = normalizeSamples(obj.samples, sids, modern);
  const capacity = sids.length * 3;
  if (obj.voices.length > capacity) {
    throw new SidwaveValidationError("$.voices", `the SID${sids.length > 1 ? " map" : ""} has ${capacity} voices; ${obj.voices.length} were given`);
  }
  const instruments = normalizeInstruments(obj.instruments, "$.instruments", modern);
  const voiceSlots = new Map<number, number>();
  const occupied = new Set<number>();
  const voices: SidwaveVoice[] = obj.voices.map((raw: unknown, i: number) => {
    const path = `$.voices[${i}]`;
    if (!isPlainObject(raw)) throw new SidwaveValidationError(path, "expected a voice mapping");
    checkKeys(raw, VOICE_KEYS, path);
    let slot: number | undefined;
    if (raw.sid !== undefined || raw.channel !== undefined) {
      const chip = sids.findIndex((sid) => sid.id === String(raw.sid));
      if ((typeof raw.sid !== "string" && !Number.isSafeInteger(raw.sid)) || chip < 0) throw new SidwaveValidationError(`${path}.sid`, "references an unknown SID");
      slot = chip * 3 + requireNumber(raw.channel, `${path}.channel`, { min: 1, max: 3, integer: true }) - 1;
    }
    const id = raw.id === undefined && slot !== undefined ? slot + 1
      : requireNumber(raw.id, `${path}.id`, { min: 1, max: 30, integer: true });
    slot ??= id - 1;
    if (slot >= capacity) throw new SidwaveValidationError(`${path}.id`, `voice ${id} requires SID ${Math.ceil(id / 3)}, which is outside the SID map`);
    if (voiceSlots.has(id)) throw new SidwaveValidationError(`${path}.id`, `voice id ${id} is declared more than once`);
    if (occupied.has(slot)) throw new SidwaveValidationError(path, "the SID channel is assigned to more than one voice");
    voiceSlots.set(id, slot);
    occupied.add(slot);
    const voice = normalizeVoice(raw, path, id, modern);
    const name = voice.instrument;
    if (name && !name.startsWith("lib:") && !instruments[name]) {
      throw new SidwaveValidationError(`${path}.instrument`, `instrument ${JSON.stringify(name)} is not defined`);
    }
    return voice;
  });

  if (!Array.isArray(obj.timeline) || obj.timeline.length === 0) {
    throw new SidwaveValidationError("$.timeline", "missing timeline (expected a list of sections)");
  }
  const timeline = obj.timeline.map((t: unknown, i: number) => normalizeTimelineSection(t, `$.timeline[${i}]`, voices));

  const timelineBars = timeline.reduce((sum: number, s: SidwaveTimelineSection) => sum + s.bars, 0);
  if (timelineBars > MAX_SIDWAVE_BARS) {
    throw new SidwaveValidationError("$.timeline", `the sections add up to ${timelineBars} bars, above the maximum ${MAX_SIDWAVE_BARS}`);
  }
  let length_bars = timelineBars;
  if (header.length_bars !== undefined) {
    length_bars = requireNumber(header.length_bars, `${headerPath}.length_bars`, { min: 1, max: MAX_SIDWAVE_BARS, integer: true });
  }

  const meter = obj.meter === undefined ? 4 : requireNumber(obj.meter, "$.meter", { min: 3, max: 4, integer: true }) as 3 | 4;
  if (meter !== 4 && !modern) throw new SidwaveValidationError("$.meter", "3/4 requires sidwave: 1.2");
  const song: ParsedSidwave["song"] = { title, tempo, mode, length_bars, meter, global_fx };
  if (author !== undefined) song.author = author;
  const speed = obj.speed === undefined ? 1 : requireNumber(obj.speed, "$.speed", { min: 1, max: 4, integer: true });
  if (obj.cpu !== undefined && obj.cpu !== "turbo") throw new SidwaveValidationError("$.cpu", "expected turbo");
  const declaredVersion = String(obj.sidwave);
  const version = declaredVersion === "1.1" || declaredVersion === "1.2" ? declaredVersion : "1.0";
  return { version, song, voices, timeline, instruments, speed, sids, samples, voiceSlots, cpu: obj.cpu };
}

// data/ultimate/multisid.md, Owner configurations.
const ULTISID8 = [0xd400, 0xd480, 0xd500, 0xd580, 0xd420, 0xd4a0, 0xd520, 0xd5a0];
const SID_LAYOUTS: Record<SidLayout, number[]> = {
  ultisid8: ULTISID8,
  "ultisid8+socket1": [...ULTISID8, 0xd440],
  "ultisid8+sockets": [...ULTISID8, 0xd440, 0xd460],
};

function normalizeSids(raw: unknown): SidMapEntry[] {
  if (raw === undefined) return [{ id: "sid1", address: 0xd400, volume: 15 }];
  if (!Array.isArray(raw)) {
    const value = requireObject(raw, "$.sids", ["layout", "overrides"]);
    if (typeof value.layout !== "string" || !Object.prototype.hasOwnProperty.call(SID_LAYOUTS, value.layout)) {
      throw new SidwaveValidationError("$.sids.layout", "expected ultisid8, ultisid8+socket1 or ultisid8+sockets");
    }
    const entries = SID_LAYOUTS[value.layout as SidLayout].map((address, i) => ({ id: `sid${i + 1}`, address, volume: 15 }));
    if (value.overrides === undefined) return entries;
    if (!isPlainObject(value.overrides)) throw new SidwaveValidationError("$.sids.overrides", "expected a mapping of layout SID IDs");
    checkKeys(value.overrides, new Set(entries.map(({ id }) => id)), "$.sids.overrides");
    return entries.map((entry) => {
      const path = `$.sids.overrides.${entry.id}`;
      if (value.overrides[entry.id] === undefined) return entry;
      return { ...entry, ...parseSidMix(requireObject(value.overrides[entry.id], path, ["volume", "pan"]), path) };
    });
  }
  if (raw.length < 1 || raw.length > 10) throw new SidwaveValidationError("$.sids", "expected 1..10 SIDs");
  const addresses = new Set<number>();
  const ids = new Set<string>();
  return raw.map((entry, i) => {
    const path = `$.sids[${i}]`;
    const sid = requireObject(entry, path, ["id", "address", "model", "volume", "filter", "pan"]);
    const id = typeof sid.id === "number" && Number.isSafeInteger(sid.id) ? String(sid.id) : sid.id;
    if (typeof id !== "string" || !id.trim()) throw new SidwaveValidationError(`${path}.id`, "expected a non-empty string or integer SID identifier");
    if (ids.has(id)) throw new SidwaveValidationError(`${path}.id`, "SID id is duplicated");
    ids.add(id);
    if (typeof sid.address !== "string" || !/^\$D[4-7][02468ACE]0$/i.test(sid.address)) {
      throw new SidwaveValidationError(`${path}.address`, "use a SID address in $D400..$D7E0 on $20 steps; $DE00..$DFFF is unavailable");
    }
    const address = Number.parseInt(sid.address.slice(1), 16);
    if (addresses.has(address)) throw new SidwaveValidationError(`${path}.address`, "SID address is duplicated");
    addresses.add(address);
    if (sid.model !== undefined && sid.model !== "6581" && sid.model !== "8580") {
      throw new SidwaveValidationError(`${path}.model`, 'expected "6581" or "8580"');
    }
    let filter: SidFilter | undefined;
    if (sid.filter !== undefined) {
      const fp = `${path}.filter`;
      if (!isPlainObject(sid.filter)) throw new SidwaveValidationError(fp, "expected a mapping");
      const value = sid.filter;
      if (value.cutoff_base !== undefined) {
        filter = { filter_env: parseFilterEnv(value, fp) };
      } else {
        checkKeys(value, new Set(["filter_env", "filter_mod"]), fp);
        filter = {
          filter_env: value.filter_env === undefined ? undefined : parseFilterEnv(value.filter_env, `${fp}.filter_env`),
          filter_mod: value.filter_mod === undefined ? undefined : parseFilterMod(value.filter_mod, `${fp}.filter_mod`),
        };
      }
    }
    return { id, address, model: sid.model, filter, ...parseSidMix(sid, path) };
  });
}

function parseSidMix(sid: Record<string, unknown>, path: string): { volume: number; pan?: string } {
  const volume = sid.volume === undefined ? 15 : requireNumber(sid.volume, `${path}.volume`, { min: 0, max: 15, integer: true });
  const pan = sid.pan;
  if (pan !== undefined && (typeof pan !== "string" || !/^(?:Center|(?:Left|Right) [1-5])$/.test(pan))) {
    throw new SidwaveValidationError(`${path}.pan`, "use Center, Left 1 through Left 5, or Right 1 through Right 5");
  }
  return { volume, pan };
}

function normalizeSamples(raw: unknown, sids: SidMapEntry[], modern: boolean): SidwaveSamples | undefined {
  if (raw === undefined) return;
  if (!modern) throw new SidwaveValidationError("$.samples", "samples require sidwave: 1.2");
  const root = requireObject(raw, "$.samples", ["rate", "voices"]);
  const rate = requireNumber(root.rate, "$.samples.rate", { min: 16, max: 8000, integer: true });
  if (!Array.isArray(root.voices) || root.voices.length < 1 || root.voices.length > 255) {
    throw new SidwaveValidationError("$.samples.voices", "expected 1..255 scheduled samples");
  }
  const occupied = new Set<string>();
  let totalBytes = 0;
  const voices = root.voices.map((raw: unknown, i: number) => {
    const path = `$.samples.voices[${i}]`;
    const sample = requireObject(raw, path, ["sid", "at", "hex", "base64", "kit"]);
    const chip = sids.findIndex((sid) => sid.id === String(sample.sid));
    if ((typeof sample.sid !== "string" && !Number.isSafeInteger(sample.sid)) || chip < 0) {
      throw new SidwaveValidationError(`${path}.sid`, "references an unknown SID");
    }
    if (!Array.isArray(sample.at) || !sample.at.length || sample.at.length > 20000) {
      throw new SidwaveValidationError(`${path}.at`, "expected 1..20000 player frame offsets");
    }
    const at = sample.at.map((raw: unknown, j: number) => {
      const frame = requireNumber(raw, `${path}.at[${j}]`, { min: 0, max: 0xffffff, integer: true });
      const key = `${chip}:${frame}`;
      if (occupied.has(key)) throw new SidwaveValidationError(`${path}.at[${j}]`, "this SID already has a sample scheduled on this frame");
      occupied.add(key);
      return frame;
    });
    if (["hex", "base64", "kit"].filter((key) => sample[key] !== undefined).length !== 1) {
      throw new SidwaveValidationError(path, "provide exactly one of hex, base64 or kit");
    }
    let data: Uint8Array;
    if (sample.hex !== undefined) {
      const hex = typeof sample.hex === "string" ? sample.hex.replace(/\s/g, "") : "";
      if (!/^[0-9a-f]+$/i.test(hex)) throw new SidwaveValidationError(`${path}.hex`, "expected hexadecimal sample nibbles");
      if (hex.length > 0xc800) throw new SidwaveValidationError(path, "sample data exceeds the $D000 limit");
      data = Uint8Array.from(hex, (n) => Number.parseInt(n, 16));
    } else if (sample.base64 !== undefined) {
      const encoded = sample.base64;
      if (typeof encoded !== "string" || !encoded.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        throw new SidwaveValidationError(`${path}.base64`, "expected base64-encoded bytes with two nibbles per byte");
      }
      if (encoded.length > 0xc800) throw new SidwaveValidationError(path, "sample data exceeds the $D000 limit");
      const packed = Buffer.from(encoded, "base64");
      data = new Uint8Array(packed.length * 2);
      packed.forEach((byte, j) => { data[j * 2] = byte >>> 4; data[j * 2 + 1] = byte & 15; });
    } else {
      const kit = sample.kit;
      if (kit !== "kick" && kit !== "snare" && kit !== "clap") {
        throw new SidwaveValidationError(`${path}.kit`, "expected kick, snare or clap");
      }
      data = synthesizeSample(kit, rate);
    }
    totalBytes += data.length;
    if (totalBytes > 0xc800) throw new SidwaveValidationError("$.samples", "sample data exceeds the $D000 limit");
    return { chip, at, data };
  });
  return { rate, voices };
}

function synthesizeSample(kit: "kick" | "snare" | "clap", rate: number): Uint8Array {
  let noise = 0x5e71;
  let phase = 0;
  const seconds = kit === "kick" ? 0.17 : kit === "snare" ? 0.14 : 0.11;
  return Uint8Array.from({ length: Math.ceil(seconds * rate) }, (_, index) => {
    const t = index / rate;
    noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
    const random = noise / 0x80000000 - 1;
    phase += (kit === "kick" ? 45 + 155 * Math.exp(-t * 42) : 172) / rate;
    const osc = Math.sin(phase * 2 * Math.PI);
    const clap = Math.exp(-t * 160) +
      (t >= 0.012 ? Math.exp(-(t - 0.012) * 140) : 0) +
      (t >= 0.026 ? Math.exp(-(t - 0.026) * 65) : 0);
    const signal = kit === "kick" ? osc * Math.exp(-t * 23) :
      kit === "snare" ? (0.76 * random + 0.24 * osc) * Math.exp(-t * 28) : random * clap;
    return Math.round(7.5 + 7.5 * Math.max(-1, Math.min(1, signal)));
  });
}

function normalizeInstruments(raw: unknown, path: string, modern: boolean): Record<string, Record<string, any>> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) throw new SidwaveValidationError(path, "expected a mapping of instrument names to instruments");
  const result: Record<string, Record<string, any>> = {};
  const fields = new Set(["waveform", "wave", "adsr", "pulse_width", "hard_restart", "wavetable", "loop", "pulsetable", "filtertable", "vibrato", "slide", "portamento", "legato", "ring", "sync"]);
  for (const [name, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) throw new SidwaveValidationError(`${path}.${name}`, "expected an instrument mapping");
    checkKeys(value, fields, `${path}.${name}`);
    const inst = { ...(value as Record<string, any>) };
    if (inst.legato !== undefined && typeof inst.legato !== "boolean") throw new SidwaveValidationError(`${path}.${name}.legato`, "expected a boolean");
    if (inst.portamento !== undefined) inst.portamento = requireNumber(inst.portamento, `${path}.${name}.portamento`, { min: 0, max: 255, integer: true });
    if (inst.adsr !== undefined && (!Array.isArray(inst.adsr) || inst.adsr.length !== 4)) throw new SidwaveValidationError(`${path}.${name}.adsr`, "expected [attack, decay, sustain, release]");
    if (inst.wavetable !== undefined && !Array.isArray(inst.wavetable)) throw new SidwaveValidationError(`${path}.${name}.wavetable`, "expected a list of steps");
    if (inst.wavetable !== undefined) {
      if (!inst.wavetable.length) throw new SidwaveValidationError(`${path}.${name}.wavetable`, "expected at least one step");
      const waves = new Set(["tri", "saw", "pulse", "noise", "tri+pulse", "saw+pulse", "tri+saw", "tri+saw+pulse"]);
      inst.wavetable = inst.wavetable.map((step: any, i: number) => {
        const sp = `${path}.${name}.wavetable[${i}]`;
        if (!isPlainObject(step)) throw new SidwaveValidationError(sp, "expected a step mapping");
        checkKeys(step, new Set(["wave", "test", "gate", "ring", "sync", "note", "frames"]), sp);
        if (step.wave !== undefined && !waves.has(String(step.wave))) throw new SidwaveValidationError(`${sp}.wave`, "unknown wavetable waveform");
        for (const flag of ["test", "gate", "ring", "sync"]) if (step[flag] !== undefined && typeof step[flag] !== "boolean") throw new SidwaveValidationError(`${sp}.${flag}`, "expected a boolean");
        if (step.frames !== undefined) requireNumber(step.frames, `${sp}.frames`, { min: 1, max: 255, integer: true });
        if (step.note !== undefined && !( /^[+-]\d+$/.test(String(step.note)) || /^[A-Ga-g][#b]?[0-7]$/.test(String(step.note)))) throw new SidwaveValidationError(`${sp}.note`, "expected relative semitones such as +12 or an absolute note such as C5");
        return { ...step, frames: step.frames ?? 1, gate: step.gate ?? true };
      });
      if (inst.loop !== undefined) requireNumber(inst.loop, `${path}.${name}.loop`, { min: 0, max: inst.wavetable.length - 1, integer: true });
    }
    const ip = `${path}.${name}`;
    if (modern && inst.hard_restart !== undefined) {
      const hp = `${ip}.hard_restart`;
      const restart = requireObject(inst.hard_restart, hp, ["frames", "adsr", "test"]);
      const frames = requireNumber(restart.frames, `${hp}.frames`, { min: 0, max: 255, integer: true });
      if (restart.test !== undefined && typeof restart.test !== "boolean") throw new SidwaveValidationError(`${hp}.test`, "expected a boolean");
      if (!frames && (restart.test || restart.adsr !== undefined)) throw new SidwaveValidationError(hp, "zero frames disables the restart and cannot set ADSR or TEST");
      let adsr = [0, 0, 0, 0];
      if (restart.adsr !== undefined) {
        if (!Array.isArray(restart.adsr) || restart.adsr.length !== 4) throw new SidwaveValidationError(`${hp}.adsr`, "expected [attack, decay, sustain, release]");
        adsr = restart.adsr.map((value: unknown, i: number) =>
          requireNumber(value, `${hp}.adsr[${i}]`, { min: 0, max: 15, integer: true }));
      }
      inst.hard_restart = { frames, adsr, test: restart.test === true };
    }
    if (inst.pulsetable !== undefined) inst.pulsetable = normalizeRegisterTable(inst.pulsetable, inst.loop, `${ip}.pulsetable`, "set");
    if (inst.filtertable !== undefined) inst.filtertable = normalizeRegisterTable(inst.filtertable, inst.loop, `${ip}.filtertable`, "cutoff");
    result[name] = inst;
  }
  return result;
}

const SIDWAVE_FILTER_TABLE_TYPES = {
  lowpass: 0x10,
  bandpass: 0x20,
  highpass: 0x40,
  "lowpass+highpass": 0x50,
  "bandpass+highpass": 0x60,
  all: 0x70,
} as const;

export interface SidwaveRegisterTable {
  steps: Array<{ value: number; add: boolean; frames: number; resonance?: number; type?: number }>;
  loop?: number;
}

function normalizeRegisterTable(
  raw: unknown, instrumentLoop: unknown, path: string, setKey: "set" | "cutoff",
): SidwaveRegisterTable {
  const mapped = isPlainObject(raw);
  if (mapped) checkKeys(raw, new Set(["steps", "loop"]), path);
  const list = mapped ? raw.steps : raw;
  const stepPath = mapped ? `${path}.steps` : path;
  if (!Array.isArray(list) || list.length < 1 || list.length > 255) {
    throw new SidwaveValidationError(stepPath, "expected a list of 1..255 steps");
  }
  const loopValue = mapped ? raw.loop : instrumentLoop;
  const loop = loopValue === undefined ? undefined : requireNumber(
    loopValue, mapped ? `${path}.loop` : path.replace(/[^.]+$/, "loop"), { min: 0, max: list.length - 1, integer: true },
  );
  const filter = setKey === "cutoff";
  const keys = new Set([setKey, "add", "frames", ...(filter ? ["resonance", "type"] : [])]);
  const steps = list.map((step, i) => {
    const sp = `${stepPath}[${i}]`;
    if (!isPlainObject(step)) throw new SidwaveValidationError(sp, "expected a step mapping");
    checkKeys(step, keys, sp);
    const add = step[setKey] === undefined;
    if (add === (step.add === undefined)) throw new SidwaveValidationError(sp, `expected exactly one of ${setKey} or add`);
    const frames = step.frames === undefined && !(add && !filter) ? 1
      : requireNumber(step.frames, `${sp}.frames`, { min: 1, max: 255, integer: true });
    let value: number;
    if (add) {
      value = requireNumber(step.add, `${sp}.add`, { min: -2048, max: 2047, integer: true });
    } else if (filter) {
      value = requireNumber(step.cutoff, `${sp}.cutoff`, { min: 0, max: 2047, integer: true });
    } else {
      const set = requireNumber(step.set, `${sp}.set`, { min: 0, max: 4094 });
      if (set === 0 || (set > 1 && !Number.isInteger(set))) {
        throw new SidwaveValidationError(`${sp}.set`, "expected fraction 0 < x <= 1 or integer 1..4094");
      }
      value = set <= 1 ? Math.max(1, Math.min(4094, Math.round(set * 4095))) : set;
    }
    const resonance = step.resonance === undefined ? undefined
      : requireNumber(step.resonance, `${sp}.resonance`, { min: 0, max: 15, integer: true });
    let type: number | undefined;
    if (step.type !== undefined) {
      if (typeof step.type !== "string" || !Object.prototype.hasOwnProperty.call(SIDWAVE_FILTER_TABLE_TYPES, step.type)) {
        throw new SidwaveValidationError(`${sp}.type`, "unknown filter type");
      }
      type = SIDWAVE_FILTER_TABLE_TYPES[step.type as keyof typeof SIDWAVE_FILTER_TABLE_TYPES];
    }
    return { value, add, frames, resonance, type };
  });
  return { steps, loop };
}

function parseTempo(value: unknown, path: string): number {
  if (value === undefined) return 100;
  return requireNumber(value, path, { min: SIDWAVE_TEMPO_RANGE.min, max: SIDWAVE_TEMPO_RANGE.max });
}

function parseMode(value: unknown, path: string): SystemMode {
  if (value === undefined) return "PAL";
  const m = String(value).toUpperCase();
  if (m !== "PAL" && m !== "NTSC") throw new SidwaveValidationError(path, `expected PAL or NTSC, got ${JSON.stringify(value)}`);
  return m;
}

function normalizeVoice(v: Record<string, any>, path: string, id: number, modern: boolean): SidwaveVoice {
  const wfRaw = v.waveform === undefined ? "pulse" : String(v.waveform).toLowerCase();
  if (!WAVEFORMS.has(wfRaw)) {
    throw new SidwaveValidationError(`${path}.waveform`, `unknown waveform ${JSON.stringify(v.waveform)}; use pulse, sawtooth, triangle or noise`);
  }
  const waveform = normalizeWaveform(wfRaw as Waveform);

  let pulseWidth: number | undefined;
  if (v.pulse_width !== undefined) {
    const pw = requireNumber(v.pulse_width, `${path}.pulse_width`, { min: 0, max: 4095 });
    pulseWidth = pw > 0 && pw <= 1 ? Math.round(pw * 4095) : Math.floor(pw);
    if (pulseWidth <= 0 || pulseWidth >= 4095) {
      throw new SidwaveValidationError(`${path}.pulse_width`, "a pulse width of 0% or 100% is silent; use a fraction between 0 and 1 or 1..4094");
    }
  }

  let adsr: [number, number, number, number] = [2, 2, 10, 3];
  if (v.adsr !== undefined) {
    if (!Array.isArray(v.adsr) || v.adsr.length !== 4) {
      throw new SidwaveValidationError(`${path}.adsr`, "expected [attack, decay, sustain, release] with values 0..15");
    }
    adsr = v.adsr.map((n: unknown, i: number) => requireNumber(n, `${path}.adsr[${i}]`, { min: 0, max: 15, integer: true })) as typeof adsr;
  }

  const patterns: Record<string, SidwavePattern> = {};
  if (v.patterns !== undefined) {
    if (!isPlainObject(v.patterns)) throw new SidwaveValidationError(`${path}.patterns`, "expected a mapping of pattern names to patterns");
    for (const [name, p] of Object.entries(v.patterns as Record<string, unknown>)) {
      patterns[name] = validatePattern(p, `${path}.patterns.${name}`, modern);
    }
  }

  let echo: SidwaveEcho | undefined;
  let unison: SidwaveUnison | undefined;
  if (v.echo !== undefined || v.unison !== undefined) {
    if (!modern) throw new SidwaveValidationError(path, "echo and unison require sidwave: 1.2");
    if (v.echo !== undefined && v.unison !== undefined) throw new SidwaveValidationError(path, "choose echo or unison");
    if (Object.keys(patterns).length || v.instrument !== undefined) throw new SidwaveValidationError(path, "echo and unison inherit the source voice's patterns and instruments");
    const kind = v.echo !== undefined ? "echo" : "unison";
    const ep = `${path}.${kind}`;
    const fx = requireObject(v[kind], ep, kind === "echo" ? ["voice", "delay", "volume", "detune"] : ["voice", "detune"]);
    const voice = requireNumber(fx.voice, `${ep}.voice`, { min: 1, max: 30, integer: true });
    const detune = fx.detune === undefined ? (kind === "echo" ? 0 : 5)
      : requireNumber(fx.detune, `${ep}.detune`, { min: -100, max: 100 });
    if (kind === "echo") {
      const delay = requireNumber(fx.delay, `${ep}.delay`, { min: 1, max: 65535, integer: true });
      const volume = requireNumber(fx.volume, `${ep}.volume`, { min: 0, max: 1 });
      echo = { voice, delay, volume, detune };
    } else {
      unison = { voice, detune };
    }
  }
  const detune = v.detune === undefined ? undefined : requireNumber(v.detune, `${path}.detune`, { min: -100, max: 100 });
  if (detune !== undefined && (!modern || echo || unison)) {
    throw new SidwaveValidationError(`${path}.detune`, "standalone voice detune requires SIDWAVE 1.2 and no echo or unison");
  }
  return {
    id, detune, name: v.name === undefined ? `Voice${id}` : String(v.name), waveform, pulse_width: pulseWidth, adsr,
    instrument: v.instrument === undefined ? undefined : String(v.instrument), patterns, echo, unison,
  };
}

function validatePattern(raw: unknown, path: string, modern: boolean): SidwavePattern {
  if (!isPlainObject(raw)) throw new SidwaveValidationError(path, "expected a pattern mapping (groove, motif or type: arpeggio)");
  // Copy first: numeric strings are stored as numbers, and the caller's object stays untouched.
  const p = { ...(raw as Record<string, any>) };
  if (p.length !== undefined) p.length = requireNumber(p.length, `${path}.length`, { min: 1 / 64, max: 64 });
  if (p.transpositions !== undefined) {
    if (!Array.isArray(p.transpositions) || p.transpositions.length === 0) {
      throw new SidwaveValidationError(`${path}.transpositions`, "expected a non-empty list of semitone offsets");
    }
    p.transpositions = p.transpositions.map((t: unknown, i: number) => requireNumber(t, `${path}.transpositions[${i}]`, { min: -48, max: 48, integer: true }));
  }
  if (p.fx !== undefined) validatePatternFx(p.fx, `${path}.fx`);

  if (p.type !== undefined || p.notes !== undefined) {
    if (p.type !== undefined && p.type !== "arpeggio") {
      throw new SidwaveValidationError(`${path}.type`, `unknown pattern type ${JSON.stringify(p.type)}; only 'arpeggio' is supported (a pattern with 'notes' is an arpeggio)`);
    }
    checkKeys(p, ARP_KEYS, path);
    if (!Array.isArray(p.notes) || p.notes.length === 0) throw new SidwaveValidationError(`${path}.notes`, "expected a non-empty list of note names");
    p.notes.forEach((n: unknown, i: number) => requireNote(n, `${path}.notes[${i}]`));
    if (p.frame_rate !== undefined) requireNumber(p.frame_rate, `${path}.frame_rate`, { min: 1, max: 50, integer: true });
    return p as SidwavePatternArp;
  }
  if (p.groove !== undefined || p.drums !== undefined) {
    checkKeys(p, GROOVE_KEYS, path);
    if (p.drums !== undefined && p.groove !== undefined) throw new SidwaveValidationError(`${path}.drums`, "use either groove or drums, not both");
    if (p.drums !== undefined) {
      const d = p.drums;
      if (!isPlainObject(d) || !isPlainObject(d.kit) || typeof d.steps !== "string" || !Object.keys(d).every((k) => ["kit", "steps"].includes(k))) throw new SidwaveValidationError(`${path}.drums`, "expected { kit: { letter: instrument }, steps: 'k.h.s.h' }");
      const kit = d.kit as Record<string, unknown>;
      if (!Object.keys(kit).length || Object.keys(kit).some((k) => k.length !== 1 || !/^[a-z]$/i.test(k) || typeof kit[k] !== "string")) throw new SidwaveValidationError(`${path}.drums.kit`, "expected one-letter keys mapped to instrument names");
      p.groove = [...d.steps].map((ch: string, i: number) => {
        if (ch === ".") return "-";
        const inst = kit[ch];
        if (typeof inst !== "string") throw new SidwaveValidationError(`${path}.drums.steps[${i}]`, `no kit instrument for ${JSON.stringify(ch)}`);
        return { note: "C3", inst };
      });
      delete p.drums;
    }
    if (!Array.isArray(p.groove) || p.groove.length === 0) throw new SidwaveValidationError(`${path}.groove`, "expected a non-empty list of notes, '-' rests or '~' ties");
    // An unquoted ~ in YAML is null; it is the tie token, so read it as one.
    p.groove = p.groove.map((n: unknown) => (n === null ? "~" : n));
    p.groove = p.groove.map((n: unknown, i: number) => {
      if (isPlainObject(n)) {
        const entry = { ...n };
        const np = `${path}.groove[${i}]`;
        if (modern && entry.chord !== undefined) {
          checkKeys(entry, new Set(["chord", "arp", "speed", "inst", "len"]), np);
          parseChordArp({ chord: entry.chord, arp: entry.arp, speed: entry.speed }, np);
        } else {
          checkKeys(entry, new Set(["note", "inst", "len", "legato", "portamento", "slide_from", ...(modern ? ["bend", "gate_off"] : [])]), np);
          requireNote(entry.note, `${np}.note`);
        }
        if (entry.inst !== undefined && typeof entry.inst !== "string") throw new SidwaveValidationError(`${path}.groove[${i}].inst`, "expected an instrument name");
        if (entry.len !== undefined) entry.len = requireNumber(entry.len, `${path}.groove[${i}].len`, { min: 1 / 64, max: 64 });
        if (entry.legato !== undefined && typeof entry.legato !== "boolean") throw new SidwaveValidationError(`${path}.groove[${i}].legato`, "expected a boolean");
        if (entry.portamento !== undefined) entry.portamento = requireNumber(entry.portamento, `${path}.groove[${i}].portamento`, { min: 0, max: 255, integer: true });
        if (entry.slide_from !== undefined) requireNote(entry.slide_from, `${path}.groove[${i}].slide_from`);
        if (entry.bend !== undefined) {
          if (entry.slide_from !== undefined || entry.portamento !== undefined) {
            throw new SidwaveValidationError(np, "use bend or slide_from/portamento for one note");
          }
          const bp = `${np}.bend`;
          const bend = requireObject(entry.bend, bp, ["to", "frames"]);
          const to = typeof bend.to === "number" || (typeof bend.to === "string" && /^[+-]?\d+$/.test(bend.to))
            ? requireNumber(bend.to, `${bp}.to`, { min: -48, max: 48, integer: true })
            : (requireNote(bend.to, `${bp}.to`), String(bend.to));
          entry.bend = { to, frames: requireNumber(bend.frames, `${bp}.frames`, { min: 1, max: 255, integer: true }) };
        }
        if (entry.gate_off !== undefined) {
          entry.gate_off = requireNumber(entry.gate_off, `${np}.gate_off`, { min: 0, max: 255, integer: true });
        }
        return entry;
      }
      const tok = String(n).trim();
      const note = tok.split("@")[0]!;
      if (modern && tok.endsWith("@arp")) parseChordArp({ chord: tok.slice(0, -4) }, `${path}.groove[${i}]`);
      else if (!isRestToken(tok) && !isTieToken(tok)) requireNote(note, `${path}.groove[${i}]`);
      return n;
    });
    return p as SidwavePatternGroove;
  }
  if (p.motif !== undefined) {
    checkKeys(p, MOTIF_KEYS, path);
    if (p.root !== undefined) requireNote(p.root, `${path}.root`);
    parseMotif(String(p.motif), p.root === undefined ? "C3" : String(p.root), `${path}.motif`);
    return p as SidwavePatternMotif;
  }
  throw new SidwaveValidationError(path, "a pattern needs 'groove', 'drums', 'motif' or 'type: arpeggio' with 'notes'");
}

function validatePatternFx(raw: unknown, path: string): void {
  if (!isPlainObject(raw)) throw new SidwaveValidationError(path, "expected a mapping");
  const fx = raw as Record<string, any>;
  checkKeys(fx, PATTERN_FX_KEYS, path);
  if (fx.vibrato !== undefined) {
    const v = requireObject(fx.vibrato, `${path}.vibrato`, ["depth", "rate", "delay"]);
    requireNumber(v.depth, `${path}.vibrato.depth`, { min: 0.03, max: 6 });
    // At about 50 player calls per second, faster rates sample too few points per cycle (25 Hz lands on zero crossings).
    requireNumber(v.rate, `${path}.vibrato.rate`, { min: 0.2, max: 12 });
    if (v.delay !== undefined) requireNumber(v.delay, `${path}.vibrato.delay`, { min: 0, max: 255, integer: true });
  }
  if (fx.pwm_sweep !== undefined) {
    const v = requireObject(fx.pwm_sweep, `${path}.pwm_sweep`, ["depth", "speed"]);
    requireNumber(v.depth, `${path}.pwm_sweep.depth`, { min: 0, max: 2047, exclusiveMin: true });
    requireNumber(v.speed, `${path}.pwm_sweep.speed`, { min: 0, max: 25, exclusiveMin: true });
  }
  if (fx.slide !== undefined) {
    const v = requireObject(fx.slide, `${path}.slide`, ["depth", "speed"]);
    const d = requireNumber(v.depth, `${path}.slide.depth`, { min: -24, max: 24, integer: true });
    if (d === 0) throw new SidwaveValidationError(`${path}.slide.depth`, "must not be 0");
    requireNumber(v.speed, `${path}.slide.speed`, { min: 1, max: 255, integer: true });
  }
  if (fx.filter_mod !== undefined) parseFilterMod(fx.filter_mod, `${path}.filter_mod`);
}

export interface FilterModSpec { sweep: number; amount: number; unit: "steps" | "beats" | "bars" | "frames" }

/** Parses `{ sweep: "+500 over 8 steps" }` or `{ sweep: 500, steps: 8 }`. */
export function parseFilterMod(raw: unknown, path: string): FilterModSpec {
  const v = requireObject(raw, path, ["sweep", "steps", "beats", "bars", "frames"]);
  if (typeof v.sweep === "string") {
    const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*(?:over\s+(\d+(?:\.\d+)?)\s*(steps?|beats?|bars?|frames?))?\s*$/i.exec(v.sweep);
    if (!m) throw new SidwaveValidationError(`${path}.sweep`, `expected e.g. "+500 over 8 steps", got ${JSON.stringify(v.sweep)}`);
    const sweep = Number(m[1]);
    const amount = m[2] === undefined ? 1 : Number(m[2]);
    const unit = (m[3] ? m[3].toLowerCase().replace(/s$/, "") + "s" : "steps") as FilterModSpec["unit"];
    return checkFilterMod({ sweep, amount, unit }, path);
  }
  const sweep = requireNumber(v.sweep, `${path}.sweep`, { min: -2047, max: 2047 });
  for (const unit of ["steps", "beats", "bars", "frames"] as const) {
    if (v[unit] !== undefined) return checkFilterMod({ sweep, amount: requireNumber(v[unit], `${path}.${unit}`, { min: 0, exclusiveMin: true }), unit }, path);
  }
  return checkFilterMod({ sweep, amount: 1, unit: "steps" }, path);
}

function checkFilterMod(spec: FilterModSpec, path: string): FilterModSpec {
  if (Math.abs(spec.sweep) > 2047) throw new SidwaveValidationError(`${path}.sweep`, "must be within -2047..2047 cutoff units");
  if (!(spec.amount > 0)) throw new SidwaveValidationError(path, "sweep duration must be positive");
  return spec;
}

function parseGlobalFx(raw: unknown, path: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw new SidwaveValidationError(path, "expected a mapping");
  const fx = { ...(raw as Record<string, any>) };
  checkKeys(fx, GLOBAL_FX_KEYS, path);
  if (fx.reverb_sim !== undefined) {
    const v = { ...requireObject(fx.reverb_sim, `${path}.reverb_sim`, ["depth", "delay_frames"]) };
    fx.reverb_sim = v;
    requireNumber(v.depth, `${path}.reverb_sim.depth`, { min: 0, max: 1, exclusiveMin: true });
    v.delay_frames = requireNumber(v.delay_frames, `${path}.reverb_sim.delay_frames`, { min: 1, max: 50, integer: true });
  }
  if (fx.filter_env !== undefined) fx.filter_env = parseFilterEnv(fx.filter_env, `${path}.filter_env`);
  return fx;
}

function parseFilterEnv(raw: unknown, path: string): Record<string, unknown> {
  const v = requireObject(raw, path, ["cutoff_base", "sweep", "speed", "resonance", "type", "voices"]);
  requireNumber(v.cutoff_base, `${path}.cutoff_base`, { min: 0, max: 2047 });
  if (v.sweep !== undefined) requireNumber(v.sweep, `${path}.sweep`, { min: -2047, max: 2047 });
  if (v.speed !== undefined) requireNumber(v.speed, `${path}.speed`, { min: 0, max: 1024, exclusiveMin: true });
  if (v.resonance !== undefined) requireNumber(v.resonance, `${path}.resonance`, { min: 0, max: 15, integer: true });
  if (v.type !== undefined && !["lowpass", "bandpass", "highpass"].includes(String(v.type).toLowerCase())) {
    throw new SidwaveValidationError(`${path}.type`, "expected lowpass, bandpass or highpass");
  }
  if (v.voices !== undefined) {
    if (!Array.isArray(v.voices)) throw new SidwaveValidationError(`${path}.voices`, "expected a list of voice ids");
    v.voices.forEach((id: unknown, i: number) => requireNumber(id, `${path}.voices[${i}]`, { min: 1, max: 3, integer: true }));
  }
  return v;
}

function normalizeWaveform(w: Waveform): Waveform {
  if (w === "saw") return "sawtooth";
  if (w === "tri") return "triangle";
  return w;
}

const LAYER_KEY = /^(?:v|voice)?([1-9]|[12][0-9]|30)$/i;

function normalizeTimelineSection(raw: unknown, path: string, voices: SidwaveVoice[]): SidwaveTimelineSection {
  if (!isPlainObject(raw)) throw new SidwaveValidationError(path, "expected a section mapping with bars and layers");
  const t = raw as Record<string, any>;
  checkKeys(t, SECTION_KEYS, path);
  const bars = requireNumber(t.bars, `${path}.bars`, { min: 1, max: MAX_SIDWAVE_BARS, integer: true });
  const tempo = t.tempo === undefined ? undefined : parseTempo(t.tempo, `${path}.tempo`);
  const swing = t.swing === undefined ? undefined : requireNumber(t.swing, `${path}.swing`, { min: 0, max: 0.5 });
  const layers: Record<string, string> = {};
  if (t.layers !== undefined && !isPlainObject(t.layers)) throw new SidwaveValidationError(`${path}.layers`, "expected a mapping such as { v1: A, v2: \"-\" }");
  for (const [k, v] of Object.entries((t.layers ?? {}) as Record<string, unknown>)) {
    const km = LAYER_KEY.exec(k);
    if (!km) throw new SidwaveValidationError(`${path}.layers.${k}`, "layer keys must be v1 through v30");
    const id = Number(km[1]);
    const key = `v${id}`;
    if (layers[key] !== undefined) throw new SidwaveValidationError(`${path}.layers.${k}`, `voice ${id} is assigned twice`);
    const ref = v === null || v === undefined ? "-" : String(v).trim();
    const voice = voices.find((vv) => vv.id === id);
    const parsed = parseLayerRef(ref, Object.keys(voice?.patterns ?? {}));
    if (parsed.pattern !== null) {
      if (!voice) throw new SidwaveValidationError(`${path}.layers.${k}`, `voice ${id} is not declared in voices`);
      if (!(parsed.pattern in (voice.patterns ?? {}))) {
        const known = Object.keys(voice.patterns ?? {});
        throw new SidwaveValidationError(`${path}.layers.${k}`, `pattern ${JSON.stringify(ref)} is not defined for voice ${id}${known.length ? ` (known: ${known.join(", ")})` : ""}`);
      }
    }
    layers[key] = ref;
  }
  return { section: t.section === undefined ? "" : String(t.section), bars, tempo, swing, layers };
}

export interface LayerRef {
  /** Pattern name, or null for a silent layer. */
  pattern: string | null;
  transpose: number;
  fade: boolean;
}

/**
 * Parses a timeline layer reference: a pattern name followed by optional modifiers.
 * `↑`/`^` transpose up an octave, `↓` down an octave, `+N`/`-N` by N semitones, and a trailing
 * `–`, `—` or `-` fades the voice out over the section. `-`, `.`, `rest` or an empty value is silence.
 */
export function parseLayerRef(ref: string, patternNames: string[]): LayerRef {
  const s = ref.trim();
  if (s === "" || s === "-" || s === "–" || s === "—" || s === "." || s.toLowerCase() === "rest") return { pattern: null, transpose: 0, fade: false };
  if (patternNames.includes(s)) return { pattern: s, transpose: 0, fade: false };
  let rest = s;
  let transpose = 0;
  let fade = false;
  for (;;) {
    let m: RegExpExecArray | null;
    if ((m = /(↑|\^)$/.exec(rest))) { transpose += 12; rest = rest.slice(0, m.index); }
    else if ((m = /↓$/.exec(rest))) { transpose -= 12; rest = rest.slice(0, m.index); }
    else if ((m = /([+-]\d+)$/.exec(rest)) && !patternNames.includes(rest)) { transpose += Number(m[1]); rest = rest.slice(0, m.index); }
    else if ((m = /(–|—|-)$/.exec(rest)) && !patternNames.includes(rest)) { fade = true; rest = rest.slice(0, m.index); }
    else break;
    rest = rest.trimEnd();
    if (patternNames.includes(rest)) break;
  }
  return { pattern: rest, transpose, fade };
}

// ---------------------------------------------------------------------------
// Musical tokens

export function noteNameToMidi(note: string): number | undefined {
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
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export function midiToNoteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export function isRestToken(token: string): boolean {
  return token === "-" || token === "." || token.toLowerCase() === "r" || token.toLowerCase() === "rest";
}

export function isTieToken(token: string): boolean {
  return token === "~" || token === "_";
}

function requireNote(raw: unknown, path: string): number {
  const midi = typeof raw === "string" ? noteNameToMidi(raw) : undefined;
  if (midi === undefined) throw new SidwaveValidationError(path, `invalid note ${JSON.stringify(raw)}; use names such as C4, Eb3 or F#2`);
  if (midi < SIDWAVE_NOTE_RANGE.min || midi > SIDWAVE_NOTE_RANGE.max) {
    throw new SidwaveValidationError(path, `note ${raw} is outside the supported range C0..B7`);
  }
  return midi;
}

const CHORD_QUALITIES: Record<string, number[]> = {
  "": [0, 4, 7], maj: [0, 4, 7], M: [0, 4, 7],
  m: [0, 3, 7], min: [0, 3, 7],
  dim: [0, 3, 6], aug: [0, 4, 8], "+": [0, 4, 8],
  sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7],
  "6": [0, 4, 7, 9], m6: [0, 3, 7, 9], min6: [0, 3, 7, 9],
  "7": [0, 4, 7, 10], maj7: [0, 4, 7, 11], M7: [0, 4, 7, 11], m7: [0, 3, 7, 10], min7: [0, 3, 7, 10],
  dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10],
  "9": [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], M9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], min9: [0, 3, 7, 10, 14],
  add9: [0, 4, 7, 14],
};

export function parseChordArp(chord: { chord: unknown; arp?: unknown; speed?: unknown }, path: string): { base: number; offsets: number[]; speed: number } {
  const match = typeof chord.chord === "string" && /^([A-G][#b]?)(.*)$/.exec(chord.chord);
  if (!match || !Object.prototype.hasOwnProperty.call(CHORD_QUALITIES, match[2]!)) {
    throw new SidwaveValidationError(`${path}.chord`, "expected a chord symbol such as Cm7");
  }
  const base = noteNameToMidi(`${match[1]}3`)!;
  let offsets = CHORD_QUALITIES[match[2]!]!;
  if (chord.arp !== undefined) {
    if (typeof chord.arp !== "string" || !/^\s*[+-]?\d+(?:\s*,\s*[+-]?\d+){0,31}\s*$/.test(chord.arp)) {
      throw new SidwaveValidationError(`${path}.arp`, "expected 1..32 comma-separated offsets, e.g. 0,3,7,10");
    }
    offsets = chord.arp.split(",").map((value) => requireNumber(value, `${path}.arp`, { min: -48, max: 48, integer: true }));
  }
  const speed = chord.speed === undefined ? 1 : requireNumber(chord.speed, `${path}.speed`, { min: 1, max: 255, integer: true });
  return { base, offsets, speed };
}

/** Motif entry: a MIDI note, a rest (null) or a tie ("~"). */
export type MotifEntry = number | null | "~";

/**
 * Expands a motif string into entries. Tokens: note names (C4, Eb3), integers (semitones above `root`),
 * chord symbols (Cmin9, Am7, F, Gsus4; expanded to their chord tones starting in the root's octave),
 * `-` rests and `~` ties. Purely alphabetic words that are not chord symbols (e.g. "pad", "motif") are ignored.
 */
export function parseMotif(motif: string, root: string, path: string): MotifEntry[] {
  const rootMidi = requireNote(root, path.replace(/\.motif$/, ".root"));
  const rootOctave = Math.floor(rootMidi / 12) - 1;
  const entries: MotifEntry[] = [];
  for (const token of motif.split(/[\s,]+/).filter((t) => t.length > 0)) {
    if (isRestToken(token)) { entries.push(null); continue; }
    if (isTieToken(token)) { entries.push("~"); continue; }
    if (/^[+-]?\d+$/.test(token)) {
      const midi = rootMidi + Number(token);
      if (midi < SIDWAVE_NOTE_RANGE.min || midi > SIDWAVE_NOTE_RANGE.max) {
        throw new SidwaveValidationError(path, `motif offset ${token} from ${root} leaves the range C0..B7`);
      }
      entries.push(midi);
      continue;
    }
    const note = noteNameToMidi(token);
    if (note !== undefined) { entries.push(requireNote(token, path)); continue; }
    const chord = /^([A-G])([#b]?)(.*)$/.exec(token);
    if (chord && chord[3] in CHORD_QUALITIES) {
      const base = noteNameToMidi(`${chord[1]}${chord[2]}${rootOctave}`)!;
      for (const iv of CHORD_QUALITIES[chord[3]]!) {
        const midi = base + iv;
        if (midi > SIDWAVE_NOTE_RANGE.max) throw new SidwaveValidationError(path, `chord ${token} leaves the range C0..B7`);
        entries.push(midi);
      }
      continue;
    }
    if (/^[A-Za-z]+$/.test(token)) continue; // descriptive word
    throw new SidwaveValidationError(path, `unrecognised motif token ${JSON.stringify(token)}; use notes (C4), semitone offsets (0 4 7), chord symbols (Cmin9), '-' or '~'`);
  }
  if (!entries.some((e) => typeof e === "number")) {
    throw new SidwaveValidationError(path, `motif ${JSON.stringify(motif)} contains no notes; use notes (C4 Eb4 G4), semitone offsets (0 3 7) or a chord symbol (Cmin9)`);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Generic helpers

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function checkKeys(obj: Record<string, unknown>, allowed: Set<string>, path: string, hint?: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new SidwaveValidationError(`${path}.${key}`, hint ?? `unknown field; expected one of ${[...allowed].join(", ")}`);
    }
  }
}

function requireObject(raw: unknown, path: string, keys: string[]): Record<string, any> {
  if (!isPlainObject(raw)) throw new SidwaveValidationError(path, `expected a mapping with ${keys.join(", ")}`);
  checkKeys(raw, new Set(keys), path);
  return raw;
}

function requireNumber(raw: unknown, path: string, opts: { min?: number; max?: number; integer?: boolean; exclusiveMin?: boolean }): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new SidwaveValidationError(path, `expected a number, got ${JSON.stringify(raw)}`);
  if (opts.integer && !Number.isInteger(n)) throw new SidwaveValidationError(path, `expected a whole number, got ${n}`);
  if (opts.min !== undefined && (opts.exclusiveMin ? n <= opts.min : n < opts.min)) {
    throw new SidwaveValidationError(path, `${n} is below the minimum ${opts.exclusiveMin ? "(exclusive) " : ""}${opts.min}`);
  }
  if (opts.max !== undefined && n > opts.max) throw new SidwaveValidationError(path, `${n} is above the maximum ${opts.max}`);
  return n;
}
