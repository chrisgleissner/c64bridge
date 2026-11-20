/*
C64 Bridge - SIDWAVE to PRG Compiler
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { Buffer } from "node:buffer";
import { assemblyToPrgDetailed } from "./tools/translation/assembler.js";
import type { ParsedSidwave, SystemMode, SidwaveVoice, SidwavePattern, SidwavePatternGroove, MotifEntry, SidwaveRegisterTable, FilterModSpec } from "./sidwave.js";
import {
  SidwaveValidationError,
  isRestToken,
  isTieToken,
  midiToHz,
  midiToNoteName,
  noteNameToMidi,
  parseFilterMod,
  parseLayerRef,
  parseMotif,
} from "./sidwave.js";

/** Standalone PRG start address (`10 SYS2061`). */
export const SIDWAVE_PRG_ENTRY = 0x080d;
/** PSID init routine (A = song number, ignored). */
export const SIDWAVE_INIT_ADDRESS = 0x0810;
/** PSID play routine, called once per video frame. */
export const SIDWAVE_PLAY_ADDRESS = 0x0813;
export const SIDWAVE_LOAD_ADDRESS = 0x0801;
/** The player and its data must end below the I/O area at $D000. */
export const SIDWAVE_MEMORY_END = 0xd000;
/** Frames of gate-off with zeroed ADSR before every new note (hard restart). */
export const SIDWAVE_HARD_RESTART_FRAMES = 2;
/** Shortest note: one frame with the gate on plus the hard restart before the next note. */
export const SIDWAVE_MIN_NOTE_FRAMES = SIDWAVE_HARD_RESTART_FRAMES + 1;
/** BASIC's memory ends where the BASIC ROM starts. */
export const SIDWAVE_BASIC_END = 0xa000;

export interface CompileResult {
  prg: Buffer;
  /** SYS address of the standalone PRG; it installs an IRQ that plays the song and returns to BASIC. */
  entryAddress: number;
  initAddress: number;
  playAddress: number;
  loadAddress: number;
  /** First address after the program. */
  endAddress: number;
  /** Player calls in one pass of the song. */
  totalFrames: number;
  framesPerSecond: number;
  instrumentCount: number;
  /** Per-voice command stream sizes in bytes. */
  streamBytes: number[];
  /** Bytes of BASIC memory left after the standalone PRG returns to BASIC (program and variables live behind the player). */
  basicFreeBytes: number;
  /** Conditions the caller should pass on, such as a PRG that leaves no BASIC memory. */
  warnings: string[];
  /** Conservative NMOS 6502 cycle estimate, excluding the host IRQ and VIC stalls. */
  worstCaseCyclesPerCall: number;
}

/**
 * Compiles SIDWAVE to a C64 program with a frame-based player.
 *
 * The compiler arranges the timeline into per-voice note events with frame-exact onsets
 * (no tempo drift), then encodes them as compact command streams. The 6502 player reads the
 * streams once per frame and runs the per-note modulation itself: hard restart, fast arpeggio,
 * pitch slide, vibrato, pulse-width sweep, and per-SID filters with sweep and per-pattern ramp.
 */
export function compileSidwaveToPrg(doc: ParsedSidwave, { loop = true }: { loop?: boolean } = {}): CompileResult {
  const arrangement = arrangeSidwave(doc);
  const streams = arrangement.voices.map((v) => encodeVoiceStream(v.events, arrangement.totalFrames));
  const worstCaseCyclesPerCall = estimatePlayerCycles(arrangement);
  const requiresTurbo = (system: SystemMode) => worstCaseCyclesPerCall > stockPlayerBudget(system, doc.speed);
  const turboOnly = Number(requiresTurbo("PAL")) | (Number(requiresTurbo("NTSC")) << 1);
  // Check the size before assembling the streams: the player and its tables are assembled once with
  // empty streams, which gives the exact start of the stream data. Songs larger than 64 KB would
  // otherwise wrap the address counter inside the assembler.
  const layout = assemblyToPrgDetailed(buildPlayerAsm(arrangement, streams.map(() => [OP.LOOP]), loop, turboOnly), {
    fileName: "sidwave_player.asm",
    loadAddress: SIDWAVE_LOAD_ADDRESS,
  });
  const streamStart = layout.symbols.get("stream0")!;
  const projectedEnd = streamStart + streams.reduce((sum, st) => sum + st.length, 0);
  // The PRG installer also writes three bytes after the program (an empty BASIC program).
  if (projectedEnd + 3 > SIDWAVE_MEMORY_END) {
    const kb = ((projectedEnd - SIDWAVE_LOAD_ADDRESS) / 1024).toFixed(1);
    throw new SidwaveValidationError(
      "$.timeline",
      `the compiled song needs ${kb} KB and would end at $${projectedEnd.toString(16).toUpperCase()}, past the $D000 limit (about 50 KB); shorten the timeline or use longer note lengths`,
    );
  }
  const warnings: string[] = [];
  if (arrangement.chips) {
    const availableCycles = stockPlayerBudget(arrangement.system, doc.speed);
    const required = worstCaseCyclesPerCall / availableCycles;
    if (requiresTurbo(arrangement.system) && !doc.cpu) {
      throw new SidwaveValidationError("$.cpu",
        `the player needs up to ${worstCaseCyclesPerCall} cycles per call at speed ${doc.speed} (${availableCycles} available at 1 MHz ${arrangement.system}); use cpu: turbo for a CPU speed of at least ${Math.ceil(required)} MHz`);
    }
    const level = arrangement.chips.reduce((sum, chip, i) => {
      const sustain = arrangement.voices.slice(i * 3, i * 3 + 3).reduce((total, voice) => {
        const peak = voice.notes.reduce((max, { inst }) => {
          const instrument = arrangement.instruments[inst]!;
          const saw = (instrument.wave & 0x20) || instrument.wavetable?.some((step) => String(step.wave).includes("saw"));
          return saw ? Math.max(max, instrument.sr >> 4) : max;
        }, 0);
        return total + peak;
      }, 0);
      return sum + chip.volume * sustain / 225;
    }, 0);
    if (level > 10) warnings.push(`Sawtooth level could reach ${level.toFixed(1)} on one pan side (recommended maximum 10). Lower SID volume or sustain, or spread the SIDs across the mixer sides.`);
  }
  const asm = buildPlayerAsm(arrangement, streams, loop, turboOnly);
  const assembled = assemblyToPrgDetailed(asm, { fileName: "sidwave_player.asm", loadAddress: SIDWAVE_LOAD_ADDRESS });
  const prg = assembled.prg;
  const endAddress = SIDWAVE_LOAD_ADDRESS + prg.length - 2;
  for (const [label, expected] of [["install", SIDWAVE_PRG_ENTRY], ["init_vec", SIDWAVE_INIT_ADDRESS], ["play_vec", SIDWAVE_PLAY_ADDRESS], ["prg_end", endAddress]] as const) {
    if (assembled.symbols.get(label) !== expected) throw new Error(`SIDWAVE player layout error: ${label} is not at $${expected.toString(16)}`);
  }
  // After the PRG's SYS returns, BASIC's program and variables start right behind the player.
  const basicFreeBytes = Math.max(0, SIDWAVE_BASIC_END - (endAddress + 3));
  if (basicFreeBytes < 1024) {
    warnings.push(
      basicFreeBytes === 0
        ? `The PRG ends at $${endAddress.toString(16).toUpperCase()}, past BASIC's memory ($A000): after it returns to BASIC, any BASIC command that needs memory fails with ?OUT OF MEMORY. The music keeps playing.`
        : `The PRG leaves only ${basicFreeBytes} bytes of BASIC memory after it returns to BASIC.`,
    );
  }
  return {
    prg,
    entryAddress: SIDWAVE_PRG_ENTRY,
    initAddress: SIDWAVE_INIT_ADDRESS,
    playAddress: SIDWAVE_PLAY_ADDRESS,
    loadAddress: SIDWAVE_LOAD_ADDRESS,
    endAddress,
    totalFrames: arrangement.totalFrames,
    framesPerSecond: arrangement.fps,
    instrumentCount: arrangement.instruments.length - 1,
    streamBytes: streams.map((s) => s.length),
    basicFreeBytes,
    warnings,
    worstCaseCyclesPerCall,
  };
}

export function validateSidwavePsidMap(doc: ParsedSidwave): void {
  if (doc.sids.length > 3) {
    throw new SidwaveValidationError("$.sids", "PSID supports at most 3 SID chips; use PRG output for more than 3 SIDs");
  }
  if (!doc.sids.some(({ address }) => address === 0xd400)) {
    throw new SidwaveValidationError("$.sids", "PSID requires a primary SID at $D400; use PRG output for this map");
  }
}

/**
 * Wraps the compiled PRG in a PSID v2-v4 file. Init and play are the player's fixed entry points;
 * the clock flag follows the document's mode. Multispeed init sets the CIA play rate.
 * `entryAddress` is accepted for compatibility and ignored.
 */
export function compileSidwaveToSid(
  doc: ParsedSidwave,
  prg: Buffer,
  options?: { entryAddress?: number; initAddress?: number; playAddress?: number },
): { sid: Buffer } {
  validateSidwavePsidMap(doc);
  const primary = doc.sids.find(({ address }) => address === 0xd400)!;
  const headerSids = [primary, ...doc.sids.filter((sid) => sid !== primary)];
  const version = headerSids.length >= 3 ? 4 : headerSids.length === 2 ? 3 : 2;
  // HVSC SID_file_format.txt: v2-v4 all start their data at $7C.
  const headerSize = 0x7c;
  const header = Buffer.alloc(headerSize, 0);
  header.write("PSID", 0, "ascii");
  header.writeUInt16BE(version, 4);
  header.writeUInt16BE(headerSize, 6); // data offset
  header.writeUInt16BE(0, 8); // load address taken from the first two data bytes
  header.writeUInt16BE(options?.initAddress ?? SIDWAVE_INIT_ADDRESS, 10);
  header.writeUInt16BE(options?.playAddress ?? SIDWAVE_PLAY_ADDRESS, 12);
  header.writeUInt16BE(1, 14); // songs
  header.writeUInt16BE(1, 16); // start song
  header.writeUInt32BE(doc.speed > 1 ? 1 : 0, 18); // bit 0 selects CIA timer timing for the first song
  writeLatin1(header, doc.song.title ?? "Untitled", 0x16);
  writeLatin1(header, doc.song.author ?? "SIDWAVE", 0x36);
  writeLatin1(header, "c64bridge SIDWAVE", 0x56);
  const clockBits = doc.song.mode === "NTSC" ? 0b10 : 0b01;
  const flags = headerSids.reduce((bits, { model }, i) =>
    bits | ((model === "6581" ? 1 : model === "8580" ? 2 : 0) << (4 + 2 * i)), clockBits << 2);
  header.writeUInt16BE(flags, 0x76);
  if (version >= 3) header[0x7a] = (headerSids[1]!.address - 0xd000) >> 4;
  if (version >= 4) header[0x7b] = (headerSids[2]!.address - 0xd000) >> 4;
  const body = Buffer.isBuffer(prg) ? prg : Buffer.from(prg);
  return { sid: Buffer.concat([header, body]) };
}

function writeLatin1(buf: Buffer, text: string, offset: number): void {
  const safe = [...text].map((ch) => (ch.codePointAt(0)! <= 0xff ? ch : "?")).join("").slice(0, 32);
  buf.write(safe, offset, 32, "latin1");
}

export function hzToSidFrequency(hz: number, system: SystemMode): number {
  const phi2 = system === "PAL" ? 985_248 : 1_022_727;
  const value = Math.round((hz * 16_777_216) / phi2);
  return Math.max(0, Math.min(0xffff, value));
}

const CLOCK_HZ: Record<SystemMode, number> = { PAL: 985_248, NTSC: 1_022_727 };
/** CPU cycles per video frame: 312 lines x 63 cycles (PAL), 263 lines x 65 cycles (NTSC). */
const CYCLES_PER_FRAME: Record<SystemMode, number> = { PAL: 312 * 63, NTSC: 263 * 65 };
/** Video frame rate of a real C64: 50.1245 Hz on PAL, 59.8262 Hz on NTSC. The player runs once per frame. */
export function sidwaveFrameRate(system: SystemMode): number {
  return CLOCK_HZ[system] / CYCLES_PER_FRAME[system];
}

/** Highest playable MIDI note for a system: B7 exceeds the 16-bit frequency register at the PAL clock. */
export function maxSidwaveMidi(system: SystemMode): number {
  let midi = 107;
  while (Math.round((midiToHz(midi) * 16_777_216) / CLOCK_HZ[system]) > 0xffff) midi -= 1;
  return midi;
}

function waveformToCtrl(w: string): number {
  const wf = (w || "pulse").toLowerCase();
  if (wf.includes("tri") && wf.includes("saw") && wf.includes("pulse")) return 0x70;
  if (wf.includes("tri") && wf.includes("pulse")) return 0x50;
  if (wf.includes("saw") && wf.includes("pulse")) return 0x60;
  if (wf.includes("tri") && wf.includes("saw")) return 0x30;
  if (wf.startsWith("tri")) return 0x10;
  if (wf.startsWith("saw")) return 0x20;
  if (wf.startsWith("noise")) return 0x80;
  return 0x40;
}

// ---------------------------------------------------------------------------
// Arrangement: timeline -> per-voice note events

export interface Instrument {
  ad: number;
  sr: number;
  wave: number;
  pw: number;
  pwStep: number;
  pwMin: number;
  pwMax: number;
  /**
   * Vibrato amplitude factors as mantissa/shift pairs: amplitude = ft[note] * mant >> (8 + shift), with the factor
   * 2^(d/12) - 1 above the note and 1 - 2^(-d/12) below it, so the pitch swings exactly ±depth semitones.
   */
  vibUp: [number, number];
  vibDown: [number, number];
  vibRate: number; // phase increment per frame (256 = one cycle)
  vibDelay: number;
  arp: number[]; // semitone offsets; empty = none
  arpSpeed: number;
  slideSemis: number;
  slideSpeed: number;
  /** round(65536 / speed): the player's per-frame slide step is magnitude x slideRecip / 256 (16.8 fixed point). */
  slideRecip: number;
  filter: number;
  ring?: boolean;
  sync?: boolean;
  wavetable?: Array<Record<string, any>>;
  waveloop?: number;
  pulsetable?: SidwaveRegisterTable;
  filtertable?: SidwaveRegisterTable;
}

export interface ArrangedNote {
  start: number;
  end: number;
  midi: number;
  inst: number;
  legato?: boolean;
  portamento?: number;
  /** Fade window applied to this note's sustain level, if any. */
  fade?: { start: number; end: number };
}

type GlobalEvent =
  | { frame: number; kind: "filtermod"; step: number; count: number }
  | { frame: number; kind: "volume"; value: number };

interface ChipArrangement {
  address: number;
  volume: number;
  filter: Arrangement["filter"];
  hasFilterTable: boolean;
  hasFilterMod: boolean;
}

export interface Arrangement {
  fps: number;
  speed: number;
  framesPerBeat: number;
  totalFrames: number;
  system: SystemMode;
  instruments: Instrument[];
  voices: Array<{ notes: ArrangedNote[]; events: StreamEvent[] }>;
  chips?: ChipArrangement[];
  turbo?: boolean;
  filter: { base: number; sweep: number; stepFixed: number; resonance: number; mode: number; used: boolean };
}

export interface StreamEvent {
  frame: number;
  order: number;
  bytes: number[];
}

const BEAT_EPS = 1e-9;
/** A note costs at least 3 stream bytes (note, wait, hard restart) and the song has about 52,000 bytes: 20,000 notes in one voice can never fit. Rejecting early avoids arranging millions of notes first. */
const MAX_NOTES_PER_VOICE = 20_000;

function createInstrumentPool() {
  // Instrument 0 is a neutral placeholder: voices that have not played a note yet use it, so they are not routed to the filter.
  const instruments: Instrument[] = [{ ad: 0, sr: 0, wave: 0, pw: 0, pwStep: 0, pwMin: 0, pwMax: 0, vibUp: [0, 0], vibDown: [0, 0], vibRate: 0, vibDelay: 0, arp: [], arpSpeed: 0, slideSemis: 0, slideSpeed: 0, slideRecip: 0, filter: 0 }];
  const instKeys = new Map<string, number>();
  const instIndex = (inst: Instrument): number => {
    const key = JSON.stringify(inst);
    let idx = instKeys.get(key);
    if (idx === undefined) {
      idx = instruments.length;
      if (idx >= 64) throw new SidwaveValidationError("$.voices", "more than 63 distinct voice/pattern/effect combinations; reuse patterns or effects");
      instruments.push(inst);
      instKeys.set(key, idx);
    }
    return idx;
  };

  return { instruments, instIndex };
}

export function arrangeSidwave(doc: ParsedSidwave): Arrangement {
  const first = doc.sids[0]!;
  const extended = doc.version === "1.2" || doc.sids.length > 1 || first.address !== 0xd400 || first.volume !== 15 ||
    first.filter || doc.cpu || doc.voices.some(({ id }) => doc.voiceSlots.get(id) !== id - 1);
  if (!extended) return arrangeChip(doc, createInstrumentPool());

  const pool = createInstrumentPool();
  const parts = doc.sids.map((sid, chip) => {
    const idByChannel = new Map<number, number>();
    const voices = doc.voices.flatMap((voice) => {
      const slot = doc.voiceSlots.get(voice.id)!;
      if (Math.floor(slot / 3) !== chip) return [];
      const channel = slot % 3 + 1;
      idByChannel.set(channel, voice.id);
      return [{ ...voice, id: channel }];
    });
    const timeline = doc.timeline.map((section) => {
      const layers = Object.fromEntries([...idByChannel].map(([channel, id]) =>
        [`v${channel}`, section.layers[`v${id}`] ?? "-"]));
      return { ...section, layers };
    });
    const globalFx = doc.song.global_fx;
    const filterEnv = sid.filter?.filter_env ?? (chip === 0 ? globalFx.filter_env : undefined);
    return arrangeChip({
      ...doc, voices, timeline,
      song: { ...doc.song, global_fx: { reverb_sim: globalFx.reverb_sim, filter_env: filterEnv } },
    }, pool, sid.volume, sid.filter?.filter_mod, idByChannel);
  });
  return {
    ...parts[0]!,
    voices: parts.flatMap((part) => part.voices),
    chips: doc.sids.map((sid, i) => {
      const part = parts[i]!;
      return {
        address: sid.address,
        volume: sid.volume,
        filter: part.filter,
        hasFilterTable: part.voices.some(({ notes }) => notes.some(({ inst }) => !!pool.instruments[inst]!.filtertable)),
        hasFilterMod: part.voices[0]!.events.some(({ bytes }) => bytes[0] === OP.FILTERMOD),
      };
    }),
    turbo: doc.cpu === "turbo",
  };
}

function arrangeChip(
  doc: ParsedSidwave, { instruments, instIndex }: ReturnType<typeof createInstrumentPool>,
  volume = 15, sidMod?: FilterModSpec, idByChannel?: ReadonlyMap<number, number>,
): Arrangement {
  const system: SystemMode = doc.song.mode ?? "PAL";
  const fps = sidwaveFrameRate(system) * doc.speed;
  const framesPerBeat = (fps * 60) / doc.song.tempo;
  const frameAt = (beat: number) => Math.round(beat * framesPerBeat + BEAT_EPS);
  const maxMidi = maxSidwaveMidi(system);
  const totalBars = doc.song.length_bars;
  const totalFrames = frameAt(totalBars * 4);

  const gfx = doc.song.global_fx as Record<string, any>;
  const fenv = gfx.filter_env as Record<string, any> | undefined;
  const filterVoices = new Set<number>(fenv ? (fenv.voices ?? [1, 2, 3]).map(Number) : []);
  let filterUsed = !!fenv || !!sidMod;

  const voicesById = new Map<number, SidwaveVoice>(doc.voices.map((v) => [v.id, v]));
  const notes: ArrangedNote[][] = [[], [], []];
  const globals: GlobalEvent[] = [];
  if (sidMod) {
    const unitFrames = { steps: framesPerBeat, beats: framesPerBeat, bars: 4 * framesPerBeat, frames: 1 }[sidMod.unit];
    const count = Math.max(1, Math.min(0xffff, Math.round(sidMod.amount * unitFrames)));
    globals.push({ frame: 0, kind: "filtermod", step: Math.round(sidMod.sweep * 32 / count), count });
  }
  const fadeWindows: Array<Array<{ start: number; end: number }>> = [[], [], []];
  const reverb = gfx.reverb_sim as { depth: number; delay_frames: number } | undefined;

  // Expand the timeline, cycling it when length_bars exceeds it and truncating when shorter.
  const sections: Array<{ index: number; startBeat: number; endBeat: number }> = [];
  for (let bar = 0, i = 0; bar < totalBars; i += 1) {
    const s = doc.timeline[i % doc.timeline.length]!;
    const bars = Math.min(s.bars, totalBars - bar);
    sections.push({ index: i % doc.timeline.length, startBeat: bar * 4, endBeat: (bar + bars) * 4 });
    bar += bars;
  }

  for (const sec of sections) {
    const section = doc.timeline[sec.index]!;
    const secPath = `$.timeline[${sec.index}]`;
    const sf = frameAt(sec.startBeat);
    const ef = frameAt(sec.endBeat);
    const active: number[] = [];
    const fading: number[] = [];
    for (const id of [1, 2, 3]) {
      const ref = section.layers[`v${id}`];
      if (ref === undefined) continue;
      const voice = voicesById.get(id);
      const parsed = parseLayerRef(ref, Object.keys(voice?.patterns ?? {}));
      if (parsed.pattern === null || !voice) continue;
      const pattern = voice.patterns![parsed.pattern]!;
      const patPath = `${secPath}.layers.v${idByChannel?.get(id) ?? id} (${parsed.pattern})`;
      active.push(id);
      if (parsed.fade) {
        fading.push(id);
        fadeWindows[id - 1]!.push({ start: sf, end: ef });
      }
      const fxRaw = (pattern.fx ?? {}) as Record<string, any>;
      const filterMod = fxRaw.filter_mod ? parseFilterMod(fxRaw.filter_mod, `${patPath}.fx.filter_mod`) : undefined;
      if (filterMod) filterUsed = true;
      const routed = filterVoices.has(id) || !!filterMod || (!fenv && !!sidMod) ? 1 : 0;
      const entries = patternEntries(pattern, patPath);
      const lengthBeats = pattern.length ?? 1;
      const transpositions = pattern.transpositions ?? [0];
      const durations = entries.map((entry) => entry.kind === "note" ? entry.len ?? lengthBeats : lengthBeats);
      const variableLength = durations.some((duration) => duration !== lengthBeats);
      const cycleBeats = variableLength ? durations.reduce((sum, duration) => sum + duration, 0) : entries.length * lengthBeats;
      const out = notes[id - 1]!;
      for (let c = 0; ; c += 1) {
        const cycleStart = sec.startBeat + c * cycleBeats;
        if (cycleStart >= sec.endBeat - BEAT_EPS) break;
        const tr = transpositions[c % transpositions.length]! + parsed.transpose;
        if (filterMod) {
          const unitFrames = { steps: lengthBeats * framesPerBeat, beats: framesPerBeat, bars: 4 * framesPerBeat, frames: 1 }[filterMod.unit];
          const count = Math.max(1, Math.min(0xffff, Math.round(filterMod.amount * unitFrames)));
          // Offset and step are in cutoff x 32 units and signed 24-bit in the player, so the full ±2047 range ramps smoothly.
          const step = Math.round((filterMod.sweep * 32) / count);
          globals.push({ frame: frameAt(cycleStart), kind: "filtermod", step, count });
        }
        let offset = 0;
        for (let k = 0; k < entries.length; k += 1) {
          const b = cycleStart + (variableLength ? offset : k * lengthBeats);
          const duration = durations[k]!;
          offset += duration;
          if (b >= sec.endBeat - BEAT_EPS) break;
          const truncated = b + duration > sec.endBeat + BEAT_EPS;
          const f0 = frameAt(b);
          const f1 = frameAt(Math.min(b + duration, sec.endBeat));
          const entry = entries[k]!;
          if (entry.kind === "rest") continue;
          if (entry.kind === "tie") {
            // A tie holds the note sounding right before it, also across a section boundary; after a rest it is a rest.
            const last = out[out.length - 1];
            if (last && last.end === f0) last.end = f1;
            continue;
          }
          if (f1 - f0 < SIDWAVE_MIN_NOTE_FRAMES) {
            if (truncated) continue;
            throw new SidwaveValidationError(
              patPath,
              `each entry lasts ${(duration * framesPerBeat).toFixed(2)} frames at ${doc.song.tempo} BPM; the player needs at least ${SIDWAVE_MIN_NOTE_FRAMES} frames per note (one sounding frame plus the ${SIDWAVE_HARD_RESTART_FRAMES}-frame hard restart); raise 'length' or lower the tempo`,
            );
          }
          const base = entry.notes[0]! + tr;
          const offsets = entry.notes.map((n) => n - entry.notes[0]!);
          for (const off of offsets) {
            const midi = base + off;
            if (midi < 12 || midi > maxMidi) {
              throw new SidwaveValidationError(
                patPath,
                `note ${midiToNoteName(midi)} (after transposition ${tr >= 0 ? "+" : ""}${tr}) is outside the playable range C0..${midiToNoteName(maxMidi)} on ${system}`,
              );
            }
          }
          const slideDepth = fxRaw.slide ? Number(fxRaw.slide.depth) : 0;
          if (slideDepth !== 0 && (base - slideDepth < 12 || base - slideDepth > maxMidi)) {
            throw new SidwaveValidationError(
              `${patPath}.fx.slide.depth`,
              `the slide into ${midiToNoteName(base)} would start at ${midiToNoteName(base - slideDepth)}, outside the playable range C0..${midiToNoteName(maxMidi)} on ${system}`,
            );
          }
          if (fxRaw.vibrato) {
            // The upward swing must fit the 16-bit frequency register, or it would clip and the vibrato become lopsided.
            const depth = Number(fxRaw.vibrato.depth);
            const top = base + Math.max(...offsets);
            const peak = (midiToHz(top) * Math.pow(2, depth / 12) * 16_777_216) / CLOCK_HZ[system];
            if (Math.round(peak) > 0xffff) {
              const maxDepth = 12 * Math.log2((0xffff * CLOCK_HZ[system]) / 16_777_216 / midiToHz(top));
              throw new SidwaveValidationError(
                `${patPath}.fx.vibrato.depth`,
                `a vibrato of ${depth} semitones on ${midiToNoteName(top)} would rise above the SID's highest frequency on ${system}; use a depth of at most ${Math.floor(maxDepth * 100) / 100} or a lower note`,
              );
            }
          }
          const instrumentName = entry.instrument ?? voice.instrument;
          const isLibrary = instrumentName?.startsWith("lib:");
          const bank = isLibrary ? SIDWAVE_INSTRUMENT_LIBRARY : doc.instruments;
          const key = isLibrary ? instrumentName!.slice(4) : instrumentName;
          const namedInstrument = key && Object.prototype.hasOwnProperty.call(bank, key) ? bank[key] : undefined;
          if (instrumentName && !namedInstrument) throw new SidwaveValidationError(`${patPath}.instrument`, `instrument ${JSON.stringify(instrumentName)} is not defined`);
          const instVoice = namedInstrument ? { ...voice, waveform: (namedInstrument.waveform ?? namedInstrument.wave ?? voice.waveform) as any, pulse_width: namedInstrument.pulse_width ?? voice.pulse_width, adsr: namedInstrument.adsr ?? voice.adsr } : voice;
          const inst = buildInstrument(instVoice, { ...fxRaw, ...(namedInstrument ?? {}) }, entry.arp ? offsets : [], entry.arp ? entry.arpSpeed : 0, routed, fps);
          if (out.length >= MAX_NOTES_PER_VOICE) {
            throw new SidwaveValidationError(patPath, `voice ${id} has more than ${MAX_NOTES_PER_VOICE} notes; every note takes at least 3 bytes, so the song would end past the $D000 limit (about 50 KB); use longer note lengths or fewer bars`);
          }
          const previous = out[out.length - 1];
          const legato = (entry.legato ?? namedInstrument?.legato) && previous?.end === f0;
          out.push({
            start: f0, end: f1, midi: base,
            inst: legato ? previous!.inst : instIndex(inst),
            legato,
            portamento: entry.portamento ?? namedInstrument?.portamento,
          });
        }
      }
      if (filterMod) globals.push({ frame: ef, kind: "filtermod", step: 0, count: 0 });
    }

    // Master volume fade when every sounding voice of the section fades.
    if (fading.length > 0 && fading.length === active.length) {
      for (let beat = sec.startBeat; beat < sec.endBeat - BEAT_EPS; beat += 1) {
        const f = frameAt(beat);
        globals.push({ frame: f, kind: "volume", value: Math.round(volume * (1 - (f - sf) / (ef - sf))) });
      }
      globals.push({ frame: ef, kind: "volume", value: volume });
    }

    // Reverb simulation: a free voice echoes the lowest active voice, delayed and quieter.
    if (reverb && active.length > 0 && active.length < 3) {
      const src = Math.min(...active);
      const tgt = [1, 2, 3].find((id) => !active.includes(id))!;
      const delay = reverb.delay_frames;
      for (const n of notes[src - 1]!) {
        if (n.start < sf || n.start >= ef) continue;
        const start = n.start + delay;
        const end = Math.min(n.end + delay, ef);
        if (end - start < SIDWAVE_MIN_NOTE_FRAMES) continue;
        const srcInst = instruments[n.inst]!;
        const sustain = Math.round((srcInst.sr >> 4) * reverb.depth);
        const echo: Instrument = { ...srcInst, sr: (sustain << 4) | (srcInst.sr & 0x0f) };
        notes[tgt - 1]!.push({ ...n, start, end, inst: instIndex(echo) });
      }
      if (fading.includes(src)) fadeWindows[tgt - 1]!.push({ start: sf, end: ef });
    }
  }

  for (let v = 0; v < 3; v += 1) {
    notes[v]!.sort((a, b) => a.start - b.start);
    for (const n of notes[v]!) {
      const w = fadeWindows[v]!.find((fw) => n.start >= fw.start && n.start < fw.end);
      if (w) n.fade = w;
    }
  }

  const voices = notes.map((list, v) => ({
    notes: list,
    events: buildVoiceEvents(list, instruments, totalFrames, framesPerBeat, v === 0 ? globals : []),
  }));

  const base = fenv ? Math.round(Number(fenv.cutoff_base)) : 1024;
  const sweep = fenv?.sweep !== undefined ? Math.round(Number(fenv.sweep)) : 0;
  const sweepFrames = fenv?.speed !== undefined ? Number(fenv.speed) * framesPerBeat : 0;
  const stepFixed = sweep !== 0 && sweepFrames > 0 ? Math.max(1, Math.round((Math.abs(sweep) * 32) / sweepFrames)) : 0;
  const type = String(fenv?.type ?? "lowpass").toLowerCase();
  const mode = filterUsed ? (type === "bandpass" ? 0x20 : type === "highpass" ? 0x40 : 0x10) : 0;
  const resonance = fenv?.resonance !== undefined ? Number(fenv.resonance) : 8;

  return {
    fps,
    speed: doc.speed,
    framesPerBeat,
    totalFrames,
    system,
    instruments,
    voices,
    filter: { base, sweep, stepFixed, resonance, mode, used: filterUsed },
  };
}

type PatternEntry =
  | { kind: "rest" }
  | { kind: "tie" }
  | ({
    kind: "note"; notes: number[]; instrument?: string; len?: number; legato?: boolean; portamento?: number;
  } & ({ arp: false; arpSpeed: 0 } | { arp: true; arpSpeed: number }));

function patternEntries(pattern: SidwavePattern, path: string): PatternEntry[] {
  const p = pattern as any;
  if (p.type === "arpeggio" || Array.isArray(p.notes)) {
    const midis = (p.notes as string[]).map((n) => noteNameToMidi(n)!);
    if (p.frame_rate !== undefined) return [{ kind: "note", notes: midis, arp: true, arpSpeed: Number(p.frame_rate) }];
    return midis.map((m) => ({ kind: "note", notes: [m], arp: false, arpSpeed: 0 }));
  }
  if (Array.isArray(p.groove)) {
    return (p.groove as SidwavePatternGroove["groove"]).map((raw) => {
      if (typeof raw === "object") {
        const { note, inst: instrument, len, legato, portamento } = raw;
        return { kind: "note", notes: [noteNameToMidi(note)!], arp: false, arpSpeed: 0, instrument, len, legato, portamento };
      }
      const tok = String(raw).trim();
      if (isRestToken(tok)) return { kind: "rest" };
      if (isTieToken(tok)) return { kind: "tie" };
      const [note, instrument] = tok.split("@");
      return { kind: "note", notes: [noteNameToMidi(note)!], arp: false, arpSpeed: 0, instrument };
    });
  }
  const entries: MotifEntry[] = parseMotif(String(p.motif), p.root === undefined ? "C3" : String(p.root), `${path}.motif`);
  return entries.map((e) => (e === null ? { kind: "rest" } : e === "~" ? { kind: "tie" } : { kind: "note", notes: [e], arp: false, arpSpeed: 0 }));
}

function buildInstrument(voice: SidwaveVoice, fx: Record<string, any>, arp: number[], arpSpeed: number, filter: number, fps: number): Instrument {
  const adsr = voice.adsr ?? [2, 2, 10, 3];
  const wave = waveformToCtrl(voice.waveform ?? "pulse");
  const baseWidth = voice.pulse_width ?? 0x800;
  const pw = fx.pulsetable && baseWidth > 0 && baseWidth <= 1
    ? Math.min(4094, Math.max(1, Math.round(baseWidth * 4095))) : baseWidth;
  let pwStep = 0;
  let pwMin = pw;
  let pwMax = pw;
  if (!fx.pulsetable && fx.pwm_sweep && wave === 0x40) {
    const rawDepth = Number(fx.pwm_sweep.depth);
    const depth = rawDepth <= 1 ? rawDepth * 4095 : rawDepth;
    pwMin = Math.max(16, Math.round(pw - depth));
    pwMax = Math.min(4079, Math.round(pw + depth));
    pwStep = Math.max(1, Math.round((2 * (pwMax - pwMin) * Number(fx.pwm_sweep.speed)) / fps));
  }
  const vib = fx.vibrato;
  const slide = fx.slide;
  const depth = vib ? Number(vib.depth) : 0;
  const slideSpeed = slide ? Number(slide.speed) : 0;
  const slideRecip = slideSpeed > 1 ? Math.round(65536 / slideSpeed) : 0;
  return {
    ad: ((adsr[0] & 0xf) << 4) | (adsr[1] & 0xf),
    sr: ((adsr[2] & 0xf) << 4) | (adsr[3] & 0xf),
    wave: wave | (fx.ring ? 0x04 : 0) | (fx.sync ? 0x02 : 0),
    pw,
    pwStep,
    pwMin,
    pwMax,
    // The player's triangle peaks at 126/128, so the factors are raised by 128/126 to reach ±depth exactly.
    vibUp: vib ? mantissaShift((128 / 126) * (Math.pow(2, depth / 12) - 1)) : [0, 0],
    vibDown: vib ? mantissaShift((128 / 126) * (1 - Math.pow(2, -depth / 12))) : [0, 0],
    vibRate: vib ? Math.max(1, Math.min(255, Math.round((256 * Number(vib.rate)) / fps))) : 0,
    vibDelay: vib ? Number(vib.delay ?? 0) : 0,
    arp,
    arpSpeed,
    slideSemis: slide ? Number(slide.depth) : 0,
    slideSpeed,
    slideRecip,
    filter,
    wavetable: Array.isArray(fx.wavetable) ? fx.wavetable.map((s: any) => ({ ...s })) : undefined,
    waveloop: fx.loop,
    pulsetable: fx.pulsetable,
    filtertable: fx.filtertable,
  };
}

/** Small documented SID instrument recipes; waveform bits follow the SID control-register map. */
export const SIDWAVE_INSTRUMENT_LIBRARY: Record<string, Record<string, any>> = {
  kick: {
    waveform: "noise", adsr: [0, 0, 12, 4],
    wavetable: [{ wave: "noise", note: "C6", frames: 1 }, { wave: "pulse", note: "C3" }, { wave: "pulse", note: "C2" }, { wave: "tri", note: "C1" }],
  },
  snare: {
    waveform: "noise", adsr: [0, 2, 8, 5],
    wavetable: [{ wave: "noise", note: "A6", frames: 2 }, { wave: "noise", note: "C6" }, { wave: "pulse", note: "C4" }, { wave: "tri", note: "C3" }],
  },
  hat: {
    waveform: "noise", adsr: [0, 0, 4, 2],
    wavetable: [{ wave: "noise", note: "G7" }, { wave: "noise", note: "C7" }, { wave: "noise", note: "C7", gate: false }],
  },
  bass_pluck: {
    waveform: "triangle", adsr: [0, 8, 0, 4],
    wavetable: [{ wave: "pulse", note: "+12" }, { wave: "tri" }],
  },
  filter_bass: {
    waveform: "saw", adsr: [0, 7, 9, 3],
    filtertable: { steps: [{ value: 1450, add: false, frames: 1, resonance: 8, type: 0x10 }, { value: -36, add: true, frames: 24 }] },
  },
  lead_pwm: {
    waveform: "pulse", pulse_width: 0.3, adsr: [1, 4, 10, 3],
    pulsetable: { steps: [{ value: 819, add: false, frames: 1 }, { value: 38, add: true, frames: 16 }, { value: -38, add: true, frames: 16 }], loop: 1 },
  },
  chip_arp_major: {
    waveform: "pulse", adsr: [0, 3, 8, 2], loop: 0,
    wavetable: ["+0", "+4", "+7", "+12"].map((note) => ({ note, frames: 2 })),
  },
  chip_arp_minor: {
    waveform: "pulse", adsr: [0, 3, 8, 2], loop: 0,
    wavetable: ["+0", "+3", "+7", "+12"].map((note) => ({ note, frames: 2 })),
  },
  bell_ring: {
    waveform: "tri", adsr: [0, 4, 7, 5], ring: true,
    wavetable: [{ wave: "tri", note: "+12" }, { wave: "tri" }],
  },
  sync_lead: {
    waveform: "saw", adsr: [0, 4, 9, 3], sync: true,
    wavetable: [{ wave: "saw", note: "+12", frames: 2 }, { wave: "saw" }],
  },
  pad_slow: {
    waveform: "tri", adsr: [5, 4, 11, 7],
    filtertable: { steps: [
      { value: 500, add: false, frames: 1, type: 0x10 },
      { value: 12, add: true, frames: 32 },
      { value: -12, add: true, frames: 32 },
    ], loop: 1 },
  },
};

/** Represents 0 < k < 1 as mant / 2^(8 + shift) with the largest shift that keeps mant <= 255 (at least 7 bits of precision). */
function mantissaShift(k: number): [number, number] {
  let shift = 0;
  while (shift < 15 && Math.round(k * 2 ** (9 + shift)) <= 255) shift += 1;
  return [Math.max(1, Math.round(k * 2 ** (8 + shift))), shift];
}

// ---------------------------------------------------------------------------
// Command stream

export const OP = {
  NOTE: 0x00, // + note index 0..95 (C0..B7)
  INST: 0x60, // + instrument 0..63
  WAIT: 0xa0, // + frames-1, 1..64 frames
  GATEOFF: 0xe0,
  HARDRESTART: 0xe1,
  SETSR: 0xe2, // nn
  SETVOL: 0xe3, // nn
  WAITLONG: 0xe4, // nn frames, 0 = 256
  FILTERMOD: 0xe5, // step (signed 24-bit, cutoff x 32), count lo, count hi
  LOOP: 0xe6,
  LEGATO: 0xe7, // target note index
  PORTAMENTO: 0xe8, // duration, direction, PAL and NTSC magnitude (16-bit) and step (16.8)
} as const;

const ORDER = { gate: 0, filterReset: 1, inst: 2, note: 3, sustain: 4, filterStart: 5, volume: 6 } as const;

function buildVoiceEvents(notes: ArrangedNote[], instruments: Instrument[], total: number, framesPerBeat: number, globals: GlobalEvent[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  const wrap = (f: number) => (f >= total ? f - total : f);
  let currentInst = -1;
  for (let i = 0; i < notes.length; i += 1) {
    const n = notes[i]!;
    const nextNote = notes[i + 1];
    const next = nextNote?.start ?? notes[0]!.start + total;
    const hr = Math.max(n.start + 1, next - SIDWAVE_HARD_RESTART_FRAMES);
    const continues = nextNote?.legato && nextNote.start === n.end;
    const gateOff = continues ? n.end : Math.min(n.end, hr);
    if (!continues) {
      if (gateOff < hr) events.push({ frame: wrap(gateOff), order: ORDER.gate, bytes: [OP.GATEOFF] });
      events.push({ frame: wrap(hr), order: ORDER.gate, bytes: [OP.HARDRESTART] });
    }
    if (n.inst !== currentInst) {
      events.push({ frame: n.start, order: ORDER.inst, bytes: [OP.INST + n.inst] });
      currentInst = n.inst;
    }
    const note = n.midi - 12;
    const bytes = n.legato && i > 0 && notes[i - 1]!.end === n.start ? [OP.LEGATO, note] : [OP.NOTE + note];
    const previous = notes[i - 1];
    if (n.portamento && previous) {
      bytes.push(OP.PORTAMENTO, n.portamento, Number(previous.midi > n.midi));
      for (const system of ["PAL", "NTSC"] as const) {
        const magnitude = Math.abs(hzToSidFrequency(midiToHz(previous.midi), system) - hzToSidFrequency(midiToHz(n.midi), system));
        const step = Math.floor((magnitude * 256) / n.portamento);
        bytes.push(magnitude & 255, magnitude >> 8, step & 255, (step >> 8) & 255, step >> 16);
      }
    }
    events.push({ frame: n.start, order: ORDER.note, bytes });
    if (n.fade) {
      const inst = instruments[n.inst]!;
      const sustain = inst.sr >> 4;
      const level = (f: number) => (Math.round(sustain * Math.max(0, 1 - (f - n.fade!.start) / (n.fade!.end - n.fade!.start))) << 4) | (inst.sr & 0x0f);
      events.push({ frame: n.start, order: ORDER.sustain, bytes: [OP.SETSR, level(n.start)] });
      const firstBeat = Math.ceil((n.start + 1) / framesPerBeat - BEAT_EPS);
      for (let beat = firstBeat; ; beat += 1) {
        const f = Math.round(beat * framesPerBeat + BEAT_EPS);
        if (f >= gateOff) break;
        if (f > n.start) events.push({ frame: f, order: ORDER.sustain, bytes: [OP.SETSR, level(f)] });
      }
    }
  }
  for (const g of globals) {
    if (g.kind === "volume") {
      events.push({ frame: wrap(g.frame), order: ORDER.volume, bytes: [OP.SETVOL, g.value] });
    } else {
      const step = g.step & 0xffffff;
      events.push({
        frame: wrap(g.frame),
        order: g.count === 0 ? ORDER.filterReset : ORDER.filterStart,
        bytes: [OP.FILTERMOD, step & 0xff, (step >> 8) & 0xff, step >> 16, g.count & 0xff, g.count >> 8],
      });
    }
  }
  return events;
}

export function encodeVoiceStream(events: StreamEvent[], total: number): number[] {
  const sorted = [...events].sort((a, b) => a.frame - b.frame || a.order - b.order);
  const out: number[] = [];
  const pushWait = (frames: number) => {
    let left = frames;
    while (left > 256) {
      out.push(OP.WAITLONG, 0);
      left -= 256;
    }
    if (left <= 0) return;
    if (left <= 64) out.push(OP.WAIT + left - 1);
    else out.push(OP.WAITLONG, left & 0xff);
  };
  let cursor = 0;
  for (const e of sorted) {
    if (e.frame > cursor) {
      pushWait(e.frame - cursor);
      cursor = e.frame;
    }
    out.push(...e.bytes);
  }
  pushWait(total - cursor);
  out.push(OP.LOOP);
  return out;
}

// ---------------------------------------------------------------------------
// 6502 player

// Upper bounds for the NMOS 6502 paths in PLAYER_CODE, including indexed
// reads and taken branches crossing a page. Costs for instrument-dependent
// paths are charged only when the corresponding feature is in the score.
function estimatePlayerCycles(arr: Arrangement): number {
  const hasWave = arr.instruments.some((inst) => !!inst.wavetable?.length);
  const hasPulse = arr.instruments.some((inst) => !!inst.pulsetable);
  const hasFilter = arr.instruments.some((inst) => !!inst.filtertable);
  const hasMod = arr.chips?.some((chip) => chip.hasFilterMod);
  const hasSweep = arr.chips?.some((chip) => chip.filter.stepFixed);
  const bursts = new Map<number, number>();
  const add = (frame: number, cycles: number) => bursts.set(frame, (bursts.get(frame) ?? 0) + cycles);
  let regular = 140; // entry, pointer/banking saves, play-once wrapper and return
  for (const chip of arr.chips ?? [{ filter: arr.filter, hasFilterTable: hasFilter }]) {
    regular += arr.chips ? 155 : 0; // base table lookup, 3-channel dispatch and unfiltered volume
    if (chip.filter.used || chip.hasFilterTable || !arr.chips) {
      regular += 180 + (arr.chips ? 80 : 0); // filter calculation and routing, load constants
      if (hasMod || !arr.chips) regular += arr.chips ? 160 : 60; // ramp and chip state copy
      if (hasSweep || !arr.chips) regular += arr.chips ? 165 : 85; // sweep and chip state copy
      if (chip.hasFilterTable) regular += 135; // ownership and winning chip's four filter writes
    }
  }
  for (const [slot, { events, notes }] of arr.voices.entries()) {
    const chip = arr.chips?.[Math.floor(slot / 3)];
    if (chip && !events.length && !(slot % 3 === 0 && chip.filter.used)) continue;
    const used = [...new Set(notes.map(({ inst }) => arr.instruments[inst]!))];
    regular += 220; // ordinary wait (including WAITLONG), register output and inactive effects
    if (hasWave) regular += used.some((inst) => inst.wavetable?.length) ? 100 : 20;
    if (hasPulse) regular += used.some((inst) => inst.pulsetable) ? 145 : 25;
    if (hasFilter) regular += used.some((inst) => inst.filtertable) ? 190 : 25;
    if (used.some((inst) => inst.arp.length)) regular += 85;
    if (notes.some((note) => note.portamento || arr.instruments[note.inst]!.slideSpeed)) regular += 110;
    if (used.some((inst) => inst.vibRate)) regular += 330;
    if (used.some((inst) => inst.pwStep)) regular += 95;
    add(0, 100 + (slot % 3 === 0 && (!chip || chip.filter.used) ? 60 : 0)); // stream wrap and envelope reset
    let currentInst = 0;
    for (const { frame, bytes: [op, ...args] } of [...events].sort((a, b) => a.frame - b.frame || a.order - b.order)) {
      if (op! >= OP.INST && op! < OP.WAIT) {
        currentInst = op! - OP.INST;
        add(frame, 45);
      } else if (op! < OP.INST || op === OP.LEGATO) {
        const inst = arr.instruments[currentInst]!;
        let cycles = op === OP.LEGATO ? 110 : 169;
        if (op !== OP.LEGATO) {
          if (hasWave) cycles += 42;
          if (hasPulse) cycles += 47;
          if (hasFilter) cycles += 160;
          if (inst.vibRate) cycles += 490 + 33 * (inst.vibUp[1] + inst.vibDown[1]);
          if (inst.slideSemis) cycles += 580;
        }
        if (args.length > (op === OP.LEGATO ? 1 : 0)) cycles += 240; // portamento command and operands
        add(frame, cycles);
      } else if (op === OP.FILTERMOD) {
        add(frame, 200);
      } else if (op === OP.GATEOFF || op === OP.HARDRESTART) {
        add(frame, 66 + (hasPulse ? 21 : 0) + (hasFilter ? 32 : 0) + (hasWave ? 7 : 0));
      } else {
        add(frame, 85); // SETSR or SETVOL
      }
    }
  }
  return regular + [...bursts.values()].reduce((max, cycles) => Math.max(max, cycles), 0);
}

// A single player body processes one 3-channel group at a time. Only the
// chip state crosses group boundaries. All SID writes use the same pointer.
function multiplexSids(
  code: string, chips: ChipArrangement[], hasFilterTable: boolean, stateBytes: number,
): string {
  const count = chips.length;
  const filtered = chips.some((c) => c.filter.used || c.hasFilterTable);
  const hasMod = chips.some((c) => c.hasFilterMod);
  const hasSweep = chips.some((c) => c.filter.stepFixed);
  const filterState = [
    ...(hasSweep ? ["g_cutlo", "g_cuthi", "g_edir"] : []),
    ...(hasMod ? ["g_mofflo", "g_moffmd", "g_moffhi", "g_mstlo", "g_mstmd", "g_msthi", "g_mcntlo", "g_mcnthi"] : []),
    ...(hasFilterTable ? ["g_ftactive"] : []),
  ];
  const constants = ["fenv_init", "fenv_init+1", "fenv_init+2", "res_route", "fmode",
    ...(hasSweep ? ["fenv_step", "fenv_step+1", "fenv_min", "fenv_min+1", "fenv_max", "fenv_max+1"] : []),
  ];
  const loadChipFilter = [
    ...constants.map((name) => `  lda chip_${name.replace("+", "_")},x\n  sta ${name}`),
    ...(hasSweep ? [] : ["  lda fenv_init\n  sta g_cutlo\n  lda fenv_init+1\n  sta g_cuthi"]),
    ...filterState.map((name) => `  lda chip_${name},x\n  sta ${name}`),
  ].join("\n");
  const bankSave = filterState.map((name) => `  lda ${name}\n  sta chip_${name},x`).join("\n");
  const rangeStart = (label: string) => `  ldx chip_last\n${label}:`;
  const rangeEnd = (label: string) => `  cpx chip_first\n  beq ${label}_done\n  dex\n  jmp ${label}\n${label}_done:`;

  // Descending across the active chip's three slots, with channel bit masks
  // repeated in vbit. Filter ownership can only refer to voices in this group.
  code = code.replace("  ldx #2\ngl_route:", rangeStart("gl_route"))
    .replace("  dex\n  bpl gl_route", rangeEnd("gl_route"))
    .replace("  ldx #2\nft_voice:", rangeStart("ft_voice"))
    .replace("  dex\n  bpl ft_voice", rangeEnd("ft_voice"))
    .replace("  ldy #2\nft_mark_newer:", "  ldy chip_last\nft_mark_newer:")
    .replace("  dey\n  bpl ft_mark_newer", "  cpy chip_first\n  beq ft_mark_done\n  dey\n  bpl ft_mark_newer\nft_mark_done:");
  if (hasMod) {
    code = code.replace("  sta g_edir\n  rts\n\nv_save:", `  sta g_edir
  lda #0
  sta g_mofflo
  sta g_moffmd
  sta g_moffhi
  sta g_mcntlo
  sta g_mcnthi
  rts

v_save:`);
  } else {
    code = code.replace(/c_fmod:\n[\s\S]*?(?=c_loop:)/, "c_fmod:\n  jmp v_read\n")
      .replace(/  ; filter ramp from filter_mod[\s\S]*?(?=gl_env:)/, "")
      .replace("  adc g_mofflo\n", "").replace("  adc g_moffmd\n", "").replace("  adc g_moffhi\n", "");
  }
  if (!hasSweep) code = code.replace(/gl_env:\n[\s\S]*?(?=gl_done:\n)/, "gl_env:\n");
  if (!filtered) code = code.replace(/globals:\n[\s\S]*?(?=gl_done:\n)/, "globals:\n");

  // Add a constant register offset to the SID base through Y. Voice writes
  // already have the channel offset in Y and follow the sequence below.
  code = code.replace(
    /  ldy voff,x\n[\s\S]*?  sta \$D404,y/,
    `  ldy voff,x
  lda f_lo
  sta (sid_io),y
  iny
  lda f_hi
  sta (sid_io),y
  iny
  lda v_pwlo,x
  sta (sid_io),y
  iny
  lda v_pwhi,x
  sta (sid_io),y
  iny
  iny
  lda v_ad,x
  sta (sid_io),y
  iny
  lda v_sr,x
  sta (sid_io),y
  dey
  dey
  lda v_ctrl,x
  sta (sid_io),y`,
  );
  code = code.replace(/  sta \$D4(1[5-8])\n/g, (_, offset) => `  ldy #$${offset}\n  sta (sid_io),y\n`);

  // Clear every state byte, including when the arrays cross a page.
  const clear = Array.from({ length: Math.ceil(stateBytes / 256) }, (_, page) =>
    `  sta vars+${Math.min(page * 256, Math.max(0, stateBytes - 256))},x`).join("\n");
  code = code.replace(/ini_state:\n[\s\S]*?(?=ini_voice:\n)/, `ini_state:
  ldx #0
ini_chips:
  jsr chip_base
  lda #0
  ldy #$18
ini_sid:
  sta (sid_io),y
  dey
  bpl ini_sid
  lda chip_volume,x
  ldy #$18
  sta (sid_io),y
  inx
  cpx #${count}
  bne ini_chips
  lda #0
  ldx #${Math.min(256, stateBytes) - 1}
ini_vars:
${clear}
  dex
  cpx #$FF
  bne ini_vars
  ldx #${count * 3 - 1}
`);
  code = code.replace("  lda #15\n  sta g_vol\n  jsr env_reset\n", `
  ldx #${count - 1}
ini_filters:
  lda chip_volume,x
  sta chip_g_vol,x
  lda #0
${filterState.filter((name) => !["g_cutlo", "g_cuthi", "g_edir"].includes(name)).map((name) => `  sta chip_${name},x`).join("\n")}
${hasSweep ? ["g_cutlo", "g_cuthi", "g_edir"].map((name, i) =>
    `  lda chip_${constants[i]!.replace("+", "_")},x\n  sta chip_${name},x`).join("\n") : ""}
  dex
  bpl ini_filters
`);
  code = code.replace("  cpx #0\n  bne c_loop_x\n  jsr env_reset",
    filtered ? "  cpx chip_first\n  bne c_loop_x\n  jsr env_reset" : "");

  code = code.replace("  lda ptr+1\n  pha\n  ldx #0\n  jsr voice\n  ldx #1\n  jsr voice\n  ldx #2\n  jsr voice\n  jsr globals",
    `  lda ptr+1
  pha
  lda sid_io
  pha
  lda sid_io+1
  pha
  ldx #0
play_chip:
  stx chip_index
  jsr chip_base
  lda chip_g_vol,x
  sta g_vol
${filtered ? `  lda chip_has_filter,x
  bne play_chip_filter
  jmp play_chip_ready
play_chip_filter:
${loadChipFilter}
play_chip_ready:` : ""}
  lda chip_first_slot,x
  sta chip_first
  clc
  adc #2
  sta chip_last
  ldx chip_first
play_channel:
  lda voice_live,x
  beq play_channel_next
  jsr voice
play_channel_next:
  cpx chip_last
  beq play_chip_mix
  inx
  bne play_channel
play_chip_mix:
  ldx chip_index
${filtered ? `  lda chip_has_filter,x
  beq play_chip_volume
  jsr globals
  ldx chip_index
${bankSave}
  jmp play_chip_next
play_chip_volume:` : ""}
  lda g_vol
  ldy #$18
  sta (sid_io),y
play_chip_next:
  lda g_vol
  sta chip_g_vol,x
  inx
  cpx #${count}
  beq play_chips_done
  jmp play_chip
play_chips_done:
  pla
  sta sid_io+1
  pla
  sta sid_io`);

  // Preserve the caller's indirect pointer during init and play-once cleanup, too.
  code = code.replace("init_core:\n  tax", `init_core:
  tax
  lda sid_io
  pha
  lda sid_io+1
  pha`);
  code = code.replace("  pla\n  sta $01\n  rts\n\nplay:", `  pla
  sta $01
  pla
  sta sid_io+1
  pla
  sta sid_io
  rts

play:`);
  code = code.replace(/  lda #0\n  sta \$D404\n[\s\S]*?(?=  lda \$0314)/, `  lda sid_io
  pha
  lda sid_io+1
  pha
  ldx #0
finish_chip:
  jsr chip_base
  lda #0
  ldy #4
  sta (sid_io),y
  ldy #11
  sta (sid_io),y
  ldy #18
  sta (sid_io),y
  ldy #23
  sta (sid_io),y
  iny
  sta (sid_io),y
  inx
  cpx #${count}
  bne finish_chip
  pla
  sta sid_io+1
  pla
  sta sid_io
`);
  return code + `
chip_base:
  lda chip_address_lo,x
  sta sid_io
  lda chip_address_hi,x
  sta sid_io+1
  rts
chip_index: .res 1
chip_first: .res 1
chip_last: .res 1
chip_g_vol: .res ${count}
${filterState.map((name) => `chip_${name}: .res ${count}`).join("\n")}
`;
}

function stockPlayerBudget(system: SystemMode, speed: number): number {
  // Allow for VIC badlines and the host IRQ. Speed increases the call rate.
  return Math.floor((CYCLES_PER_FRAME[system] - 1_100) / speed) - 500;
}

function addTurboInit(code: string, speed: number, turboOnly: number): string {
  // hardware.md, Turbo Control: one register write survives the post-start
  // 1 MHz hold. Count CIA IRQs for the video standard measured in do_install.
  const hold = (system: SystemMode) => Math.ceil(4.25 * sidwaveFrameRate(system) * speed);
  return code.replace("det_pal:\n  lda cia_lo,x", `det_pal:
  lda #0
  sta turbo_wait
  sta turbo_wait+1
  lda $D031
  cmp #$FF
  bne turbo_enable
  lda turbo_required,x
  beq turbo_ready
  ; Keep BASIC responsive when the selected score exceeds the stock budget.
  cli
  rts
turbo_enable:
  lda #$8F
  sta $D031
  lda turbo_hold_lo,x
  sta turbo_wait
  lda turbo_hold_hi,x
  sta turbo_wait+1
turbo_ready:
  lda cia_lo,x`).replace("irq:\n  jsr play\n  jmp $EA31", `irq:
  lda turbo_wait
  ora turbo_wait+1
  beq turbo_play
  lda turbo_wait
  bne turbo_dec
  dec turbo_wait+1
turbo_dec:
  dec turbo_wait
  jmp $EA31
turbo_play:
  jsr play
  jmp $EA31
turbo_wait: .res 2
turbo_hold_lo: .byte <${hold("PAL")}, <${hold("NTSC")}
turbo_hold_hi: .byte >${hold("PAL")}, >${hold("NTSC")}
turbo_required: .byte ${turboOnly & 1}, ${turboOnly >> 1}`);
}

/** The old 1.0/1.1 template stays byte stable. Specialize the 1.2 player. */
function omitUnusedVoiceEffects(code: string, insts: Instrument[], hasPortamento: boolean): string {
  const arpeggio = insts.some((inst) => inst.arp.length);
  const slide = insts.some((inst) => inst.slideSpeed);
  const vibrato = insts.some((inst) => inst.vibRate);
  const pulseSweep = insts.some((inst) => inst.pwStep);

  if (!arpeggio) {
    code = code.replace(/v_regs:\n[\s\S]*?vr_noarp:\n/, "v_regs:\n")
      .replace("  lda i_arpspd,y\n  sta v_arpcnt,x\n", "")
      .replace("  sta v_arppos,x\n", "")
      .replace(/  lda i_arplen,y\n[\s\S]*?(?=va_slide:\n)/, "");
  }
  if (!slide) {
    code = code.replace(/vn_slide:\n[\s\S]*?(?=; ---- per-frame register output ----)/, "vn_slide:\n  jmp v_read\n\n")
      .replace(/mul16:\n[\s\S]*?(?=; ---- filter, routing and volume ----)/, "");
  }
  if (!slide && !hasPortamento) {
    code = code.replace("  lda i_slspd,y\n  sta v_scnt,x\n", "")
      .replace(/  ; slide: the remaining offset[\s\S]*?(?=vr_vib:\n)/, "")
      .replace(/va_slide:\n[\s\S]*?(?=va_vib:\n)/, "va_slide:\n");
  }
  if (!vibrato) {
    code = code.replace(/  lda i_vibdel,y\n  sta v_vibdel,x\n/, "")
      .replace(/  sta v_vibph,x\n[\s\S]*?(?=vn_slide:\n)/, "")
      .replace(/vr_vib:\n[\s\S]*?(?=vr_write:\n)/, "vr_vib:\n")
      .replace(/va_vib:\n[\s\S]*?(?=va_pw:\n)/, "va_vib:\n")
      .replace(/shr_p:\n[\s\S]*?(?=; ---- 8x8 multiply:)/, "")
      .replace(/mul:\n[\s\S]*?(?=; ---- 16x16 multiply:)/, "");
  }
  if (!pulseSweep) {
    code = code.replace("  sta v_pwdir,x\n", "").replace(/va_pw:\n[\s\S]*?(?=va_done:\n)/, "va_pw:\n");
  }
  if (!slide && !vibrato) code = code.replace(/mul8:\n[\s\S]*?(?=; ---- filter, routing and volume ----)/, "");
  return code;
}

function buildPlayerAsm(arr: Arrangement, streams: number[][], loop: boolean, turboOnly: number): string {
  const L: string[] = [];
  const insts = arr.instruments;
  const hasLegato = arr.voices.some(({ events }) => events.some((event) => event.order === ORDER.note && event.bytes[0] === OP.LEGATO));
  const hasPortamento = arr.voices.some(({ events }) => events.some((event) => event.order === ORDER.note && event.bytes.length > 2));
  const hasWavetable = insts.some((i) => i.wavetable?.length);
  const hasPulseTable = insts.some((i) => i.pulsetable?.steps?.length);
  const hasFilterTable = insts.some((i) => i.filtertable?.steps?.length);
  const channels = arr.voices.length;
  const voiceVars = VOICE_VARS.filter((name) => hasWavetable || !["wtpos", "wtleft", "wtnote"].includes(name));
  const pulseVars = hasPulseTable ? ["ptpos", "ptleft"] : [];
  const filterVars = hasFilterTable ? ["ftpos", "ftleft", "cutlo", "cuthi", "ftres", "fttype", "ftnewer"] : [];
  const stateBytes = channels * (voiceVars.length + pulseVars.length + filterVars.length) + GLOBAL_VARS.length + Number(hasFilterTable);
  const clockIndex = arr.system === "NTSC" ? 1 : 0;
  // The PRG's CIA timer reproduces the song's video frame rate on whichever clock the machine has.
  const ciaLatch = (clock: number) => Math.round(clock / (arr.fps)) - 1;
  const f = arr.filter;
  const fBase = Math.max(0, Math.min(2047, f.base)) * 32;
  const fEnd = Math.max(0, Math.min(2047, f.base + f.sweep)) * 32;
  const fMin = Math.min(fBase, fEnd);
  const fMax = Math.max(fBase, fEnd);
  const fDir = f.sweep < 0 ? 1 : 0;

  L.push(`ptr = $FB`);
  if (arr.chips) L.push(`sid_io = $FD`);
  L.push(`* = $0801`);
  L.push(`  .byte $0B,$08,$0A,$00,$9E,$32,$30,$36,$31,$00,$00,$00 ; 10 SYS2061`);
  L.push(`install:`);
  L.push(`  jmp do_install`);
  L.push(`init_vec:`);
  L.push(`  jmp init`);
  L.push(`play_vec:`);
  L.push(`  jmp play`);
  let playerCode = PLAYER_CODE;
  if (!hasWavetable) {
    playerCode = playerCode.replace(/  lda i_wtlen,y\n  beq vn_table_done\n  lda #0\n  sta v_wtpos,x\n  lda i_wtst,y\n  tay\n  lda wt_frames,y\n  sta v_wtleft,x\nvn_table_done:\n/, "");
    playerCode = playerCode.replace(/  sta tmp\n  ldy v_inst,x\n  lda i_wtlen,y\n  beq vr_plain_note\n[\s\S]*?vr_plain_note:\n/, "");
    playerCode = playerCode.replace("vr_note:\n  lda tmp\n  tay", "vr_note:\n  tay");
    playerCode = playerCode.replace(/  lda i_wtlen,y\n  beq va_return\n[\s\S]*?va_return:\n/, "");
  }
  if (hasWavetable) {
    // Wavetable initialization uses Y for its first row. The following loads need the instrument index.
    playerCode = playerCode.replace("  sta v_wtleft,x\nvn_table_done:", "  sta v_wtleft,x\n  ldy v_inst,x\nvn_table_done:");
  }
  if (hasPulseTable || hasFilterTable) {
    playerCode = playerCode.replace("  dex\n  bpl ini_vars", "  dex\n  cpx #$FF\n  bne ini_vars");
  }
  const addNoteHook = (routine: string) => {
    playerCode = playerCode.replace("note_on:\n  sta v_note,x\n", `note_on:\n  sta v_note,x\n  jsr ${routine}\n`);
  };
  const addReleaseHook = (routine: string) => {
    for (const label of ["c_gateoff", "c_hr"]) {
      playerCode = playerCode.replace(`${label}:\n`, `${label}:\n  jsr ${routine}\n`);
    }
  };
  if (hasPulseTable) {
    addNoteHook("pt_start");
    addReleaseHook("pt_stop");
    playerCode = playerCode.replace("vr_write:\n", "vr_write:\n  jsr pt_tick\n");
    playerCode += PULSE_TABLE_CODE + registerTableCode("pt", "pw", 1, 4094);
  }
  if (hasFilterTable) {
    addNoteHook("ft_start");
    addReleaseHook("ft_stop");
    playerCode = playerCode.replace("globals:\n", "globals:\n  lda g_ftactive\n  beq gl_regular\n  jmp ft_globals\ngl_regular:\n");
    playerCode += FILTER_TABLE_CODE + registerTableCode("ft", "cut", 0, 2047);
  }
  if (hasWavetable) {
    // Stop the table on release so its gate bit cannot undo a rest or hard restart.
    for (const label of ["c_gateoff", "c_hr"]) {
      playerCode = playerCode.replace(`${label}:\n`, `${label}:\n  lda #0\n  sta v_wtleft,x\n`);
    }
    playerCode = playerCode.replace("  lda wt_ctrl,y\n", "  lda wt_ctrl,y\n  pha\n  lda v_wtleft,x\n  bne vr_wt_active\n  pla\n  and #$FE\n  jmp vr_wt_ctrl\nvr_wt_active:\n  pla\nvr_wt_ctrl:\n");
    playerCode = playerCode.replace("  dec v_wtleft,x\n", "  lda v_wtleft,x\n  beq va_return\n  dec v_wtleft,x\n");
  }
  if (hasLegato) {
    playerCode += LEGATO_CODE;
  }
  if (hasPortamento) {
    playerCode = playerCode.replace("init_core:\n", "init_core:\n  sta port_clock\n");
    playerCode += PORTAMENTO_CODE;
  }
  if (arr.speed > 1) {
    // PSID hosts use the CIA latch written by init when song 1 selects CIA timing.
    // The PRG installer already sets the latch and enters at init_core.
    playerCode = playerCode.replace("  lda doc_clock\ninit_core:", `  ldx doc_clock
  lda cia_lo,x
  sta $DC04
  lda cia_hi,x
  sta $DC05
  txa
init_core:`);
  }
  if (!loop) {
    const calls = arr.totalFrames + 1;
    // Both anchors must exist; a silent miss would turn a play-once piece into a loop.
    if (!playerCode.includes("  jsr env_reset\n  pla") || !playerCode.includes("play:\n")) {
      throw new Error("SIDWAVE player code changed: the play-once patch points were not found");
    }
    playerCode = playerCode.replace("  jsr env_reset\n  pla", `  jsr env_reset
  lda #${calls & 255}
  sta song_left
  lda #${(calls >> 8) & 255}
  sta song_left+1
  lda #${calls >> 16}
  sta song_left+2
  pla`);
    playerCode = playerCode.replace("play:\n", "play:\n  jmp play_once\nplay_tick:\n");
    playerCode += PLAY_ONCE_CODE;
  }
  if (arr.chips) {
    playerCode = omitUnusedVoiceEffects(playerCode, insts, hasPortamento);
    playerCode = multiplexSids(playerCode, arr.chips, Boolean(hasFilterTable), stateBytes);
    if (arr.turbo) playerCode = addTurboInit(playerCode, arr.speed, turboOnly);
  }
  L.push(playerCode);
  // Constants
  L.push(`doc_clock: .byte ${clockIndex}`);
  L.push(`cia_lo: .byte <${ciaLatch(CLOCK_HZ.PAL)}, <${ciaLatch(CLOCK_HZ.NTSC)}`);
  L.push(`cia_hi: .byte >${ciaLatch(CLOCK_HZ.PAL)}, >${ciaLatch(CLOCK_HZ.NTSC)}`);
  L.push(`fenv_init: .byte <${fBase}, >${fBase}, ${fDir}`);
  L.push(`fenv_step: .byte <${f.stepFixed}, >${f.stepFixed}`);
  L.push(`fenv_min: .byte <${fMin}, >${fMin}`);
  L.push(`fenv_max: .byte <${fMax}, >${fMax}`);
  L.push(`res_route: .byte ${(f.resonance & 0x0f) << 4}`);
  L.push(`fmode: .byte ${f.mode}`);
  L.push(`voff: .byte ${streams.map((_, i) => (i % 3) * 7).join(", ")}`);
  L.push(`vbit: .byte ${streams.map((_, i) => 1 << (i % 3)).join(", ")}`);
  L.push(`start_lo: .byte ${streams.map((_, i) => `<stream${i}`).join(", ")}`);
  L.push(`start_hi: .byte ${streams.map((_, i) => `>stream${i}`).join(", ")}`);
  if (arr.chips) {
    const chipColumn = (name: string, get: (chip: ChipArrangement, i: number) => number) =>
      L.push(`chip_${name}: .byte ${arr.chips!.map(get).join(", ")}`);
    chipColumn("address_lo", (chip) => chip.address & 255);
    chipColumn("address_hi", (chip) => chip.address >> 8);
    chipColumn("first_slot", (_, i) => i * 3);
    chipColumn("volume", (chip) => chip.volume);
    chipColumn("has_filter", (chip) => Number(chip.filter.used || chip.hasFilterTable));
    if (arr.chips.some((chip) => chip.filter.used || chip.hasFilterTable)) {
      const start = ({ filter }: ChipArrangement) => filter.base * 32;
      const end = ({ filter }: ChipArrangement) => Math.max(0, Math.min(2047, filter.base + filter.sweep)) * 32;
      const filterWord = (name: string, get: (chip: ChipArrangement) => number) => {
        chipColumn(name, (chip) => get(chip) & 255);
        chipColumn(`${name}_1`, (chip) => get(chip) >> 8);
      };
      filterWord("fenv_init", start);
      chipColumn("fenv_init_2", ({ filter }) => Number(filter.sweep < 0));
      if (arr.chips.some(({ filter }) => filter.stepFixed)) {
        filterWord("fenv_step", ({ filter }) => filter.stepFixed);
        filterWord("fenv_min", (chip) => Math.min(start(chip), end(chip)));
        filterWord("fenv_max", (chip) => Math.max(start(chip), end(chip)));
      }
      chipColumn("res_route", ({ filter }) => filter.resonance << 4);
      chipColumn("fmode", ({ filter }) => filter.mode);
    }
    L.push(`voice_live: .byte ${arr.voices.map(({ events }, i) =>
      Number(events.length > 0 || (i % 3 === 0 && arr.chips![i / 3]!.filter.used))).join(", ")}`);
  }
  L.push(`cmd_tab:`);
  const commands = ["c_gateoff", "c_hr", "c_sr", "c_vol", "c_waitl", "c_fmod", "c_loop"];
  if (hasLegato || hasPortamento) commands.push(hasLegato ? "c_legato" : "c_loop");
  if (hasPortamento) commands.push("c_portamento");
  for (const name of commands) L.push(`  .byte <(${name}-1), >(${name}-1)`);

  // Instrument tables
  const arpTable: number[] = [];
  const arpStart = insts.map((inst) => {
    if (inst.arp.length === 0) return 0;
    for (let s = 0; s + inst.arp.length <= arpTable.length; s += 1) {
      if (inst.arp.every((v, i) => arpTable[s + i] === v)) return s;
    }
    const s = arpTable.length;
    arpTable.push(...inst.arp);
    return s;
  });
  if (arpTable.length > 256) throw new SidwaveValidationError("$.voices", "arpeggio tables exceed 256 entries");
  const col = (name: string, values: number[]) => pushByteRows(L, name, values.map((v) => `$${hex2(v)}`));
  col("i_ad", insts.map((i) => i.ad));
  col("i_sr", insts.map((i) => i.sr));
  col("i_wave", insts.map((i) => i.wave));
  col("i_pwlo", insts.map((i) => i.pw & 0xff));
  col("i_pwhi", insts.map((i) => i.pw >> 8));
  col("i_pwslo", insts.map((i) => i.pwStep & 0xff));
  col("i_pwshi", insts.map((i) => i.pwStep >> 8));
  col("i_pwminlo", insts.map((i) => i.pwMin & 0xff));
  col("i_pwminhi", insts.map((i) => i.pwMin >> 8));
  col("i_pwmaxlo", insts.map((i) => i.pwMax & 0xff));
  col("i_pwmaxhi", insts.map((i) => i.pwMax >> 8));
  col("i_vupm", insts.map((i) => i.vibUp[0]));
  col("i_vupsh", insts.map((i) => i.vibUp[1]));
  col("i_vdnm", insts.map((i) => i.vibDown[0]));
  col("i_vdnsh", insts.map((i) => i.vibDown[1]));
  col("i_vibrate", insts.map((i) => i.vibRate));
  col("i_vibdel", insts.map((i) => i.vibDelay));
  col("i_arpst", arpStart);
  col("i_arplen", insts.map((i) => i.arp.length));
  col("i_arpspd", insts.map((i) => Math.max(1, i.arpSpeed)));
  col("i_slsemi", insts.map((i) => i.slideSemis & 0xff));
  col("i_slspd", insts.map((i) => i.slideSpeed));
  col("i_slreclo", insts.map((i) => i.slideRecip & 0xff));
  col("i_slrechi", insts.map((i) => i.slideRecip >> 8));
  col("i_filt", insts.map((i) => i.filter));
  const wt: Array<{ ctrl: number; note: number; mode: number; frames: number }> = [];
  const wtStart = insts.map((inst) => {
    if (!inst.wavetable?.length) return 0;
    const start = wt.length;
    for (const s of inst.wavetable) {
      const wave = s.wave === undefined ? inst.wave & 0xf0 : waveformToCtrl(String(s.wave));
      const ring = s.ring ?? Boolean(inst.wave & 4);
      const sync = s.sync ?? Boolean(inst.wave & 2);
      const ctrl = wave | (s.gate === false ? 0 : 1) | (ring ? 4 : 0) | (sync ? 2 : 0) | (s.test ? 8 : 0);
      const n = s.note === undefined ? "" : String(s.note);
      const mode = !n ? 0 : /^[+-]/.test(n) ? 1 : 2;
      const note = mode === 0 ? 0 : mode === 1 ? (Number(n) & 255) : (noteNameToMidi(n)! - 12);
      wt.push({ ctrl, note, mode, frames: Number(s.frames ?? 1) });
    }
    return start;
  });
  if (wt.length > 255) throw new SidwaveValidationError("$.instruments", "wavetable data exceeds 255 steps");
  if (hasWavetable) {
    col("i_wtst", wtStart);
    col("i_wtlen", insts.map((i) => i.wavetable?.length ?? 0));
    col("i_wtlp", insts.map((i) => i.wavetable?.length ? (i.waveloop ?? i.wavetable.length - 1) : 0));
    col("wt_ctrl", wt.length ? wt.map((s) => s.ctrl) : [0]);
    col("wt_note", wt.length ? wt.map((s) => s.note) : [0]);
    col("wt_mode", wt.length ? wt.map((s) => s.mode) : [0]);
    col("wt_frames", wt.length ? wt.map((s) => s.frames) : [1]);
  }
  for (const [enabled, prefix, name] of [
    [hasPulseTable, "pt", "pulsetable"], [hasFilterTable, "ft", "filtertable"],
  ] as const) {
    if (!enabled) continue;
    const steps: SidwaveRegisterTable["steps"] = [];
    const tables = insts.map((inst) => inst[name]);
    const starts = tables.map((table) => {
      if (!table) return 0;
      const start = steps.length;
      steps.push(...table.steps);
      return start;
    });
    if (steps.length > 255) throw new SidwaveValidationError("$.instruments", `${name} data exceeds 255 steps`);
    col(`i_${prefix}st`, starts);
    col(`i_${prefix}len`, tables.map((table) => table?.steps.length ?? 0));
    col(`i_${prefix}lp`, tables.map((table) => table?.loop ?? 255));
    col(`${prefix}_lo`, steps.map((step) => step.value & 255));
    col(`${prefix}_hi`, steps.map((step) => (step.value >> 8) & 255));
    col(`${prefix}_add`, steps.map((step) => +step.add));
    col(`${prefix}_frames`, steps.map((step) => step.frames));
    if (prefix === "ft") {
      col("ft_res", steps.map((step) => step.resonance === undefined ? 255 : step.resonance << 4));
      col("ft_type", steps.map((step) => step.type ?? 255));
    }
  }
  col("arptab", arpTable.length ? arpTable.map((v) => v & 0xff) : [0]);

  if (!arr.chips || insts.some((inst) => inst.slideSpeed || inst.vibRate)) {
    // Quarter-square table for the 8x8 multiply: sq(x) = floor(x * x / 4), x = 0..511.
    const squares = Array.from({ length: 512 }, (_, x) => Math.floor((x * x) / 4));
    col("sq_lo", squares.map((v) => v & 0xff));
    col("sq_hi", squares.map((v) => (v >> 8) & 0xff));
  }

  // Frequency tables C0..B7 for both clocks; init copies the right one into ftlo/fthi.
  for (const sys of ["PAL", "NTSC"] as const) {
    const values = Array.from({ length: 96 }, (_, n) => hzToSidFrequency(midiToHz(n + 12), sys));
    col(`${sys.toLowerCase()}_lo`, values.map((v) => v & 0xff));
    col(`${sys.toLowerCase()}_hi`, values.map((v) => v >> 8));
  }

  // RAM
  L.push(`ftlo: .res 96`);
  L.push(`fthi: .res 96`);
  L.push(`vars:`);
  for (const name of voiceVars) L.push(`v_${name}: .res ${channels}`);
  for (const name of GLOBAL_VARS) L.push(`${name}: .res 1`);
  for (const name of pulseVars) L.push(`v_${name}: .res ${channels}`);
  if (hasFilterTable) {
    for (const name of filterVars) L.push(`v_${name}: .res ${channels}`);
    L.push("g_ftactive: .res 1");
  }
  L.push(`vars_end:`);

  streams.forEach((s, i) => pushByteRows(L, `stream${i}`, s.map((b) => `$${hex2(b)}`)));
  L.push(`prg_end:`);
  return L.join("\n");
}

const VOICE_VARS = [
  "ptrlo", "ptrhi", "wait", "note", "inst", "ctrl", "ad", "sr", "pwlo", "pwhi", "pwdir", "arppos", "arpcnt", "wtpos", "wtleft", "wtnote",
  "vibph", "vibdel", "vuplo", "vuphi", "vdnlo", "vdnhi", "sofflo", "soffmd", "soffhi", "sstlo", "sstmd", "ssthi", "sdir", "scnt",
];
const GLOBAL_VARS = [
  "g_vol", "g_cutlo", "g_cuthi", "g_edir", "g_mofflo", "g_moffmd", "g_moffhi", "g_mstlo", "g_mstmd", "g_msthi", "g_mcntlo", "g_mcnthi",
  "f_lo", "f_hi", "p0", "p1", "p2", "m_lo", "m_hi", "m_fac", "n_lo", "n_hi", "q0", "q1", "q2", "q3",
  "ma", "mb", "r_lo", "r_hi", "ysave",
  "tmp", "t_lo", "t_hi", "t_xx",
];

// The player. X holds the voice index (0..2) inside the voice routine; Y is scratch.
const PLAYER_CODE = String.raw`
do_install:
  sei
det1:
  lda $D012
det2:
  cmp $D012
  beq det2
  bmi det1
  ldx #0
  cmp #$20
  bcs det_pal
  ldx #1
det_pal:
  lda cia_lo,x
  sta $DC04
  lda cia_hi,x
  sta $DC05
  lda $DC0E
  and #$80
  ora #$11
  sta $DC0E
  txa
  jsr init_core
  ; Move BASIC's program and variables behind the player (like NEW with a raised start of BASIC),
  ; so BASIC stays usable after the SYS returns and new program lines cannot overwrite the player.
  lda #0
  sta prg_end
  sta prg_end+1
  sta prg_end+2
  lda #<(prg_end+1)
  sta $2B
  lda #>(prg_end+1)
  sta $2C
  lda #<(prg_end+3)
  sta $2D
  sta $2F
  sta $31
  lda #>(prg_end+3)
  sta $2E
  sta $30
  sta $32
  lda #<irq
  sta $0314
  lda #>irq
  sta $0315
  cli
  rts

irq:
  jsr play
  jmp $EA31

init:
  lda doc_clock
init_core:
  tax
  lda $01
  pha
  lda #$36
  sta $01
  ldy #95
  cpx #0
  bne ini_ntsc
ini_pal:
  lda pal_lo,y
  sta ftlo,y
  lda pal_hi,y
  sta fthi,y
  dey
  bpl ini_pal
  jmp ini_state
ini_ntsc:
  lda ntsc_lo,y
  sta ftlo,y
  lda ntsc_hi,y
  sta fthi,y
  dey
  bpl ini_ntsc
ini_state:
  lda #0
  ldx #$18
ini_sid:
  sta $D400,x
  dex
  bpl ini_sid
  ldx #vars_end-vars-1
ini_vars:
  sta vars,x
  dex
  bpl ini_vars
  ldx #2
ini_voice:
  lda #1
  sta v_wait,x
  lda start_lo,x
  sta v_ptrlo,x
  lda start_hi,x
  sta v_ptrhi,x
  dex
  bpl ini_voice
  lda #15
  sta g_vol
  jsr env_reset
  pla
  sta $01
  rts

play:
  lda $01
  pha
  lda #$36
  sta $01
  lda ptr
  pha
  lda ptr+1
  pha
  ldx #0
  jsr voice
  ldx #1
  jsr voice
  ldx #2
  jsr voice
  jsr globals
  pla
  sta ptr+1
  pla
  sta ptr
  pla
  sta $01
  rts

fetch:
  ldy #0
  lda (ptr),y
  inc ptr
  bne fetch_x
  inc ptr+1
fetch_x:
  rts

voice:
  dec v_wait,x
  beq v_seq
  jmp v_regs
v_seq:
  lda v_ptrlo,x
  sta ptr
  lda v_ptrhi,x
  sta ptr+1
v_read:
  jsr fetch
  cmp #$60
  bcs v_not_note
  jmp note_on
v_not_note:
  cmp #$A0
  bcs v_not_inst
  sbc #$5F ; carry is clear here, so this subtracts $60
  sta v_inst,x
  jmp v_read
v_not_inst:
  cmp #$E0
  bcs v_cmd
  sbc #$9E ; carry is clear here, so this subtracts $9F (WAIT $A0 = 1 frame)
  sta v_wait,x
  jmp v_save
v_cmd:
  sec
  sbc #$E0
  asl
  tay
  lda cmd_tab+1,y
  pha
  lda cmd_tab,y
  pha
  rts

c_gateoff:
  lda v_ctrl,x
  and #$FE
  sta v_ctrl,x
  jmp v_read
c_hr:
  lda v_ctrl,x
  and #$FE
  sta v_ctrl,x
  lda #0
  sta v_ad,x
  sta v_sr,x
  jmp v_read
c_sr:
  jsr fetch
  sta v_sr,x
  jmp v_read
c_vol:
  jsr fetch
  sta g_vol
  jmp v_read
c_waitl:
  jsr fetch
  sta v_wait,x
  jmp v_save
c_fmod:
  jsr fetch
  sta g_mstlo
  jsr fetch
  sta g_mstmd
  jsr fetch
  sta g_msthi
  jsr fetch
  sta g_mcntlo
  jsr fetch
  sta g_mcnthi
  lda #0
  sta g_mofflo
  sta g_moffmd
  sta g_moffhi
  jmp v_read
c_loop:
  lda start_lo,x
  sta ptr
  lda start_hi,x
  sta ptr+1
  cpx #0
  bne c_loop_x
  jsr env_reset
c_loop_x:
  jmp v_read

; the filter sweep restarts with the song so every pass sounds the same
env_reset:
  lda fenv_init
  sta g_cutlo
  lda fenv_init+1
  sta g_cuthi
  lda fenv_init+2
  sta g_edir
  rts

v_save:
  lda ptr
  sta v_ptrlo,x
  lda ptr+1
  sta v_ptrhi,x
  jmp v_regs

; ---- note on: A = note index ----
note_on:
  sta v_note,x
  ldy v_inst,x
  lda i_ad,y
  sta v_ad,x
  lda i_sr,y
  sta v_sr,x
  lda i_wave,y
  ora #1
  sta v_ctrl,x
  lda i_wtlen,y
  beq vn_table_done
  lda #0
  sta v_wtpos,x
  lda i_wtst,y
  tay
  lda wt_frames,y
  sta v_wtleft,x
vn_table_done:
  lda i_pwlo,y
  sta v_pwlo,x
  lda i_pwhi,y
  sta v_pwhi,x
  lda i_arpspd,y
  sta v_arpcnt,x
  lda i_vibdel,y
  sta v_vibdel,x
  lda i_slspd,y
  sta v_scnt,x
  lda #0
  sta v_pwdir,x
  sta v_arppos,x
  sta v_vibph,x
  sta v_vuplo,x
  sta v_vuphi,x
  sta v_vdnlo,x
  sta v_vdnhi,x
  ; vibrato amplitudes above and below the note: ft[n] * mant >> (8 + shift)
  lda i_vupm,y
  beq vn_slide
  ldy v_note,x
  lda ftlo,y
  sta m_lo
  lda fthi,y
  sta m_hi
  ldy v_inst,x
  lda i_vupm,y
  sta m_fac
  jsr mul
  lda i_vupsh,y
  jsr shr_p
  lda p1
  sta v_vuplo,x
  lda p2
  sta v_vuphi,x
  lda i_vdnm,y
  sta m_fac
  jsr mul
  lda i_vdnsh,y
  jsr shr_p
  lda p1
  sta v_vdnlo,x
  lda p2
  sta v_vdnhi,x
vn_slide:
  ldy v_inst,x
  lda i_slsemi,y
  bne vn_sl_on
  jmp v_read
vn_sl_on:
  ; the slide starts at note - semis (the compiler checks that it is in range)
  sta tmp
  lda v_note,x
  sec
  sbc tmp
  tay
  lda tmp
  bmi vn_sl_above
  ; start below: magnitude = ft[note] - ft[start]
  lda #0
  sta v_sdir,x
  sty tmp
  ldy v_note,x
  sec
  lda ftlo,y
  ldy tmp
  sbc ftlo,y
  sta m_lo
  ldy v_note,x
  lda fthi,y
  ldy tmp
  sbc fthi,y
  sta m_hi
  jmp vn_sl_step
vn_sl_above:
  ; start above: magnitude = ft[start] - ft[note]
  lda #1
  sta v_sdir,x
  sty tmp
  sec
  lda ftlo,y
  ldy v_note,x
  sbc ftlo,y
  sta m_lo
  ldy tmp
  lda fthi,y
  ldy v_note,x
  sbc fthi,y
  sta m_hi
vn_sl_step:
  ; offset = magnitude (16.8 fixed point); step per frame = magnitude * round(65536 / speed) / 256
  lda #0
  sta v_sofflo,x
  lda m_lo
  sta v_soffmd,x
  lda m_hi
  sta v_soffhi,x
  ldy v_inst,x
  lda i_slreclo,y
  sta n_lo
  lda i_slrechi,y
  sta n_hi
  jsr mul16
  lda q1
  sta v_sstlo,x
  lda q2
  sta v_sstmd,x
  lda q3
  sta v_ssthi,x
  jmp v_read

; ---- per-frame register output ----
v_regs:
  ldy v_inst,x
  lda i_arplen,y
  beq vr_noarp
  lda i_arpst,y
  clc
  adc v_arppos,x
  tay
  lda arptab,y
  clc
  adc v_note,x
  jmp vr_note
vr_noarp:
  lda v_note,x
vr_note:
  sta tmp
  ldy v_inst,x
  lda i_wtlen,y
  beq vr_plain_note
  lda i_wtst,y
  clc
  adc v_wtpos,x
  tay
  lda wt_ctrl,y
  sta v_ctrl,x
  lda wt_mode,y
  beq vr_plain_note
  cmp #1
  bne vr_abs_table_note
  lda v_note,x
  clc
  adc wt_note,y
  jmp vr_table_note
vr_abs_table_note:
  lda wt_note,y
vr_table_note:
  tay
  lda ftlo,y
  sta f_lo
  lda fthi,y
  sta f_hi
  jmp vr_write
vr_plain_note:
  lda tmp
  tay
  lda ftlo,y
  sta f_lo
  lda fthi,y
  sta f_hi
  ; slide: the remaining offset, applied below or above the note
  lda v_scnt,x
  bne vr_sl_on
  jmp vr_vib
vr_sl_on:
  lda v_soffmd,x
  sta t_lo
  lda v_soffhi,x
  sta t_hi
vr_sl_apply:
  lda v_sdir,x
  bne vr_sl_up
  sec
  lda f_lo
  sbc t_lo
  sta f_lo
  lda f_hi
  sbc t_hi
  sta f_hi
  bcs vr_vib
  lda #0
  sta f_lo
  sta f_hi
  jmp vr_vib
vr_sl_up:
  clc
  lda f_lo
  adc t_lo
  sta f_lo
  lda f_hi
  adc t_hi
  sta f_hi
  bcc vr_vib
  lda #$FF
  sta f_lo
  sta f_hi
vr_vib:
  lda v_vuplo,x
  ora v_vuphi,x
  beq vr_novib
  lda v_vibdel,x
  beq vr_vib_on
vr_novib:
  jmp vr_write
vr_vib_on:
  lda v_vibph,x
  and #$7F
  cmp #$40
  bcc vr_tri
  eor #$7F
vr_tri:
  asl
  sta m_fac
  lda v_vibph,x
  bmi vr_vib_dn
  lda v_vuplo,x
  sta m_lo
  lda v_vuphi,x
  sta m_hi
  jsr mul
  asl p0
  rol p1
  rol p2
  ; add round(amplitude * tri / 128): the carry holds the rounding bit
  lda p0
  cmp #$80
  lda f_lo
  adc p1
  sta f_lo
  lda f_hi
  adc p2
  sta f_hi
  bcc vr_write
  lda #$FF
  sta f_lo
  sta f_hi
  jmp vr_write
vr_vib_dn:
  lda v_vdnlo,x
  sta m_lo
  lda v_vdnhi,x
  sta m_hi
  jsr mul
  asl p0
  rol p1
  rol p2
  ; subtract round(amplitude * tri / 128): a clear carry borrows the rounding bit
  lda #$7F
  cmp p0
  lda f_lo
  sbc p1
  sta f_lo
  lda f_hi
  sbc p2
  sta f_hi
  bcs vr_write
  lda #0
  sta f_lo
  sta f_hi
vr_write:
  ldy voff,x
  lda f_lo
  sta $D400,y
  lda f_hi
  sta $D401,y
  lda v_pwlo,x
  sta $D402,y
  lda v_pwhi,x
  sta $D403,y
  lda v_ad,x
  sta $D405,y
  lda v_sr,x
  sta $D406,y
  lda v_ctrl,x
  sta $D404,y

; ---- advance modulators for the next frame ----
  ldy v_inst,x
  lda i_arplen,y
  beq va_slide
  dec v_arpcnt,x
  bne va_slide
  lda i_arpspd,y
  sta v_arpcnt,x
  lda v_arppos,x
  clc
  adc #1
  cmp i_arplen,y
  bcc va_arp_ok
  lda #0
va_arp_ok:
  sta v_arppos,x
va_slide:
  lda v_scnt,x
  beq va_vib
  dec v_scnt,x
  sec
  lda v_sofflo,x
  sbc v_sstlo,x
  sta v_sofflo,x
  lda v_soffmd,x
  sbc v_sstmd,x
  sta v_soffmd,x
  lda v_soffhi,x
  sbc v_ssthi,x
  sta v_soffhi,x
  bcs va_vib
  lda #0
  sta v_soffmd,x
  sta v_soffhi,x
va_vib:
  lda v_vibdel,x
  beq va_vib_run
  dec v_vibdel,x
  jmp va_pw
va_vib_run:
  lda v_vibph,x
  clc
  adc i_vibrate,y
  sta v_vibph,x
va_pw:
  lda i_pwslo,y
  ora i_pwshi,y
  beq va_done
  lda v_pwdir,x
  bne va_pw_down
  clc
  lda v_pwlo,x
  adc i_pwslo,y
  sta v_pwlo,x
  lda v_pwhi,x
  adc i_pwshi,y
  sta v_pwhi,x
  cmp i_pwmaxhi,y
  bcc va_done
  bne va_pw_max
  lda v_pwlo,x
  cmp i_pwmaxlo,y
  bcc va_done
va_pw_max:
  lda i_pwmaxlo,y
  sta v_pwlo,x
  lda i_pwmaxhi,y
  sta v_pwhi,x
  lda #1
  sta v_pwdir,x
  rts
va_pw_down:
  sec
  lda v_pwlo,x
  sbc i_pwslo,y
  sta v_pwlo,x
  lda v_pwhi,x
  sbc i_pwshi,y
  sta v_pwhi,x
  bcc va_pw_min
  cmp i_pwminhi,y
  bcc va_pw_min
  bne va_done
  lda v_pwlo,x
  cmp i_pwminlo,y
  beq va_pw_min
  bcs va_done
va_pw_min:
  lda i_pwminlo,y
  sta v_pwlo,x
  lda i_pwminhi,y
  sta v_pwhi,x
  lda #0
  sta v_pwdir,x
va_done:
  lda i_wtlen,y
  beq va_return
  dec v_wtleft,x
  bne va_return
  lda v_wtpos,x
  clc
  adc #1
  cmp i_wtlen,y
  bcc va_wt_next
  lda i_wtlp,y
  sta v_wtpos,x
  jmp va_wt_load
va_wt_next:
  sta v_wtpos,x
va_wt_load:
  lda i_wtst,y
  clc
  adc v_wtpos,x
  tay
  lda wt_frames,y
  sta v_wtleft,x
va_return:
  rts

;  ---- p2:p1 = round(p2:p1:p0 / 2^(8 + A)) (A = 0..15) ----
shr_p:
  sta tmp
shr_l:
  lda tmp
  beq shr_x
  lsr p2
  ror p1
  ror p0
  dec tmp
  jmp shr_l
shr_x:
  lda p0
  cmp #$80
  lda p1
  adc #0
  sta p1
  lda p2
  adc #0
  sta p2
  rts

; ---- 8x8 multiply: ma * mb -> r_hi:r_lo, using a*b = sq(a+b) - sq(|a-b|) with sq(x) = floor(x*x/4) ----
; Clobbers A and Y; preserves X, ma and mb.
mul8:
  lda ma
  clc
  adc mb
  tay
  bcc mul8_low
  lda sq_lo+256,y
  sta r_lo
  lda sq_hi+256,y
  sta r_hi
  jmp mul8_diff
mul8_low:
  lda sq_lo,y
  sta r_lo
  lda sq_hi,y
  sta r_hi
mul8_diff:
  lda ma
  sec
  sbc mb
  bcs mul8_pos
  eor #$FF
  adc #1
mul8_pos:
  tay
  sec
  lda r_lo
  sbc sq_lo,y
  sta r_lo
  lda r_hi
  sbc sq_hi,y
  sta r_hi
  rts

; ---- 16x8 multiply: m_hi:m_lo * m_fac -> p2:p1:p0 (preserves X, Y and m) ----
mul:
  sty ysave
  lda m_fac
  sta mb
  lda m_lo
  sta ma
  jsr mul8
  lda r_lo
  sta p0
  lda r_hi
  sta p1
  lda m_hi
  sta ma
  jsr mul8
  clc
  lda p1
  adc r_lo
  sta p1
  lda r_hi
  adc #0
  sta p2
  ldy ysave
  rts

; ---- 16x16 multiply: m_hi:m_lo * n_hi:n_lo -> q3:q2:q1:q0 (preserves X, Y, m and n) ----
mul16:
  sty ysave
  lda m_lo
  sta ma
  lda n_lo
  sta mb
  jsr mul8
  lda r_lo
  sta q0
  lda r_hi
  sta q1
  lda m_hi
  sta ma
  jsr mul8
  clc
  lda q1
  adc r_lo
  sta q1
  lda r_hi
  adc #0
  sta q2
  lda n_hi
  sta mb
  jsr mul8
  clc
  lda q2
  adc r_lo
  sta q2
  lda r_hi
  adc #0
  sta q3
  lda m_lo
  sta ma
  jsr mul8
  clc
  lda q1
  adc r_lo
  sta q1
  lda q2
  adc r_hi
  sta q2
  lda q3
  adc #0
  sta q3
  ldy ysave
  rts

; ---- filter, routing and volume ----
globals:
  ; cutoff = sweep position (unsigned 16-bit) + filter_mod offset (signed 24-bit), clamped to 0..2047 x 32
  clc
  lda g_cutlo
  adc g_mofflo
  sta t_lo
  lda g_cuthi
  adc g_moffmd
  sta t_hi
  lda #0
  adc g_moffhi
  sta t_xx
  bmi gl_low
  beq gl_out
  lda #$E0
  sta t_lo
  lda #$FF
  sta t_hi
  jmp gl_out
gl_low:
  lda #0
  sta t_lo
  sta t_hi
gl_out:
  lda t_lo
  lsr
  lsr
  lsr
  lsr
  lsr
  sta $D415
  lda t_hi
  sta $D416
  lda #0
  sta tmp
  ldx #2
gl_route:
  ldy v_inst,x
  lda i_filt,y
  beq gl_route_n
  lda vbit,x
  ora tmp
  sta tmp
gl_route_n:
  dex
  bpl gl_route
  lda tmp
  ora res_route
  sta $D417
  lda g_vol
  ora fmode
  sta $D418
  ; filter ramp from filter_mod
  lda g_mcntlo
  ora g_mcnthi
  beq gl_env
  clc
  lda g_mofflo
  adc g_mstlo
  sta g_mofflo
  lda g_moffmd
  adc g_mstmd
  sta g_moffmd
  lda g_moffhi
  adc g_msthi
  sta g_moffhi
  lda g_mcntlo
  bne gl_dec
  dec g_mcnthi
gl_dec:
  dec g_mcntlo
gl_env:
  lda fenv_step
  ora fenv_step+1
  beq gl_done
  lda g_edir
  bne gl_env_down
  clc
  lda g_cutlo
  adc fenv_step
  sta g_cutlo
  lda g_cuthi
  adc fenv_step+1
  sta g_cuthi
  bcs gl_env_top
  cmp fenv_max+1
  bcc gl_done
  bne gl_env_top
  lda g_cutlo
  cmp fenv_max
  bcc gl_done
gl_env_top:
  lda fenv_max
  sta g_cutlo
  lda fenv_max+1
  sta g_cuthi
  lda #1
  sta g_edir
  rts
gl_env_down:
  sec
  lda g_cutlo
  sbc fenv_step
  sta g_cutlo
  lda g_cuthi
  sbc fenv_step+1
  sta g_cuthi
  bcc gl_env_bot
  cmp fenv_min+1
  bcc gl_env_bot
  bne gl_done
  lda g_cutlo
  cmp fenv_min
  beq gl_env_bot
  bcs gl_done
gl_env_bot:
  lda fenv_min
  sta g_cutlo
  lda fenv_min+1
  sta g_cuthi
  lda #0
  sta g_edir
gl_done:
  rts
`;

// Both tables use the same cursor and signed arithmetic. A zero counter holds the
// previous register value. A new note seeds the cursor so its first call enters row 0.
function registerTableCode(prefix: "pt" | "ft", value: "pw" | "cut", min: number, max: number): string {
  return `
${prefix}_tick:
  lda v_${prefix}left,x
  bne ${prefix}_running
  rts
${prefix}_running:
  dec v_${prefix}left,x
  bne ${prefix}_current
  ldy v_inst,x
  lda v_${prefix}pos,x
  clc
  adc #1
  cmp i_${prefix}len,y
  bcc ${prefix}_next
  lda i_${prefix}lp,y
  cmp #$FF
  bne ${prefix}_next
  rts
${prefix}_next:
  sta v_${prefix}pos,x
  clc
  adc i_${prefix}st,y
  tay
  lda ${prefix}_frames,y
  sta v_${prefix}left,x
  jmp ${prefix}_step
${prefix}_current:
  ldy v_inst,x
  lda i_${prefix}st,y
  clc
  adc v_${prefix}pos,x
  tay
${prefix}_step:
${prefix === "ft" ? `  lda ft_res,y
  cmp #$FF
  beq ft_keep_res
  sta v_ftres,x
ft_keep_res:
  lda ft_type,y
  bmi ft_keep_type
  sta v_fttype,x
ft_keep_type:
` : ""}  lda ${prefix}_add,y
  beq ${prefix}_set
  clc
  lda v_${value}lo,x
  adc ${prefix}_lo,y
  sta t_lo
  lda v_${value}hi,x
  adc ${prefix}_hi,y
  bmi ${prefix}_min
  cmp #>${max}
  bcc ${prefix}_sum
  bne ${prefix}_max
  tay
  lda t_lo
  cmp #<${max}
  bcc ${prefix}_write
${prefix}_max:
  lda #<${max}
  ldy #>${max}
  bne ${prefix}_write
${prefix}_min:
  lda #${min}
  ldy #0
  jmp ${prefix}_write
${prefix}_sum:
  tay
  lda t_lo
${min ? `  bne ${prefix}_write
  cpy #0
  bne ${prefix}_write
  lda #${min}
` : ""}  jmp ${prefix}_write
${prefix}_set:
  lda ${prefix}_lo,y
  sta v_${value}lo,x
  lda ${prefix}_hi,y
  sta v_${value}hi,x
  rts
${prefix}_write:
  sta v_${value}lo,x
  tya
  sta v_${value}hi,x
  rts
`;
}

// A generated piece plays once. Stop writing the SID after the last score tick
// and detach the IRQ only when running as the installed PRG.
const PLAY_ONCE_CODE = String.raw`
play_once:
  lda song_left
  ora song_left+1
  ora song_left+2
  bne play_once_running
  rts
play_once_running:
  lda song_left
  bne play_once_low
  lda song_left+1
  bne play_once_mid
  dec song_left+2
play_once_mid:
  dec song_left+1
play_once_low:
  dec song_left
  lda song_left
  ora song_left+1
  ora song_left+2
  beq finish_song
  jmp play_tick
finish_song:
  lda $01
  pha
  lda #$36
  sta $01
  lda #0
  sta $D404
  sta $D40B
  sta $D412
  sta $D417
  lda #$0F
  sta $D418
  lda $0314
  cmp #<irq
  bne finish_done
  lda $0315
  cmp #>irq
  bne finish_done
  lda #$31
  sta $0314
  lda #$EA
  sta $0315
  ; Restore the 60 Hz KERNAL jiffy clock.
  ldx #0
  lda $02A6
  bne finish_latch
  inx
finish_latch:
  lda kernal_cia_lo,x
  sta $DC04
  lda kernal_cia_hi,x
  sta $DC05
finish_done:
  pla
  sta $01
  rts
kernal_cia_lo: .byte <16420, <17044
kernal_cia_hi: .byte >16420, >17044
song_left: .res 3
`;

const LEGATO_CODE = String.raw`
c_legato:
  jsr fetch
  sta v_note,x
  lda #0
  sta v_scnt,x
  jmp v_read
`;

const PORTAMENTO_CODE = String.raw`
; Each clock has five bytes of glide data, prepared by the compiler.
c_portamento:
  jsr fetch
  sta v_scnt,x
  jsr fetch
  sta v_sdir,x
  lda port_clock
  beq port_load
  jsr port_skip
port_load:
  lda #0
  sta v_sofflo,x
  jsr fetch
  sta v_soffmd,x
  jsr fetch
  sta v_soffhi,x
  jsr fetch
  sta v_sstlo,x
  jsr fetch
  sta v_sstmd,x
  jsr fetch
  sta v_ssthi,x
  lda port_clock
  bne port_done
  jsr port_skip
port_done:
  jmp v_read
port_skip:
  clc
  lda ptr
  adc #5
  sta ptr
  bcc port_skip_done
  inc ptr+1
port_skip_done:
  rts
port_clock: .byte 0
`;

const PULSE_TABLE_CODE = String.raw`
pt_start:
  lda #$FF
  sta v_ptpos,x
  ldy v_inst,x
  lda i_ptlen,y
  beq pt_stop
  lda #1
  bne pt_counter
pt_stop:
  lda #0
pt_counter:
  sta v_ptleft,x
  rts
`;

const FILTER_TABLE_CODE = String.raw`
ft_start:
  ldy v_inst,x
  lda i_ftlen,y
  beq ft_stop
  lda vbit,x
  ora g_ftactive
  sta g_ftactive
  ; Each voice remembers which voices started more recently. Inactive voices
  ; are masked out, so the next most recent active note can take over.
  lda vbit,x
  ldy #2
ft_mark_newer:
  ora v_ftnewer,y
  sta v_ftnewer,y
  lda vbit,x
  dey
  bpl ft_mark_newer
  lda #0
  sta v_ftnewer,x
  sta v_cutlo,x
  sta v_cuthi,x
  lda #$80
  sta v_ftres,x
  lda #$10
  sta v_fttype,x
  lda #$FF
  sta v_ftpos,x
  lda #1
  sta v_ftleft,x
  rts
ft_stop:
  lda vbit,x
  eor #$FF
  and g_ftactive
  sta g_ftactive
  rts

ft_globals:
  ldx #2
ft_voice:
  lda vbit,x
  and g_ftactive
  beq ft_next_voice
  jsr ft_tick
  lda v_ftnewer,x
  and g_ftactive
  bne ft_next_voice
  lda v_cutlo,x
  and #7
  sta $D415
  lda v_cutlo,x
  sta t_lo
  lda v_cuthi,x
  lsr
  ror t_lo
  lsr
  ror t_lo
  lsr
  ror t_lo
  lda t_lo
  sta $D416
  lda v_ftres,x
  ora g_ftactive
  sta $D417
  lda v_fttype,x
  ora g_vol
  sta $D418
ft_next_voice:
  dex
  bpl ft_voice
  rts
`;

function pushByteRows(out: string[], label: string, items: string[], perLine = 16): void {
  out.push(`${label}:`);
  for (let i = 0; i < items.length; i += perLine) {
    out.push(`  .byte ${items.slice(i, i + perLine).join(",")}`);
  }
}

function hex2(n: number): string {
  return (n & 0xff).toString(16).toUpperCase().padStart(2, "0");
}
