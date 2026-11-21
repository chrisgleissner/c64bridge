/*
C64 Bridge - SIDWAVE Parser and Types
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { Buffer } from 'node:buffer';
import pkg from 'yaml';
import { renderSample, SAMPLE_SOURCE_KEYS, type RenderedSample, type SampleSource } from "./sidwavePcm.js";
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
  bars?: number;
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
  level?: number;
  accented?: boolean;
  glide?: boolean;
  kitNote?: boolean;
}

export interface SidwaveChord {
  chord: string;
  arp?: string;
  speed?: number;
  inst?: string;
  len?: number;
  legato?: boolean;
  level?: number;
  accented?: boolean;
  glide?: boolean;
}

export interface SidwaveEcho {
  voice: number;
  delay?: number;
  delay_beats?: number;
  adsr?: [number, number, number, number];
  volume: number;
  detune?: number;
}

export interface SidwaveUnison {
  voice: number;
  detune: number;
}

interface SamplePattern {
  steps: string;
  map: Record<string, string>;
  from_bar?: number;
  to_bar?: number;
  every?: number;
}

export interface SidwaveSampleVoice extends SampleSource {
  sid?: string | number;
  sample?: string;
  at?: number[];
  bar?: number;
  beat?: number;
  at_beat?: Array<number | { bar: number; beat: number }>;
  pattern?: SamplePattern;
  pitch?: number;
  length_beats?: number;
}

interface SampleTrigger {
  chip: number;
  name: string;
  path: string;
  pitch: number;
  lengthBeats?: number;
  at?: number;
  beat?: number;
}

export interface SidwaveSampleSchedule {
  rate: number;
  defs: Map<string, RenderedSample>;
  triggers: SampleTrigger[];
}

/** Resolved player commands. A command without a name ends a loop. */
export interface SidwaveSamples {
  rate: number;
  defs: Map<string, RenderedSample>;
  commands: Array<{ chip: number; at: number[]; name?: string; pitch: number; stopChips?: number[] }>;
}

export interface SidwavePatternDrums extends SidwavePatternCommon {
  drums: { kit: Record<string, string>; steps: string };
}

export type SidwavePattern = SidwavePatternDrums | SidwavePatternArp | SidwavePatternMotif | SidwavePatternGroove;

export interface SidwaveVoice {
  id: number; // 1..30
  level?: number;
  role?: "bass" | "lead" | "drums" | "pad" | "arp";
  center?: { sid?: string; channel?: number; level?: number };
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

export type SidwaveRamp = number | { from?: number; to: number; bars?: number };
export interface SidwaveFilterMove { cutoff?: SidwaveRamp; resonance?: number }

export interface SidwaveTimelineSection {
  section?: string;
  bars: number;
  tempo?: number | { to: number };
  swing?: number;
  transpose?: number;
  level?: SidwaveRamp;
  levels?: Record<string, SidwaveRamp>;
  volume?: Record<string, SidwaveRamp>;
  filter?: Record<string, SidwaveFilterMove>;
  layers: Record<string, string>;
}

export type SidModel = "6581" | "8580";
interface SidFilter {
  owner?: number;
  route?: number[];
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
  samples?: { rate: number; defs?: Record<string, SampleSource>; voices?: SidwaveSampleVoice[]; triggers?: SidwaveSampleVoice[] };
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
  samples?: SidwaveSampleSchedule;
  /** Zero based physical voice slot for each declared voice ID. */
  voiceSlots: Map<number, number>;
  timeline: SidwaveTimelineSection[];
  accent?: number;
  swing?: number;
  swingUnit?: number;
  loopTo?: number;
  end?: { holdBeats: number; release: boolean };
  layout?: SidLayout;
  digiVoices?: Array<{ id: string; chip: number; patterns: Record<string, SidwavePattern> }>;
  /** Fields that a pre-1.2 document may contain but that have no effect before sidwave: 1.2 (JSON paths). */
  ignoredFields?: string[];
}

/** Raised for SIDWAVE documents that cannot be played as written. The message names the offending path. */
export class SidwaveValidationError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    const boundedPath = clipText(path, 240);
    super(`Invalid SIDWAVE at ${boundedPath}: ${clipText(detail, 600)}`);
    this.path = boundedPath;
    this.name = "SidwaveValidationError";
  }
}

export const SIDWAVE_TEMPO_RANGE = { min: 30, max: 220 } as const;
/** MIDI numbers of C0 and B7, the note range of the player's frequency table. */
export const SIDWAVE_NOTE_RANGE = { min: 12, max: 107 } as const;

const TOP_LEVEL_KEYS = new Set(["sidwave", "title", "author", "tempo", "mode", "length_bars", "global_fx", "voices", "timeline", "instruments", "speed", "meter", "sids", "cpu", "samples", "kit", "sections", "loop_to", "accent", "end", "swing", "swing_unit"]);
const LEGACY_KEYS = new Set(["song", "voices", "timeline"]);
const LEGACY_SONG_KEYS = new Set(["title", "author", "tempo", "mode", "length_bars", "global_fx"]);
const VOICE_KEYS = new Set(["id", "sid", "channel", "name", "waveform", "pulse_width", "adsr", "patterns", "instrument", "echo", "unison", "detune", "level", "role", "center"]);
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
    if (obj.sidwave !== undefined && !["1", "1.0", "1.1", "1.2"].includes(scalarText(obj.sidwave, "$.sidwave"))) {
      throw new SidwaveValidationError("$.sidwave", `unsupported version ${describeValue(obj.sidwave)}; use 1.0, 1.1 or 1.2`);
    }
  }
  const modern = obj.sidwave === 1.2 || obj.sidwave === "1.2";
  const header = (legacy ? obj.song : obj) as Record<string, unknown>;
  const headerPath = legacy ? "$.song" : "$";

  const title = header.title === undefined ? "Untitled" : requireText(header.title, `${headerPath}.title`);
  const author = header.author === undefined ? undefined : requireText(header.author, `${headerPath}.author`);
  const tempo = parseTempo(header.tempo, `${headerPath}.tempo`);
  const mode = parseMode(header.mode, `${headerPath}.mode`);
  const global_fx = parseGlobalFx(header.global_fx, `${headerPath}.global_fx`, modern);
  const meter = obj.meter === undefined ? 4 : requireNumber(obj.meter, "$.meter", { min: 3, max: 4, integer: true }) as 3 | 4;
  if (meter !== 4 && !modern) throw new SidwaveValidationError("$.meter", "3/4 requires sidwave: 1.2");
  for (const key of ["kit", "sections", "loop_to", "accent", "end", "swing", "swing_unit"]) {
    if (!modern && obj[key] !== undefined) throw new SidwaveValidationError(`$.${key}`, "requires sidwave: 1.2");
  }
  const kit = obj.kit === undefined ? undefined : normalizeKit(obj.kit, "$.kit");

  if (!Array.isArray(obj.voices) || (obj.voices.length === 0 && obj.samples === undefined)) {
    throw new SidwaveValidationError("$.voices", "missing voices (expected a list of 1 to 30 voices)");
  }
  const sids = normalizeSids(obj.sids, modern);
  const layout = !Array.isArray(obj.sids) ? obj.sids?.layout as SidLayout | undefined : undefined;
  const capacity = sids.length * 3;
  if (obj.voices.filter((v: any) => v?.digi === undefined).length > capacity) {
    throw new SidwaveValidationError("$.voices", `the SID${sids.length > 1 ? " map" : ""} has ${capacity} voices; ${obj.voices.length} were given`);
  }
  const instruments = normalizeInstruments(obj.instruments, "$.instruments", modern);
  // SIDWAVE 1.1 (c64bridge 1.3.1) accepted hard_restart in an instrument without using it. Keep accepting
  // it so that such documents still compile, and report it as ignored.
  const ignoredFields = !modern && obj.instruments && typeof obj.instruments === "object"
    ? Object.entries(obj.instruments as Record<string, unknown>)
      .filter(([, inst]) => inst !== null && typeof inst === "object" && Object.prototype.hasOwnProperty.call(inst, "hard_restart"))
      .map(([name]) => `$.instruments.${name}.hard_restart`)
    : [];
  const voiceSlots = new Map<number, number>();
  const occupied = new Set<number>();
  const digiVoices: NonNullable<ParsedSidwave["digiVoices"]> = [];
  const voices: SidwaveVoice[] = obj.voices.flatMap((raw: unknown, i: number) => {
    const path = `$.voices[${i}]`;
    if (!isPlainObject(raw)) throw new SidwaveValidationError(path, "expected a voice mapping");
    if (modern && raw.digi !== undefined) {
      checkKeys(raw, new Set(["id", "digi", "patterns"]), path);
      const id = scalarText(raw.id, path + ".id");
      const chip = sids.findIndex((sid) => sid.id === scalarText(raw.digi, path + ".digi"));
      if (!/^d[1-9][0-9]*$/.test(id) || digiVoices.some((v) => v.id === id) || chip < 0 || !isPlainObject(raw.patterns)) {
        throw new SidwaveValidationError(path, "need a unique digi ID, a mapped SID and patterns");
      }
      const patterns = Object.fromEntries(Object.entries(raw.patterns).map(([name, pattern]) => [
        name, validatePattern(pattern, `${path}.patterns.${name}`, true, meter, kit),
      ]));
      digiVoices.push({ id, chip, patterns });
      return [];
    }
    checkKeys(raw, modern ? VOICE_KEYS : new Set([...VOICE_KEYS].filter((key) => !["level", "role", "center"].includes(key))), path);
    let slot: number | undefined;
    if (raw.sid !== undefined || raw.channel !== undefined) {
      const sidId = scalarText(raw.sid, path + ".sid");
      const chip = sids.findIndex((sid) => sid.id === sidId);
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
    const voice = normalizeVoice(raw, path, id, modern, meter, kit);
    const name = voice.instrument;
    if (name && !name.startsWith("lib:") && !hasOwn(instruments, name)) {
      throw new SidwaveValidationError(`${path}.instrument`, `instrument ${describeValue(name)} is not defined`);
    }
    return [voice];
  });

  if (!Array.isArray(obj.timeline) || obj.timeline.length === 0) {
    throw new SidwaveValidationError("$.timeline", "missing timeline (expected a list of sections)");
  }
  if (obj.timeline.length > MAX_SIDWAVE_BARS) {
    throw new SidwaveValidationError("$.timeline", `at most ${MAX_SIDWAVE_BARS} sections can fit in the bar limit`);
  }
  if (digiVoices.length && obj.samples === undefined) throw new SidwaveValidationError("$.samples", "digi voices need samples.defs for the samples their kits name");
  const timeline = modern
    ? normalizeForm(obj.timeline, obj.sections, voices, digiVoices, sids, meter)
    : obj.timeline.map((t: unknown, i: number) => normalizeTimelineSection(t, `$.timeline[${i}]`, voices));
  if (Number(obj.loop_to !== undefined) + Number(obj.end !== undefined) + Number(obj.length_bars !== undefined) > 1) {
    throw new SidwaveValidationError("$.timeline", "loop_to, end and length_bars are mutually exclusive");
  }
  let loopTo: number | undefined;
  if (obj.loop_to !== undefined) {
    const target = obj.loop_to;
    const named = typeof target === "string" ? timeline.findIndex((s: SidwaveTimelineSection) => s.section === target) : -1;
    if (named >= 0) loopTo = named;
    else if (typeof target === "string" && !/^\s*\d+\s*$/.test(target)) throw new SidwaveValidationError("$.loop_to", "unknown timeline section");
    else loopTo = requireNumber(target, "$.loop_to", { min: 1, max: timeline.length, integer: true }) - 1;
  }
  const endDef = obj.end === true ? {} : obj.end === undefined ? undefined : requireObject(obj.end, "$.end", ["hold_beats", "release"]);
  if (endDef?.release !== undefined && typeof endDef.release !== "boolean") throw new SidwaveValidationError("$.end.release", "expected a boolean");
  const end = endDef && { holdBeats: requireNumber(endDef.hold_beats ?? 0, "$.end.hold_beats", { min: 0, max: 64 }), release: endDef.release ?? true };
  const accent = obj.accent === undefined ? undefined : requireNumber(obj.accent, "$.accent", { min: 0, max: 8, integer: true });
  const swing = obj.swing === undefined ? undefined : requireNumber(obj.swing, "$.swing", { min: 0.5, max: 0.75 });
  const swingUnit = obj.swing_unit === undefined ? undefined : requireNumber(obj.swing_unit, "$.swing_unit", { min: 1 / 64, max: 1 });

  const timelineBars = timeline.reduce((sum: number, s: SidwaveTimelineSection) => sum + s.bars, 0);
  if (timelineBars > MAX_SIDWAVE_BARS) {
    throw new SidwaveValidationError("$.timeline", `the sections add up to ${timelineBars} bars, above the maximum ${MAX_SIDWAVE_BARS}`);
  }
  let length_bars = timelineBars;
  if (header.length_bars !== undefined) {
    length_bars = requireNumber(header.length_bars, `${headerPath}.length_bars`, { min: 1, max: MAX_SIDWAVE_BARS, integer: true });
  }

  const samples = normalizeSamples(obj.samples, sids, modern, length_bars, meter, digiVoices.length > 0);
  const song: ParsedSidwave["song"] = { title, tempo, mode, length_bars, meter, global_fx };
  if (author !== undefined) song.author = author;
  const speed = obj.speed === undefined ? 1 : requireNumber(obj.speed, "$.speed", { min: 1, max: 4, integer: true });
  if (obj.cpu !== undefined && obj.cpu !== "turbo") throw new SidwaveValidationError("$.cpu", "expected turbo");
  const declaredVersion = String(obj.sidwave);
  const version = declaredVersion === "1.1" || declaredVersion === "1.2" ? declaredVersion : "1.0";
  for (const [chip, sid] of sids.entries()) {
    const owner = sid.filter?.owner;
    if (owner === undefined) continue;
    const slot = voiceSlots.get(owner);
    if (slot === undefined || Math.floor(slot / 3) !== chip) throw new SidwaveValidationError(`$.sids[${chip}].filter.owner`, "must name a declared voice of this SID");
    sid.filter!.route ??= [slot % 3 + 1];
  }
  return { version, song, voices, timeline, instruments, speed, sids, samples, voiceSlots, cpu: obj.cpu,
    accent, swing, swingUnit, loopTo, end, layout, digiVoices, ...(ignoredFields.length ? { ignoredFields } : {}) };

}

// data/ultimate/multisid.md, Owner configurations.
const ULTISID8 = [0xd400, 0xd480, 0xd500, 0xd580, 0xd420, 0xd4a0, 0xd520, 0xd5a0];
const SID_LAYOUTS: Record<SidLayout, number[]> = {
  ultisid8: ULTISID8,
  "ultisid8+socket1": [...ULTISID8, 0xd440],
  "ultisid8+sockets": [...ULTISID8, 0xd440, 0xd460],
};

function normalizeSids(raw: unknown, modern: boolean): SidMapEntry[] {
  if (raw === undefined) return [{ id: "sid1", address: 0xd400, volume: 15 }];
  if (!Array.isArray(raw)) {
    const value = requireObject(raw, "$.sids", ["layout", "overrides", ...(modern ? ["pan"] : [])]);
    if (typeof value.layout !== "string" || !Object.prototype.hasOwnProperty.call(SID_LAYOUTS, value.layout)) {
      throw new SidwaveValidationError("$.sids.layout", "expected ultisid8, ultisid8+socket1 or ultisid8+sockets");
    }
    if (value.pan !== undefined && !["wide", "narrow"].includes(value.pan)) throw new SidwaveValidationError("$.sids.pan", "use wide or narrow");
    const spread = value.pan === "wide" ? 5 : 3;
    const entries: SidMapEntry[] = SID_LAYOUTS[value.layout as SidLayout].map((address, i) => ({
      id: `sid${i + 1}`, address, volume: 15,
      ...(value.pan ? { pan: i < 4 ? `Left ${spread}` : i < 8 ? `Right ${spread}` : "Center" } : {}),
    }));
    if (value.overrides === undefined) return entries;
    if (!isPlainObject(value.overrides)) throw new SidwaveValidationError("$.sids.overrides", "expected a mapping of layout SID IDs");
    checkKeys(value.overrides, new Set(entries.map(({ id }) => id)), "$.sids.overrides");
    return entries.map((entry) => {
      const path = `$.sids.overrides.${entry.id}`;
      if (value.overrides[entry.id] === undefined) return entry;
      const override = requireObject(value.overrides[entry.id], path, ["volume", "pan", ...(modern ? ["model"] : [])]);
      if (override.model !== undefined && !["6581", "8580"].includes(override.model)) throw new SidwaveValidationError(path + ".model", "use 6581 or 8580");
      const mix = parseSidMix(override, path);
      return { ...entry, ...mix, pan: mix.pan ?? entry.pan, model: override.model };
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
        filter = { filter_env: parseFilterEnv(value, fp, modern) };
      } else {
        checkKeys(value, new Set(["filter_env", "filter_mod", ...(modern ? ["owner", "route"] : [])]), fp);
        filter = {
          filter_env: value.filter_env === undefined ? undefined : parseFilterEnv(value.filter_env, `${fp}.filter_env`, modern),
          filter_mod: value.filter_mod === undefined ? undefined : parseFilterMod(value.filter_mod, `${fp}.filter_mod`),
          owner: value.owner === undefined ? undefined : requireNumber(scalarText(value.owner, fp + ".owner").replace(/^v/i, ""), fp + ".owner", { min: 1, max: 30, integer: true }),
          route: value.route === undefined ? undefined : normalizeRoute(value.route, fp + ".route"),

        };
      }
    }
    return { id, address, model: sid.model, filter, ...parseSidMix(sid, path) };
  });
}

function normalizeRoute(raw: unknown, path: string): number[] {
  if (!Array.isArray(raw) || new Set(raw).size !== raw.length) throw new SidwaveValidationError(path, "expected distinct local channel numbers");
  return raw.map((n) => requireNumber(n, path, { min: 1, max: 3, integer: true }));
}

function parseSidMix(sid: Record<string, unknown>, path: string): { volume: number; pan?: string } {
  const volume = sid.volume === undefined ? 15 : requireNumber(sid.volume, `${path}.volume`, { min: 0, max: 15, integer: true });
  const pan = sid.pan;
  if (pan !== undefined && (typeof pan !== "string" || !/^(?:Center|(?:Left|Right) [1-5])$/.test(pan))) {
    throw new SidwaveValidationError(`${path}.pan`, "use Center, Left 1 through Left 5, or Right 1 through Right 5");
  }
  return { volume, pan };
}

function normalizeSamples(raw: unknown, sids: SidMapEntry[], modern: boolean, bars: number, meter: 3 | 4, digiLayers = false): SidwaveSampleSchedule | undefined {
  if (raw === undefined) return;
  const path = "$.samples";
  if (!modern) throw new SidwaveValidationError(path, "samples require sidwave: 1.2");
  const root = requireObject(raw, path, ["rate", "defs", "voices", "triggers"]);
  const rate = requireNumber(root.rate, path + ".rate", { min: 16, max: 8000, integer: true });
  const defs = new Map<string, RenderedSample>();
  let totalBytes = 0;
  const add = (name: string, value: unknown, sourcePath: string) => {
    try {
      const sample = renderSample(value, rate);
      totalBytes += sample.data.length;
      if (totalBytes > 0xc800) {
        throw new Error(`Sample data needs ${totalBytes} bytes and cannot fit below $D000. Use a lower rate or shorter samples`);
      }
      defs.set(name, sample);
    } catch (error) {
      throw new SidwaveValidationError(sourcePath, error instanceof Error ? error.message : String(error));
    }
  };
  if (root.defs !== undefined) {
    if (!isPlainObject(root.defs)) throw new SidwaveValidationError(path + ".defs", "expected a mapping");
    const entries = Object.entries(root.defs);
    if (entries.length > 255) throw new SidwaveValidationError(path + ".defs", "expected at most 255 definitions");
    for (const [name, value] of entries) {
      const sourcePath = path + ".defs." + name;
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new SidwaveValidationError(sourcePath, "invalid sample name");
      add(name, value, sourcePath);
    }
  }

  const triggers: SampleTrigger[] = [];
  const occupied = new Set<string>();
  const songBeat = (bar: unknown, beat: unknown, here: string) =>
    meter * (requireNumber(bar, here + ".bar", { min: 1, max: bars, integer: true }) - 1) +
    requireNumber(beat ?? 1, here + ".beat", { min: 1, max: meter + 1 - 1e-9 }) - 1;
  for (const list of ["voices", "triggers"] as const) {
    if (root[list] === undefined) continue;
    const entries = root[list];
    if (!Array.isArray(entries) || entries.length > 255) {
      throw new SidwaveValidationError(path + "." + list, "expected at most 255 sample entries");
    }
    entries.forEach((raw: unknown, i: number) => {
      const here = `${path}.${list}[${i}]`;
      const item = requireObject(raw, here, [...SAMPLE_SOURCE_KEYS, "sid", "sample", "at", "bar", "beat", "at_beat", "pattern", "pitch", "length_beats"]);
      const chip = item.sid === undefined ? 0 : sids.findIndex((sid) => sid.id === scalarText(item.sid, here + ".sid"));
      if (chip < 0 || (item.sid !== undefined && typeof item.sid !== "string" && !Number.isSafeInteger(item.sid))) {
        throw new SidwaveValidationError(here + ".sid", "references an unknown SID");
      }
      const pitch = requireNumber(item.pitch ?? 0, here + ".pitch", { min: -48, max: 48 });
      const lengthBeats = item.length_beats === undefined ? undefined :
        requireNumber(item.length_beats, here + ".length_beats", { min: 0.001, max: bars * meter });
      const inline = Object.fromEntries(SAMPLE_SOURCE_KEYS.filter((key) => item[key] !== undefined).map((key) => [key, item[key]]));
      let sample = item.sample;
      if (Object.keys(inline).length) {
        if (sample !== undefined || item.pattern !== undefined) throw new SidwaveValidationError(here, "use a named sample or an inline source");
        sample = `${list}[${i}]`;
        add(sample as string, inline, here);
      }
      const schedule = (name: unknown, when: Pick<SampleTrigger, "at" | "beat">, triggerPath: string) => {
        if (typeof name !== "string" || !defs.has(name)) {
          throw new SidwaveValidationError(triggerPath, `sample ${describeValue(name)} is not defined`);
        }
        if (defs.get(name)!.loop !== (lengthBeats !== undefined)) {
          throw new SidwaveValidationError(triggerPath, "a looping sample requires length_beats and a one-shot sample cannot use it");
        }
        if (triggers.length >= 20_000) throw new SidwaveValidationError(path, "at most 20000 sample triggers are supported");
        const key = when.at === undefined ? `${chip}:beat:${when.beat}` : `${chip}:call:${when.at}`;
        if (occupied.has(key)) throw new SidwaveValidationError(triggerPath, "this SID already has a sample scheduled at this position");
        occupied.add(key);
        triggers.push({ chip, name, pitch, lengthBeats, path: triggerPath, ...when });
      };
      const kinds = [item.at, item.bar, item.at_beat, item.pattern].filter((x) => x !== undefined).length;
      if (kinds !== 1 || (item.beat !== undefined && item.bar === undefined)) {
        throw new SidwaveValidationError(here, "provide exactly one schedule: at, bar and beat, at_beat, or pattern");
      }
      if (item.pattern !== undefined) {
        if (sample !== undefined) throw new SidwaveValidationError(here, "a pattern uses its map to select samples");
        const pat = requireObject(item.pattern, here + ".pattern", ["steps", "map", "from_bar", "to_bar", "every"]);
        if (typeof pat.steps !== "string" || !/^[A-Za-z0-9.]{1,256}$/.test(pat.steps) || !isPlainObject(pat.map)) {
          throw new SidwaveValidationError(here + ".pattern", "provide up to 256 steps (letters, digits, dots) and a sample map");
        }
        const from = requireNumber(pat.from_bar ?? 1, here + ".pattern.from_bar", { min: 1, max: bars, integer: true });
        const to = requireNumber(pat.to_bar ?? bars, here + ".pattern.to_bar", { min: from, max: bars, integer: true });
        const every = requireNumber(pat.every ?? 1, here + ".pattern.every", { min: 1, max: bars, integer: true });
        const steps = Array.from(pat.steps);
        const map = pat.map;
        for (let bar = from; bar <= to; bar += every) steps.forEach((step, j) => {
          if (step !== ".") schedule(Object.prototype.hasOwnProperty.call(map, step) ? map[step] : undefined,
            { beat: (bar - 1) * meter + j * meter / steps.length }, `${here}.pattern (bar ${bar}, step ${j + 1})`);
        });
      } else if (item.bar !== undefined) {
        schedule(sample, { beat: songBeat(item.bar, item.beat, here) }, here);
      } else {
        const field = item.at === undefined ? "at_beat" : "at";
        const positions = item[field];
        if (!Array.isArray(positions) || !positions.length || positions.length > 20_000) {
          throw new SidwaveValidationError(here + "." + field, "expected 1..20000 offsets");
        }
        positions.forEach((raw: unknown, j: number) => {
          const positionPath = `${here}.${field}[${j}]`;
          if (field === "at") {
            schedule(sample, { at: requireNumber(raw, positionPath, { min: 0, max: 0xffffff, integer: true }) }, positionPath);
          } else if (isPlainObject(raw)) {
            const pos = requireObject(raw, positionPath, ["bar", "beat"]);
            schedule(sample, { beat: songBeat(pos.bar, pos.beat, positionPath) }, positionPath);
          } else {
            schedule(sample, { beat: requireNumber(raw, positionPath, { min: 0, max: bars * meter }) }, positionPath);
          }
        });
      }
    });
  }
  if (!triggers.length && !digiLayers) throw new SidwaveValidationError(path, "expected at least one sample trigger");
  return { rate, defs, triggers };
}

function normalizeInstruments(raw: unknown, path: string, modern: boolean): Record<string, Record<string, any>> {
  if (raw === undefined) return Object.create(null);
  if (!isPlainObject(raw)) throw new SidwaveValidationError(path, "expected a mapping of instrument names to instruments");
  const result: Record<string, Record<string, any>> = Object.create(null);
  const fields = new Set(["waveform", "wave", "adsr", "pulse_width", "hard_restart", "wavetable", "loop", "pulsetable", "filtertable", "vibrato", "slide", "portamento", "legato", "ring", "sync", ...(modern ? ["source_note"] : [])]);
  for (const [name, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) throw new SidwaveValidationError(`${path}.${name}`, "expected an instrument mapping");
    checkKeys(value, fields, `${path}.${name}`);
    const inst = { ...(value as Record<string, any>) };
    if (inst.source_note !== undefined && !validTablePitch(inst.source_note)) throw new SidwaveValidationError(path + "." + name + ".source_note", "expected a note or signed semitone offset");
    if (inst.legato !== undefined && typeof inst.legato !== "boolean") throw new SidwaveValidationError(`${path}.${name}.legato`, "expected a boolean");
    if (inst.portamento !== undefined) inst.portamento = requireNumber(inst.portamento, `${path}.${name}.portamento`, { min: 0, max: 255, integer: true });
    const ip = `${path}.${name}`;
    if (inst.adsr !== undefined) inst.adsr = parseAdsr(inst.adsr, ip + ".adsr");
    if (inst.pulse_width !== undefined) inst.pulse_width = parsePulseWidth(inst.pulse_width, ip + ".pulse_width", true);
    for (const key of ["waveform", "wave"]) {
      if (inst[key] === undefined) continue;
      const wave = requireText(inst[key], ip + "." + key).toLowerCase();
      if (!WAVEFORMS.has(wave) && !/^(?:tri\+pulse|tri\+saw|saw\+pulse|tri\+saw\+pulse)$/.test(wave)) {
        throw new SidwaveValidationError(ip + "." + key, "unknown instrument waveform");
      }
    }
    for (const flag of ["ring", "sync"]) {
      if (inst[flag] !== undefined && typeof inst[flag] !== "boolean") throw new SidwaveValidationError(ip + "." + flag, "expected a boolean");
    }
    validatePatternFx({ ...(inst.vibrato !== undefined ? { vibrato: inst.vibrato } : {}),
      ...(inst.slide !== undefined ? { slide: inst.slide } : {}) }, ip);
    if (inst.loop !== undefined && inst.wavetable === undefined && !Array.isArray(inst.pulsetable) && !Array.isArray(inst.filtertable)) {
      throw new SidwaveValidationError(ip + ".loop", "needs a wavetable or a step list");
    }
    if (inst.wavetable !== undefined && !Array.isArray(inst.wavetable)) throw new SidwaveValidationError(`${path}.${name}.wavetable`, "expected a list of steps");
    if (inst.wavetable !== undefined) {
      if (!inst.wavetable.length) throw new SidwaveValidationError(`${path}.${name}.wavetable`, "expected at least one step");
      const waves = new Set(["tri", "saw", "pulse", "noise", "tri+pulse", "saw+pulse", "tri+saw", "tri+saw+pulse"]);
      inst.wavetable = inst.wavetable.map((step: any, i: number) => {
        const sp = `${path}.${name}.wavetable[${i}]`;
        if (!isPlainObject(step)) throw new SidwaveValidationError(sp, "expected a step mapping");
        checkKeys(step, new Set(["wave", "test", "gate", "ring", "sync", "note", "frames", ...(modern ? ["calls", "slide_to"] : [])]), sp);
        if (modern && step.wave !== undefined && /noise\+|\+noise/.test(requireText(step.wave, sp + ".wave"))) {
          throw new SidwaveValidationError(`${sp}.wave`, "noise combined with another waveform can lock the noise register; use noise alone");
        }
        if (step.wave !== undefined && !waves.has(requireText(step.wave, sp + ".wave"))) throw new SidwaveValidationError(`${sp}.wave`, "unknown wavetable waveform");
        for (const flag of ["test", "gate", "ring", "sync"]) if (step[flag] !== undefined && typeof step[flag] !== "boolean") throw new SidwaveValidationError(`${sp}.${flag}`, "expected a boolean");
        if (step.frames !== undefined && step.calls !== undefined) throw new SidwaveValidationError(sp, "choose frames or calls");
        if (step.frames !== undefined) requireNumber(step.frames, `${sp}.frames`, { min: 1, max: 255, integer: true });
        if (step.calls !== undefined) requireNumber(step.calls, `${sp}.calls`, { min: 1, max: 255, integer: true });
        if (step.slide_to !== undefined && !validTablePitch(step.slide_to)) throw new SidwaveValidationError(sp + ".slide_to", "expected a note or signed semitone offset");
        if (step.note !== undefined && !validTablePitch(step.note)) throw new SidwaveValidationError(`${sp}.note`, "expected relative semitones such as +12 or an absolute note such as C5");
        return { ...step, frames: step.frames ?? 1, gate: step.gate ?? true };
      });
      if (inst.loop !== undefined) requireNumber(inst.loop, `${path}.${name}.loop`, { min: 0, max: inst.wavetable.length - 1, integer: true });
    }
    if (modern && inst.hard_restart !== undefined) {
      const hp = `${ip}.hard_restart`;
      const restart = requireObject(inst.hard_restart, hp, ["frames", "adsr", "test"]);
      const frames = requireNumber(restart.frames ?? 2, `${hp}.frames`, { min: 0, max: 255, integer: true });
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
    if (inst.pulsetable !== undefined) inst.pulsetable = normalizeRegisterTable(inst.pulsetable, inst.loop, `${ip}.pulsetable`, "set", modern);
    if (inst.filtertable !== undefined) inst.filtertable = normalizeRegisterTable(inst.filtertable, inst.loop, `${ip}.filtertable`, "cutoff", modern);
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

function validTablePitch(value: unknown): boolean {
  return typeof value === "string" && (/^[+-]\d+$/.test(value) || /^[A-Ga-g][#b]?[0-7]$/.test(value));
}

export interface SidwaveRegisterTable {
  steps: Array<{ value: number; add: boolean; frames: number; resonance?: number; type?: number; calls?: number; hz?: string; cadence?: number }>;
  loop?: number;
  reset?: boolean;
}

function normalizeRegisterTable(
  raw: unknown, instrumentLoop: unknown, path: string, setKey: "set" | "cutoff", modern = false,
): SidwaveRegisterTable {
  const mapped = isPlainObject(raw);
  if (mapped) checkKeys(raw, new Set(["steps", "loop", ...(modern ? ["reset"] : [])]), path);
  if (mapped && raw.reset !== undefined && typeof raw.reset !== "boolean") throw new SidwaveValidationError(path + ".reset", "expected boolean");
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
  const keys = new Set([setKey, "add", "frames", ...(modern ? ["calls"] : []), ...(filter ? ["resonance", "type"] : [])]);
  const steps = list.map((step, i) => {
    const sp = `${stepPath}[${i}]`;
    if (!isPlainObject(step)) throw new SidwaveValidationError(sp, "expected a step mapping");
    checkKeys(step, keys, sp);
    const add = step[setKey] === undefined;
    if (add === (step.add === undefined)) throw new SidwaveValidationError(sp, `expected exactly one of ${setKey} or add`);
    if (step.frames !== undefined && step.calls !== undefined) throw new SidwaveValidationError(sp, "choose frames or calls");
    const calls = step.calls === undefined ? undefined : requireNumber(step.calls, sp + ".calls", { min: 1, max: 255, integer: true });
    const frames = calls !== undefined || (step.frames === undefined && !(add && !filter)) ? 1
      : requireNumber(step.frames, `${sp}.frames`, { min: 1, max: 255, integer: true });
    let value: number;
    let hz: string | undefined;
    if (add) {
      value = requireNumber(step.add, `${sp}.add`, { min: -2048, max: 2047, integer: true });
    } else if (filter) {
      const cutoff = parseCutoff(step.cutoff, `${sp}.cutoff`, modern);
      hz = typeof cutoff === "string" ? cutoff : undefined;
      value = typeof cutoff === "number" ? cutoff : 0;
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
    return { value, add, frames, resonance, type, ...(calls === undefined ? {} : { calls }), ...(hz ? { hz } : {}) };
  });
  return { steps, loop, ...(mapped && raw.reset !== undefined ? { reset: raw.reset as boolean } : {}) };
}

function parseTempo(value: unknown, path: string): number {
  if (value === undefined) return 100;
  return requireNumber(value, path, { min: SIDWAVE_TEMPO_RANGE.min, max: SIDWAVE_TEMPO_RANGE.max });
}

function parseMode(value: unknown, path: string): SystemMode {
  if (value === undefined) return "PAL";
  const m = requireText(value, path).toUpperCase();
  if (m !== "PAL" && m !== "NTSC") throw new SidwaveValidationError(path, `expected PAL or NTSC, got ${describeValue(value)}`);
  return m;
}

function parsePulseWidth(raw: unknown, path: string, keepFraction = false): number {
  const pw = requireNumber(raw, path, { min: 0, max: 4095 });
  const register = pw > 0 && pw <= 1 ? Math.round(pw * 4095) : Math.floor(pw);
  if (register <= 0 || (register >= 4095 && !(keepFraction && pw === 1))) {
    throw new SidwaveValidationError(path, "a pulse width of 0% or 100% is silent; use a fraction between 0 and 1 or 1..4094");
  }
  return keepFraction ? pw : register;
}

function normalizeVoice(v: Record<string, any>, path: string, id: number, modern: boolean, meter: number, kit?: Record<string, string>): SidwaveVoice {
  const wfRaw = v.waveform === undefined ? "pulse" : requireText(v.waveform, path + ".waveform").toLowerCase();
  if (!WAVEFORMS.has(wfRaw)) {
    throw new SidwaveValidationError(`${path}.waveform`, `unknown waveform ${describeValue(v.waveform)}; use pulse, sawtooth, triangle or noise`);
  }
  const waveform = normalizeWaveform(wfRaw as Waveform);

  const pulseWidth = v.pulse_width === undefined ? undefined : parsePulseWidth(v.pulse_width, path + ".pulse_width");

  let adsr: [number, number, number, number] = [2, 2, 10, 3];
  if (v.adsr !== undefined) {
    if (!Array.isArray(v.adsr) || v.adsr.length !== 4) {
      throw new SidwaveValidationError(`${path}.adsr`, "expected [attack, decay, sustain, release] with values 0..15");
    }
    adsr = v.adsr.map((n: unknown, i: number) => requireNumber(n, `${path}.adsr[${i}]`, { min: 0, max: 15, integer: true })) as typeof adsr;
  }

  const patterns: Record<string, SidwavePattern> = Object.create(null);
  if (v.patterns !== undefined) {
    if (!isPlainObject(v.patterns)) throw new SidwaveValidationError(`${path}.patterns`, "expected a mapping of pattern names to patterns");
    for (const [name, p] of Object.entries(v.patterns as Record<string, unknown>)) {
      patterns[name] = validatePattern(p, `${path}.patterns.${name}`, modern, meter, kit);
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
    const fx = requireObject(v[kind], ep, kind === "echo" ? ["voice", "delay", "delay_beats", "adsr", "volume", "detune"] : ["voice", "detune"]);
    const voice = requireNumber(fx.voice, `${ep}.voice`, { min: 1, max: 30, integer: true });
    const detune = fx.detune === undefined ? (kind === "echo" ? 0 : 5)
      : requireNumber(fx.detune, `${ep}.detune`, { min: -100, max: 100 });
    if (kind === "echo") {
      if ((fx.delay === undefined) === (fx.delay_beats === undefined)) throw new SidwaveValidationError(ep, "use delay or delay_beats");
      const delay = fx.delay === undefined ? undefined : requireNumber(fx.delay, `${ep}.delay`, { min: 1, max: 65535, integer: true });
      const delay_beats = fx.delay_beats === undefined ? undefined : requireNumber(fx.delay_beats, `${ep}.delay_beats`, { min: 1 / 64, max: 64 });
      const echoAdsr = fx.adsr === undefined ? undefined : parseAdsr(fx.adsr, ep + ".adsr");
      const volume = requireNumber(fx.volume, `${ep}.volume`, { min: 0, max: 1 });
      echo = { voice, delay, delay_beats, volume, detune, adsr: echoAdsr };
    } else {
      unison = { voice, detune };
    }
  }
  const detune = v.detune === undefined ? undefined : requireNumber(v.detune, `${path}.detune`, { min: -100, max: 100 });
  if (detune !== undefined && (!modern || echo || unison)) {
    throw new SidwaveValidationError(`${path}.detune`, "standalone voice detune requires SIDWAVE 1.2 and no echo or unison");
  }
  const level = v.level === undefined ? undefined : parseLevel(v.level, path + ".level");
  const role = v.role;
  if (role !== undefined && !["bass", "lead", "drums", "pad", "arp"].includes(role)) throw new SidwaveValidationError(path + ".role", "unknown role");
  const centerValue = v.center === true ? {} : v.center === undefined || v.center === false ? undefined : requireObject(v.center, path + ".center", ["sid", "channel", "level"]);
  if (centerValue && ((centerValue.sid === undefined) !== (centerValue.channel === undefined))) throw new SidwaveValidationError(path + ".center", "give both sid and channel for an explicit mirror");
  const center = centerValue && {
    sid: centerValue.sid === undefined ? undefined : scalarText(centerValue.sid, path + ".center.sid"),
    channel: centerValue.channel === undefined ? undefined : requireNumber(centerValue.channel, path + ".center.channel", { min: 1, max: 3, integer: true }),
    level: centerValue.level === undefined ? undefined : parseLevel(centerValue.level, path + ".center.level"),
  };
  return {
    id, detune, level, role, center, name: v.name === undefined ? `Voice${id}` : requireText(v.name, path + ".name"), waveform, pulse_width: pulseWidth, adsr,
    instrument: v.instrument === undefined ? undefined : requireText(v.instrument, path + ".instrument"), patterns, echo, unison,
  };
}

function validatePattern(raw: unknown, path: string, modern: boolean, meter: number, defaultKit?: Record<string, string>): SidwavePattern {
  if (!isPlainObject(raw)) throw new SidwaveValidationError(path, "expected a pattern mapping (groove, motif or type: arpeggio)");
  // Copy first: numeric strings are stored as numbers, and the caller's object stays untouched.
  const p = { ...(raw as Record<string, any>) };
  if (modern && p.bars !== undefined) {
    p.bars = requireNumber(p.bars, path + ".bars", { min: 1, max: MAX_SIDWAVE_BARS, integer: true });
  }
  const keys = (base: Set<string>) => modern ? new Set([...base, "bars"]) : base;
  if (modern && p.motif !== undefined) {
    checkKeys(p, keys(MOTIF_KEYS), path);
    p.groove = compactTokens(requireText(p.motif, path + ".motif"), path + ".motif", defaultKit, requireText(p.root ?? "C3", path + ".root"));
    delete p.motif;
    delete p.root;
  }
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
      throw new SidwaveValidationError(`${path}.type`, `unknown pattern type ${describeValue(p.type)}; only 'arpeggio' is supported (a pattern with 'notes' is an arpeggio)`);
    }
    checkKeys(p, keys(ARP_KEYS), path);
    if (!Array.isArray(p.notes) || p.notes.length === 0) throw new SidwaveValidationError(`${path}.notes`, "expected a non-empty list of note names");
    p.notes.forEach((n: unknown, i: number) => requireNote(n, `${path}.notes[${i}]`));
    if (p.frame_rate !== undefined) requireNumber(p.frame_rate, `${path}.frame_rate`, { min: 1, max: 50, integer: true });
    if (modern) checkPatternBars(p, undefined, meter, path);
    return p as SidwavePatternArp;
  }
  if (p.groove !== undefined || p.drums !== undefined) {
    checkKeys(p, keys(GROOVE_KEYS), path);
    if (p.drums !== undefined && p.groove !== undefined) throw new SidwaveValidationError(`${path}.drums`, "use either groove or drums, not both");
    if (p.drums !== undefined) {
      const d = p.drums;
      if (!isPlainObject(d) || !(isPlainObject(d.kit) || (modern && d.kit === undefined && defaultKit)) || typeof d.steps !== "string" || !Object.keys(d).every((k) => ["kit", "steps"].includes(k))) throw new SidwaveValidationError(`${path}.drums`, "expected { kit: { letter: instrument }, steps: 'k.h.s.h' }");
      const kit = (d.kit ?? defaultKit) as Record<string, unknown>;
      if (!Object.keys(kit).length || Object.keys(kit).some((k) => k.length !== 1 || !/^[a-z]$/i.test(k) || typeof kit[k] !== "string")) throw new SidwaveValidationError(`${path}.drums.kit`, "expected one-letter keys mapped to instrument names");
      p.groove = [...(modern ? d.steps.replace(/\s/g, "") : d.steps)].map((ch: string, i: number) => {
        if (ch === ".") return "-";
        if (modern && ch === "|") return "|";
        const inst = kit[ch];
        if (typeof inst !== "string") throw new SidwaveValidationError(`${path}.drums.steps[${i}]`, `no kit instrument for ${describeValue(ch)}`);
        return { note: "C3", inst, ...(modern ? { kitNote: true } : {}) };
      });
      delete p.drums;
    }
    if (modern && typeof p.groove === "string") p.groove = compactTokens(p.groove, path + ".groove", defaultKit);
    else if (modern && Array.isArray(p.groove)) p.groove = p.groove.flatMap((value: unknown) => typeof value === "string"
      ? compactTokens(value, path + ".groove", defaultKit) : [value]);
    if (modern) checkPatternBars(p, p.groove, meter, path);
    if (!Array.isArray(p.groove) || p.groove.length === 0) throw new SidwaveValidationError(`${path}.groove`, "expected a non-empty list of notes, '-' rests or '~' ties");
    // An unquoted ~ in YAML is null; it is the tie token, so read it as one.
    p.groove = p.groove.map((n: unknown) => (n === null ? "~" : n));
    p.groove = p.groove.map((n: unknown, i: number) => {
      if (isPlainObject(n)) {
        const entry = { ...n };
        const np = `${path}.groove[${i}]`;
        if (modern && entry.chord !== undefined) {
          checkKeys(entry, new Set(["chord", "arp", "speed", "inst", "len", "legato", "level", "accented", "glide"]), np);
          parseChordArp({ chord: entry.chord, arp: entry.arp, speed: entry.speed }, np);
        } else {
          checkKeys(entry, new Set(["note", "inst", "len", "legato", "portamento", "slide_from", ...(modern ? ["bend", "gate_off", "level", "accented", "glide", "kitNote"] : [])]), np);
          requireNote(entry.note, `${np}.note`);
        }
        if (entry.inst !== undefined && typeof entry.inst !== "string") throw new SidwaveValidationError(`${path}.groove[${i}].inst`, "expected an instrument name");
        if (entry.level !== undefined) entry.level = parseLevel(entry.level, np + ".level");
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
      const tok = requireText(n, `${path}.groove[${i}]`).trim();
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
    parseMotif(requireText(p.motif, path + ".motif"), p.root === undefined ? "C3" : String(p.root), `${path}.motif`);
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
  const durations = (["steps", "beats", "bars", "frames"] as const).filter((unit) => v[unit] !== undefined);
  if (durations.length > 1) throw new SidwaveValidationError(path, "choose one sweep duration");
  if (typeof v.sweep === "string" && !Number.isFinite(Number(v.sweep.trim()))) {
    const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*(?:over\s+(\d+(?:\.\d+)?)\s*(steps?|beats?|bars?|frames?))?\s*$/i.exec(v.sweep);
    if (!m) throw new SidwaveValidationError(`${path}.sweep`, `expected e.g. "+500 over 8 steps", got ${describeValue(v.sweep)}`);
    const sweep = Number(m[1]);
    if (durations.length) throw new SidwaveValidationError(path, "the sweep text already supplies its duration");
    const amount = Number(m[2]);
    const unit = (m[3] ? m[3].toLowerCase().replace(/s$/, "") + "s" : "steps") as FilterModSpec["unit"];
    return checkFilterMod({ sweep, amount, unit }, path);
  }
  const sweep = requireNumber(v.sweep, `${path}.sweep`, { min: -2047, max: 2047 });
  for (const unit of durations) {
    if (v[unit] !== undefined) return checkFilterMod({ sweep, amount: requireNumber(v[unit], `${path}.${unit}`, { min: 0, exclusiveMin: true }), unit }, path);
  }
  return checkFilterMod({ sweep, amount: 1, unit: "steps" }, path);
}

function checkFilterMod(spec: FilterModSpec, path: string): FilterModSpec {
  if (Math.abs(spec.sweep) > 2047) throw new SidwaveValidationError(`${path}.sweep`, "must be within -2047..2047 cutoff units");
  if (!(spec.amount > 0)) throw new SidwaveValidationError(path, "sweep duration must be positive");
  return spec;
}

function parseGlobalFx(raw: unknown, path: string, modern = false): Record<string, unknown> {
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
  if (fx.filter_env !== undefined) fx.filter_env = parseFilterEnv(fx.filter_env, `${path}.filter_env`, modern);
  return fx;
}

function parseFilterEnv(raw: unknown, path: string, modern = false): Record<string, unknown> {
  const v = requireObject(raw, path, ["cutoff_base", "sweep", "speed", "resonance", "type", "voices"]);
  v.cutoff_base = parseCutoff(v.cutoff_base, `${path}.cutoff_base`, modern);
  if (v.sweep !== undefined) requireNumber(v.sweep, `${path}.sweep`, { min: -2047, max: 2047 });
  if (v.speed !== undefined) requireNumber(v.speed, `${path}.speed`, { min: 0, max: 1024, exclusiveMin: true });
  if (v.resonance !== undefined) requireNumber(v.resonance, `${path}.resonance`, { min: 0, max: 15, integer: true });
  if (v.type !== undefined && !["lowpass", "bandpass", "highpass"].includes(requireText(v.type, path + ".type").toLowerCase())) {
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

const LEVELS: Record<string, number> = { pp: 4, p: 6, mp: 8, mf: 10, f: 12, ff: 15 };
function parseLevel(raw: unknown, path: string): number {
  return typeof raw === "string" && hasOwn(LEVELS, raw) ? LEVELS[raw]! :
    requireNumber(raw, path, { min: 1, max: 15, integer: true });
}

function parseAdsr(raw: unknown, path: string): [number, number, number, number] {
  if (!Array.isArray(raw) || raw.length !== 4) throw new SidwaveValidationError(path, "expected four ADSR nibbles");
  return raw.map((n, i) => requireNumber(n, `${path}[${i}]`, { min: 0, max: 15, integer: true })) as [number, number, number, number];
}

function normalizeKit(raw: unknown, path: string): Record<string, string> {
  if (!isPlainObject(raw) || !Object.keys(raw).length) throw new SidwaveValidationError(path, "expected kit keys mapped to instruments");
  for (const [key, instrument] of Object.entries(raw)) {
    if (!/^[A-Za-z]$/.test(key) || key.toUpperCase() in CHORD_QUALITIES || /^[A-Ga-g]$/.test(key) || typeof instrument !== "string") {
      throw new SidwaveValidationError(path + "." + key, "use a one-letter key that is not a note, chord, rest or tie");
    }
  }
  return { ...raw } as Record<string, string>;
}

function compactTokens(text: string, path: string, kit?: Record<string, string>, motifRoot?: string): unknown[] {
  const entries: unknown[] = [];
  let inSlur = false;
  let first = true;
  for (const token of text.match(/[()|]|[^\s,()|]+/g) ?? []) {
    if (token === "(") {
      if (inSlur) throw new SidwaveValidationError(path, "slurs cannot nest");
      inSlur = first = true;
    } else if (token === ")") {
      if (!inSlur || first) throw new SidwaveValidationError(path, "unmatched or empty slur");
      inSlur = false;
    } else if (token === "|" || isRestToken(token) || isTieToken(token)) {
      entries.push(token);
    } else {
      const match = /^(\/?)([^!@]+)(!?)(?:@([^@!]+))?$/.exec(token);
      if (!match) throw new SidwaveValidationError(path, `invalid note token ${token}; use [/ ]NOTE[!][@inst] without spaces`);
      const [, slash, note, accent, instrument] = match;
      const inst = kit?.[note!];
      const flags = { ...(inSlur && !first ? { legato: true } : {}),
        ...(slash ? { glide: true } : {}), ...(accent ? { accented: true } : {}) };
      if (inst) entries.push({ note: "C3", inst, kitNote: true, ...flags });
      else if (instrument === "arp") entries.push({ chord: note, ...flags });
      else if (motifRoot === undefined || noteNameToMidi(note!) !== undefined) {
        entries.push(Object.keys(flags).length || motifRoot !== undefined ? { note, ...(instrument ? { inst: instrument } : {}), ...flags } : token);
      }
      else {
        const midis = parseMotif(note!, motifRoot, path, true) as number[];
        midis.forEach((midi, i) => entries.push({ note: midiToNoteName(midi), ...(instrument ? { inst: instrument } : {}),
          ...flags, ...(inSlur && i > 0 ? { legato: true } : {}) }));
      }
      first = false;
    }
  }
  if (inSlur) throw new SidwaveValidationError(path, "unclosed slur");
  return entries;
}

function checkPatternBars(pattern: any, groove: any, meter: number, path: string): void {
  const len = Number(pattern.length ?? 1);
  if (Array.isArray(groove)) {
    let beats = 0;
    let total = 0;
    let group = 1;
    const lined = groove.includes("|");
    for (const entry of [...groove, "|"]) {
      if (entry === "|") {
        if (lined && Math.abs(beats - meter) > 1e-8) throw new SidwaveValidationError(path, `group ${group} lasts ${beats} beats; expected ${meter}`);
        group++;
        total += beats;
        beats = 0;
      } else beats += Number(entry?.len ?? len);
    }
    if (lined) pattern.groove = groove.filter((entry) => entry !== "|");
    if (pattern.bars !== undefined && Math.abs(total - meter * pattern.bars) > 1e-8) {
      throw new SidwaveValidationError(path, `pattern lasts ${total} beats; expected ${meter * pattern.bars}`);
    }
  } else if (pattern.bars !== undefined && Math.abs(patternBeats(pattern) - meter * pattern.bars) > 1e-8) {
    throw new SidwaveValidationError(path, `pattern lasts ${patternBeats(pattern)} beats; expected ${meter * pattern.bars}`);
  }
}

export function patternBeats(pattern: SidwavePattern): number {
  const len = pattern.length ?? 1;
  if ("groove" in pattern) return pattern.groove.reduce((sum, entry) => sum + (typeof entry === "object" ? Number(entry.len ?? len) : len), 0);
  if ("notes" in pattern) return pattern.frame_rate === undefined ? pattern.notes.length * len : len;
  return parseMotif((pattern as SidwavePatternMotif).motif!, (pattern as SidwavePatternMotif).root ?? "C3", "$.pattern").length * len;
}

export function parseLayerSequence(ref: string, patterns: string[], path: string): { items: LayerRef[]; sequence: boolean } {
  const sequence = !patterns.includes(ref) && /[\s*()]/.test(ref);
  const parse = (item: string) => {
    const layer = parseLayerRef(item, patterns);
    if (layer.pattern !== null && !patterns.includes(layer.pattern)) {
      throw new SidwaveValidationError(path, `pattern ${describeValue(item)} is not defined${patterns.length ? ` (known: ${patterns.join(", ")})` : ""}`);
    }
    if (sequence && layer.fade) throw new SidwaveValidationError(path, "use a section level ramp to fade a sequence");
    return layer;
  };
  if (!sequence) return { items: [parse(ref)], sequence };
  const tokens = ref.match(/[()]|\*[^\s()*]*|[^\s()*]+/g) ?? [];
  let pos = 0;
  const read = (nested: boolean): LayerRef[] => {
    const result: LayerRef[] = [];
    while (pos < tokens.length && tokens[pos] !== ")") {
      const token = tokens[pos++]!;
      if (token.startsWith("*") || (nested && token === "(")) throw new SidwaveValidationError(path, "invalid sequence or nested group");
      const group = token === "(";
      const items = group ? read(true) : [parse(token)];
      if (group && (tokens[pos++] !== ")" || !items.length || !tokens[pos]?.startsWith("*"))) {
        throw new SidwaveValidationError(path, "a sequence group needs a closing ')' and repeat count");
      }
      const count = tokens[pos]?.startsWith("*")
        ? requireNumber(tokens[pos++]!.slice(1), path, { min: 1, max: MAX_SIDWAVE_BARS, integer: true }) : 1;
      if (result.length + items.length * count > 16_384) throw new SidwaveValidationError(path, "sequence is too long");
      for (let i = 0; i < count; i++) result.push(...items);
    }
    return result;
  };
  const items = read(false);
  if (pos !== tokens.length || !items.length) throw new SidwaveValidationError(path, "unmatched sequence parenthesis");
  return { items, sequence };
}

function normalizeForm(raw: unknown[], definitions: unknown, voices: SidwaveVoice[],
  digis: NonNullable<ParsedSidwave["digiVoices"]>, sids: SidMapEntry[], meter: number): SidwaveTimelineSection[] {
  const names = definitions === undefined ? {} : definitions;
  if (!isPlainObject(names)) throw new SidwaveValidationError("$.sections", "expected named sections");
  for (const [name, value] of Object.entries(names)) {
    if (!/^[A-Za-z_][\w-]*$/.test(name) || !isPlainObject(value)) throw new SidwaveValidationError("$.sections." + name, "invalid named section");
    formSection(value, "$.sections." + name, voices, digis, sids, meter);
  }
  const timeline: SidwaveTimelineSection[] = [];
  let bars = 0;
  raw.forEach((entry, i) => {
    const path = `$.timeline[${i}]`;
    let name: string | undefined;
    let overrides: Record<string, any> = {};
    let count = 1;
    if (typeof entry === "string") {
      const [ref, repeat, ...extra] = entry.split("*");
      if (extra.length) throw new SidwaveValidationError(path, "invalid section repetition");
      const suffix = hasOwn(names, ref!) ? null : /([+-]\d+)$/.exec(ref!);
      name = suffix ? ref!.slice(0, suffix.index) : ref;
      if (suffix) overrides.transpose = Number(suffix[1]);
      if (repeat !== undefined) count = requireNumber(repeat, path, { min: 1, max: MAX_SIDWAVE_BARS, integer: true });
    } else {
      if (!isPlainObject(entry)) throw new SidwaveValidationError(path, "expected an inline section or named reference");
      const { use, ...rest } = entry;
      if (use !== undefined && typeof use !== "string") throw new SidwaveValidationError(path + ".use", "expected a section name");
      name = use;
      overrides = rest;
    }
    let definition = overrides;
    if (name !== undefined) {
      if (!hasOwn(names, name)) throw new SidwaveValidationError(path, `unknown section ${name}`);
      const base = names[name] as Record<string, any>;
      if (overrides.layers !== undefined && !isPlainObject(overrides.layers)) throw new SidwaveValidationError(path + ".layers", "expected a mapping");
      definition = { ...base, ...overrides, section: name, layers: { ...base.layers, ...overrides.layers } };
    }
    const section = formSection(definition, path, voices, digis, sids, meter);
    bars += section.bars * count;
    if (bars > MAX_SIDWAVE_BARS) throw new SidwaveValidationError(path, `timeline exceeds ${MAX_SIDWAVE_BARS} bars`);
    for (let j = 0; j < count; j++) timeline.push(section);
  });
  return timeline;
}

function formSection(t: Record<string, any>, path: string, voices: SidwaveVoice[],
  digis: NonNullable<ParsedSidwave["digiVoices"]>, sids: SidMapEntry[], meter: number): SidwaveTimelineSection {
  checkKeys(t, new Set([...SECTION_KEYS, "level", "levels", "volume", "filter", "transpose"]), path);
  const layers: Record<string, string> = {};
  if (t.layers !== undefined && !isPlainObject(t.layers)) throw new SidwaveValidationError(path + ".layers", "expected a mapping");
  let inferred = 0;
  for (const [raw, value] of Object.entries(t.layers ?? {})) {
    const id = LAYER_KEY.exec(raw)?.[1];
    const key = id ? `v${id}` : raw;
    const patterns = (id ? voices.find((v) => v.id === Number(id)) : digis.find((v) => v.id === raw))?.patterns;
    if (!id && !digis.some((v) => v.id === raw)) throw new SidwaveValidationError(path + ".layers." + raw, "unknown layer");
    const ref = value == null ? "-" : requireText(value, path + ".layers." + raw).trim();
    if (hasOwn(layers, key)) throw new SidwaveValidationError(path + ".layers." + raw, "voice assigned twice");
    const sequence = parseLayerSequence(ref, Object.keys(patterns ?? {}), path + ".layers." + raw);
    inferred = Math.max(inferred, sequence.items.reduce((sum, item) => sum + (item.pattern ? patternBeats(patterns![item.pattern]!) : meter), 0));
    layers[key] = ref;
  }
  const bars = requireNumber(t.bars ?? inferred / meter, path + ".bars", { min: 1, max: MAX_SIDWAVE_BARS, integer: true });
  const numberAt = (min: number, max: number) => (value: unknown, name: string) => requireNumber(value, name, { min, max, integer: true });
  const ramp = (raw: unknown, name: string, parse: typeof parseLevel): SidwaveRamp => {
    if (!isPlainObject(raw)) return parse(raw, name);
    checkKeys(raw, new Set(["from", "to", "bars"]), name);
    return { from: raw.from === undefined ? undefined : parse(raw.from, name + ".from"), to: parse(raw.to, name + ".to"),
      bars: raw.bars === undefined ? undefined : requireNumber(raw.bars, name + ".bars", { min: 1, max: bars }) };
  };
  const level = t.level === undefined ? undefined : ramp(t.level, path + ".level", parseLevel);
  const levels = t.levels === undefined ? undefined : Object.fromEntries(Object.entries(requireObject(t.levels, path + ".levels", voices.map((v) => `v${v.id}`)))
    .map(([key, value]) => [key, ramp(value, path + ".levels." + key, parseLevel)]));
  const ids = sids.map(({ id }) => id);
  const volume = t.volume === undefined ? undefined : isPlainObject(t.volume) && ids.some((id) => hasOwn(t.volume, id))
    ? Object.fromEntries(Object.entries(requireObject(t.volume, path + ".volume", ids)).map(([id, value]) =>
      [id, ramp(value, path + ".volume." + id, numberAt(0, 15))]))
    : Object.fromEntries(ids.map((id) => [id, ramp(t.volume, path + ".volume", numberAt(0, 15))]));
  const filterMove = (raw: unknown, name: string): SidwaveFilterMove => {
    const move = requireObject(raw, name, ["cutoff", "resonance"]);
    return { cutoff: move.cutoff === undefined ? undefined : ramp(move.cutoff, name + ".cutoff", numberAt(-2047, 2047)),
      resonance: move.resonance === undefined ? undefined : numberAt(0, 15)(move.resonance, name + ".resonance") };
  };
  const filter = t.filter === undefined ? undefined : isPlainObject(t.filter) && ids.some((id) => hasOwn(t.filter, id))
    ? Object.fromEntries(Object.entries(requireObject(t.filter, path + ".filter", ids)).map(([id, value]) => [id, filterMove(value, path + ".filter." + id)]))
    : Object.fromEntries(ids.map((id) => [id, filterMove(t.filter, path + ".filter")]));
  const tempo = t.tempo === undefined ? undefined : isPlainObject(t.tempo)
    ? { to: parseTempo(requireObject(t.tempo, path + ".tempo", ["to"]).to, path + ".tempo.to") }
    : parseTempo(t.tempo, path + ".tempo");
  const swing = t.swing === undefined ? undefined : requireNumber(t.swing, path + ".swing", { min: 0.5, max: 0.75 });
  const transpose = t.transpose === undefined ? undefined : numberAt(-96, 96)(t.transpose, path + ".transpose");
  return { section: t.section === undefined ? "" : requireText(t.section, path + ".section"), bars, tempo, swing, transpose, layers, level, levels, volume, filter };
}

function parseCutoff(raw: unknown, path: string, modern: boolean): number | string {
  if (modern && typeof raw === "string" && /^(?:\d+(?:\.\d+)?|\.\d+)k?Hz$/i.test(raw)) {
    if (parseFloat(raw) <= 0) throw new SidwaveValidationError(path, "cutoff frequency must be positive");
    return raw;
  }
  return requireNumber(raw, path, { min: 0, max: 2047 });
}

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
    const ref = v === null || v === undefined ? "-" : requireText(v, `${path}.layers.${k}`).trim();
    const voice = voices.find((vv) => vv.id === id);
    const parsed = parseLayerRef(ref, Object.keys(voice?.patterns ?? {}));
    if (parsed.pattern !== null) {
      if (!voice) throw new SidwaveValidationError(`${path}.layers.${k}`, `voice ${id} is not declared in voices`);
      if (!hasOwn(voice.patterns ?? {}, parsed.pattern)) {
        const known = Object.keys(voice.patterns ?? {});
        throw new SidwaveValidationError(`${path}.layers.${k}`, `pattern ${describeValue(ref)} is not defined for voice ${id}${known.length ? ` (known: ${known.join(", ")})` : ""}`);
      }
    }
    layers[key] = ref;
  }
  return { section: t.section === undefined ? "" : requireText(t.section, path + ".section"), bars, tempo, swing, layers };
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
  if (midi === undefined) throw new SidwaveValidationError(path, `invalid note ${describeValue(raw)}; use names such as C4, Eb3 or F#2`);
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
export function parseMotif(motif: string, root: string, path: string, strict = false): MotifEntry[] {
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
    if (chord && hasOwn(CHORD_QUALITIES, chord[3]!)) {
      const base = noteNameToMidi(`${chord[1]}${chord[2]}${rootOctave}`)!;
      for (const iv of CHORD_QUALITIES[chord[3]]!) {
        const midi = base + iv;
        if (midi > SIDWAVE_NOTE_RANGE.max) throw new SidwaveValidationError(path, `chord ${token} leaves the range C0..B7`);
        entries.push(midi);
      }
      continue;
    }
    if (!strict && /^[A-Za-z]+$/.test(token)) continue; // descriptive word
    throw new SidwaveValidationError(path, `unrecognised motif token ${describeValue(token)}; use notes (C4), semitone offsets (0 4 7), chord symbols (Cmin9), '-' or '~'`);
  }
  if (!entries.some((e) => typeof e === "number")) {
    throw new SidwaveValidationError(path, `motif ${describeValue(motif)} contains no notes; use notes (C4 Eb4 G4), semitone offsets (0 3 7) or a chord symbol (Cmin9)`);
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
  if (typeof n !== "number" || !Number.isFinite(n)) throw new SidwaveValidationError(path, `expected a number, got ${describeValue(raw)}`);
  if (opts.integer && !Number.isInteger(n)) throw new SidwaveValidationError(path, `expected a whole number, got ${n}`);
  if (opts.min !== undefined && (opts.exclusiveMin ? n <= opts.min : n < opts.min)) {
    throw new SidwaveValidationError(path, `${n} is below the minimum ${opts.exclusiveMin ? "(exclusive) " : ""}${opts.min}`);
  }
  if (opts.max !== undefined && n > opts.max) throw new SidwaveValidationError(path, `${n} is above the maximum ${opts.max}`);
  return n;
}

function hasOwn(obj: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(obj, key); }

function clipText(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + "…";
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(clipText(value, 80));
  if (Array.isArray(value)) return `an array (${value.length} elements)`;
  if (value !== null && typeof value === "object") return "a mapping";
  return String(value);
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== "string") throw new SidwaveValidationError(path, "expected text");
  return value;
}

function scalarText(value: unknown, path: string): string {
  return typeof value === "number" ? String(value) : requireText(value, path);
}
