/*
C64 Bridge - SIDWAVE to PRG Compiler
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { Buffer } from "node:buffer";
import { assemblyToPrgDetailed } from "./tools/translation/assembler.js";
import type { ParsedSidwave, SystemMode, SidwaveVoice, SidwavePattern, MotifEntry } from "./sidwave.js";
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
  /** Frames in one pass of the song; the player loops after this many play calls. */
  totalFrames: number;
  framesPerSecond: number;
  instrumentCount: number;
  /** Per-voice command stream sizes in bytes. */
  streamBytes: [number, number, number];
  /** Bytes of BASIC memory left after the standalone PRG returns to BASIC (program and variables live behind the player). */
  basicFreeBytes: number;
  /** Conditions the caller should pass on, such as a PRG that leaves no BASIC memory. */
  warnings: string[];
}

/**
 * Compiles SIDWAVE to a C64 program with a frame-based player.
 *
 * The compiler arranges the timeline into per-voice note events with frame-exact onsets
 * (no tempo drift), then encodes them as compact command streams. The 6502 player reads the
 * streams once per frame and runs the per-note modulation itself: hard restart, fast arpeggio,
 * pitch slide, vibrato, pulse-width sweep, and a global filter with sweep and per-pattern ramp.
 */
export function compileSidwaveToPrg(doc: ParsedSidwave): CompileResult {
  const arrangement = arrangeSidwave(doc);
  const streams = arrangement.voices.map((v) => encodeVoiceStream(v.events, arrangement.totalFrames));
  // Check the size before assembling the streams: the player and its tables are assembled once with
  // empty streams, which gives the exact start of the stream data. Songs larger than 64 KB would
  // otherwise wrap the address counter inside the assembler.
  const layout = assemblyToPrgDetailed(buildPlayerAsm(arrangement, [[OP.LOOP], [OP.LOOP], [OP.LOOP]]), {
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
  const asm = buildPlayerAsm(arrangement, streams);
  const assembled = assemblyToPrgDetailed(asm, { fileName: "sidwave_player.asm", loadAddress: SIDWAVE_LOAD_ADDRESS });
  const prg = assembled.prg;
  const endAddress = SIDWAVE_LOAD_ADDRESS + prg.length - 2;
  for (const [label, expected] of [["install", SIDWAVE_PRG_ENTRY], ["init_vec", SIDWAVE_INIT_ADDRESS], ["play_vec", SIDWAVE_PLAY_ADDRESS], ["prg_end", endAddress]] as const) {
    if (assembled.symbols.get(label) !== expected) throw new Error(`SIDWAVE player layout error: ${label} is not at $${expected.toString(16)}`);
  }
  // After the PRG's SYS returns, BASIC's program and variables start right behind the player.
  const basicFreeBytes = Math.max(0, SIDWAVE_BASIC_END - (endAddress + 3));
  const warnings: string[] = [];
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
    streamBytes: streams.map((s) => s.length) as [number, number, number],
    basicFreeBytes,
    warnings,
  };
}

/**
 * Wraps the compiled PRG in a PSID v2 file. Init and play are the player's fixed entry points;
 * the clock flag follows the document's mode so the host calls play at 50 Hz (PAL) or 60 Hz (NTSC).
 * `entryAddress` is accepted for compatibility and ignored.
 */
export function compileSidwaveToSid(
  doc: ParsedSidwave,
  prg: Buffer,
  options?: { entryAddress?: number; initAddress?: number; playAddress?: number },
): { sid: Buffer } {
  const headerSize = 0x7c;
  const header = Buffer.alloc(headerSize, 0);
  header.write("PSID", 0, "ascii");
  header.writeUInt16BE(2, 4); // version
  header.writeUInt16BE(headerSize, 6); // data offset
  header.writeUInt16BE(0, 8); // load address taken from the first two data bytes
  header.writeUInt16BE(options?.initAddress ?? SIDWAVE_INIT_ADDRESS, 10);
  header.writeUInt16BE(options?.playAddress ?? SIDWAVE_PLAY_ADDRESS, 12);
  header.writeUInt16BE(1, 14); // songs
  header.writeUInt16BE(1, 16); // start song
  header.writeUInt32BE(0, 18); // speed: vertical blank timing for song 1
  writeLatin1(header, doc.song.title ?? "Untitled", 0x16);
  writeLatin1(header, doc.song.author ?? "SIDWAVE", 0x36);
  writeLatin1(header, "c64bridge SIDWAVE", 0x56);
  const clockBits = doc.song.mode === "NTSC" ? 0b10 : 0b01;
  header.writeUInt16BE(clockBits << 2, 0x76); // flags: built-in player, C64 compatible, clock, SID model unspecified
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
}

export interface ArrangedNote {
  start: number;
  end: number;
  midi: number;
  inst: number;
  /** Fade window applied to this note's sustain level, if any. */
  fade?: { start: number; end: number };
}

type GlobalEvent =
  | { frame: number; kind: "filtermod"; step: number; count: number }
  | { frame: number; kind: "volume"; value: number };

export interface Arrangement {
  fps: number;
  framesPerBeat: number;
  totalFrames: number;
  system: SystemMode;
  instruments: Instrument[];
  voices: Array<{ notes: ArrangedNote[]; events: StreamEvent[] }>;
  filter: { base: number; sweep: number; stepFixed: number; resonance: number; mode: number; used: boolean };
}

export interface StreamEvent {
  frame: number;
  order: number;
  bytes: number[];
}

const BEAT_EPS = 1e-9;

export function arrangeSidwave(doc: ParsedSidwave): Arrangement {
  const system: SystemMode = doc.song.mode ?? "PAL";
  const fps = sidwaveFrameRate(system);
  const framesPerBeat = (fps * 60) / doc.song.tempo;
  const frameAt = (beat: number) => Math.round(beat * framesPerBeat + BEAT_EPS);
  const maxMidi = maxSidwaveMidi(system);
  const totalBars = doc.song.length_bars;
  const totalFrames = frameAt(totalBars * 4);

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

  const gfx = doc.song.global_fx as Record<string, any>;
  const fenv = gfx.filter_env as Record<string, any> | undefined;
  const filterVoices = new Set<number>(fenv ? (fenv.voices ?? [1, 2, 3]).map(Number) : []);
  let filterUsed = !!fenv;

  const voicesById = new Map<number, SidwaveVoice>(doc.voices.map((v) => [v.id, v]));
  const notes: ArrangedNote[][] = [[], [], []];
  const globals: GlobalEvent[] = [];
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
      const patPath = `${secPath}.layers.v${id} (${parsed.pattern})`;
      active.push(id);
      if (parsed.fade) {
        fading.push(id);
        fadeWindows[id - 1]!.push({ start: sf, end: ef });
      }
      const fxRaw = (pattern.fx ?? {}) as Record<string, any>;
      const filterMod = fxRaw.filter_mod ? parseFilterMod(fxRaw.filter_mod, `${patPath}.fx.filter_mod`) : undefined;
      if (filterMod) filterUsed = true;
      const routed = filterVoices.has(id) || !!filterMod ? 1 : 0;
      const entries = patternEntries(pattern, patPath);
      const lengthBeats = pattern.length ?? 1;
      const transpositions = pattern.transpositions ?? [0];
      const cycleBeats = entries.length * lengthBeats;
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
        for (let k = 0; k < entries.length; k += 1) {
          const b = cycleStart + k * lengthBeats;
          if (b >= sec.endBeat - BEAT_EPS) break;
          const truncated = b + lengthBeats > sec.endBeat + BEAT_EPS;
          const f0 = frameAt(b);
          const f1 = frameAt(Math.min(b + lengthBeats, sec.endBeat));
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
              `each entry lasts ${(lengthBeats * framesPerBeat).toFixed(2)} frames at ${doc.song.tempo} BPM; the player needs at least ${SIDWAVE_MIN_NOTE_FRAMES} frames per note (one sounding frame plus the ${SIDWAVE_HARD_RESTART_FRAMES}-frame hard restart); raise 'length' or lower the tempo`,
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
          const inst = buildInstrument(voice, fxRaw, entry.arp ? offsets : [], entry.arp ? entry.arpSpeed : 0, routed, fps);
          out.push({ start: f0, end: f1, midi: base, inst: instIndex(inst) });
        }
      }
      if (filterMod) globals.push({ frame: ef, kind: "filtermod", step: 0, count: 0 });
    }

    // Master volume fade when every sounding voice of the section fades.
    if (fading.length > 0 && fading.length === active.length) {
      for (let beat = sec.startBeat; beat < sec.endBeat - BEAT_EPS; beat += 1) {
        const f = frameAt(beat);
        globals.push({ frame: f, kind: "volume", value: Math.round(15 * (1 - (f - sf) / (ef - sf))) });
      }
      globals.push({ frame: ef, kind: "volume", value: 15 });
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
        notes[tgt - 1]!.push({ start, end, midi: n.midi, inst: instIndex(echo) });
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
  | { kind: "note"; notes: number[]; arp: false; arpSpeed: 0 }
  | { kind: "note"; notes: number[]; arp: true; arpSpeed: number };

function patternEntries(pattern: SidwavePattern, path: string): PatternEntry[] {
  const p = pattern as any;
  if (p.type === "arpeggio" || Array.isArray(p.notes)) {
    const midis = (p.notes as string[]).map((n) => noteNameToMidi(n)!);
    if (p.frame_rate !== undefined) return [{ kind: "note", notes: midis, arp: true, arpSpeed: Number(p.frame_rate) }];
    return midis.map((m) => ({ kind: "note", notes: [m], arp: false, arpSpeed: 0 }));
  }
  if (Array.isArray(p.groove)) {
    return (p.groove as unknown[]).map((raw) => {
      const tok = String(raw).trim();
      if (isRestToken(tok)) return { kind: "rest" };
      if (isTieToken(tok)) return { kind: "tie" };
      return { kind: "note", notes: [noteNameToMidi(tok)!], arp: false, arpSpeed: 0 };
    });
  }
  const entries: MotifEntry[] = parseMotif(String(p.motif), p.root === undefined ? "C3" : String(p.root), `${path}.motif`);
  return entries.map((e) => (e === null ? { kind: "rest" } : e === "~" ? { kind: "tie" } : { kind: "note", notes: [e], arp: false, arpSpeed: 0 }));
}

function buildInstrument(voice: SidwaveVoice, fx: Record<string, any>, arp: number[], arpSpeed: number, filter: number, fps: number): Instrument {
  const adsr = voice.adsr ?? [2, 2, 10, 3];
  const wave = waveformToCtrl(voice.waveform ?? "pulse");
  const pw = voice.pulse_width ?? 0x800;
  let pwStep = 0;
  let pwMin = pw;
  let pwMax = pw;
  if (fx.pwm_sweep && wave === 0x40) {
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
    wave,
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
  };
}

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
} as const;

const ORDER = { gate: 0, filterReset: 1, inst: 2, note: 3, sustain: 4, filterStart: 5, volume: 6 } as const;

function buildVoiceEvents(notes: ArrangedNote[], instruments: Instrument[], total: number, framesPerBeat: number, globals: GlobalEvent[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  const wrap = (f: number) => (f >= total ? f - total : f);
  let currentInst = -1;
  for (let i = 0; i < notes.length; i += 1) {
    const n = notes[i]!;
    const next = i + 1 < notes.length ? notes[i + 1]!.start : notes[0]!.start + total;
    const hr = Math.max(n.start + 1, next - SIDWAVE_HARD_RESTART_FRAMES);
    const gateOff = Math.min(n.end, hr);
    if (gateOff < hr) events.push({ frame: wrap(gateOff), order: ORDER.gate, bytes: [OP.GATEOFF] });
    events.push({ frame: wrap(hr), order: ORDER.gate, bytes: [OP.HARDRESTART] });
    if (n.inst !== currentInst) {
      events.push({ frame: n.start, order: ORDER.inst, bytes: [OP.INST + n.inst] });
      currentInst = n.inst;
    }
    events.push({ frame: n.start, order: ORDER.note, bytes: [OP.NOTE + (n.midi - 12)] });
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

function buildPlayerAsm(arr: Arrangement, streams: number[][]): string {
  const L: string[] = [];
  const insts = arr.instruments;
  const clockIndex = arr.system === "NTSC" ? 1 : 0;
  // The PRG's CIA timer reproduces the song's video frame rate on whichever clock the machine has.
  const ciaLatch = (clock: number) => Math.round(clock / arr.fps) - 1;
  const f = arr.filter;
  const fBase = Math.max(0, Math.min(2047, f.base)) * 32;
  const fEnd = Math.max(0, Math.min(2047, f.base + f.sweep)) * 32;
  const fMin = Math.min(fBase, fEnd);
  const fMax = Math.max(fBase, fEnd);
  const fDir = f.sweep < 0 ? 1 : 0;

  L.push(`ptr = $FB`);
  L.push(`* = $0801`);
  L.push(`  .byte $0B,$08,$0A,$00,$9E,$32,$30,$36,$31,$00,$00,$00 ; 10 SYS2061`);
  L.push(`install:`);
  L.push(`  jmp do_install`);
  L.push(`init_vec:`);
  L.push(`  jmp init`);
  L.push(`play_vec:`);
  L.push(`  jmp play`);
  L.push(PLAYER_CODE);
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
  L.push(`voff: .byte 0, 7, 14`);
  L.push(`vbit: .byte 1, 2, 4`);
  L.push(`start_lo: .byte <stream0, <stream1, <stream2`);
  L.push(`start_hi: .byte >stream0, >stream1, >stream2`);
  L.push(`cmd_tab:`);
  for (const name of ["c_gateoff", "c_hr", "c_sr", "c_vol", "c_waitl", "c_fmod", "c_loop"]) L.push(`  .byte <(${name}-1), >(${name}-1)`);

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
  col("arptab", arpTable.length ? arpTable.map((v) => v & 0xff) : [0]);

  // Quarter-square table for the 8x8 multiply: sq(x) = floor(x * x / 4), x = 0..511.
  const squares = Array.from({ length: 512 }, (_, x) => Math.floor((x * x) / 4));
  col("sq_lo", squares.map((v) => v & 0xff));
  col("sq_hi", squares.map((v) => (v >> 8) & 0xff));

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
  for (const name of VOICE_VARS) L.push(`v_${name}: .res 3`);
  for (const name of GLOBAL_VARS) L.push(`${name}: .res 1`);
  L.push(`vars_end:`);

  streams.forEach((s, i) => pushByteRows(L, `stream${i}`, s.map((b) => `$${hex2(b)}`)));
  L.push(`prg_end:`);
  return L.join("\n");
}

const VOICE_VARS = [
  "ptrlo", "ptrhi", "wait", "note", "inst", "ctrl", "ad", "sr", "pwlo", "pwhi", "pwdir", "arppos", "arpcnt",
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

function pushByteRows(out: string[], label: string, items: string[], perLine = 16): void {
  out.push(`${label}:`);
  for (let i = 0; i < items.length; i += perLine) {
    out.push(`  .byte ${items.slice(i, i + perLine).join(",")}`);
  }
}

function hex2(n: number): string {
  return (n & 0xff).toString(16).toUpperCase().padStart(2, "0");
}
