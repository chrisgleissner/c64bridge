/*
C64 Bridge - SIDWAVE to PRG Compiler
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { Buffer } from "node:buffer";
import { assemblyToPrg } from "./tools/translation/assembler.js";
import type { ParsedSidwave, SystemMode, SidwaveVoice } from "./sidwave.js";
import { midiToHz, noteNameToMidi } from "./sidwave.js";

export interface CompileResult {
  prg: Buffer;
  /**
   * Entry address used for both init and play (single-entry player).
   * The routine detects first-call initialisation and subsequent play calls.
   */
  entryAddress: number;
}

/**
 * Small SIDWAVE to PRG compiler: generates a 50/60Hz player that writes SID registers from a precomputed frame table.
 * It currently supports three voices with per-frame frequency, waveform, pulse width, and ADSR gate on/off.
 * Effects are not fully implemented; basic PWM sweep from pulse_width and simple transpositions are handled.
 */
export function compileSidwaveToPrg(doc: ParsedSidwave): CompileResult {
  const system: SystemMode = (doc.song.mode ?? "PAL");
  const fps = system === "PAL" ? 50 : 60;

  // Estimate total frames by bars at 4/4 with quarter note = 1 beat = 1/ (tempo/60) seconds.
  const beatsPerBar = 4;
  const secondsPerBeat = 60 / (doc.song.tempo ?? 100);
  const framesPerBeat = Math.max(1, Math.round(secondsPerBeat * fps));
  const totalBeats = (doc.song.length_bars ?? 16) * beatsPerBar;
  const totalFrames = Math.max(framesPerBeat * totalBeats, fps * 15); // ensure at least ~15s of content
  const cappedFrames = Math.min(totalFrames, 255); // v1 player index Y wraps at 255

  // Build per-voice frame data arrays.
  const voices: SidwaveVoice[] = [1, 2, 3].map((id) =>
    (doc.voices.find((v) => v.id === id) as SidwaveVoice | undefined) ?? ({ id, name: `Voice${id}`, waveform: "triangle", adsr: [2, 2, 10, 3], pulse_width: 2048, patterns: {} } as SidwaveVoice),
  );

  const freqFrames: Array<Uint16Array> = [new Uint16Array(cappedFrames), new Uint16Array(cappedFrames), new Uint16Array(cappedFrames)];
  const ctrlFrames: Array<Uint8Array> = [new Uint8Array(cappedFrames), new Uint8Array(cappedFrames), new Uint8Array(cappedFrames)];
  const pwFrames: Array<Uint16Array> = [new Uint16Array(cappedFrames), new Uint16Array(cappedFrames), new Uint16Array(cappedFrames)];
  const adFrames: Array<Uint8Array> = [new Uint8Array(cappedFrames), new Uint8Array(cappedFrames), new Uint8Array(cappedFrames)];
  const srFrames: Array<Uint8Array> = [new Uint8Array(cappedFrames), new Uint8Array(cappedFrames), new Uint8Array(cappedFrames)];

  // Build frames from timeline/patterns where possible
  const framesForVoice: Array<string[]> = [[], [], []];
  // Precompute frames-per-bar
  const framesPerBar = framesPerBeat * beatsPerBar;

  for (let vi = 0; vi < 3; vi += 1) {
    const v = voices[vi]!;
    const adsr = v.adsr ?? [2, 2, 10, 3];
    const ad = ((adsr[0] & 0xf) << 4) | (adsr[1] & 0xf);
    const sr = ((adsr[2] & 0xf) << 4) | (adsr[3] & 0xf);
    adFrames[vi]!.fill(ad);
    srFrames[vi]!.fill(sr);
    const waveformCtrl = waveformToCtrl((v.waveform as any) ?? "pulse");
    const basePw = Math.max(0, Math.min(0x0fff, Math.floor((v.pulse_width as any) ?? 0x0800)));

    // Collect a note per frame using timeline mapping (fallback to simple arp)
    const notesForSong: string[] = [];
    const patterns = (v.patterns ?? {}) as Record<string, any>;
    const voiceKeyCandidates = [
      `v${v.id}`,
      `voice${v.id}`,
      `${v.id}`,
    ];
    for (const section of doc.timeline ?? []) {
      // Pick the first matching layer key that maps to this voice
      let patternName: string | undefined;
      for (const key of voiceKeyCandidates) {
        if (section.layers && section.layers[key]) {
          patternName = String(section.layers[key]);
          break;
        }
      }
      const bars = Math.max(1, Math.floor(section.bars ?? 1));
      const totalFramesInSection = bars * framesPerBar;
      const pat = (patternName ? patterns[patternName] : undefined) as any;
      if (!pat) {
        // Fill section with sustained default note
        for (let i = 0; i < totalFramesInSection; i += 1) notesForSong.push("C3");
        continue;
      }
      if (pat.type === "arpeggio" && Array.isArray(pat.notes) && pat.notes.length) {
        const stepFrames = Math.max(1, Math.round((pat.frame_rate ? fps / pat.frame_rate : framesPerBeat)));
        let idx = 0;
        for (let f = 0; f < totalFramesInSection; f += 1) {
          if (f % stepFrames === 0) idx = (idx + 1) % pat.notes.length;
          notesForSong.push(String(pat.notes[idx]));
        }
      } else if (Array.isArray(pat.groove) && pat.groove.length) {
        const stepFrames = framesPerBeat; // one note per beat
        let gi = 0;
        for (let f = 0; f < totalFramesInSection; f += 1) {
          if (f % stepFrames === 0) gi = (gi + 1) % pat.groove.length;
          notesForSong.push(String(pat.groove[gi]));
        }
      } else if (typeof pat.motif === "string" && pat.motif.trim().length > 0) {
        const intervals = pat.motif
          .split(/[\s,]+/)
          .map((x: string) => Number.parseInt(x, 10))
          .filter((n: number) => Number.isFinite(n));
        const lengthBeats = Math.max(1, Math.floor(pat.length ?? 1));
        const stepFrames = framesPerBeat * lengthBeats;
        const baseNote = "C3";
        let mi = 0;
        for (let f = 0; f < totalFramesInSection; f += 1) {
          if (f % stepFrames === 0) mi = (mi + 1) % Math.max(1, intervals.length);
          const iv = intervals.length ? intervals[mi] : 0;
          notesForSong.push(transposeNote(baseNote, iv));
        }
      } else {
        // Unknown pattern shape; fill with default sustained
        for (let i = 0; i < totalFramesInSection; i += 1) notesForSong.push("C3");
      }
    }

    // Ensure we have at least cappedFrames entries
    if (notesForSong.length < cappedFrames) {
      const fallback = inferNotesForVoice(v) ?? ["C3", "E3", "G3", "B2"];
      let i = 0;
      while (notesForSong.length < cappedFrames) {
        notesForSong.push(fallback[i % fallback.length]!);
        i += 1;
      }
    }

    const fx = inferVoiceFx(v);
    const vibDepthSemis = fx.vibrato?.depth ?? 0;
    const vibRateHz = fx.vibrato?.rate ?? 0;
    const pwmDepth = fx.pwm_sweep?.depth ?? 0;
    const pwmSpeed = fx.pwm_sweep?.speed ?? 0;

    for (let f = 0; f < cappedFrames; f += 1) {
      const note = notesForSong[f] ?? notesForSong[notesForSong.length - 1] ?? "C3";
      const midi = noteNameToMidi(note) ?? 48;
      const vib = vibDepthSemis > 0 && vibRateHz > 0 ? vibDepthSemis * Math.sin((2 * Math.PI * vibRateHz * f) / fps) : 0;
      const midiWithVib = midi + vib;
      const hz = midiToHz(midiWithVib);
      const sidFreq = hzToSidFrequency(hz, system);
      freqFrames[vi]![f] = sidFreq;
      ctrlFrames[vi]![f] = waveformCtrl | 0x01; // GATE on
      const baseSweep = pwmDepth > 0 && pwmSpeed > 0 ? pwmDepth * Math.sin((2 * Math.PI * pwmSpeed * f) / fps) : 0;
      const lfo = (String(v.waveform).toLowerCase().startsWith("pulse")) ? baseSweep : 0;
      const pw = (String(v.waveform).toLowerCase().startsWith("pulse") ? Math.max(0, Math.min(0x0fff, Math.floor(basePw + lfo))) : basePw) & 0x0fff;
      pwFrames[vi]![f] = pw;
    }
  }

  const entryAddress = 0x0810;
  const asm = buildPlayerAsm({ system, totalFrames: cappedFrames, freqFrames, ctrlFrames, pwFrames, adFrames, srFrames, entryAddress });
  const prg = assemblyToPrg(asm, { fileName: "sidwave_player.asm", loadAddress: 0x0801 });
  return { prg, entryAddress };
}

/**
 * Build a minimal PSID v2 header and embed the PRG body, so clients can POST via sidplay attachment.
 * The PRG must contain a 2-byte load address followed by code. We keep loadAddress=0 (derive from data), init/play=$0810.
 */
export function compileSidwaveToSid(doc: ParsedSidwave, prg: Buffer, options?: { entryAddress?: number }): { sid: Buffer } {
  const headerSize = 124; // PSID v2 header size
  const header = Buffer.alloc(headerSize, 0);
  header.write("PSID", 0, "ascii");
  header.writeUInt16BE(2, 4); // version
  header.writeUInt16BE(headerSize, 6); // data offset
  header.writeUInt16BE(0, 8); // load address (0 => take from data)
  const entry = options?.entryAddress ?? 0x0810;
  header.writeUInt16BE(entry, 10); // init
  header.writeUInt16BE(entry, 12); // play (single entry; routine self-dispatches)
  header.writeUInt16BE(1, 14); // songs
  header.writeUInt16BE(1, 16); // start song
  header.writeUInt32BE(0, 18); // speed
  // strings (32 bytes each)
  const title = (doc.song.title ?? "Untitled").slice(0, 31);
  header.write(title, 22, "ascii");
  header.write("SIDWAVE", 54, "ascii");
  header.write("MCP", 86, "ascii");
  // data is PRG body; if it already has a 2-byte load address, keep it so loaders can use it
  const body = Buffer.isBuffer(prg) ? prg : Buffer.from(prg);
  return { sid: Buffer.concat([header, body]) };
}

export function hzToSidFrequency(hz: number, system: SystemMode): number {
  const phi2 = system === "PAL" ? 985_248 : 1_022_727;
  const value = Math.round((hz * 16_777_216) / phi2);
  return Math.max(0, Math.min(0xffff, value));
}

function waveformToCtrl(w: string): number {
  const wf = (w || "pulse").toLowerCase();
  if (wf.startsWith("tri")) return 1 << 4;
  if (wf.startsWith("saw")) return 1 << 5;
  if (wf.startsWith("pulse")) return 1 << 6;
  if (wf.startsWith("noise")) return 1 << 7;
  return 1 << 6;
}

function inferNotesForVoice(v: SidwaveVoice): string[] | undefined {
  const pnames = Object.keys(v.patterns ?? {});
  for (const name of pnames) {
    const p: any = (v.patterns as any)[name];
    if (!p) continue;
    if (Array.isArray(p.notes)) return p.notes as string[];
    if (Array.isArray(p.groove)) return p.groove as string[];
  }
  return undefined;
}

function inferVoiceFx(v: SidwaveVoice): {
  vibrato?: { depth?: number; rate?: number };
  slide?: { depth?: number; speed?: number };
  pwm_sweep?: { depth?: number; speed?: number };
} {
  const patterns = v.patterns ?? {} as Record<string, any>;
  const first = Object.values(patterns)[0] as any;
  const fx = (first && typeof first === "object" && first.fx) ? first.fx : {};
  return {
    vibrato: fx?.vibrato,
    slide: fx?.slide,
    pwm_sweep: fx?.pwm_sweep,
  };
}

function buildPlayerAsm(args: {
  system: SystemMode;
  totalFrames: number;
  freqFrames: Array<Uint16Array>;
  ctrlFrames: Array<Uint8Array>;
  pwFrames: Array<Uint16Array>;
  adFrames: Array<Uint8Array>;
  srFrames: Array<Uint8Array>;
  entryAddress: number;
}): string {
  const L: string[] = [];
  const entryHex = hex16(args.entryAddress);
  L.push(`* = $${entryHex}`);
  L.push("; --- PSID single-entry init/play routine ---");
  L.push("entry:");
  L.push("  LDA inited");
  L.push("  BNE do_play");
  L.push("  JSR init");
  L.push("  RTS");
  L.push("do_play:");
  L.push("  JSR play_frame");
  L.push("  RTS");
  L.push("");
  L.push("init:");
  L.push("  LDA #$0F");
  L.push("  STA $D418");
  L.push("  LDA #$00");
  L.push("  STA frame_idx");
  L.push("  LDA #$01");
  L.push("  STA inited");
  L.push("  RTS");
  L.push("");
  L.push("play_frame:");
  L.push("  LDY frame_idx");
  for (let v = 0; v < 3; v += 1) {
    const base = 0xd400 + v * 7;
    L.push(`  ; voice ${v + 1}`);
    L.push(`  LDA v${v + 1}_freq_lo,Y`);
    L.push(`  STA $${hex16(base)}`);
    L.push(`  LDA v${v + 1}_freq_hi,Y`);
    L.push(`  STA $${hex16(base + 1)}`);
    L.push(`  LDA v${v + 1}_pw_lo,Y`);
    L.push(`  STA $${hex16(base + 2)}`);
    L.push(`  LDA v${v + 1}_pw_hi,Y`);
    L.push(`  STA $${hex16(base + 3)}`);
    L.push(`  LDA v${v + 1}_ctrl,Y`);
    L.push(`  STA $${hex16(base + 4)}`);
    L.push(`  LDA v${v + 1}_ad,Y`);
    L.push(`  STA $${hex16(base + 5)}`);
    L.push(`  LDA v${v + 1}_sr,Y`);
    L.push(`  STA $${hex16(base + 6)}`);
  }
  L.push("  INY");
  L.push(`  CPY #$${hex2(args.totalFrames & 0xff)}`);
  L.push("  BCC store_idx");
  L.push("  LDY #$00");
  L.push("store_idx:");
  L.push("  STY frame_idx");
  L.push("  RTS");
  L.push("");
  L.push("; --- Zero page state ---");
  L.push("frame_idx = $FB");
  L.push("inited    = $FC");
  L.push("");
  // Data tables
  for (let v = 0; v < 3; v += 1) {
    const fLo: string[] = [];
    const fHi: string[] = [];
    const pwLo: string[] = [];
    const pwHi: string[] = [];
    const ctrl: string[] = [];
    const ad: string[] = [];
    const sr: string[] = [];
    for (let i = 0; i < args.totalFrames; i += 1) {
      const f = args.freqFrames[v]![i]!;
      fLo.push(`$${hex2(f & 0xff)}`);
      fHi.push(`$${hex2((f >> 8) & 0xff)}`);
      const pw = args.pwFrames[v]![i]!;
      pwLo.push(`$${hex2(pw & 0xff)}`);
      pwHi.push(`$${hex2((pw >> 8) & 0x0f)}`);
      ctrl.push(`$${hex2(args.ctrlFrames[v]![i]!)}`);
      ad.push(`$${hex2(args.adFrames[v]![i]!)}`);
      sr.push(`$${hex2(args.srFrames[v]![i]!)}`);
    }
    pushByteRows(L, `v${v + 1}_freq_lo`, fLo);
    pushByteRows(L, `v${v + 1}_freq_hi`, fHi);
    pushByteRows(L, `v${v + 1}_pw_lo`, pwLo);
    pushByteRows(L, `v${v + 1}_pw_hi`, pwHi);
    pushByteRows(L, `v${v + 1}_ctrl`, ctrl);
    pushByteRows(L, `v${v + 1}_ad`, ad);
    pushByteRows(L, `v${v + 1}_sr`, sr);
  }
  return L.join("\n");
}

function pushByteRows(out: string[], label: string, items: string[], perLine = 16): void {
  out.push("");
  out.push(`${label}:`);
  for (let i = 0; i < items.length; i += perLine) {
    const row = items.slice(i, i + perLine).join(",");
    out.push(`  .byte ${row}`);
  }
}

function hex2(n: number): string {
  return (n & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

function hex16(n: number): string {
  return (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

function transposeNote(note: string, semitones: number): string {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec((note || "").trim());
  if (!m) return note;
  const letter = m[1]!.toUpperCase();
  const accidental = m[2]!;
  const octave = Number(m[3]);
  const map: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let semi = map[letter] ?? 0;
  if (accidental === "#") semi += 1;
  if (accidental === "b") semi -= 1;
  let midi = (octave + 1) * 12 + semi + semitones;
  const letters = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const newOct = Math.floor(midi / 12) - 1;
  const name = letters[((midi % 12) + 12) % 12];
  return `${name}${newOct}`;
}
