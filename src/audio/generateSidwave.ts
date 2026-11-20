import { midiToNoteName, noteNameToMidi, type SidwaveDocument, type SidwaveGrooveNote, type SystemMode } from "../sidwave.js";
import { maxSidwaveMidi, sidwaveFrameRate } from "../sidwaveCompiler.js";

export const MUSIC_STYLES = {
  chiptune: { tempo: 130, speed: 2, bass: "lib:filter_bass", drumLine: "kB.hO.sB.hOkBhs." },
  ambient: { tempo: 80, speed: 1, bass: "lib:filter_bass", drumLine: "B..h..O...sB..k." },
  funk: { tempo: 105, speed: 2, bass: "lib:bass_pluck", drumLine: "kB.Oh.Bs.Bh.OkB." },
} as const;

export const DEFAULT_MUSIC_SEED = 65;
export type MusicStyle = keyof typeof MUSIC_STYLES;

interface GenerateOptions {
  root: string;
  intervals?: number[];
  steps?: number;
  tempoMs?: number;
  waveform?: "pulse" | "saw" | "tri" | "noise";
  preset: "classic" | "expression";
  style: MusicStyle;
  seed: number;
  system: SystemMode;
}

type Entry = string | SidwaveGrooveNote;
type Chord = { degree: number; name: string; minor: boolean };
const HARMONIES = [
  { mode: "minor", scale: [0, 2, 3, 5, 7, 8, 10], chords: [{ degree: 0, name: "i", minor: true }, { degree: 5, name: "VI", minor: false }, { degree: 2, name: "III", minor: false }, { degree: 6, name: "VII", minor: false }] },
  { mode: "major", scale: [0, 2, 4, 5, 7, 9, 11], chords: [{ degree: 0, name: "I", minor: false }, { degree: 4, name: "V", minor: false }, { degree: 5, name: "vi", minor: true }, { degree: 3, name: "IV", minor: false }] },
] as const;
const DRUMS: Record<string, string> = { k: "lib:kick", h: "lib:hat", s: "lib:snare" };
const EXPRESSION_MS = [250, 180, 180, 400];

// Mulberry32. Keep all arithmetic in the same 32-bit sequence on Bun and Node.
function randomSource(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let x = Math.imul(seed ^ (seed >>> 15), seed | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 0x100000000;
  };
}

const pitchClass = (midi: number) => ((midi % 12) + 12) % 12;

export function generateSidwave(options: GenerateOptions) {
  const { style, system, seed, preset } = options;
  const { tempo, bass, drumLine } = MUSIC_STYLES[style];
  const random = randomSource(seed);
  const harmony = HARMONIES[random() < 0.5 ? 0 : 1]!;
  const { scale, chords, mode } = harmony;
  const root = noteNameToMidi(options.root)!;
  const tonic = pitchClass(root);
  const maxMidi = maxSidwaveMidi(system);
  // Keep an octave above the lead root available, even when the caller chooses a high key.
  const leadRoot = Math.max(36 + tonic, Math.min(root, 72 + tonic));
  const customLength = options.steps !== undefined || options.tempoMs !== undefined || options.intervals !== undefined;
  const steps = options.steps ?? (customLength ? 16 : undefined);
  const beatMs = 60_000 / tempo;
  const durations = steps === undefined ? [] : Array.from({ length: steps }, (_, i) =>
    preset === "expression" ? EXPRESSION_MS[i % EXPRESSION_MS.length]! : options.tempoMs ?? beatMs / 2,
  );
  const totalMs = durations.reduce((sum, value) => sum + value, 0);
  const bars = steps === undefined ? 8 : Math.max(1, Math.ceil(totalMs / (4 * beatMs) - 1e-9));
  const shortest = durations.length > 0 ? Math.min(...durations) : Infinity;
  // The legacy 20 ms setting still fits three player calls and a hard restart.
  const speed = Math.max(MUSIC_STYLES[style].speed, Math.ceil(3_000 / (shortest * sidwaveFrameRate(system))));
  const lead: Entry[] = [];
  const leadTimeline: Array<{ t: number; note: string; durationMs: number }> = [];
  const backing: Entry[] = [];
  const chordEntries: Entry[] = [];

  const chordAt = (bar: number): Chord => chords[bar % chords.length]!;
  const scaleNote = (degree: number) => leadRoot + scale[degree % scale.length]! + 12 * Math.floor(degree / scale.length);
  let position = 2;
  function walk(chord: Chord, accent: boolean): number {
    const allowed = Array.from({ length: 10 }, (_, i) => i).filter((degree) => {
      const chordTone = [0, 2, 4].some((offset) => (chord.degree + offset) % 7 === degree % 7);
      const distance = Math.abs(position - degree);
      return (!accent || chordTone) && distance > 0 && distance <= (accent ? 3 : 2);
    });
    position = allowed[Math.floor(random() * allowed.length)] ?? position;
    return scaleNote(position);
  }

  const leadInstrument = options.waveform && options.waveform !== "pulse" ? "custom_lead" : "lib:lead_pwm";
  const articulation = (midi: number, len: number, connected: boolean, inst?: string): SidwaveGrooveNote => ({
    note: midiToNoteName(midi), len, ...(inst ? { inst } : {}),
    ...(connected ? { legato: true, portamento: style === "ambient" ? 7 : 4 } : {}),
  });

  for (let bar = 0; bar < bars; bar += 1) {
    const chord = chordAt(bar);
    const chordPitch = pitchClass(tonic + scale[chord.degree]!);
    const bassRoot = 36 + chordPitch;
    const bassCells = bar % 4 === 3 && style !== "ambient" ? drumLine.slice(0, -4) + "Ohsk" : drumLine;
    for (const cell of bassCells) {
      if (cell in DRUMS) backing.push(`C3@${DRUMS[cell]}`);
      else if (cell === ".") backing.push("-");
      else {
        const pitch = midiToNoteName(bassRoot + (cell === "O" ? 12 : 0));
        backing.push(style === "funk" && cell === "O" ? `${pitch}@lib:sync_lead` : pitch);
      }
    }
    const chordNote = midiToNoteName(48 + chordPitch);
    const arp = `lib:chip_arp_${chord.minor ? "minor" : "major"}`;
    if (style === "ambient") {
      chordEntries.push({ note: chordNote, len: 2, inst: "lib:pad_slow" }, { note: chordNote, len: 1.5, inst: arp }, `${chordNote}@lib:bell_ring`);
    } else {
      chordEntries.push({ note: chordNote, len: 1.5, inst: arp }, "-", { note: chordNote, len: 1, inst: arp }, "-", { note: chordNote, len: 0.5, inst: arp });
    }
  }

  let leadRest = 0.5;
  if (steps !== undefined) {
    let t = 0;
    for (const [i, durationMs] of durations.entries()) {
      const chord = chordAt(Math.floor(t / (4 * beatMs)));
      const interval = options.intervals?.[i % options.intervals.length];
      let midi = interval === undefined ? walk(chord, i % 4 === 0) : root + interval;
      if (midi < 12) midi = 12 + pitchClass(midi);
      const note = midiToNoteName(midi);
      const len = durationMs / beatMs;
      // At very short spacings a full hard restart would eat most of each note.
      lead.push(articulation(midi, len, i % 4 !== 0 && options.waveform !== "noise"));
      leadTimeline.push({ t, note, durationMs });
      t += durationMs;
    }
    const remaining = bars * 4 - totalMs / beatMs;
    if (remaining >= 1 / 64) {
      leadRest = remaining;
      lead.push("-");
    } else if (remaining > 0) {
      const last = lead[lead.length - 1] as SidwaveGrooveNote;
      last.len! += remaining;
    }
  } else {
    const hook: Entry[][] = [];
    const rhythm = preset === "expression" ? [1, 0.25, 0.75, 0.5, 1] :
      style === "ambient" ? [1.5, 0.5, 1.5] : style === "funk" ? [0.5, 0.25, 0.75, 0.5, 1.5] : [0.75, 0.25, 0.5, 1, 1];
    for (let bar = 0; bar < bars; bar += 1) {
      if (bar === 4 || bar === 5) {
        lead.push(...hook[bar - 4]!);
        continue;
      }
      const chord = chordAt(bar);
      const phrase: Entry[] = rhythm.map((len, i) => {
        const cadence = bar === 7 && i === rhythm.length - 1;
        const midi = cadence ? scaleNote(0) : walk(chord, i === 0 || i === rhythm.length - 1);
        const bell = style === "ambient" && i === 0 && bar % 2 === 1 && !options.waveform;
        return articulation(midi, len, i > 0 && i % 2 === 1 && options.waveform !== "noise", bell ? "lib:bell_ring" : undefined);
      });
      phrase.push("-");
      if (bar < 2) hook.push(phrase);
      lead.push(...phrase);
    }
  }

  const score: SidwaveDocument = {
    sidwave: "1.1", title: `Signal ${seed.toString(16).toUpperCase()} | ${style}`, tempo, mode: system, speed,
    ...(leadInstrument === "custom_lead" ? { instruments: { custom_lead: { waveform: options.waveform, adsr: [1, 5, 9, 3] } } } : {}),
    voices: [
      { id: 1, name: "Bass and drums", instrument: bass, patterns: { Bass: { length: 0.25, groove: backing } } },
      { id: 2, name: "Harmony", patterns: { Chords: { length: 0.5, groove: chordEntries } } },
      { id: 3, name: "Lead", instrument: leadInstrument, patterns: {
        Lead: {
          length: leadRest, groove: lead,
          fx: { ...(options.waveform !== "noise" && lead.every((entry) => typeof entry === "string" || noteNameToMidi(entry.note)! < maxMidi)
            ? { vibrato: { depth: style === "ambient" ? 0.18 : 0.32, rate: style === "ambient" ? 3 : 5, delay: style === "ambient" ? 10 : 6 } } : {}) },
        },
      } },
    ],
    timeline: [{ section: "Composition", bars, layers: { v1: "Bass", v2: "Chords", v3: "Lead" } }],
  };
  const key = `${midiToNoteName(12 + tonic).slice(0, -1)} ${mode}`;
  return { score, key, progression: chords.map(({ name }) => name), tempo, bars, speed, leadTimeline };
}
