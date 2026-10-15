/*
C64 Bridge - SIDWAVE Parser and Types
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

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
  groove: string[];
}

export type SidwavePattern = SidwavePatternArp | SidwavePatternMotif | SidwavePatternGroove;

export interface SidwaveVoice {
  id: number; // 1..3
  name?: string;
  waveform?: Waveform;
  pulse_width?: number;
  adsr?: [number, number, number, number];
  patterns?: Record<string, SidwavePattern>;
}

export interface SidwaveTimelineSection {
  section?: string;
  bars: number;
  layers: Record<string, string>;
}

export interface SidwaveDocument {
  sidwave?: number | string;
  title?: string;
  author?: string;
  tempo?: number;
  mode?: SystemMode;
  length_bars?: number;
  global_fx?: Record<string, unknown>;
  voices?: SidwaveVoice[];
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
  song: Required<Pick<SidwaveSongMeta, "title" | "tempo" | "mode">> & {
    author?: string;
    length_bars: number;
    global_fx: Record<string, unknown>;
  };
  voices: SidwaveVoice[];
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

const TOP_LEVEL_KEYS = new Set(["sidwave", "title", "author", "tempo", "mode", "length_bars", "global_fx", "voices", "timeline"]);
const LEGACY_KEYS = new Set(["song", "voices", "timeline"]);
const LEGACY_SONG_KEYS = new Set(["title", "author", "tempo", "mode", "length_bars", "global_fx"]);
const VOICE_KEYS = new Set(["id", "name", "waveform", "pulse_width", "adsr", "patterns"]);
const ARP_KEYS = new Set(["type", "notes", "frame_rate", "length", "transpositions", "fx"]);
const GROOVE_KEYS = new Set(["groove", "length", "transpositions", "fx"]);
const MOTIF_KEYS = new Set(["motif", "root", "length", "transpositions", "fx"]);
const SECTION_KEYS = new Set(["section", "bars", "layers"]);
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
    if (obj.sidwave !== undefined && !["1", "1.0"].includes(String(obj.sidwave))) {
      throw new SidwaveValidationError("$.sidwave", `unsupported version ${JSON.stringify(obj.sidwave)}; use 1.0`);
    }
  }
  const header = (legacy ? obj.song : obj) as Record<string, unknown>;
  const headerPath = legacy ? "$.song" : "$";

  const title = header.title === undefined ? "Untitled" : String(header.title);
  const author = header.author === undefined ? undefined : String(header.author);
  const tempo = parseTempo(header.tempo, `${headerPath}.tempo`);
  const mode = parseMode(header.mode, `${headerPath}.mode`);
  const global_fx = parseGlobalFx(header.global_fx, `${headerPath}.global_fx`);

  if (!Array.isArray(obj.voices) || obj.voices.length === 0) {
    throw new SidwaveValidationError("$.voices", "missing voices (expected a list of 1 to 3 voices)");
  }
  if (obj.voices.length > 3) {
    throw new SidwaveValidationError("$.voices", `the SID has 3 voices; ${obj.voices.length} were given`);
  }
  const voices = obj.voices.map((v: unknown, i: number) => normalizeVoice(v, `$.voices[${i}]`));
  const seen = new Set<number>();
  voices.forEach((v: SidwaveVoice, i: number) => {
    if (seen.has(v.id)) throw new SidwaveValidationError(`$.voices[${i}].id`, `voice id ${v.id} is declared more than once`);
    seen.add(v.id);
  });

  if (!Array.isArray(obj.timeline) || obj.timeline.length === 0) {
    throw new SidwaveValidationError("$.timeline", "missing timeline (expected a list of sections)");
  }
  const timeline = obj.timeline.map((t: unknown, i: number) => normalizeTimelineSection(t, `$.timeline[${i}]`, voices));

  const timelineBars = timeline.reduce((sum: number, s: SidwaveTimelineSection) => sum + s.bars, 0);
  let length_bars = timelineBars;
  if (header.length_bars !== undefined) {
    length_bars = requireNumber(header.length_bars, `${headerPath}.length_bars`, { min: 1, integer: true });
  }

  const song: ParsedSidwave["song"] = { title, tempo, mode, length_bars, global_fx };
  if (author !== undefined) song.author = author;
  return { song, voices, timeline };
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

function normalizeVoice(raw: unknown, path: string): SidwaveVoice {
  if (!isPlainObject(raw)) throw new SidwaveValidationError(path, "expected a voice mapping");
  const v = raw as Record<string, any>;
  checkKeys(v, VOICE_KEYS, path);
  const id = requireNumber(v.id, `${path}.id`, { min: 1, max: 3, integer: true });

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
      patterns[name] = validatePattern(p, `${path}.patterns.${name}`);
    }
  }

  return { id, name: v.name === undefined ? `Voice${id}` : String(v.name), waveform, pulse_width: pulseWidth, adsr, patterns };
}

function validatePattern(raw: unknown, path: string): SidwavePattern {
  if (!isPlainObject(raw)) throw new SidwaveValidationError(path, "expected a pattern mapping (groove, motif or type: arpeggio)");
  const p = raw as Record<string, any>;
  if (p.length !== undefined) requireNumber(p.length, `${path}.length`, { min: 1 / 64, max: 64 });
  if (p.transpositions !== undefined) {
    if (!Array.isArray(p.transpositions) || p.transpositions.length === 0) {
      throw new SidwaveValidationError(`${path}.transpositions`, "expected a non-empty list of semitone offsets");
    }
    p.transpositions.forEach((t: unknown, i: number) => requireNumber(t, `${path}.transpositions[${i}]`, { min: -48, max: 48, integer: true }));
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
  if (p.groove !== undefined) {
    checkKeys(p, GROOVE_KEYS, path);
    if (!Array.isArray(p.groove) || p.groove.length === 0) throw new SidwaveValidationError(`${path}.groove`, "expected a non-empty list of notes, '-' rests or '~' ties");
    p.groove.forEach((n: unknown, i: number) => {
      const tok = String(n).trim();
      if (!isRestToken(tok) && !isTieToken(tok)) requireNote(n, `${path}.groove[${i}]`);
    });
    return p as SidwavePatternGroove;
  }
  if (p.motif !== undefined) {
    checkKeys(p, MOTIF_KEYS, path);
    if (p.root !== undefined) requireNote(p.root, `${path}.root`);
    parseMotif(String(p.motif), p.root === undefined ? "C3" : String(p.root), `${path}.motif`);
    return p as SidwavePatternMotif;
  }
  throw new SidwaveValidationError(path, "a pattern needs 'groove', 'motif' or 'type: arpeggio' with 'notes'");
}

function validatePatternFx(raw: unknown, path: string): void {
  if (!isPlainObject(raw)) throw new SidwaveValidationError(path, "expected a mapping");
  const fx = raw as Record<string, any>;
  checkKeys(fx, PATTERN_FX_KEYS, path);
  if (fx.vibrato !== undefined) {
    const v = requireObject(fx.vibrato, `${path}.vibrato`, ["depth", "rate", "delay"]);
    requireNumber(v.depth, `${path}.vibrato.depth`, { min: 0.03, max: 6 });
    requireNumber(v.rate, `${path}.vibrato.rate`, { min: 0.2, max: 25 });
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
  const fx = raw as Record<string, any>;
  checkKeys(fx, GLOBAL_FX_KEYS, path);
  if (fx.reverb_sim !== undefined) {
    const v = requireObject(fx.reverb_sim, `${path}.reverb_sim`, ["depth", "delay_frames"]);
    requireNumber(v.depth, `${path}.reverb_sim.depth`, { min: 0, max: 1, exclusiveMin: true });
    requireNumber(v.delay_frames, `${path}.reverb_sim.delay_frames`, { min: 1, max: 50, integer: true });
  }
  if (fx.filter_env !== undefined) {
    const v = requireObject(fx.filter_env, `${path}.filter_env`, ["cutoff_base", "sweep", "speed", "resonance", "type", "voices"]);
    requireNumber(v.cutoff_base, `${path}.filter_env.cutoff_base`, { min: 0, max: 2047 });
    if (v.sweep !== undefined) requireNumber(v.sweep, `${path}.filter_env.sweep`, { min: -2047, max: 2047 });
    if (v.speed !== undefined) requireNumber(v.speed, `${path}.filter_env.speed`, { min: 0, max: 1024, exclusiveMin: true });
    if (v.resonance !== undefined) requireNumber(v.resonance, `${path}.filter_env.resonance`, { min: 0, max: 15, integer: true });
    if (v.type !== undefined && !["lowpass", "bandpass", "highpass"].includes(String(v.type).toLowerCase())) {
      throw new SidwaveValidationError(`${path}.filter_env.type`, "expected lowpass, bandpass or highpass");
    }
    if (v.voices !== undefined) {
      if (!Array.isArray(v.voices)) throw new SidwaveValidationError(`${path}.filter_env.voices`, "expected a list of voice ids");
      v.voices.forEach((id: unknown, i: number) => requireNumber(id, `${path}.filter_env.voices[${i}]`, { min: 1, max: 3, integer: true }));
    }
  }
  return fx;
}

function normalizeWaveform(w: Waveform): Waveform {
  if (w === "saw") return "sawtooth";
  if (w === "tri") return "triangle";
  return w;
}

const LAYER_KEY = /^(?:v|voice)?([1-3])$/i;

function normalizeTimelineSection(raw: unknown, path: string, voices: SidwaveVoice[]): SidwaveTimelineSection {
  if (!isPlainObject(raw)) throw new SidwaveValidationError(path, "expected a section mapping with bars and layers");
  const t = raw as Record<string, any>;
  checkKeys(t, SECTION_KEYS, path);
  const bars = requireNumber(t.bars, `${path}.bars`, { min: 1, integer: true });
  const layers: Record<string, string> = {};
  if (t.layers !== undefined && !isPlainObject(t.layers)) throw new SidwaveValidationError(`${path}.layers`, "expected a mapping such as { v1: A, v2: \"-\" }");
  for (const [k, v] of Object.entries((t.layers ?? {}) as Record<string, unknown>)) {
    const km = LAYER_KEY.exec(k);
    if (!km) throw new SidwaveValidationError(`${path}.layers.${k}`, "layer keys must be v1, v2 or v3");
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
  return { section: t.section === undefined ? "" : String(t.section), bars, layers };
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
