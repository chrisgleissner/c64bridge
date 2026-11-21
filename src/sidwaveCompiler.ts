/*
C64 Bridge - SIDWAVE to PRG Compiler
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { Buffer } from "node:buffer";
import { cutoffHz, resolveCutoff } from "./sidwaveFilterModel.js";
import { RELEASE_MS, SidwaveFindings, lintArrangement, arrangementReport, formatFinding, type SidwaveFinding } from "./sidwaveLint.js";
import { digiTriggers, makeTimelineClock, rampValue, timelinePatternPasses, type TimelineClock } from "./sidwaveForm.js";
import type { SampleStats } from "./sidwavePcm.js";
import { addDigiPlayer, digiCyclesPerCall, digiDataAsm, digiPeakCycles, digiPeriod, validateDigiRate } from "./sidwaveDigi.js";
import { assemblyToPrgDetailed } from "./tools/translation/assembler.js";
import { isModern, patternBeats, sectionBarBeats } from "./sidwave.js";
import type { ParsedSidwave, SystemMode, SidwaveVoice, SidwavePattern, SidwavePatternGroove, MotifEntry, SidwaveRegisterTable, FilterModSpec, SidwaveSamples, SidwaveGrooveNote } from "./sidwave.js";
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
  parseChordArp,
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
  arrangement?: string[];
  durationSeconds: number;
  loopTo?: number;
  lint?: SidwaveFinding[];
  /** Bytes of BASIC memory left after the standalone PRG returns to BASIC (program and variables live behind the player). */
  basicFreeBytes: number;
  /** Conditions the caller should pass on, such as a PRG that leaves no BASIC memory. */
  warnings: string[];
  /** Conservative NMOS 6502 cycle estimate, excluding the host IRQ and VIC stalls. */
  worstCaseCyclesPerCall: number;
  /** CIA2 digi interrupt cycles consumed by each score player call. */
  digiCyclesPerCall: number;
  digiWorstCaseCyclesPerNmi: number;
  /** Encoded digi sample bytes included in the PRG. */
  sampleBytes: number;
  sampleDefinitions: Record<string, SampleStats>;
  /** Space between the compiled PRG and $D000. */
  bytesBelowD000: number;
  requiresTurbo: boolean;
  irqAddress: number;
  digiNmiAddress?: number;
  digiChainAddress?: number;
}

/**
 * Compiles SIDWAVE to a C64 program with a frame-based player.
 *
 * The compiler arranges the timeline into per-voice note events with frame-exact onsets
 * (no tempo drift), then encodes them as compact command streams. The 6502 player reads the
 * streams once per frame and runs the per-note modulation itself: hard restart, fast arpeggio,
 * pitch slide, vibrato, pulse-width sweep, and per-SID filters with sweep and per-pattern ramp.
 */
export function compileSidwaveToPrg(doc: ParsedSidwave, options: { loop?: boolean; compress?: boolean } = {}): CompileResult {
  return compilePlayer(doc, options);
}

function compilePlayer(doc: ParsedSidwave, { loop = true, compress = true }: { loop?: boolean; compress?: boolean },
  planned?: Arrangement): CompileResult {
  loop = loop && !doc.end;
  const loopOffsets: number[] = [];
  let streamCalls = 0;
  let streamBytes = 0;
  const streams: StreamByte[][] = [];
  const streamLimit = SIDWAVE_MEMORY_END - SIDWAVE_LOAD_ADDRESS - 3;
  const rejectOversize = () => {
    throw new SidwaveValidationError("$.timeline", "the compiled voice streams would end past the $D000 limit (about 50 KB); shorten the timeline or use longer note lengths");
  };
  let previous: { events: StreamEvent[]; total: number; loopFrame?: number; bytes: number } | undefined;
  const packVoice = (v: Arrangement["voices"][number], i: number, part: Arrangement) => {
    const loopFrame = loop ? part.clock?.loopFrame : undefined;
    // Identical timed events produce the same packed size. If that size
    // would already exceed the remaining space, avoid packing the copy.
    if (previous && streamBytes + previous.bytes > streamLimit && part.totalFrames === previous.total &&
      loopFrame === previous.loopFrame && sameStreamEvents(v.events, previous.events)) rejectOversize();
    const tokens = encodeVoiceTokens(v.events, part.totalFrames, loopFrame);
    let bytes: StreamByte[];
    if (!isModern(doc) || !compress) {
      bytes = [];
      for (const token of tokens) { if (!token.length) loopOffsets[i] = bytes.length; bytes.push(...token); }
    } else {
      const packed = compressVoiceTokens(tokens, i, (offset) => { loopOffsets[i] = offset; });
      streamCalls += packed.calls;
      bytes = packed.bytes;
    }
    streamBytes += bytes.length;
    if (streamBytes > streamLimit) rejectOversize();
    previous = { events: v.events, total: part.totalFrames, loopFrame, bytes: bytes.length };
    streams[i] = bytes;
  };
  // Plain multi-SID scores can be packed and checked one chip at a time. A
  // score with a release tail or generated voices/samples needs the final arrangement.
  const independent = !planned && doc.sids.length > 1 && !doc.end && !doc.samples &&
    !doc.voices.some(({ echo, unison, center }) => echo || unison || center);
  const arrangement = independent
    ? arrangeAll(doc, 0, (part, chip) => part.voices.forEach((voice, channel) => packVoice(voice, chip * 3 + channel, part)))
    : planned ?? arrangeSidwave(doc);
  if (!independent) arrangement.voices.forEach((voice, i) => packVoice(voice, i, arrangement));
  arrangement.loopOffsets = loopOffsets;
  arrangement.streamCalls = streamCalls;

  if (arrangement.samples) validateDigiRate(arrangement.samples, Object.values(CLOCK_HZ));
  const musicCycles = estimatePlayerCycles(arrangement, loop);
  const digiCyclesAt = (system: SystemMode) => arrangement.samples
    ? digiCyclesPerCall(arrangement.samples, arrangement.fps, CLOCK_HZ[system]) : 0;
  const digiCycles = digiCyclesAt(arrangement.system);
  const worstCaseCyclesPerCall = musicCycles + digiCycles;
  const budgetAt = (system: SystemMode) => arrangement.samples
    ? Math.floor((CYCLES_PER_FRAME[system] - 1_100) * sidwaveFrameRate(system) / arrangement.fps) - 500
    : stockPlayerBudget(system, doc.speed);
  const requiresTurbo = (system: SystemMode) => musicCycles + digiCyclesAt(system) > budgetAt(system);
  const turboOnly = Number(requiresTurbo("PAL")) | (Number(requiresTurbo("NTSC")) << 1);
  // Check the size before assembling the streams: the player and its tables are assembled once with
  // empty streams, which gives the exact start of the stream data. Songs larger than 64 KB would
  // otherwise wrap the address counter inside the assembler.
  const layout = assemblyToPrgDetailed(buildPlayerAsm(arrangement, streams.map(() => [OP.LOOP]), loop, turboOnly, false), {
    fileName: "sidwave_player.asm",
    loadAddress: SIDWAVE_LOAD_ADDRESS,
  });
  const streamStart = layout.symbols.get("stream0")!;
  const sampleBytes = [...(arrangement.samples?.defs.values() ?? [])].reduce((sum, sample) => sum + sample.data.length, 0);
  const projectedEnd = streamStart + streams.reduce((sum, st) => sum + st.length, 0) + sampleBytes;
  // The PRG installer also writes three bytes after the program (an empty BASIC program).
  if (projectedEnd + 3 > SIDWAVE_MEMORY_END) {
    const kb = ((projectedEnd - SIDWAVE_LOAD_ADDRESS) / 1024).toFixed(1);
    throw new SidwaveValidationError(
      "$.timeline",
      `the compiled song needs ${kb} KB and would end at $${projectedEnd.toString(16).toUpperCase()}, past the $D000 limit (about 50 KB); shorten the timeline or use longer note lengths` +
        (sampleBytes ? `. With the BASIC terminator it needs ${projectedEnd + 3 - SIDWAVE_LOAD_ADDRESS} bytes and includes ${sampleBytes} sample bytes. Use a lower sample rate or shorter samples` : ""),
    );
  }
  const warnings: string[] = [];
  for (const field of doc.ignoredFields ?? []) warnings.push(`${field} has no effect before sidwave: 1.2 and was ignored`);
  if (arrangement.findings) {
    lintArrangement(doc, arrangement, arrangement.findings);
    for (const finding of arrangement.findings.list()) warnings.push(formatFinding(finding));
  }
  if (arrangement.samples) {
    warnings.push(`CIA2 digi playback reserves up to ${digiCycles} CPU cycles per player call and temporarily replaces the sample SID's master volume.`);
  }
  if (arrangement.chips) {
    const availableCycles = budgetAt(arrangement.system);
    const required = worstCaseCyclesPerCall / availableCycles;
    if (!planned && requiresTurbo(arrangement.system) && !doc.cpu) {
      throw new SidwaveValidationError("$.cpu",
        `the player needs up to ${worstCaseCyclesPerCall} cycles per call at speed ${doc.speed}${digiCycles ? ` including ${digiCycles} for the CIA2 digi NMI` : ""} (${availableCycles} available at 1 MHz ${arrangement.system}); use cpu: turbo for a CPU speed of at least ${Math.ceil(required)} MHz`);
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
    durationSeconds: arrangement.totalFrames / arrangement.fps,
    loopTo: doc.loopTo === undefined ? undefined : doc.loopTo + 1,
    arrangement: planned ? undefined : arrangementReport(doc, arrangement),
    lint: arrangement.findings?.list(),

    basicFreeBytes,
    warnings,
    worstCaseCyclesPerCall,
    digiCyclesPerCall: digiCycles,
    digiWorstCaseCyclesPerNmi: arrangement.samples ? digiPeakCycles(arrangement.samples) : 0,
    sampleBytes,
    sampleDefinitions: Object.fromEntries([...(arrangement.samples?.defs ?? [])].map(([name, sample]) => [name, sample.stats])),
    bytesBelowD000: SIDWAVE_MEMORY_END - (endAddress + 3),
    requiresTurbo: requiresTurbo(arrangement.system),
    irqAddress: assembled.symbols.get("irq")!,
    digiNmiAddress: assembled.symbols.get("digi_nmi"),
    digiChainAddress: assembled.symbols.get("digi_chain"),
  };
}

/** Project a resolved arrangement to one SID. The source score keeps its original version. */
export function projectSidwaveStem(doc: ParsedSidwave, arrangement: Arrangement, chip: number): Arrangement {
  const sid = doc.sids[chip];
  if (!sid) throw new RangeError(`SID ${chip} is not declared`);
  const first = chip * 3;
  const sources = new Map(arrangement.mirrors?.map(([source, target]) => [target, source]));
  const voices = arrangement.voices.slice(first, first + 3).map((voice, channel) => {
    const source = sources.get(first + channel);
    const events = source === undefined ? voice.events : [
      ...voice.events,
      ...arrangement.voices[source]!.events.filter(({ bytes }) =>
        bytes[0] !== OP.SAMPLE && bytes[0] !== OP.SETVOL && bytes[0] !== OP.FILTERMOD && bytes[0] !== OP.FILTEROFFSET),
    ];
    return { ...voice, events: events.filter(({ bytes }) => bytes[0] !== OP.SAMPLE) };
  });
  const original = arrangement.chips?.[chip];
  return {
    ...arrangement, voices, findings: undefined,
    tuning: arrangement.tuning && voices.map((_, i) => arrangement.tuning![sources.get(first + i) ?? first + i]!),
    chips: original ? [{ ...original, address: 0xd400, owner: original.owner === undefined ? undefined : original.owner - first }] : undefined,
    filter: original?.filter ?? arrangement.filter,
    samples: undefined, mirrors: undefined, turbo: false,
  };
}

/** Export one arranged SID stem as a PSID for offline reference rendering. */
export function compileSidwaveStem(doc: ParsedSidwave, arrangement: Arrangement, chip: number): Buffer {
  const projected = projectSidwaveStem(doc, arrangement, chip);
  const metadata: ParsedSidwave = { ...doc, samples: undefined, sids: [{ ...doc.sids[chip]!, address: 0xd400 }] };
  return compileSidwaveToSid(metadata, compilePlayer(metadata, {}, projected).prg).sid;
}

export function validateSidwavePsidMap(doc: ParsedSidwave): void {
  if (doc.samples) {
    throw new SidwaveValidationError("$.samples", "CIA2 NMI digi samples require standalone PRG output");
  }
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
  let safe = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    safe += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : code <= 0xff ? ch : "?";
    if (safe.length === 32) break;
  }
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
  /**
   * SIDWAVE 1.3 vibrato fade: 16-bit increment per call of the fade level, ceil(65536 / fade calls). The player
   * scales the triangle by the level's high byte / 256 until the level overflows, then plays the full depth.
   */
  vibFade?: number;
  arp: number[]; // semitone offsets; empty = none
  arpSpeed: number;
  slideSemis: number;
  slideSpeed: number;
  /** round(65536 / speed): the player's per-frame slide step is magnitude x slideRecip / 256 (16.8 fixed point). */
  slideRecip: number;
  filter: number;
  ring?: boolean;
  sync?: boolean;
  sourceNote?: string;
  wavetable?: Array<Record<string, any>>;
  waveloop?: number;
  pulsetable?: SidwaveRegisterTable;
  filtertable?: SidwaveRegisterTable;
  restart?: { frames: number; ad: number; sr: number; test: boolean };
}

export interface ArrangedNote {
  start: number;
  end: number;
  midi: number;
  inst: number;
  legato?: boolean;
  portamento?: number;
  glideFrom?: number;
  gateOff?: number;
  releaseFrame?: number;
  sustain?: number;
  /** Silent note that only drives a sync or ring source oscillator (source_note). */
  hidden?: boolean;
  percussion?: boolean;
  beat?: number;
  path?: string;
  volume?: number;
  section?: number;
  attack?: number;
  release?: number;
  /** Fade window applied to this note's sustain level, if any. */
  fade?: { start: number; end: number };
  /** SIDWAVE 1.3: a chord-arp entry and the accent flag, which a follower with its own instrument needs. */
  chord?: { offsets: number[]; speed: number };
  accented?: boolean;
}

type GlobalEvent =
  | { frame: number; kind: "filtermod"; step: number; count: number }
  | { frame: number; kind: "volume"; value: number }
  | { frame: number; kind: "foffset"; value: number; res: number };

interface ChipArrangement {
  address: number;
  volume: number;
  filter: Arrangement["filter"];
  hasFilterTable: boolean;
  hasFilterMod: boolean;
  /** filter.owner: global voice slot and static routing bits ($D417 low nibble) of this chip. */
  owner?: number;
  route?: number;
  hasOffset?: boolean;
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
  softVolume?: boolean;
  clock?: TimelineClock;
  findings?: SidwaveFindings;
  loopOffsets?: number[];
  explicitEnd?: boolean;
  /** CALL commands in the voice streams (stream subroutines). */
  streamCalls?: number;
  /** Centred voices as [source slot, mirror slot] pairs. */
  mirrors?: Array<[number, number]>;
  /** Release tail in player calls that follows the held end of the song. */
  endTail?: number;
  tuning?: number[];
  samples?: SidwaveSamples;
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
  const instObjects = new WeakMap<Instrument, number>();
  const instIndex = (inst: Instrument): number => {
    const cached = instObjects.get(inst);
    if (cached !== undefined) return cached;
    const key = JSON.stringify(inst);
    let idx = instKeys.get(key);
    if (idx === undefined) {
      idx = instruments.length;
      if (idx >= 64) throw new SidwaveValidationError("$.voices", "more than 63 distinct voice/pattern/effect combinations; reuse patterns or effects");
      instruments.push(inst);
      instKeys.set(key, idx);
    }
    instObjects.set(inst, idx);
    return idx;
  };

  return { instruments, instIndex };
}

/** Maps every `center` voice to the channel of its paired SID on the other pan side. */
function resolveCenterMirrors(doc: ParsedSidwave): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const used = new Set(doc.voiceSlots.values());
  for (const voice of doc.voices) {
    if (!voice.center) continue;
    const path = `$.voices.v${voice.id}.center`;
    const slot = doc.voiceSlots.get(voice.id)!;
    let mirror: number;
    if (voice.center.sid !== undefined) {
      const chip = doc.sids.findIndex((sid) => sid.id === voice.center!.sid);
      if (chip < 0) throw new SidwaveValidationError(path, `SID ${voice.center.sid} is not mapped`);
      mirror = chip * 3 + voice.center.channel! - 1;
    } else {
      const chip = Math.floor(slot / 3);
      if (!doc.layout || chip >= 8) throw new SidwaveValidationError(path, "this SID has no paired SID; write center: { sid, channel }");
      mirror = ((chip + 4) % 8) * 3 + slot % 3;
    }
    if (mirror === slot || Math.floor(mirror / 3) === Math.floor(slot / 3)) throw new SidwaveValidationError(path, "the mirror channel must be on another SID");
    if (used.has(mirror)) throw new SidwaveValidationError(path, `the mirror channel (SID ${doc.sids[Math.floor(mirror / 3)]!.id}, channel ${mirror % 3 + 1}) is scored by another voice; centre needs an unscored channel`);
    used.add(mirror);
    pairs.push([slot, mirror]);
  }
  return pairs;
}

export function arrangeSidwave(doc: ParsedSidwave): Arrangement {
  if (!isModern(doc) || !doc.end) return arrangeAll(doc, 0);
  // The release tail depends on the instruments that sound at the last bar line, so arrange once to find it.
  const probe = arrangeAll(doc, 0);
  if (!doc.end.release) return probe;
  // An echo copy of a note that sounds at the end starts its release one echo delay later. Its gate-off was clamped
  // to the last player call, which cut the echo before its release. Extend the tail by the delay plus the release.
  let tail = probe.endTail ?? 0;
  for (const voice of doc.voices) {
    const copy = voice.echo ?? voice.follow;
    if (!copy) continue;
    const slot = doc.voiceSlots.get(voice.id);
    if (slot === undefined || !probe.voices[slot]?.notes.some((n) => n.end >= probe.totalFrames - 1)) continue;
    const shift = copy.delay_beats !== undefined ? copy.delay_beats * probe.framesPerBeat : (copy.delay ?? 0) * doc.speed;
    // A follower with its own instrument releases with that instrument's release rate.
    const own = voice.follow?.instrument === undefined ? undefined : voice.follow.instrument.startsWith("lib:")
      ? MODERN_LIBRARY[voice.follow.instrument.slice(4)] : doc.instruments[voice.follow.instrument];
    const adsr = voice.echo?.adsr ?? (own ? own.adsr ?? [2, 2, 10, 3] : undefined);
    const release = adsr ? Math.min(RELEASE_MS[adsr[3]!]!, 4000) / 1000 * probe.fps : probe.endTail ?? 0;
    tail = Math.max(tail, Math.ceil(shift + release));
  }
  return tail ? arrangeAll(doc, tail) : probe;
}

function arrangeAll(doc: ParsedSidwave, endTail: number, onPart?: (part: Arrangement, chip: number) => void): Arrangement {
  const first = doc.sids[0]!;
  const extended = isModern(doc) || doc.sids.length > 1 || first.address !== 0xd400 || first.volume !== 15 ||
    first.filter || doc.cpu || doc.voices.some(({ id }) => doc.voiceSlots.get(id) !== id - 1);
  if (!extended) return arrangeChip(doc, createInstrumentPool());

  const pool = createInstrumentPool();
  const mirrors = resolveCenterMirrors(doc);
  const findings = isModern(doc) ? new SidwaveFindings() : undefined;
  const clock = isModern(doc) ? makeTimelineClock(doc, sidwaveFrameRate(doc.song.mode) * doc.speed) : undefined;
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
    const part = arrangeChip({
      ...doc, voices, timeline,
      song: { ...doc.song, global_fx: { reverb_sim: globalFx.reverb_sim, filter_env: filterEnv } },
    }, pool, sid.volume, sid.filter?.filter_mod, idByChannel, clock, findings, sid, endTail);
    onPart?.(part, chip);
    return part;
  });
  const voices = parts.flatMap((part) => part.voices);
  // A centred voice sounds on its own channel and on the mirror channel; the player writes both back to back.
  for (const [source, mirror] of mirrors) voices[mirror]!.notes = voices[source]!.notes;
  const tuning = arrangeDoubles(doc, voices, pool, parts[0]!);
  const samples = arrangeSamples(doc, parts[0]!, voices);
  return {
    ...parts[0]!,
    voices,
    clock, findings,
    endTail: Math.max(...parts.map((part) => part.endTail ?? 0)),
    mirrors: mirrors.length ? mirrors : undefined,
    explicitEnd: !!doc.end,
    totalFrames: Math.max(...parts.map((part) => part.totalFrames)),
    tuning,
    samples,
    chips: doc.sids.map((sid, i) => {
      const part = parts[i]!;
      return {
        address: sid.address,
        volume: sid.volume,
        filter: part.filter,
        hasFilterTable: part.voices.some(({ notes }) => notes.some(({ inst }) => !!pool.instruments[inst]!.filtertable)),
        hasFilterMod: part.voices[0]!.events.some(({ bytes }) => bytes[0] === OP.FILTERMOD),
        hasOffset: part.voices[0]!.events.some(({ bytes }) => bytes[0] === OP.FILTEROFFSET),
        ...(sid.filter?.owner === undefined ? {} : {
          owner: doc.voiceSlots.get(sid.filter.owner)!,
          route: (sid.filter.route ?? [(doc.voiceSlots.get(sid.filter.owner)! % 3) + 1]).reduce((bits, ch) => bits | (1 << (ch - 1)), 0),
        }),
      };
    }),
    turbo: doc.cpu === "turbo",
    softVolume: isModern(doc),
  };
}

function arrangeSamples(doc: ParsedSidwave, timing: Arrangement, voices: Arrangement["voices"]): SidwaveSamples | undefined {
  const schedule = doc.samples;
  if (!schedule) return;
  const { rate, defs } = schedule;
  const { fps, framesPerBeat, totalFrames } = timing;
  const frameAt = timing.clock?.frameAt ?? ((beat: number) => Math.round(beat * framesPerBeat + BEAT_EPS));
  const digi = doc.digiVoices?.length && timing.clock ? digiTriggers(doc, timing.clock) : [];
  for (const d of digi) {
    if (!defs.has(d.name)) throw new SidwaveValidationError(d.path, `sample ${JSON.stringify(d.name)} is not defined in samples.defs`);
  }
  const scheduled: typeof schedule.triggers = [...schedule.triggers, ...digi.map((d) => ({ chip: d.chip, name: d.name, path: d.path, pitch: 0, at: d.frame }))];
  const triggers = scheduled.map((trigger) => ({
    ...trigger, frame: trigger.at ?? frameAt(trigger.beat!),
    periods: Object.values(CLOCK_HZ).map((hz) => digiPeriod(hz, rate, trigger.pitch)),
  })).sort((a, b) => a.frame - b.frame);

  const commands: SidwaveSamples["commands"] = [];
  const commandIds = new Map<string, number>();
  const emit = (chip: number, frame: number, pitch: number, name?: string, stopChips?: number[]) => {
    const key = JSON.stringify([chip, pitch, name, stopChips]);
    let index = commandIds.get(key);
    if (index === undefined) {
      index = commands.length;
      if (index >= 256) throw new SidwaveValidationError("$.samples", "at most 256 distinct start and stop commands fit");
      commandIds.set(key, index);
      commands.push({ chip, at: [], pitch, name, stopChips });
    }
    commands[index]!.at.push(frame);
    voices[chip * 3]!.events.push({ frame, order: ORDER.sample, bytes: [OP.SAMPLE, index] });
  };

  const active = new Map<number, { trigger: typeof triggers[number]; end: number; loopEnd?: number }>();
  const advance = (frame: number) => {
    for (const [chip, current] of active) {
      if (current.end > frame) continue;
      if (current.loopEnd !== undefined && current.loopEnd < totalFrames) emit(chip, current.loopEnd, 0);
      active.delete(chip);
    }
  };
  for (const trigger of triggers) {
    const { frame, chip, pitch, name, path, periods } = trigger;
    if (frame >= totalFrames) throw new SidwaveValidationError(path, "sample trigger lies outside the song");
    if (periods.some((period) => period > 65536 || period < 1)) {
      throw new SidwaveValidationError(path, "pitch and rate exceed the CIA2 timer latch range");
    }
    advance(frame);
    for (const current of active.values()) {
      const previous = current.trigger;
      if (previous.chip === chip && previous.frame === frame) {
        throw new SidwaveValidationError(path, `this SID already has sample ${previous.name} on this frame`);
      }
      if (periods.some((period, i) => period !== previous.periods[i])) {
        throw new SidwaveValidationError(path, `sample ${name} (pitch ${pitch}) overlaps ${previous.name} (pitch ${previous.pitch}) with a different CIA2 latch`);
      }
    }
    const loopEnd = trigger.lengthBeats === undefined ? undefined :
      Math.min(totalFrames, Math.max(frame + 1, trigger.beat === undefined ? frame + frameAt(trigger.lengthBeats) : frameAt(trigger.beat + trigger.lengthBeats)));
    // A one-shot owns the timer until the NMI following its last sample. Check both machine clocks.
    const clocks = Object.values(CLOCK_HZ);
    const duration = Math.max(...clocks.map((hz, i) => (defs.get(name)!.sampleCount + 1) * periods[i]! / hz));
    active.set(chip, { trigger, end: loopEnd ?? frame + fps * duration, loopEnd });
    emit(chip, frame, pitch, name);
  }
  const wrapping = [...active].filter(([, sample]) => sample.end >= totalFrames).map(([chip]) => chip);
  advance(totalFrames);
  if (wrapping.length) {
    // All carried playback ends before the earliest sample track wraps.
    // This prevents its frame-zero start from retuning another SID's old loop.
    emit(Math.min(...triggers.map(({ chip }) => chip)), totalFrames, 0, undefined, wrapping);
  }
  return { rate, defs, commands };
}

function arrangeDoubles(
  doc: ParsedSidwave, voices: Arrangement["voices"], pool: ReturnType<typeof createInstrumentPool>, timing: Arrangement,
): number[] | undefined {
  if (!doc.voices.some((voice) => voice.echo || voice.unison || voice.detune || voice.follow)) return;
  const byId = new Map(doc.voices.map((voice) => [voice.id, voice]));
  const tuning = voices.map(() => 0);
  for (const voice of doc.voices) tuning[doc.voiceSlots.get(voice.id)!] = voice.detune ?? 0;
  const visiting = new Set<number>();
  const resolved = new Set<number>();
  const resolve = (voice: SidwaveVoice) => {
    const fx = voice.echo ?? voice.unison ?? voice.follow;
    if (!fx || resolved.has(voice.id)) return;
    const path = `$.voices.v${voice.id}.${voice.echo ? "echo" : voice.unison ? "unison" : "follow"}`;
    if (visiting.has(voice.id)) throw new SidwaveValidationError(path, "voice copies form a cycle");
    const source = byId.get(fx.voice);
    if (!source) throw new SidwaveValidationError(path, `source voice ${fx.voice} is not declared`);
    const slot = doc.voiceSlots.get(voice.id)!;
    const sourceSlot = doc.voiceSlots.get(source.id)!;
    const chip = Math.floor(slot / 3);
    const sameChip = chip === Math.floor(sourceSlot / 3);
    if (voice.unison && sameChip) throw new SidwaveValidationError(path, "unison needs a channel on another SID");
    visiting.add(voice.id);
    resolve(source);
    const cents = tuning[sourceSlot]! + (fx.detune ?? 0);
    if (Math.abs(cents) > 100) throw new SidwaveValidationError(path, "combined detune must stay within ±100 cents");
    tuning[slot] = cents;
    const delay = (voice.echo?.delay ?? 0) * doc.speed;
    const volume = voice.echo?.volume ?? 1;
    const sid = doc.sids[chip]!;
    const env = sid.filter?.filter_env ?? (chip === 0 ? doc.song.global_fx.filter_env as Record<string, unknown> | undefined : undefined);
    const channels = (env?.voices ?? [1, 2, 3]) as number[];
    const target = voices[slot]!;
    if (voice.follow) {
      target.notes = followNotes(doc, voice, voice.follow, voices[sourceSlot]!.notes, pool, timing, { path, slot, cents, sameChip, sid, channels, hasEnv: !!env });
      target.events.push(...buildVoiceEvents(target.notes, pool.instruments, timing.totalFrames, timing.framesPerBeat, [], cents, timing.clock?.loopFrame, doc.end ? timing.totalFrames : undefined));
      visiting.delete(voice.id);
      resolved.add(voice.id);
      return;
    }
    // The play-once player stops writing at totalFrames. Leave a call for
    // a delayed copy's gate-off if the end of the piece truncates its tail.
    const lastGateOff = doc.end && voice.echo ? timing.totalFrames - 1 : timing.totalFrames;
    target.notes = voices[sourceSlot]!.notes.flatMap((note) => {
      const shift = voice.echo?.delay_beats !== undefined && note.beat !== undefined
        ? timing.clock!.frameAt(note.beat + voice.echo.delay_beats, true) - note.start : delay;
      const start = note.start + shift;
      const end = Math.min(note.end + shift, lastGateOff);
      if (end - start < 2) return [];
      const inst = pool.instruments[note.inst]!;
      checkDetunedPitch(note.midi, inst, cents, timing.system, path);
      if (note.glideFrom !== undefined) checkDetunedPitch(note.glideFrom, inst, cents, timing.system, path);
      const envelope = voice.echo?.adsr;
      const sustain = (envelope?.[2] ?? (inst.sr >> 4)) > 0
        ? Math.max(1, Math.round((envelope?.[2] ?? (note.sustain ?? inst.sr >> 4)) * volume)) : 0;
      const filter = sameChip ? inst.filter : Number(env ? channels.map(Number).includes(slot % 3 + 1) : !!sid.filter?.filter_mod);
      const fade = note.fade ? { start: note.fade.start + shift, end: note.fade.end + shift } : undefined;
      return [{ ...note, start, end, fade, sustain,
        beat: note.beat === undefined ? undefined : note.beat + (voice.echo?.delay_beats ?? 0),
        inst: pool.instIndex({ ...inst, ...(envelope ? { ad: envelope[0] << 4 | envelope[1] } : {}),
          sr: (sustain << 4) | (envelope?.[3] ?? (inst.sr & 15)), filter }) }];
    });
    target.events.push(...buildVoiceEvents(target.notes, pool.instruments, timing.totalFrames, timing.framesPerBeat, [], cents, timing.clock?.loopFrame, doc.end ? timing.totalFrames : undefined));
    visiting.delete(voice.id);
    resolved.add(voice.id);
  };
  doc.voices.forEach(resolve);
  return tuning.some(Boolean) ? tuning : undefined;
}

/**
 * SIDWAVE 1.3 follower: the source voice's pitched notes, shifted by delay or delay_beats (as an echo) and by
 * transpose semitones, with the follower's own instrument and level when it sets them. Kit and drum notes and the
 * silent notes that drive a sync or ring source are not copied.
 */
function followNotes(
  doc: ParsedSidwave, voice: SidwaveVoice, follow: NonNullable<SidwaveVoice["follow"]>, source: ArrangedNote[],
  pool: ReturnType<typeof createInstrumentPool>, timing: Arrangement,
  { path, slot, cents, sameChip, sid, channels, hasEnv }: { path: string; slot: number; cents: number; sameChip: boolean;
    sid: ParsedSidwave["sids"][number]; channels: number[]; hasEnv: boolean },
): ArrangedNote[] {
  const clock = timing.clock!;
  const maxMidi = maxSidwaveMidi(timing.system);
  const lastGateOff = doc.end && (follow.delay || follow.delay_beats) ? timing.totalFrames - 1 : timing.totalFrames;
  const filter = (inst: Instrument) => sameChip ? inst.filter : Number(hasEnv ? channels.map(Number).includes(slot % 3 + 1) : !!sid.filter?.filter_mod);
  const named = follow.instrument === undefined ? undefined : follow.instrument.startsWith("lib:")
    ? MODERN_LIBRARY[follow.instrument.slice(4)] : doc.instruments[follow.instrument];
  if (follow.instrument !== undefined && !named) throw new SidwaveValidationError(`${path}.instrument`, `instrument ${JSON.stringify(follow.instrument)} is not defined`);
  if (named && !sid.model && !follow.instrument!.startsWith("lib:") && JSON.stringify(named.filtertable ?? "").includes('"hz"')) {
    throw new SidwaveValidationError(`${path}.instrument`, "declare sids[].model before using a cutoff in Hz");
  }
  const owner = sid.filter?.owner === undefined ? undefined : doc.voiceSlots.get(sid.filter.owner);
  const sourceLevel = doc.voices.find((v) => v.id === follow.voice)?.level ?? 15;
  const level = follow.level ?? sourceLevel;
  const shapes = new Map<string, number>();
  // Section level for the follower: levels.v<id> of the follower, else the section level.
  const sectionLevel = (beat: number) => {
    let lo = 0;
    let hi = clock.sections.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (clock.sections[mid]!.startBeat <= beat + BEAT_EPS) lo = mid;
      else hi = mid - 1;
    }
    const entry = clock.sections[lo]!;
    const ramp = entry.section.levels?.[`v${voice.id}`] ?? entry.section.level;
    return rampValue(ramp, 15, beat - entry.startBeat, entry.endBeat - entry.startBeat, sectionBarBeats(entry.section, doc.song.meter)) / 15;
  };
  const out: ArrangedNote[] = [];
  for (const note of source) {
    if (note.hidden || note.percussion) continue;
    const shift = follow.delay_beats !== undefined && note.beat !== undefined
      ? clock.frameAt(note.beat + follow.delay_beats, true) - note.start : (follow.delay ?? 0) * doc.speed;
    const start = note.start + shift;
    const end = Math.min(note.end + shift, lastGateOff);
    if (end - start < 2) continue;
    const midi = note.midi + follow.transpose;
    const glideFrom = note.glideFrom === undefined ? undefined : note.glideFrom + follow.transpose;
    for (const pitch of [midi, glideFrom]) {
      if (pitch !== undefined && (pitch < 12 || pitch > maxMidi)) {
        throw new SidwaveValidationError(`${path}.transpose`, `${midiToNoteName(pitch - follow.transpose)} at ${note.path ?? `voice ${follow.voice}`} becomes ${midiToNoteName(pitch)}, outside the playable range C0..${midiToNoteName(maxMidi)} on ${timing.system}`);
      }
    }
    const previous = out[out.length - 1];
    const legato = !!note.legato && previous?.end === start;
    const sourceInst = pool.instruments[note.inst]!;
    let inst: Instrument;
    let index = -1;
    if (legato) {
      inst = pool.instruments[previous!.inst]!;
    } else if (named) {
      const key = `${midi}:${JSON.stringify(note.chord ?? null)}`;
      index = shapes.get(key) ?? -1;
      if (index < 0) {
        const fx: Record<string, any> = { ...named };
        if (note.chord) {
          fx.wavetable = note.chord.offsets.map((offset) => ({ note: offset < 0 ? String(offset) : `+${offset}`, frames: note.chord!.speed }));
          fx.loop = 0;
        }
        if (owner !== undefined && owner !== slot) fx.filtertable = undefined;
        const built = buildInstrument({ id: voice.id, waveform: (named.waveform ?? named.wave ?? "pulse") as any,
          pulse_width: named.pulse_width, adsr: named.adsr ?? [2, 2, 10, 3] }, fx, [], 0, 0, timing.fps, true, doc.speed, midi, sid.model);
        index = pool.instIndex({ ...built, arp: sourceInst.arp, arpSpeed: sourceInst.arpSpeed, filter: filter(built) });
        shapes.set(key, index);
      }
      inst = pool.instruments[index]!;
    } else {
      inst = sourceInst;
    }
    checkDetunedPitch(midi, inst, cents, timing.system, path);
    if (glideFrom !== undefined) checkDetunedPitch(glideFrom, inst, cents, timing.system, path);
    const sustainNibble = inst.sr >> 4;
    // Without its own instrument or level, a follower keeps the source note's sustain like an echo of volume 1.
    const sustain = legato ? previous!.sustain
      : !named && follow.level === undefined ? (note.sustain ?? sustainNibble)
      : sustainNibble ? Math.min(15, Math.max(1, Math.round(sustainNibble * level / 15 * sectionLevel(note.beat ?? 0)) + (note.accented ? doc.accent ?? 3 : 0))) : 0;
    const fade = note.fade ? { start: note.fade.start + shift, end: note.fade.end + shift } : undefined;
    const beat = note.beat === undefined ? undefined : note.beat + (follow.delay_beats ?? 0);
    const copy: ArrangedNote = { ...note, start, end, midi, glideFrom, legato, fade, sustain, beat,
      path: beat === undefined ? note.path : `bar ${clock.barOf(beat)} v${voice.id}`,
      volume: sameChip ? note.volume : undefined,
      inst: legato ? previous!.inst : named ? index
        : pool.instIndex({ ...inst, sr: ((sustain ?? sustainNibble) << 4) | (inst.sr & 15), filter: filter(inst) }) };
    out.push(copy);
  }
  // A longer hard restart in the follower's instrument must still fit between its notes.
  for (let i = 1; i < out.length; i++) {
    const restart = pool.instruments[out[i]!.inst]!.restart;
    if (!out[i]!.legato && restart?.frames && out[i]!.start - out[i - 1]!.start <= restart.frames) {
      throw new SidwaveValidationError(`${path}.instrument`, `${out[i]!.path ?? "a note"} follows the previous note after ${out[i]!.start - out[i - 1]!.start} calls; the instrument's hard restart needs more than ${restart.frames}`);
    }
  }
  return out;
}

function checkDetunedPitch(midi: number, inst: Instrument, cents: number, system: SystemMode, path: string): void {
  const pitches = [midi, ...inst.arp.map((offset) => midi + offset)];
  for (const step of inst.wavetable ?? []) {
    if (step.note === undefined) continue;
    const text = String(step.note);
    pitches.push(/^[+-]/.test(text) ? midi + Number(text) : noteNameToMidi(text)!);
  }
  if (inst.slideSemis) pitches.push(midi - inst.slideSemis);
  for (const pitch of pitches) {
    const units = Math.round(midiToHz(pitch + cents / 100) * 16_777_216 / CLOCK_HZ[system]);
    if (pitch < 12 || pitch > 107 || units > 0xffff) {
      throw new SidwaveValidationError(path, `wavetable, slide or detune pitch lies outside the playable SID frequency range on ${system}`);
    }
  }
}

function arrangeChip(
  doc: ParsedSidwave, { instruments, instIndex }: ReturnType<typeof createInstrumentPool>,
  volume = 15, sidMod?: FilterModSpec, idByChannel?: ReadonlyMap<number, number>,
  clock?: TimelineClock, findings?: SidwaveFindings, sid?: ParsedSidwave["sids"][number], endTail = 0,
): Arrangement {
  const modern = isModern(doc);
  const system: SystemMode = doc.song.mode ?? "PAL";
  const fps = sidwaveFrameRate(system) * doc.speed;
  const framesPerBeat = (fps * 60) / doc.song.tempo;
  const frameAt = clock?.frameAt ?? ((beat: number) => Math.round(beat * framesPerBeat + BEAT_EPS));
  const maxMidi = maxSidwaveMidi(system);
  const totalBars = doc.song.length_bars;
  const beatsPerBar = doc.song.meter;
  // Expand the timeline, cycling it when length_bars exceeds it and truncating when shorter. A SIDWAVE 1.3
  // section counts its bars in its own metre.
  const sections: Array<{ index: number; startBeat: number; endBeat: number; meter: number }> = [];
  for (let bar = 0, beat = 0, i = 0; bar < totalBars; i += 1) {
    const s = doc.timeline[i % doc.timeline.length]!;
    const bars = Math.min(s.bars, totalBars - bar);
    const meter = sectionBarBeats(s, beatsPerBar);
    sections.push({ index: i % doc.timeline.length, startBeat: beat, endBeat: beat + bars * meter, meter });
    beat += bars * meter;
    bar += bars;
  }
  const barOf = (beat: number) => clock ? clock.barOf(beat) : Math.floor(beat / beatsPerBar) + 1;
  const musicFrames = frameAt(sections[sections.length - 1]!.endBeat);
  const end = modern ? doc.end : undefined;
  // Notes sounding at the last bar line are held for end.hold_beats; the release tail follows.
  const holdFrames = end && clock ? clock.frameAt(clock.endBeat + end.holdBeats) - musicFrames : 0;
  const totalFrames = musicFrames + holdFrames + endTail;

  const gfx = doc.song.global_fx as Record<string, any>;
  const fenv = gfx.filter_env as Record<string, any> | undefined;
  const filterVoices = new Set<number>(fenv ? (fenv.voices ?? [1, 2, 3]).map(Number) : []);
  let filterUsed = !!fenv || !!sidMod;

  const voicesById = new Map<number, SidwaveVoice>(doc.voices.map((v) => [v.id, v]));
  // filter.owner: only the owner's tables run and the routing bits are written once (static route).
  const ownerChannel = modern && sid?.filter?.owner !== undefined
    ? [...(idByChannel ?? [])].find(([, voiceId]) => voiceId === sid.filter!.owner)?.[0] : undefined;
  const ownerRoute = ownerChannel === undefined ? undefined : (sid!.filter!.route ?? [ownerChannel]).map((slot) => slot);
  const notes: ArrangedNote[][] = [[], [], []];
  const bends = new Map<ArrangedNote, { path: string; minFrames: number }>();
  const globals: GlobalEvent[] = [];
  if (sidMod) {
    const unitFrames = { steps: framesPerBeat, beats: framesPerBeat, bars: beatsPerBar * framesPerBeat, frames: modern ? doc.speed : 1 }[sidMod.unit];
    const count = Math.max(1, Math.min(0xffff, Math.round(sidMod.amount * unitFrames)));
    globals.push({ frame: 0, kind: "filtermod", step: Math.round(sidMod.sweep * 32 / count), count });
  }
  const patternsBySource = new WeakMap<SidwavePattern, {
    entries: PatternEntry[]; durations: number[]; variableLength: boolean;
  }>();
  const instrumentShapes = new WeakMap<PatternEntry, Map<string, Instrument>>();
  const fadeWindows: Array<Array<{ start: number; end: number }>> = [[], [], []];
  const reverb = gfx.reverb_sim as { depth: number; delay_frames: number } | undefined;


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
      if (!voice) continue;
      const patterns = voice.patterns ?? {};
      const legacy = parseLayerRef(ref, Object.keys(patterns));
      const patPath = `${secPath}.layers.v${idByChannel?.get(id) ?? id}`;
      const passes = modern ? timelinePatternPasses(ref, patterns, sec.startBeat, sec.endBeat, sec.meter, patPath)
        : (function* () {
            if (!legacy.pattern) return;
            const length = patternBeats(patterns[legacy.pattern]!);
            for (let repetition = 0; sec.startBeat + repetition * length < sec.endBeat - BEAT_EPS; repetition++) {
              yield { ...legacy, beat: sec.startBeat + repetition * length, length, repetition, sequence: false, cut: false };
            }
          })();
      let hasPattern = false;
      let hasFilterMod = false;
      const out = notes[id - 1]!;
      for (const pass of passes) {
        if (!pass.pattern) continue;
        const pattern = patterns[pass.pattern]!;
        const cycleStart = pass.beat;
        if (!hasPattern) active.push(id);
        hasPattern = true;
        if (pass.fade && !fading.includes(id)) {
          fading.push(id);
          fadeWindows[id - 1]!.push({ start: sf, end: ef });
        }
        if (pass.sequence && pass.cut) findings?.add("SEQ-CUT", `bar ${barOf(cycleStart)} v${idByChannel?.get(id) ?? id}`, "Match the sequence length to the section");
        const fxRaw = (pattern.fx ?? {}) as Record<string, any>;
        const filterMod = fxRaw.filter_mod ? parseFilterMod(fxRaw.filter_mod, `${patPath}.fx.filter_mod`) : undefined;
        if (filterMod) filterUsed = hasFilterMod = true;
        const routed = ownerRoute ? Number(ownerRoute.includes(id)) : filterVoices.has(id) || !!filterMod || (!fenv && !!sidMod) ? 1 : 0;
        const lengthBeats = pattern.length ?? 1;
        let prepared = patternsBySource.get(pattern);
        if (!prepared) {
          const entries = patternEntries(pattern, patPath, modern);
          const durations = entries.map((entry) => entry.kind === "note" ? entry.len ?? lengthBeats : lengthBeats);
          prepared = { entries, durations, variableLength: durations.some((duration) => duration !== lengthBeats) };
          patternsBySource.set(pattern, prepared);
        }
        const { entries, durations, variableLength } = prepared;
        const transpositions = pattern.transpositions ?? [0];
        const tr = transpositions[pass.repetition % transpositions.length]! + pass.transpose + (section.transpose ?? 0);
        if (filterMod) {
          const unitFrames = { steps: lengthBeats * framesPerBeat, beats: framesPerBeat, bars: sec.meter * framesPerBeat, frames: modern ? doc.speed : 1 }[filterMod.unit];
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
          const f0 = frameAt(b, true);
          const f1 = frameAt(Math.min(b + duration, sec.endBeat), true);
          const entry = entries[k]!;
          if (entry.kind === "rest") continue;
          if (entry.kind === "tie") {
            // A tie holds the note sounding right before it, also across a section boundary; after a rest it is a rest.
            const last = out[out.length - 1];
            if (last && last.end === f0) last.end = f1;
            continue;
          }
          if (!modern && f1 - f0 < SIDWAVE_MIN_NOTE_FRAMES) {
            if (truncated) continue;
            throw new SidwaveValidationError(
              patPath,
              `each entry lasts ${(duration * framesPerBeat).toFixed(2)} frames at ${doc.song.tempo} BPM; the player needs at least ${SIDWAVE_MIN_NOTE_FRAMES} frames per note (one sounding frame plus the ${SIDWAVE_HARD_RESTART_FRAMES}-frame hard restart); raise 'length' or lower the tempo`,
            );
          }
          const transpose = entry.kitNote ? 0 : tr;
          const base = entry.notes[0]! + transpose;
          const offsets = entry.chord?.offsets ?? entry.notes.map((n) => n - entry.notes[0]!);
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
          const bank = isLibrary ? (modern ? MODERN_LIBRARY : SIDWAVE_INSTRUMENT_LIBRARY) : doc.instruments;
          const key = isLibrary ? instrumentName!.slice(4) : instrumentName;
          const namedInstrument = key && Object.prototype.hasOwnProperty.call(bank, key) ? bank[key] : undefined;
          if (instrumentName && !namedInstrument) throw new SidwaveValidationError(`${patPath}.instrument`, `instrument ${JSON.stringify(instrumentName)} is not defined`);
          // Repeated entries keep their instrument shape unless the voice,
          // pitch or filter routing changes. Section dynamics are applied later.
          let shapes = instrumentShapes.get(entry);
          if (!shapes) { shapes = new Map(); instrumentShapes.set(entry, shapes); }
          const shapeKey = `${id}:${base}:${routed}`;
          let inst = shapes.get(shapeKey);
          if (!inst) {
            const instVoice = namedInstrument ? { ...voice, waveform: (namedInstrument.waveform ?? namedInstrument.wave ?? voice.waveform) as any, pulse_width: namedInstrument.pulse_width ?? voice.pulse_width, adsr: namedInstrument.adsr ?? voice.adsr } : voice;
            const fx = { ...fxRaw, ...(namedInstrument ?? {}) };
            if (entry.vibrato) {
              // A per-note vibrato merges over the instrument's or pattern's and becomes its own instrument variant.
              fx.vibrato = { ...(fx.vibrato ?? {}), ...entry.vibrato };
              if (fx.vibrato.depth === undefined || fx.vibrato.rate === undefined) {
                throw new SidwaveValidationError(`${patPath}.vibrato`, "a per-note vibrato needs depth and rate when the instrument and pattern have none");
              }
              const top = base + Math.max(...offsets);
              const depth = Number(fx.vibrato.depth);
              if (Math.round((midiToHz(top) * Math.pow(2, depth / 12) * 16_777_216) / CLOCK_HZ[system]) > 0xffff) {
                throw new SidwaveValidationError(`${patPath}.vibrato.depth`, `a vibrato of ${depth} semitones on ${midiToNoteName(top)} would rise above the SID's highest frequency on ${system}`);
              }
            }
            if (entry.chord) {
              fx.wavetable = offsets.map((offset) => ({ note: offset < 0 ? String(offset) : `+${offset}`, frames: entry.chord!.speed }));
              fx.loop = 0;
            }
            if (modern && voice.center) {
              // Both copies restart with TEST set so their oscillators start in phase.
              const hr = fx.hard_restart as { frames?: number; adsr?: number[] } | undefined;
              fx.hard_restart = { frames: hr?.frames || SIDWAVE_HARD_RESTART_FRAMES, adsr: hr?.adsr ?? [0, 0, 0, 0], test: true };
            }
            if (modern && ownerChannel !== undefined && id !== ownerChannel && fx.filtertable) {
              fx.filtertable = undefined;
              findings?.once("FILTER-IGNORED", String(instrumentName ?? `v${id}`), `bar ${barOf(b)} v${idByChannel?.get(id) ?? id}`, "Move the filter table to the owner voice or remove it");
            }
            if (modern && !sid?.model && !isLibrary && JSON.stringify(fx.filtertable ?? "").includes('"hz"')) {
              throw new SidwaveValidationError(`${patPath}.instrument`, "declare sids[].model before using a cutoff in Hz");
            }
            inst = buildInstrument(instVoice, fx, entry.arp ? offsets : [], entry.arp ? entry.arpSpeed : 0, routed, fps, modern, doc.speed, base, sid?.model);
            shapes.set(shapeKey, inst);
          }
          const previous = out[out.length - 1];
          const legato = (entry.legato ?? namedInstrument?.legato) && previous?.end === f0 && f0 !== clock?.loopFrame;
          const minFrames = legato ? 1 : (inst.restart?.frames ?? SIDWAVE_HARD_RESTART_FRAMES) + (modern ? doc.speed : 1);
          if (modern && !entry.bend && f1 - f0 < minFrames) {
            if (truncated) continue;
            throw new SidwaveValidationError(patPath, `the note needs at least ${minFrames} frames including its hard restart`);
          }
          let midi = base;
          let glideFrom: number | undefined;
          let portamento = entry.portamento ?? (entry.glide ? namedInstrument?.portamento || 3 : namedInstrument?.portamento);
          if (entry.bend) {
            midi = typeof entry.bend.to === "number" ? base + entry.bend.to : noteNameToMidi(entry.bend.to)! + transpose;
            glideFrom = base;
            portamento = entry.bend.frames;
          } else if (entry.slideFrom !== undefined) {
            glideFrom = entry.slideFrom + transpose;
            portamento ||= inst.slideSpeed || SIDWAVE_HARD_RESTART_FRAMES * 2;
          }
          if (modern && portamento) portamento = Math.min(255, portamento * doc.speed);
          if (glideFrom !== undefined) {
            if (midi < 12 || midi > maxMidi || glideFrom < 12 || glideFrom > maxMidi) {
              throw new SidwaveValidationError(patPath, "bend or slide_from lies outside the playable note range");
            }
            if (inst.wavetable?.some((step) => step.note !== undefined)) {
              throw new SidwaveValidationError(patPath, "bend and slide_from require a wavetable without pitch steps");
            }
            // The explicit glide supplies its own initial offset and duration.
            inst = { ...inst, slideSemis: 0, slideSpeed: 0, slideRecip: 0 };
            if (!entry.bend && portamento >= f1 - f0) throw new SidwaveValidationError(patPath, "bend or slide_from must reach its target during the note");
          }
          const gateOff = entry.gateOff === undefined ? undefined : entry.gateOff * (modern ? doc.speed : 1);
          if (gateOff !== undefined && gateOff >= f1 - f0) {
            throw new SidwaveValidationError(patPath, "gate_off must leave at least one sounding frame");
          }
          if (out.length >= MAX_NOTES_PER_VOICE) {
            throw new SidwaveValidationError(patPath, `voice ${id} has more than ${MAX_NOTES_PER_VOICE} notes; every note takes at least 3 bytes, so the song would end past the $D000 limit (about 50 KB); use longer note lengths or fewer bars`);
          }
          const voiceId = idByChannel?.get(id) ?? id;
          const level = section.levels?.[`v${voiceId}`] ?? section.level;
          const mark = level !== undefined || voice.level !== undefined || entry.level !== undefined || entry.accented || !!voice.center;
          const sustain = inst.sr >> 4;
          const centerScale = voice.center ? (voice.center.level ?? 11.25) / 15 : 1;
          const effective = sustain ? Math.min(15, Math.max(1, Math.round(sustain * centerScale * (entry.level ?? voice.level ?? 15) / 15 *
            rampValue(level, 15, b - sec.startBeat, sec.endBeat - sec.startBeat, sec.meter) / 15) +
            (entry.accented ? doc.accent ?? 3 : 0))) : 0;
          const percussion = !!entry.kitNote || voice.role === "drums" ||
            (isLibrary && /^(?:kick|snare|hat|tom|clap|open_hat|crash)$/.test(key!));
          const transient = percussion || !!inst.wavetable?.length;
          const targetedLevel = section.levels?.[`v${voiceId}`] !== undefined || voice.level !== undefined ||
            entry.level !== undefined || entry.accented || !!voice.center;
          if (mark && !sustain && (!transient || targetedLevel)) findings?.once("LEVEL-NOOP", instrumentName ?? `v${voiceId}`, `bar ${barOf(b)} v${voiceId}`, "Use chip volume or a kit variant for sustain-zero sounds");
          const sounding = legato ? instruments[previous!.inst]! : inst;
          if (modern) {
            checkDetunedPitch(midi, sounding, voice.detune ?? 0, system, patPath);
            if (glideFrom !== undefined && voice.detune) checkDetunedPitch(glideFrom, sounding, voice.detune, system, patPath);
            if (glideFrom !== undefined && sounding.wavetable?.some((step) => step.note !== undefined)) {
              throw new SidwaveValidationError(patPath, "bend and slide_from require a wavetable without pitch steps");
            }
          }
          const arranged: ArrangedNote = {
            start: f0, end: f1, midi,
            inst: legato ? previous!.inst : instIndex(inst),
            legato,
            percussion,
            portamento, glideFrom, gateOff,
            ...(modern ? { sustain: mark && !legato ? effective : legato ? previous?.sustain : undefined, beat: b,
              section: sec.index, path: `bar ${barOf(b)} v${voiceId}`,
              volume: rampValue(section.volume?.[sid?.id ?? ""], volume, b - sec.startBeat, sec.endBeat - sec.startBeat, sec.meter) } : {}),
            ...(doc.version === "1.3" && entry.chord ? { chord: { offsets, speed: entry.chord.speed } } : {}),
            ...(doc.version === "1.3" && entry.accented ? { accented: true } : {}),

          };
          out.push(arranged);
          if (entry.bend) bends.set(arranged, { path: patPath, minFrames });
        }
      }
      if (hasFilterMod) globals.push({ frame: ef, kind: "filtermod", step: 0, count: 0 });
    }

    // Master volume fade when every sounding voice of the section fades.
    if (!modern && fading.length > 0 && fading.length === active.length) {
      for (let beat = sec.startBeat; beat < sec.endBeat - BEAT_EPS; beat += 1) {
        const f = frameAt(beat);
        globals.push({ frame: f, kind: "volume", value: Math.round(volume * (1 - (f - sf) / (ef - sf))) });
      }
      globals.push({ frame: ef, kind: "volume", value: volume });
    }

    if (modern && sid && (doc.timeline.some((s) => s.volume?.[sid.id] !== undefined))) {
      const ramp = section.volume?.[sid.id];
      const span = sec.endBeat - sec.startBeat;
      if (typeof ramp === "object" && Math.abs(ramp.to - (ramp.from ?? volume)) > (ramp.bars ?? span / sec.meter) * sec.meter) {
        findings?.add("VOL-STEP", `bar ${barOf(sec.startBeat)} ${sid.id}`, "Give each volume step a beat");
      }
      if (doc.samples?.triggers.some((trigger) => doc.sids[trigger.chip]?.id === sid.id) || doc.digiVoices?.some((digi) => doc.sids[digi.chip]?.id === sid.id)) {
        throw new SidwaveValidationError(secPath + ".volume", `cannot change volume on digi SID ${sid.id}`);
      }
      let previous = -1;
      for (let beat = sec.startBeat; beat < sec.endBeat - BEAT_EPS; beat++) {
        const value = Math.round(rampValue(ramp, volume, beat - sec.startBeat, span, sec.meter));
        if (value !== previous) globals.push({ frame: frameAt(beat), kind: "volume", value });
        previous = value;
      }
    }

    if (modern && sid && doc.timeline.some((t) => t.filter?.[sid.id] !== undefined)) {
      // Section cutoff offset (register units) and resonance: absolute state at every section start, ramps stepped per beat.
      const move = section.filter?.[sid.id];
      const span = sec.endBeat - sec.startBeat;
      let previous = "";
      for (let beat = sec.startBeat; beat < sec.endBeat - BEAT_EPS; beat++) {
        const offset = Math.round(rampValue(move?.cutoff, 0, beat - sec.startBeat, span, sec.meter));
        const res = move?.resonance === undefined ? 0 : move.resonance + 1;
        const key = `${offset}:${res}`;
        if (key !== previous) globals.push({ frame: frameAt(beat), kind: "foffset", value: offset * 32, res });
        previous = key;
      }
    }

    // Reverb simulation: a free voice echoes the lowest active voice, delayed and quieter.
    const tgt = reverb && [1, 2, 3].find((id) => {
      const voice = voicesById.get(id);
      return !active.includes(id) && !voice?.echo && !voice?.unison;
    });
    if (reverb && active.length > 0 && tgt) {
      const src = Math.min(...active);
      const delay = reverb.delay_frames * (modern ? doc.speed : 1);
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

  if (modern) {
    // source_note: hidden, silent notes keep the source oscillator (the preceding channel) at the pitch that
    // sets the pitch of a sync or ring voice. A waveform of 0 keeps the channel inaudible.
    let hiddenInst = -1;
    for (const [channel, list] of notes.entries()) {
      for (const n of [...list]) {
        const spec = instruments[n.inst]!.sourceNote;
        if (spec === undefined || n.hidden) continue;
        const source = (channel + 2) % 3;
        const midi = /^[+-]/.test(spec) ? n.midi + Number(spec) : noteNameToMidi(spec)!;
        const label = `bar ${barOf(n.beat ?? 0)} v${idByChannel?.get(source + 1) ?? source + 1}`;
        if (midi < 12 || midi > maxMidi) throw new SidwaveValidationError(`$.voices.v${idByChannel?.get(channel + 1) ?? channel + 1}`, `source_note ${spec} lies outside the playable note range at ${label}`);
        if (notes[source]!.some((m) => !m.hidden && m.start < n.end && m.end > n.start)) {
          throw new SidwaveValidationError(`$.voices.v${idByChannel?.get(source + 1) ?? source + 1}`, `the source channel of a source_note instrument must be unscored while the note sounds (${label})`);
        }
        if (hiddenInst < 0) hiddenInst = instIndex({ ...instruments[0]!, wave: 0, ad: 0, sr: 0 });
        notes[source]!.push({ start: n.start, end: n.end, midi, inst: hiddenInst, hidden: true, beat: n.beat });
      }
    }
    for (const list of notes) list.sort((a, b) => a.start - b.start);
  }
  // Ties may extend a bend across a pattern or section boundary.
  for (const [note, { path, minFrames }] of bends) {
    const length = note.end - note.start;
    if (length < minFrames) throw new SidwaveValidationError(path, `the note needs at least ${minFrames} frames including its hard restart`);
    if (note.portamento! >= length) {
      throw new SidwaveValidationError(path, "bend or slide_from must reach its target during the note");
    }
  }
  let tail = 0;
  if (end) {
    for (const list of notes) {
      for (const n of list) {
        if (n.end < musicFrames - 1 || n.start >= musicFrames) continue;
        n.end += holdFrames;
        // Release times are nominal values of the SID's release table (see RELEASE_MS in sidwaveLint.ts).
        tail = Math.max(tail, RELEASE_MS[instruments[n.inst]!.sr & 15]! / 1000 * fps);
      }
    }
  }
  const voices = notes.map((list, v) => ({
    notes: list,
    events: buildVoiceEvents(list, instruments, totalFrames, framesPerBeat, v === 0 ? globals : [], voicesById.get(v + 1)?.detune, clock?.loopFrame, end ? musicFrames : undefined),
  }));

  if (modern && fenv && typeof fenv.cutoff_base === "string" && !sid?.model) {
    throw new SidwaveValidationError("$.filter_env.cutoff_base", "declare sids[].model before using a cutoff in Hz");
  }
  const base = fenv ? resolveCutoff(fenv.cutoff_base, sid?.model, "$.filter_env.cutoff_base") : 1024;
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
    clock,
    endTail: end && end.release ? Math.min(Math.ceil(tail), Math.ceil(4 * fps)) : 0,
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
    level?: number; accented?: boolean; glide?: boolean; kitNote?: boolean;
    chord?: ReturnType<typeof parseChordArp>; bend?: SidwaveGrooveNote["bend"]; slideFrom?: number; gateOff?: number;
    vibrato?: SidwaveGrooveNote["vibrato"];
  } & ({ arp: false; arpSpeed: 0 } | { arp: true; arpSpeed: number }));

function patternEntries(pattern: SidwavePattern, path: string, modern: boolean): PatternEntry[] {
  const p = pattern as any;
  if (p.type === "arpeggio" || Array.isArray(p.notes)) {
    const midis = (p.notes as string[]).map((n) => noteNameToMidi(n)!);
    if (p.frame_rate !== undefined) return [{ kind: "note", notes: midis, arp: true, arpSpeed: Number(p.frame_rate) }];
    return midis.map((m) => ({ kind: "note", notes: [m], arp: false, arpSpeed: 0 }));
  }
  if (Array.isArray(p.groove)) {
    return (p.groove as SidwavePatternGroove["groove"]).map((raw) => {
      if (typeof raw === "object") {
        if ("chord" in raw) {
          const chord = parseChordArp(raw, path);
          return { kind: "note", notes: [chord.base], arp: false, arpSpeed: 0, chord, instrument: raw.inst, len: raw.len,
            legato: raw.legato, level: raw.level, accented: raw.accented, glide: raw.glide };
        }
        const { note, inst: instrument, len, legato, portamento, slide_from } = raw;
        return { kind: "note", notes: [noteNameToMidi(note)!], arp: false, arpSpeed: 0, instrument, len, legato, portamento,
          level: raw.level, accented: raw.accented, glide: raw.glide, kitNote: raw.kitNote,
          bend: raw.bend, slideFrom: modern && slide_from ? noteNameToMidi(slide_from) : undefined, gateOff: raw.gate_off,
          ...(raw.vibrato ? { vibrato: raw.vibrato } : {}),
        };
      }
      const tok = String(raw).trim();
      if (isRestToken(tok)) return { kind: "rest" };
      if (isTieToken(tok)) return { kind: "tie" };
      if (modern && tok.endsWith("@arp")) {
        const chord = parseChordArp({ chord: tok.slice(0, -4) }, path);
        return { kind: "note", notes: [chord.base], arp: false, arpSpeed: 0, chord };
      }
      const [note, instrument] = tok.split("@");
      return { kind: "note", notes: [noteNameToMidi(note)!], arp: false, arpSpeed: 0, instrument };
    });
  }
  const entries: MotifEntry[] = parseMotif(String(p.motif), p.root === undefined ? "C3" : String(p.root), `${path}.motif`);
  return entries.map((e) => (e === null ? { kind: "rest" } : e === "~" ? { kind: "tie" } : { kind: "note", notes: [e], arp: false, arpSpeed: 0 }));
}

function tablePitch(note: string | undefined, base: number): number {
  return note === undefined ? base : /^[+-]/.test(note) ? base + Number(note) : noteNameToMidi(note)!;
}

function scaleWaveTable(table: Array<Record<string, any>> | undefined, loop: number | undefined, speed: number, midi: number) {
  if (!table) return { steps: undefined, loop };
  const steps: Array<Record<string, any>> = [];
  let start: number | undefined;
  let pitch = midi;
  for (const [i, row] of table.entries()) {
    if (i === loop) start = steps.length;
    const calls = row.calls ?? (row.frames ?? 1) * speed;
    pitch = row.note === undefined ? midi : tablePitch(row.note, midi);
    if (row.slide_to !== undefined) {
      const from = midiToHz(pitch);
      const to = midiToHz(tablePitch(row.slide_to, midi));
      for (let c = 0; c < calls; c++) {
        const fraction = calls === 1 ? 1 : c / (calls - 1);
        steps.push({ ...row, frames: 1, hz: from + (to - from) * fraction });
      }
    } else {
      for (let left = calls; left > 0; left -= 255) steps.push({ ...row, frames: Math.min(left, 255) });
    }
  }
  return { steps, loop: start };
}

function scaleRegisterTable(table: SidwaveRegisterTable | undefined, speed: number,
  model?: ParsedSidwave["sids"][number]["model"]): SidwaveRegisterTable | undefined {
  if (!table) return;
  const steps: SidwaveRegisterTable["steps"] = [];
  let loop: number | undefined;
  for (const [i, step] of table.steps.entries()) {
    if (i === table.loop) loop = steps.length;
    const factor = step.calls ? 1 : speed;
    const calls = step.calls ?? step.frames * factor;
    let value = step.hz ? resolveCutoff(step.hz, model, "$.instruments.filtertable.cutoff") : step.value;
    const cadence = step.add && value % factor !== 0 ? factor : 1;
    if (step.add && cadence === 1) value /= factor;
    // Split without disturbing the per-frame cadence at the boundary.
    const chunk = Math.floor(255 / cadence) * cadence;
    for (let left = calls; left > 0; left -= chunk) {
      steps.push({ ...step, value, frames: Math.min(left, chunk), ...(cadence > 1 ? { cadence } : {}) });
    }
  }
  return { steps, loop, reset: table.reset };
}

function buildInstrument(voice: SidwaveVoice, fx: Record<string, any>, arp: number[], arpSpeed: number, filter: number, fps: number, modern: boolean,
  speed = 1, midi = 60, model?: ParsedSidwave["sids"][number]["model"]): Instrument {
  const adsr = voice.adsr ?? [2, 2, 10, 3];
  const wave = waveformToCtrl(voice.waveform ?? "pulse");
  const baseWidth = voice.pulse_width ?? 0x800;
  const pw = fx.pulsetable && baseWidth > 0 && (modern ? baseWidth < 1 : baseWidth <= 1)
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
  const factor = modern ? speed : 1;
  const slideSpeed = slide ? Math.min(255, Number(slide.speed) * factor) : 0;
  const waves = modern ? scaleWaveTable(fx.wavetable, fx.loop, factor, midi) : { steps: fx.wavetable, loop: fx.loop };
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
    vibDelay: vib ? Math.min(255, Number(vib.delay ?? 0) * factor) : 0,
    ...(vib?.fade ? { vibFade: Math.ceil(65536 / (Number(vib.fade) * factor)) } : {}),
    arp,
    arpSpeed: Math.min(255, arpSpeed * factor),
    slideSemis: slide ? Number(slide.depth) : 0,
    slideSpeed,
    slideRecip,
    filter,
    wavetable: Array.isArray(waves.steps) ? waves.steps.map((s: any) => ({ ...s })) : undefined,
    waveloop: waves.loop,
    pulsetable: modern ? scaleRegisterTable(fx.pulsetable, factor) : fx.pulsetable,
    filtertable: modern ? scaleRegisterTable(fx.filtertable, factor, model) : fx.filtertable,
    ...(modern && fx.source_note ? { sourceNote: String(fx.source_note) } : {}),
    restart: modern && (fx.hard_restart || speed !== 1) ? {
      frames: (fx.hard_restart?.frames ?? SIDWAVE_HARD_RESTART_FRAMES) * factor,
      ad: ((fx.hard_restart?.adsr?.[0] ?? 0) << 4) | (fx.hard_restart?.adsr?.[1] ?? 0),
      sr: ((fx.hard_restart?.adsr?.[2] ?? 0) << 4) | (fx.hard_restart?.adsr?.[3] ?? 0),
      test: fx.hard_restart?.test ?? false,
    } : undefined,
  };
}

/** Original recipes using transient noise, pitch steps and PWM from data/sound/sid-programming-best-practices.md. */
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
  tom: {
    waveform: "tri", adsr: [0, 5, 6, 4],
    wavetable: [{ wave: "noise", note: "D5" }, { wave: "tri", note: "+12" }, { note: "+5" }, { note: "+0" }],
  },
  clap: {
    waveform: "noise", adsr: [0, 3, 9, 4],
    wavetable: [{ note: "E6" }, { gate: false }, { note: "G6" }, { gate: false }, { note: "D6", frames: 3 }],
  },
  open_hat: {
    waveform: "noise", adsr: [0, 6, 5, 6],
    wavetable: [{ note: "A7" }, { note: "F7", frames: 3 }, { note: "D7", frames: 8 }, { gate: false }],
  },
  crash: {
    waveform: "noise", adsr: [0, 8, 7, 9],
    wavetable: [{ note: "G7", frames: 3 }, { note: "F#6", frames: 12 }, { note: "D6", frames: 20 }, { gate: false }],
  },
  octave_bass: {
    waveform: "saw", adsr: [0, 5, 10, 3],
    wavetable: [{ note: "+12", frames: 2 }, { note: "+0", frames: 3 }], loop: 0,
  },
  wide_pwm_pad: {
    waveform: "pulse", adsr: [5, 5, 12, 7], pulse_width: 0.18,
    pulsetable: { steps: [{ value: 737, add: false, frames: 1 }, { value: 24, add: true, frames: 100 },
      { value: -24, add: true, frames: 100 }], loop: 1 },
  },
  pluck_arp: {
    waveform: "pulse", adsr: [0, 6, 3, 4], pulse_width: 1024,
    wavetable: [{ note: "+0" }, { note: "+7" }, { note: "+12" }, { wave: "tri", note: "+7" }], loop: 0,
  },
  noise_lead_attack: {
    waveform: "saw", adsr: [0, 4, 11, 4],
    wavetable: [{ wave: "noise", note: "G6" }, { wave: "saw" }],
  },
};

const MODERN_LIBRARY = {
  ...SIDWAVE_INSTRUMENT_LIBRARY,
  kick: { waveform: "tri", adsr: [0, 9, 0, 0], wavetable: [
    { note: "E3", slide_to: "G#1", frames: 5 }, { gate: false, note: "G#1" },
  ] },
  snare: { waveform: "noise", adsr: [0, 8, 0, 0], wavetable: [
    { wave: "tri", note: "G3" }, { wave: "noise", note: "A6", frames: 5 },
  ] },
  hat: { ...SIDWAVE_INSTRUMENT_LIBRARY.hat, adsr: [0, 4, 0, 0] },
  ...Object.fromEntries(["tom", "clap", "open_hat", "crash"].map((name) => {
    const recipe = SIDWAVE_INSTRUMENT_LIBRARY[name]!;
    return [name, { ...recipe, adsr: [recipe.adsr[0], recipe.adsr[1], 0, recipe.adsr[3]] }];
  })),
  filter_bass: { ...SIDWAVE_INSTRUMENT_LIBRARY.filter_bass, filtertable: { steps: [
    { value: 0, hz: "1.2kHz", add: false, frames: 1, resonance: 8, type: 0x10 },
    { value: 0, hz: "900Hz", add: false, frames: 2 }, { value: 0, hz: "600Hz", add: false, frames: 2 },
    { value: 0, hz: "300Hz", add: false, frames: 1 },
  ] } },
  pad_slow: { ...SIDWAVE_INSTRUMENT_LIBRARY.pad_slow, legato: true, hard_restart: { frames: 0 }, filtertable: { steps:
    [400, 800, 1200, 1600, 2000, 1600, 1200, 800].map((hz) => ({ value: 0, hz: hz + "Hz", add: false, frames: 8 })),
    loop: 0, reset: false } },
  wide_pwm_pad: { ...SIDWAVE_INSTRUMENT_LIBRARY.wide_pwm_pad, legato: true, hard_restart: { frames: 0 } },
} as Record<string, Record<string, any>>;

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
  RESTART: 0xe9, // attack/decay, sustain/release, TEST flag
  SAMPLE: 0xea, // index into the sample start table
  CALL: 0xec, // stream subroutine address (16-bit); one level, no nesting
  RET: 0xed,
  FILTEROFFSET: 0xeb, // section cutoff offset (signed 24-bit, cutoff x 32), resonance + 1 (0 = table value)
} as const;

const ORDER = { gate: 0, filterReset: 1, inst: 2, note: 3, sustain: 4, filterStart: 5, volume: 6, sample: 7 } as const;

function buildVoiceEvents(notes: ArrangedNote[], instruments: Instrument[], total: number, framesPerBeat: number, globals: GlobalEvent[], cents = 0, loopFrame?: number, gateFrame?: number): StreamEvent[] {
  const events: StreamEvent[] = [];
  const wrap = (f: number) => (f >= total && gateFrame === undefined ? f - total + (loopFrame ?? 0) : f);
  let currentInst = -1;
  for (let i = 0; i < notes.length; i += 1) {
    const n = notes[i]!;
    const nextNote = notes[i + 1];
    const loopNote = loopFrame === undefined ? notes[0] : notes.find((note) => note.start >= loopFrame);
    const next = nextNote?.start ?? (gateFrame === undefined && loopNote ? loopNote.start + total - (loopFrame ?? 0) : total + 256);
    const restart = instruments[(nextNote ?? loopNote ?? n).inst]!.restart;
    const restartFrames = restart?.frames ?? SIDWAVE_HARD_RESTART_FRAMES;
    const hr = Math.max(n.start + 1, next - Math.max(1, restartFrames));
    const continues = nextNote?.legato && nextNote.start === n.end;
    const gateOff = continues ? n.end : Math.max(n.start + 1, Math.min(n.end - (n.gateOff ?? 0), hr));
    n.releaseFrame = gateOff;
    if (!continues && (nextNote || (gateFrame === undefined && !!loopNote))) {
      if (restart?.frames && next - n.start <= restart.frames) {
        throw new SidwaveValidationError("$.timeline", `note on call ${next % total} needs ${restart.frames} hard restart calls after the preceding note`);
      }
      if (gateOff < hr) events.push({ frame: wrap(gateOff), order: ORDER.gate, bytes: [OP.GATEOFF] });
      const bytes = !restart ? [OP.HARDRESTART] : !restart.frames
        ? [OP.GATEOFF] : [OP.RESTART, restart.ad, restart.sr, restart.test ? 8 : 0];
      events.push({ frame: wrap(hr), order: ORDER.gate, bytes });
    } else if (!continues) {
      events.push({ frame: gateOff, order: ORDER.gate, bytes: [OP.GATEOFF] });
    }
    if (n.inst !== currentInst || (loopFrame !== undefined && (i === 0 || notes[i - 1]!.start < loopFrame) && n.start >= loopFrame)) {
      events.push({ frame: n.start, order: ORDER.inst, bytes: [OP.INST + n.inst] });
      currentInst = n.inst;
    }
    const note = n.midi - 12;
    const bytes = n.legato && i > 0 && notes[i - 1]!.end === n.start ? [OP.LEGATO, note] : [OP.NOTE + note];
    const previous = notes[i - 1];
    const origin = n.glideFrom ?? previous?.midi;
    if (n.portamento && origin !== undefined) {
      bytes.push(OP.PORTAMENTO, n.portamento, Number(origin > n.midi));
      for (const system of ["PAL", "NTSC"] as const) {
        const magnitude = Math.abs(hzToSidFrequency(midiToHz(origin + cents / 100), system) - hzToSidFrequency(midiToHz(n.midi + cents / 100), system));
        const step = Math.floor((magnitude * 256) / n.portamento);
        bytes.push(magnitude & 255, magnitude >> 8, step & 255, (step >> 8) & 255, step >> 16);
      }
    }
    events.push({ frame: n.start, order: ORDER.note, bytes });
    // reSID envelope.h EnvelopeGenerator::clock: decay steps until sustain equality,
    // so an increased sustain during a held note can drive the envelope to zero.
    if (!n.legato && n.sustain !== undefined && !n.fade) {
      events.push({ frame: n.start, order: ORDER.sustain, bytes: [OP.SETSR, (n.sustain << 4) | (instruments[n.inst]!.sr & 15)] });
    }
    if (n.fade) {
      const inst = instruments[n.inst]!;
      const sustain = n.sustain ?? inst.sr >> 4;
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
    } else if (g.kind === "foffset") {
      const value = g.value & 0xffffff;
      events.push({ frame: wrap(g.frame), order: ORDER.volume, bytes: [OP.FILTEROFFSET, value & 0xff, (value >> 8) & 0xff, value >> 16, g.res] });
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

/** The voice's commands as tokens (waits and events); an empty token marks the loop target. */
function encodeVoiceTokens(events: StreamEvent[], total: number, loopFrame?: number): number[][] {
  const sorted = [...events, ...(loopFrame === undefined ? [] : [{ frame: loopFrame, order: -1, bytes: [] }])].sort((a, b) => a.frame - b.frame || a.order - b.order);
  const out: number[][] = [];
  const pushWait = (frames: number) => {
    let left = frames;
    while (left > 256) {
      out.push([OP.WAITLONG, 0]);
      left -= 256;
    }
    if (left <= 0) return;
    if (left <= 64) out.push([OP.WAIT + left - 1]);
    else out.push([OP.WAITLONG, left & 0xff]);
  };
  let cursor = 0;
  for (const e of sorted) {
    if (e.frame > cursor) {
      pushWait(e.frame - cursor);
      cursor = e.frame;
    }
    out.push(e.bytes);
  }
  pushWait(total - cursor);
  out.push([OP.LOOP]);
  return out;
}

function sameStreamEvents(left: StreamEvent[], right: StreamEvent[]): boolean {
  return left.length === right.length && left.every(({ frame, order, bytes }, i) => {
    const match = right[i]!;
    return frame === match.frame && order === match.order && bytes.length === match.bytes.length &&
      bytes.every((value, j) => value === match.bytes[j]);
  });
}

export function encodeVoiceStream(events: StreamEvent[], total: number, loopFrame?: number, setLoopOffset?: (offset: number) => void): number[] {
  const out: number[] = [];
  for (const token of encodeVoiceTokens(events, total, loopFrame)) {
    if (!token.length) setLoopOffset?.(out.length);
    out.push(...token);
  }
  return out;
}

export type StreamByte = number | string;

/**
 * Replaces repeated token runs with one stream subroutine: CALL <address> runs the shared copy, RET returns.
 * A copy is shared only when its commands, including every wait, are identical, so the sound is unchanged.
 * Subroutines do not nest and never contain the loop target or the final LOOP command.
 */
export function compressVoiceTokens(tokens: number[][], voice: number, setLoopOffset: (offset: number) => void): { bytes: StreamByte[]; calls: number } {
  const key = tokens.map((t) => t.join(","));
  const barrier = tokens.map((t) => !t.length || t[0] === OP.LOOP);
  const prefix = [0];
  for (const token of tokens) prefix.push(prefix[prefix.length - 1]! + token.length);
  const size = (from: number, to: number) => prefix[to]! - prefix[from]!;
  const subs: Array<{ start: number; length: number; uses: number }> = [];
  const matchAt = (i: number, sub: { start: number; length: number }) => {
    if (i + sub.length > tokens.length) return false;
    for (let k = 0; k < sub.length; k++) if (barrier[i + k] || key[i + k] !== key[sub.start + k]) return false;
    return true;
  };
  const signature = (i: number) => key[i] + "|" + key[i + 1] + "|" + key[i + 2];
  const later = new Map<string, number[]>();
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (barrier[i] || barrier[i + 1] || barrier[i + 2]) continue;
    const sig = signature(i);
    if (!later.has(sig)) later.set(sig, []);
    later.get(sig)!.push(i);
  }
  const plan = (discover: boolean, allowed: typeof subs) => {
    const cursors = new Map<string, number>();
    const steps: Array<{ token?: number; sub?: number }> = [];
    for (let i = 0; i < tokens.length;) {
      if (barrier[i]) { steps.push({ token: i++ }); continue; }
      const hit = allowed.findIndex((sub) => matchAt(i, sub));
      if (hit >= 0) { allowed[hit]!.uses++; steps.push({ sub: hit }); i += allowed[hit]!.length; continue; }
      if (discover && i + 2 < tokens.length) {
        const sig = signature(i);
        const positions = later.get(sig);
        let cursor = cursors.get(sig) ?? 0;
        while (positions?.[cursor] !== undefined && positions[cursor]! <= i) cursor++;
        cursors.set(sig, cursor);
        const next = positions?.[cursor];
        if (next !== undefined) {
          let run = 0;
          while (run < next - i && !barrier[i + run] && !barrier[next + run] && key[i + run] === key[next + run]) run++;
          if (size(i, i + run) >= 12) {
            allowed.push({ start: i, length: run, uses: 1 });
            steps.push({ sub: allowed.length - 1 });
            i += run;
            continue;
          }
        }
      }
      steps.push({ token: i++ });
    }
    return steps;
  };
  const found: typeof subs = [];
  plan(true, found);
  // Keep a subroutine only when sharing it saves bytes: (uses - 1) copies minus the CALLs and the RET.
  const kept = found.filter((sub) => (sub.uses - 1) * size(sub.start, sub.start + sub.length) - 3 * sub.uses - 1 > 0)
    .map((sub) => ({ start: sub.start, length: sub.length, uses: 0 }));
  const steps = plan(false, kept);
  const used = kept.filter((sub) => sub.uses > 0);
  const remap = new Map(kept.map((sub, i) => [i, used.indexOf(sub)]));
  let mainLength = 0;
  for (const step of steps) mainLength += step.token !== undefined ? tokens[step.token]!.length : 3;
  const offsets: number[] = [];
  let at = mainLength;
  for (const sub of used) { offsets.push(at); at += size(sub.start, sub.start + sub.length) + 1; }
  const bytes: StreamByte[] = [];
  for (const step of steps) {
    if (step.token !== undefined) {
      const token = tokens[step.token]!;
      if (!token.length) setLoopOffset(bytes.length);
      bytes.push(...token);
    } else {
      const offset = offsets[remap.get(step.sub!)!]!;
      bytes.push(OP.CALL, `<(stream${voice}+${offset})`, `>(stream${voice}+${offset})`);
    }
  }
  for (const sub of used) {
    for (let k = 0; k < sub.length; k++) bytes.push(...tokens[sub.start + k]!);
    bytes.push(OP.RET);
  }
  return { bytes, calls: steps.filter((step) => step.sub !== undefined).length };
}

// ---------------------------------------------------------------------------
// 6502 player

// Upper bounds for the NMOS 6502 paths in PLAYER_CODE, including indexed
// reads and taken branches crossing a page. Costs for instrument-dependent
// paths are charged only when the corresponding feature is in the score.
function estimatePlayerCycles(arr: Arrangement, loop: boolean): number {
  const hasWave = arr.instruments.some((inst) => !!inst.wavetable?.length);
  const hasPulse = arr.instruments.some((inst) => !!inst.pulsetable);
  const hasFilter = arr.instruments.some((inst) => !!inst.filtertable);
  const hasMod = arr.chips?.some((chip) => chip.hasFilterMod);
  const hasSweep = arr.chips?.some((chip) => chip.filter.stepFixed);
  const hasFade = arr.instruments.some((inst) => inst.vibFade);
  const bursts = new Map<number, number>();
  const add = (frame: number, cycles: number) => bursts.set(frame, (bursts.get(frame) ?? 0) + cycles);
  let regular = 180 + (arr.softVolume ? 35 + 135 * (arr.chips?.length ?? 1) : 0) + (arr.samples ? 48 * (arr.chips?.length ?? 1) : 0); // entry, pointer/banking saves, play-once wrapper and return
  for (const chip of arr.chips ?? [{ filter: arr.filter, hasFilterTable: hasFilter }]) {
    regular += arr.chips ? 155 : 0; // base table lookup, 3-channel dispatch and unfiltered volume
    if (chip.filter.used || chip.hasFilterTable || !arr.chips) {
      regular += 180 + (arr.chips ? 80 : 0); // filter calculation and routing, load constants
      if (hasMod || !arr.chips) regular += arr.chips ? 160 : 60; // ramp and chip state copy
      if (hasSweep || !arr.chips) regular += arr.chips ? 165 : 85; // sweep and chip state copy
      if (chip.hasFilterTable) regular += 135; // ownership and winning chip's four filter writes
      if (("owner" in chip && chip.owner !== undefined) && chip.hasFilterTable) regular += 190; // owner offset sum, shift and clamp, ramp
      if ("hasOffset" in chip && chip.hasOffset) regular += 80; // section offset added to the cutoff and the resonance override
    }
  }
  for (const [slot, { events, notes }] of arr.voices.entries()) {
    const chip = arr.chips?.[Math.floor(slot / 3)];
    if (chip && !events.length && !(slot % 3 === 0 && chip.filter.used)) continue;
    const used = [...new Set(notes.map(({ inst }) => arr.instruments[inst]!))];
    if (arr.tuning) regular += 135;
    if (arr.mirrors?.some(([source]) => source === slot)) regular += 150;
    if (used.some((inst) => inst.wavetable?.some((step) => step.hz !== undefined))) regular += 32;
    if (used.some((inst) => inst.pulsetable?.steps.some((step) => step.cadence))) regular += 25;
    if (used.some((inst) => inst.filtertable?.steps.some((step) => step.cadence))) regular += 25;
    if (arr.samples) regular += 16;
    // The legacy player still runs its full register/effects path for all
    // three channels, even when their streams contain only waits.
    regular += arr.chips ? 220 : 280; // wait dispatch, register output and inactive effects
    if (hasWave) regular += used.some((inst) => inst.wavetable?.length) ? 100 : 20;
    if (hasPulse) regular += used.some((inst) => inst.pulsetable) ? 145 : 25;
    if (hasFilter) regular += used.some((inst) => inst.filtertable) ? 190 : 25;
    if (used.some((inst) => inst.arp.length)) regular += 85;
    if (notes.some((note) => note.portamento || arr.instruments[note.inst]!.slideSpeed)) regular += 110;
    if (used.some((inst) => inst.vibRate)) regular += 390;
    // Vibrato fade: an 8x8 multiply of the triangle (117 cycles with page crossings) and the 16-bit level step (48).
    // A vibrato without a fade in the same score still tests the fade flag twice (16).
    if (used.some((inst) => inst.vibFade)) regular += 170;
    else if (hasFade && used.some((inst) => inst.vibRate)) regular += 16;
    if (used.some((inst) => inst.pwStep)) regular += 95;
    if (arr.streamCalls) regular += 110; // CALL and RET
    // LOOP dispatch, pointer reload and a second fetch on the same call.
    // Include commands scheduled at the stream end in the loop-target burst.
    const wrapFrame = arr.clock?.loopFrame ?? 0;
    if (loop) add(wrapFrame, 149 + (slot % 3 === 0 && (!chip || chip.filter.used) ? 78 : 0));
    let currentInst = 0;
    for (const { frame: eventFrame, bytes: [op, ...args] } of [...events].sort((a, b) => a.frame - b.frame || a.order - b.order)) {
      const frame = loop && eventFrame === arr.totalFrames ? wrapFrame : eventFrame;
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
          // Two 16x8 multiplications (four mul8 calls), plus both rounded
          // shifts. Allow the carry/sign branches and indexed page crossings.
          if (inst.vibRate) cycles += 655 + 33 * (inst.vibUp[1] + inst.vibDown[1]);
          if (inst.vibFade) cycles += 25; // arm the fade and clear its level
          if (inst.slideSemis) cycles += 580;
          if (arr.tuning && (inst.vibRate || inst.slideSemis)) cycles += 96;
        }
        if (args.length > (op === OP.LEGATO ? 1 : 0)) cycles += 240; // portamento command and operands
        add(frame, cycles);
      } else if (op === OP.RESTART || op === OP.SAMPLE) {
        const stopChips = op === OP.SAMPLE ? arr.samples?.commands[args[0]!]?.stopChips?.length ?? 0 : 0;
        add(frame % arr.totalFrames, 230 + 22 * stopChips);
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
  const owners = chips.some((c) => c.owner !== undefined);
  const offsets = chips.some((c) => c.hasOffset);
  const filterState = [
    ...(hasSweep ? ["g_cutlo", "g_cuthi", "g_edir"] : []),
    ...(hasMod ? ["g_mofflo", "g_moffmd", "g_moffhi", "g_mstlo", "g_mstmd", "g_msthi", "g_mcntlo", "g_mcnthi"] : []),
    ...(hasFilterTable ? ["g_ftactive"] : []),
    ...(owners && hasFilterTable ? ["g_fthold"] : []),
    ...(offsets ? ["g_so0", "g_so1", "g_so2", "g_sres"] : []),
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

  if (owners && hasFilterTable) code = ownerFilterCode(code, hasMod, offsets);
  // Descending across the active chip's three slots, with channel bit masks
  // repeated in vbit. Filter ownership can only refer to voices in this group.
  code = code.replace("  ldx #2\ngl_route:", rangeStart("gl_route"))
    .replace("  dex\n  bpl gl_route", rangeEnd("gl_route"))
    .replace("  ldx #2\nft_voice:", rangeStart("ft_voice"))
    .replace("  dex\n  bpl ft_voice", rangeEnd("ft_voice"))
    .replace("  ldy #2\nft_mark_newer:", "  ldy chip_last\nft_mark_newer:")
    .replace("  dey\n  bpl ft_mark_newer", "  cpy chip_first\n  beq ft_mark_done\n  dey\n  bpl ft_mark_newer\nft_mark_done:");
  if (owners) {
    // Static routing: an owner chip writes its route bits from a constant instead of the sounding instruments.
    code = code.replace("  lda #0\n  sta tmp\n  ldx chip_last\ngl_route:", `  ldy chip_index
  lda chip_owner,y
  cmp #$FF
  beq gl_route_dyn
  lda chip_route,y
  sta tmp
  jmp gl_route_set
gl_route_dyn:
  lda #0
  sta tmp
  ldx chip_last
gl_route:`).replace("  lda tmp\n  ora res_route\n  sta $D417", `gl_route_set:
${offsets ? `  lda g_sres
  beq gl_res_table
  sec
  sbc #1
  asl
  asl
  asl
  asl
  ora tmp
  jmp gl_res_set
gl_res_table:
` : ""}  lda tmp
  ora res_route
gl_res_set:
  sta $D417`);
  }
  if (offsets) {
    code = code.replace("  sta t_xx\n  bmi gl_low", `  sta t_xx
  clc
  lda t_lo
  adc g_so0
  sta t_lo
  lda t_hi
  adc g_so1
  sta t_hi
  lda t_xx
  adc g_so2
  sta t_xx
  bmi gl_low`);
  }
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
  code = code.replace("  tax\n  lda $01\n  pha", `  tax
  lda sid_io
  pha
  lda sid_io+1
  pha
  lda $01
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

/**
 * filter.owner: only the owner's table runs, and while the owner is silent the filter keeps the last table
 * value. The section offset (g_so, cutoff x 32) and the filter_mod offset are added to the table value.
 */
function ownerFilterCode(code: string, hasMod: boolean, offsets: boolean): string {
  const sum = (hasMod: boolean) => [0, 1, 2].map((i) => {
    const reg = ["t_lo", "t_hi", "t_xx"][i]!;
    const mod = ["g_mofflo", "g_moffmd", "g_moffhi"][i]!;
    const so = offsets ? `g_so${i}` : "";
    const first = i === 0;
    if (!hasMod && !so) return `  lda #0\n  sta ${reg}`;
    return (first ? "  clc\n" : "") + `  lda ${hasMod ? mod : so}\n${hasMod && so ? `  adc ${so}\n` : ""}  sta ${reg}`;
  }).join("\n");
  const ramp = hasMod ? `ft_ramp:
  lda g_mcntlo
  ora g_mcnthi
  beq ft_ramp_done
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
  bne ft_ramp_dec
  dec g_mcnthi
ft_ramp_dec:
  dec g_mcntlo
ft_ramp_done:
  rts
` : "";
  const owner = `ft_globals:
  ldy chip_index
  ldx chip_owner,y
  lda vbit,x
  and g_ftactive
  beq ft_hold
  jsr ft_tick
ft_hold:
  jsr ft_offset
  lda t_lo
  and #7
  sta $D415
  lda t_hi
  lsr
  ror t_lo
  lsr
  ror t_lo
  lsr
  ror t_lo
  lda t_lo
  sta $D416
  ldy chip_index
${offsets ? `  lda g_sres
  beq ft_res_table
  sec
  sbc #1
  asl
  asl
  asl
  asl
  jmp ft_res_set
ft_res_table:
` : ""}  lda v_ftres,x
ft_res_set:
  ora chip_route,y
  sta $D417
  lda v_fttype,x
  ora g_vol
  sta $D418
${hasMod ? "  jmp ft_ramp" : "  rts"}
; t = clamp(v_cut + ((filter_mod offset + section offset) >> 5), 0, 2047)
ft_offset:
${sum(hasMod)}
  ldy #5
ft_off_shift:
  lda t_xx
  cmp #$80
  ror t_xx
  ror t_hi
  ror t_lo
  dey
  bne ft_off_shift
  clc
  lda t_lo
  adc v_cutlo,x
  sta t_lo
  lda t_hi
  adc v_cuthi,x
  sta t_hi
  bmi ft_off_neg
  cmp #8
  bcc ft_off_done
  lda #$FF
  sta t_lo
  lda #7
  sta t_hi
  rts
ft_off_neg:
  lda #0
  sta t_lo
  sta t_hi
ft_off_done:
  rts
${ramp}`;
  const next = /ft_globals:\n[\s\S]*?ft_next_voice:\n  dex\n  bpl ft_voice\n  rts\n/;
  if (!next.test(code)) throw new Error("SIDWAVE player code changed: the filter owner patch point was not found");
  return code.replace(next, owner).replace("  beq ft_stop\n  lda vbit,x\n  ora g_ftactive", "  beq ft_stop\n  lda #1\n  sta g_fthold\n  lda vbit,x\n  ora g_ftactive")
    .replace("globals:\n  lda g_ftactive\n  beq gl_regular", "globals:\n  lda g_fthold\n  beq gl_regular");
}

/** Writes a centred voice's registers to its mirror channel straight after its own, with the same values. */
function addCenterMirrors(code: string, arr: Arrangement): string {
  const anchor = "  dey\n  dey\n  lda v_ctrl,x\n  sta (sid_io),y";
  if (!code.includes(anchor)) throw new Error("SIDWAVE player code changed: the centre mirror patch point was not found");
  const slotCount = arr.voices.length;
  const base = (slot: number) => arr.chips![Math.floor(slot / 3)]!.address + (slot % 3) * 7;
  const lo = Array(slotCount).fill(0);
  const hi = Array(slotCount).fill(0);
  for (const [source, mirror] of arr.mirrors!) {
    const address = arr.chips![Math.floor(mirror / 3)]!.address;
    lo[source] = address & 255;
    hi[source] = address >> 8;
  }
  return code.replace(anchor, `${anchor}
  lda mirror_hi,x
  beq vr_no_mirror
  jsr vr_mirror
vr_no_mirror:`) + `
vr_mirror:
  lda sid_io
  pha
  lda sid_io+1
  pha
  lda mirror_lo,x
  sta sid_io
  lda mirror_hi,x
  sta sid_io+1
  ldy voff,x
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
  sta (sid_io),y
  pla
  sta sid_io+1
  pla
  sta sid_io
  rts
mirror_lo: .byte ${lo.join(", ")}
mirror_hi: .byte ${hi.join(", ")}
`;
}

/** Keep the restart ADSR until GATE changes, on both ordinary and mirrored voices. */
function gateBeforeEnvelope(code: string): string {
  // reSID envelope.cc writeCONTROL_REG/writeSUSTAIN_RELEASE and envelope.h clock:
  // writing the new release rate while GATE is low can let the rate counter
  // run past attack 0's match. GATE must rise while the restart rates are
  // still in place. At GATE off the new release rate takes effect afterwards.
  return code.split(`  iny
  iny
  lda v_ad,x
  sta (sid_io),y
  iny
  lda v_sr,x
  sta (sid_io),y
  dey
  dey
  lda v_ctrl,x
  sta (sid_io),y`).join(`  iny
  lda v_ctrl,x
  sta (sid_io),y
  iny
  lda v_ad,x
  sta (sid_io),y
  iny
  lda v_sr,x
  sta (sid_io),y`);
}

function stockPlayerBudget(system: SystemMode, speed: number): number {
  // Allow for VIC badlines and the host IRQ. Speed increases the call rate.
  return Math.floor((CYCLES_PER_FRAME[system] - 1_100) / speed) - 500;
}

function addTurboInit(code: string, speed: number, turboOnly: number, measured = false): string {
  // hardware.md, Turbo Control: one register write survives the post-start
  // 1 MHz hold. Count CIA IRQs for the video standard measured in do_install.
  const hold = (system: SystemMode) => (measured ? Math.floor : Math.ceil)(4.25 * sidwaveFrameRate(system) * speed);
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

/** 1.2 owns the actual level per chip. g_vol remains the musical target. */
function addSoftVolume(code: string, count: number, speed: number, loop: boolean): string {
  // The chip starts silent and ramps to its configured volume (one step per call, the 1.2 start-up behaviour);
  // every later change slews one step per two video frames.
  code = code.replace("  lda chip_volume,x\n  ldy #$18\n  sta (sid_io),y\n", "")
    .replace("  sta chip_g_vol,x\n  lda #0\n", `  sta chip_g_vol,x
  lda #0
  sta soft_level,x
  sta soft_mode,x
  sta soft_phase
  sta soft_last,x
  lda #1
  sta soft_boot,x
  lda #0
${loop ? "" : "  sta soft_end_state\n"}`)
    .replace(/  ldy #\$18\n  sta \(sid_io\),y/g, "  jsr soft_write")
    .replace("  lda ptr\n  pha", "  jsr soft_clock\n  lda ptr\n  pha");
  const shared = `
soft_clock:
  lda soft_phase
  beq soft_pulse
  dec soft_phase
  lda #0
  sta soft_step
  sta soft_slow
  rts
soft_pulse:
  lda #${speed - 1}
  sta soft_phase
  lda #1
  sta soft_step
  lda soft_odd
  eor #1
  sta soft_odd
  sta soft_slow
  rts
soft_mix:
  stx soft_saved_x
  ldx chip_index
  pha
  and #15
  sta soft_target
  cmp soft_level,x
  bne soft_mix_move
  lda #0
  sta soft_boot,x
  jmp soft_mix_out
soft_mix_move:
  lda soft_boot,x
  bne soft_mix_fast
  lda soft_slow
  jmp soft_mix_gate
soft_mix_fast:
  lda soft_step
soft_mix_gate:
  beq soft_mix_out
  lda soft_level,x
  cmp soft_target
  bcs soft_mix_down
  inc soft_level,x
  jmp soft_mix_out
soft_mix_down:
  dec soft_level,x
soft_mix_out:
  pla
  and #$F0
  sta soft_mode,x
  ora soft_level,x
  ldx soft_saved_x
  rts
; Writes $D418 only when the value changed; every volume step is a DC click on the SID.
soft_write:
  jsr soft_mix
  stx soft_wx
  ldx chip_index
  cmp soft_last,x
  beq soft_write_skip
  sta soft_last,x
  ldy #$18
  sta (sid_io),y
soft_write_skip:
  ldx soft_wx
  ldy #$18
  rts
soft_wx: .res 1
soft_boot: .res ${count}
soft_slow: .res 1
soft_odd: .res 1
soft_target: .res 1
soft_last: .res ${count}
soft_level: .res ${count}
soft_mode: .res ${count}
soft_phase: .res 1
soft_step: .res 1
soft_saved_x: .res 1
`;
  if (loop) return code + shared;
  code = code.replace("  bne play_once_running\n  rts", "  bne play_once_running\n  jmp soft_end")
    .replace("  beq finish_song\n  jmp play_tick", "  bne play_once_tick\n  jmp soft_end\nplay_once_tick:\n  jmp play_tick");
  return code + shared + `
soft_end:
  lda soft_end_state
  cmp #2
  bne soft_end_banked
  rts
soft_end_banked:
  lda $01
  pha
  lda #$36
  sta $01
  lda sid_io
  pha
  lda sid_io+1
  pha
  lda soft_end_state
  bne soft_fade
soft_release:
  lda #1
  sta soft_end_state
  lda #0
  sta soft_phase
  ldx #0
soft_release_chip:
  stx chip_index
  jsr chip_base
  lda chip_first_slot,x
  tax
  ldy #4
  lda v_ctrl,x
  and #$FE
  sta (sid_io),y
  inx
  ldy #11
  lda v_ctrl,x
  and #$FE
  sta (sid_io),y
  inx
  ldy #18
  lda v_ctrl,x
  and #$FE
  sta (sid_io),y
  ldx chip_index
  inx
  cpx #${count}
  bne soft_release_chip
soft_fade:
  jsr soft_clock
  lda soft_step
  beq soft_end_return
  lda #0
  sta soft_audible
  ldx #0
soft_fade_chip:
  lda soft_level,x
  beq soft_fade_next
  jsr chip_base
  dec soft_level,x
  lda soft_level,x
  ora soft_audible
  sta soft_audible
  lda soft_level,x
  ora soft_mode,x
  ldy #$18
  sta (sid_io),y
soft_fade_next:
  inx
  cpx #${count}
  bne soft_fade_chip
  lda soft_audible
  bne soft_end_return
  lda #2
  sta soft_end_state
soft_end_return:
  pla
  sta sid_io+1
  pla
  sta sid_io
  pla
  sta $01
  lda soft_end_state
  cmp #2
  bne soft_end_done
  jmp finish_song
soft_end_done:
  rts
soft_end_state: .res 1
soft_audible: .res 1
`;
}

/** Count stock instructions across a raster line. The stock loop needs 11
 * cycles per iteration, including the taken branch. Ten reads (including
 * the terminating read) are conservatively above 1.5 MHz on PAL and NTSC. */
function measureTurboStartup(code: string): string {
  return code.replace("  beq turbo_play\n  lda turbo_wait", `  beq turbo_play
  jsr turbo_probe
  bcs turbo_measured
  lda turbo_wait`)
    .replace("  dec turbo_wait\n  jmp $EA31\nturbo_play:", `  dec turbo_wait
  lda turbo_wait
  ora turbo_wait+1
  beq turbo_play
  jmp $EA31
turbo_measured:
  lda #0
  sta turbo_wait
  sta turbo_wait+1
turbo_play:`) + `
turbo_probe:
  lda $D012
  ldx #2
  ldy #0
turbo_sync_line:
  cmp $D012
  bne turbo_new_line
  dey
  bne turbo_sync_line
  dex
  bne turbo_sync_line
  clc
  rts
turbo_new_line:
  lda $D012
  ldx #0
turbo_count_line:
  inx
  beq turbo_count_overflow
  cmp $D012
  beq turbo_count_line
  cpx #10
  rts
turbo_count_overflow:
  sec
  rts
`;
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

/**
 * SIDWAVE 1.3 vibrato fade. A note start clears the 16-bit fade level and arms it when the instrument has a fade
 * step. While armed, the triangle factor (0..126) is scaled by the level's high byte / 256 with one 8x8 multiply.
 * The level advances with the vibrato phase, so it starts after the delay; its overflow disarms the fade and the
 * vibrato plays at full depth. The template without a fade is left untouched, so other scores keep their bytes.
 */
function addVibratoFade(code: string): string {
  const replace = (from: string, to: string) => {
    if (!code.includes(from)) throw new Error(`vibrato fade: player template changed near ${JSON.stringify(from.slice(0, 40))}`);
    code = code.replace(from, to);
  };
  replace("  lda i_vibdel,y\n  sta v_vibdel,x\n", `  lda i_vibdel,y
  sta v_vibdel,x
  lda i_vfslo,y
  ora i_vfshi,y
  sta v_vfon,x
`);
  replace("  sta v_vibph,x\n  sta v_vuplo,x\n", "  sta v_vibph,x\n  sta v_vfl,x\n  sta v_vfh,x\n  sta v_vuplo,x\n");
  replace("vr_tri:\n  asl\n  sta m_fac\n", `vr_tri:
  asl
  ldy v_vfon,x
  beq vr_vf_full
  sta ma
  lda v_vfh,x
  sta mb
  jsr mul8
  lda r_hi
vr_vf_full:
  sta m_fac
`);
  replace("  adc i_vibrate,y\n  sta v_vibph,x\n", `  adc i_vibrate,y
  sta v_vibph,x
  lda v_vfon,x
  beq va_vf_done
  clc
  lda v_vfl,x
  adc i_vfslo,y
  sta v_vfl,x
  lda v_vfh,x
  adc i_vfshi,y
  sta v_vfh,x
  bcc va_vf_done
  lda #0
  sta v_vfon,x
va_vf_done:
`);
  return code;
}

function customRestartCode(wave: boolean, pulse: boolean, filter: boolean): string {
  return `
c_restart:
${pulse ? "  jsr pt_stop" : ""}
${filter ? "  jsr ft_stop" : ""}
${wave ? "  lda #0\n  sta v_wtleft,x" : ""}
  jsr fetch
  sta v_ad,x
  jsr fetch
  sta v_sr,x
  jsr fetch
  sta t_lo
  lda v_ctrl,x
  and #$F6
  ora t_lo
  sta v_ctrl,x
  jmp v_read
`;
}

function addTunedLookup(code: string, tuning: number[]): string {
  const cents = [...new Set(tuning)].filter(Boolean);
  const key = (c: number) => c === 0 ? "" : `tuned_${cents.indexOf(c)}`;
  const labels = (sys: string, hi: boolean) => tuning.map((c) =>
    c === 0 ? (hi ? "fthi" : "ftlo") : `${key(c)}_${sys}_${hi ? "hi" : "lo"}`);
  const indexed = (name: string, names: string[], high: boolean) =>
    `${name}: .byte ${names.map((label) => `${high ? ">" : "<"}${label}`).join(",")}`;
  const banks: string[] = [];
  for (const system of ["PAL", "NTSC"] as const) {
    for (const hi of [false, true]) {
      const channel = hi ? "hi" : "lo";
      const sys = system.toLowerCase();
      const names = labels(sys, hi);
      banks.push(indexed(`tb_${sys}_${channel}_lo`, names, false), indexed(`tb_${sys}_${channel}_hi`, names, true));
      for (const c of cents) {
        const values = Array.from({ length: 96 }, (_, note) => hzToSidFrequency(midiToHz(note + 12 + c / 100), system));
        pushByteRows(banks, `${key(c)}_${sys}_${channel}`, values.map((freq) => String(hi ? freq >> 8 : freq & 255)));
      }
    }
  }
  const select = (sys: string) => ["lo", "hi"].flatMap((channel) => ["lo", "hi"].map((half, i) =>
    `  lda tb_${sys}_${channel}_${half},x\n  sta tune_${channel}+${i + 1}`)).join("\n");
  return code.replace("  tax\n  lda sid_io", "  tax\n  sta tune_clock\n  lda sid_io")
    .replace("\nvoice:\n", "\nvoice:\n  jsr select_tuning\n")
    .replace(/lda ftlo,y/g, "jsr tune_lo").replace(/lda fthi,y/g, "jsr tune_hi")
    .replace(/sbc ftlo,y/g, "jsr tune_sub_lo").replace(/sbc fthi,y/g, "jsr tune_sub_hi") + `
select_tuning:
  lda tune_clock
  bne tune_ntsc
${select("pal")}
  jmp tune_prepare_sub
tune_ntsc:
${select("ntsc")}
tune_prepare_sub:
  lda tune_lo+1
  sta tune_sub_lo+1
  lda tune_lo+2
  sta tune_sub_lo+2
  lda tune_hi+1
  sta tune_sub_hi+1
  lda tune_hi+2
  sta tune_sub_hi+2
  rts
tune_lo:
  lda $FFFF,y
  rts
tune_hi:
  lda $FFFF,y
  rts
tune_sub_lo:
  sbc $FFFF,y
  rts
tune_sub_hi:
  sbc $FFFF,y
  rts
tune_clock: .res 1
${banks.join("\n")}
`;
}

function buildPlayerAsm(arr: Arrangement, streams: StreamByte[][], loop: boolean, turboOnly: number, includeSamples = true): string {
  const L: string[] = [];
  const insts = arr.instruments;
  const hasRestart = arr.voices.some(({ events }) => events.some(({ bytes }) => bytes[0] === OP.RESTART));
  const hasLegato = arr.voices.some(({ events }) => events.some((event) => event.order === ORDER.note && event.bytes[0] === OP.LEGATO));
  const hasPortamento = arr.voices.some(({ events }) => events.some((event) => event.order === ORDER.note && event.bytes.length > 2));
  const hasRawWavePitch = insts.some((i) => i.wavetable?.some((step) => step.hz !== undefined));
  const hasWavetable = insts.some((i) => i.wavetable?.length);
  const hasPulseTable = insts.some((i) => i.pulsetable?.steps?.length);
  const hasFilterTable = insts.some((i) => i.filtertable?.steps?.length);
  const channels = arr.voices.length;
  const hasFade = insts.some((i) => i.vibFade);
  const voiceVars = [...VOICE_VARS.filter((name) => hasWavetable || !["wtpos", "wtleft", "wtnote"].includes(name)),
    ...(arr.streamCalls ? ["retlo", "rethi"] : []), ...(hasFade ? ["vfl", "vfh", "vfon"] : [])];
  const pulseCadence = insts.some((i) => i.pulsetable?.steps.some((step) => step.cadence));
  const filterCadence = insts.some((i) => i.filtertable?.steps.some((step) => step.cadence));
  const pulseReset = insts.some((i) => i.pulsetable?.reset === false);
  const filterReset = insts.some((i) => i.filtertable?.reset === false);
  const pulseVars = hasPulseTable ? ["ptpos", "ptleft", ...(pulseCadence ? ["ptclock"] : []), ...(pulseReset ? ["ptinst"] : [])] : [];
  const filterVars = hasFilterTable ? ["ftpos", "ftleft", "cutlo", "cuthi", "ftres", "fttype", "ftnewer", ...(filterCadence ? ["ftclock"] : []), ...(filterReset ? ["ftinst"] : [] )] : [];
  const stateBytes = channels * (voiceVars.length + pulseVars.length + filterVars.length) + GLOBAL_VARS.length + Number(hasFilterTable)
    + Number(hasFilterTable && !!arr.chips?.some((chip) => chip.owner !== undefined)) + (arr.chips?.some((chip) => chip.hasOffset) ? 4 : 0);
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
    playerCode += PULSE_TABLE_CODE + registerTableCode("pt", "pw", 1, 4094, pulseCadence);
  }
  if (hasFilterTable) {
    addNoteHook("ft_start");
    addReleaseHook("ft_stop");
    playerCode = playerCode.replace("globals:\n", "globals:\n  lda g_ftactive\n  beq gl_regular\n  jmp ft_globals\ngl_regular:\n");
    playerCode += FILTER_TABLE_CODE + registerTableCode("ft", "cut", 0, 2047, filterCadence);
  }
  if (pulseReset) {
    playerCode = playerCode.replace("pt_start:\n", `pt_start:
  ldy v_inst,x
  lda i_ptreset,y
  bne pt_reseed
  tya
  cmp v_ptinst,x
  bne pt_reseed
  rts
pt_reseed:
  tya
  sta v_ptinst,x
`).replace(/ {2}jsr pt_stop\n/g, "  jsr pt_maybe_stop\n");
    playerCode += `
pt_maybe_stop:
  ldy v_inst,x
  lda i_ptreset,y
  beq pt_keep
  jmp pt_stop
pt_keep:
  rts
`;
  }
  if (filterReset) {
    playerCode = playerCode.replace("  sta g_ftactive\n  ; Each voice", `  sta g_ftactive
  tya
  cmp v_ftinst,x
  bne ft_reseed
  lda i_ftreset,y
  bne ft_reseed
  rts
ft_reseed:
  tya
  sta v_ftinst,x
  ; Each voice`);
  }
  if (hasRawWavePitch) {
    playerCode = playerCode.replace("init_core:\n", "init_core:\n  sta wt_clock\n")
      .replace("  cmp #1\n  bne vr_abs_table_note", `  cmp #3
  bne vr_wt_integer
  lda wt_clock
  bne vr_wt_ntsc
  lda wt_raw_pal_lo,y
  sta f_lo
  lda wt_raw_pal_hi,y
  sta f_hi
  jmp vr_write
vr_wt_ntsc:
  lda wt_raw_ntsc_lo,y
  sta f_lo
  lda wt_raw_ntsc_hi,y
  sta f_hi
  jmp vr_write
vr_wt_integer:
  cmp #1
  bne vr_abs_table_note`);
    playerCode += "\nwt_clock: .byte 0\n";
  }
  if (hasWavetable) {
    // Stop the table on release so its gate bit cannot undo a rest or hard restart.
    for (const label of ["c_gateoff", "c_hr"]) {
      playerCode = playerCode.replace(`${label}:\n`, `${label}:\n  lda #0\n  sta v_wtleft,x\n`);
    }
    playerCode = playerCode.replace("  lda wt_ctrl,y\n", "  lda wt_ctrl,y\n  pha\n  lda v_wtleft,x\n  bne vr_wt_active\n  pla\n  and #$FE\n  jmp vr_wt_ctrl\nvr_wt_active:\n  pla\nvr_wt_ctrl:\n");
    playerCode = playerCode.replace("  dec v_wtleft,x\n", "  lda v_wtleft,x\n  beq va_return\n  dec v_wtleft,x\n");
  }
  if (hasRestart) {
    playerCode += customRestartCode(Boolean(hasWavetable), Boolean(hasPulseTable), Boolean(hasFilterTable));
    if (hasWavetable) {
      playerCode = playerCode.replace("  and #$FE\n  jmp vr_wt_ctrl", `  and #$F6
  sta t_lo
  lda v_ctrl,x
  and #8
  ora t_lo
  jmp vr_wt_ctrl`);
    }
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
    playerCode += arr.explicitEnd ? PLAY_ONCE_CODE.replace(/  lda #0\n  sta \$D404[\s\S]*?  sta \$D418\n/, "") : PLAY_ONCE_CODE;
  }
  if (arr.streamCalls) playerCode += `
c_call:
  jsr fetch
  sta tmp
  jsr fetch
  pha
  lda ptr
  sta v_retlo,x
  lda ptr+1
  sta v_rethi,x
  lda tmp
  sta ptr
  pla
  sta ptr+1
  jmp v_read
c_ret:
  lda v_retlo,x
  sta ptr
  lda v_rethi,x
  sta ptr+1
  jmp v_read
`;
  if (arr.chips?.some((chip) => chip.hasOffset)) playerCode += "\n"+`c_foff:
  jsr fetch
  sta g_so0
  jsr fetch
  sta g_so1
  jsr fetch
  sta g_so2
  jsr fetch
  sta g_sres
  jmp v_read
`;
  if (arr.chips) {
    playerCode = omitUnusedVoiceEffects(playerCode, insts, hasPortamento);
    if (hasFade) playerCode = addVibratoFade(playerCode);
    playerCode = multiplexSids(playerCode, arr.chips, Boolean(hasFilterTable), stateBytes);
    if (arr.mirrors) playerCode = addCenterMirrors(playerCode, arr);
    if (arr.softVolume) playerCode = gateBeforeEnvelope(addSoftVolume(playerCode, arr.chips.length, arr.speed, loop || !!arr.explicitEnd));
    if (arr.turbo) {
      playerCode = addTurboInit(playerCode, arr.speed, turboOnly, arr.softVolume);
      if (arr.softVolume) playerCode = measureTurboStartup(playerCode);
    }
    if (arr.tuning) playerCode = addTunedLookup(playerCode, arr.tuning);
    if (arr.samples) playerCode = addDigiPlayer(playerCode, arr.samples, arr.chips, [CLOCK_HZ.PAL, CLOCK_HZ.NTSC]);
  }
  if (loop && arr.clock?.loopFrame !== undefined) {
    playerCode = playerCode.replace("c_loop:\n  lda start_lo,x\n  sta ptr\n  lda start_hi,x", "c_loop:\n  lda loop_lo,x\n  sta ptr\n  lda loop_hi,x");
    const targets = streams.map((stream, i) => `(stream${i}+${stream.length === 1 ? 0 : arr.loopOffsets?.[i] ?? 0})`);
    L.push(`loop_lo: .byte ${targets.map((t) => "<" + t).join(",")}`);
    L.push(`loop_hi: .byte ${targets.map((t) => ">" + t).join(",")}`);
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
    if (arr.chips.some((chip) => chip.owner !== undefined)) {
      chipColumn("owner", (chip) => chip.owner ?? 255);
      chipColumn("route", (chip) => chip.route ?? 0);
    }
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
  if (hasLegato || hasPortamento || hasRestart || arr.samples) commands.push(hasLegato ? "c_legato" : "c_loop");
  if (hasPortamento || hasRestart || arr.samples) commands.push(hasPortamento ? "c_portamento" : "c_loop");
  if (hasRestart || arr.samples) commands.push(hasRestart ? "c_restart" : "c_loop");
  if (arr.samples) commands.push("c_sample");
  if (arr.chips?.some((chip) => chip.hasOffset) || arr.streamCalls) {
    while (commands.length < 11) commands.push("c_loop");
    commands.push(arr.chips?.some((chip) => chip.hasOffset) ? "c_foff" : "c_loop");
  }
  if (arr.streamCalls) commands.push("c_call", "c_ret");
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
  if (hasFade) {
    col("i_vfslo", insts.map((i) => (i.vibFade ?? 0) & 0xff));
    col("i_vfshi", insts.map((i) => (i.vibFade ?? 0) >> 8));
  }
  col("i_arpst", arpStart);
  col("i_arplen", insts.map((i) => i.arp.length));
  col("i_arpspd", insts.map((i) => Math.max(1, i.arpSpeed)));
  col("i_slsemi", insts.map((i) => i.slideSemis & 0xff));
  col("i_slspd", insts.map((i) => i.slideSpeed));
  col("i_slreclo", insts.map((i) => i.slideRecip & 0xff));
  col("i_slrechi", insts.map((i) => i.slideRecip >> 8));
  col("i_filt", insts.map((i) => i.filter));
  const wt: Array<{ ctrl: number; note: number; mode: number; frames: number; hz?: number }> = [];
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
      wt.push({ ctrl, note, mode: s.hz === undefined ? mode : 3, frames: Number(s.frames ?? 1), hz: s.hz });
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
    if (hasRawWavePitch) for (const system of ["PAL", "NTSC"] as const) {
      const freq = wt.map(({ hz }) => hz === undefined ? 0 : hzToSidFrequency(hz, system));
      col(`wt_raw_${system.toLowerCase()}_lo`, freq.map((v) => v & 255));
      col(`wt_raw_${system.toLowerCase()}_hi`, freq.map((v) => v >> 8));
    }
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
    if (prefix === "pt" ? pulseCadence : filterCadence) col(`${prefix}_cadence`, steps.map((step) => step.cadence ?? 1));
    if (prefix === "pt" ? pulseReset : filterReset) col(`i_${prefix}reset`, tables.map((table) => Number(table?.reset !== false)));
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
    if (arr.chips?.some((chip) => chip.owner !== undefined)) L.push("g_fthold: .res 1");
  }
  if (arr.chips?.some((chip) => chip.hasOffset)) for (const name of ["g_so0", "g_so1", "g_so2", "g_sres"]) L.push(`${name}: .res 1`);
  L.push(`vars_end:`);

  streams.forEach((s, i) => pushByteRows(L, `stream${i}`, s.map((b) => typeof b === "string" ? b : `$${hex2(b)}`)));
  if (arr.samples) L.push(includeSamples ? digiDataAsm(arr.samples) :
    [...arr.samples.defs.keys()].map((_, i) => `digi_data${i}:`).join("\n"));
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
function registerTableCode(prefix: "pt" | "ft", value: "pw" | "cut", min: number, max: number, cadence = false): string {
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
${cadence ? `  lda ${prefix}_cadence,y
  sta v_${prefix}clock,x
` : ""}  jmp ${prefix}_step
${prefix}_current:
${cadence ? `  dec v_${prefix}clock,x
  beq ${prefix}_advance
  rts
${prefix}_advance:
` : ""}  ldy v_inst,x
  lda i_${prefix}st,y
  clc
  adc v_${prefix}pos,x
  tay
${cadence ? `  lda ${prefix}_cadence,y
  sta v_${prefix}clock,x
` : ""}${prefix}_step:
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
