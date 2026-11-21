import type { Arrangement } from "./sidwaveCompiler.js";
import { midiToHz, type ParsedSidwave, type SidwaveRamp } from "./sidwave.js";
import { digiSpans } from "./sidwaveDigi.js";
import { cutoffHz } from "./sidwaveFilterModel.js";

export interface SidwaveFinding {
  code: string;
  count: number;
  /** Position of the first occurrence, for example "bar 5 v2". */
  first: string;
  message: string;
}

/** Most severe first; codes missing here sort last. */
const SEVERITY = [
  "HR-SHORT", "FILTER-MUTED", "FILTER-BASS", "TABLE-CUT", "CLASH", "FILTER-SHARED", "FILTER-IGNORED", "LOOP-TIE",
  "SEQ-CUT", "VOL-STEP", "FLAT", "REPEAT", "LEVEL-NOOP", "HR-GAP", "FILTER-STEP", "PW-EDGE", "ARP-FAST", "NO-BASS",
  "DUP", "ONE-SIDE", "RINGSYNC-SRC", "DIGI-SHARED", "FILTER-MODEL", "TEMPO-GRID",
];
const INFO = new Set(["TEMPO-GRID"]);
export const MAX_FINDINGS = 12;

/** Collects lint findings, merging repeats of one code into a count. */
export class SidwaveFindings {
  private readonly byCode = new Map<string, SidwaveFinding>();
  private readonly seen = new Set<string>();

  add(code: string, first: string, message: string): void {
    const found = this.byCode.get(code);
    if (found) found.count++;
    else this.byCode.set(code, { code, count: 1, first, message });
  }

  /** Reports a code once per key (for example once per instrument). */
  once(code: string, key: string, first: string, message: string): void {
    const id = `${code}\0${key}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.add(code, first, message);
  }

  has(code: string): boolean { return this.byCode.has(code); }

  list(): SidwaveFinding[] {
    const rank = (code: string) => { const i = SEVERITY.indexOf(code); return i < 0 ? SEVERITY.length : i; };
    return [...this.byCode.values()].sort((a, b) => rank(a.code) - rank(b.code)).slice(0, MAX_FINDINGS);
  }
}

export function isInfoCode(code: string): boolean { return INFO.has(code); }

export function formatFinding(f: SidwaveFinding): string {
  return `${f.code}: ${f.message} (${f.count > 1 ? `${f.count} times, first at ` : "at "}${f.first})`;
}


const CYCLES_PER_FRAME = { PAL: 19656, NTSC: 17095 } as const;
const CLOCK_HZ = { PAL: 985248, NTSC: 1022727 } as const;
/**
 * Nominal SID release times in milliseconds: the MOS 6581 datasheet decay/release times, which are 3 x the attack
 * times (2 ms to 8 s) that reSID lists in envelope.cc, EnvelopeGenerator::rate_counter_period. They are nominal
 * values, not measurements, and real chips differ; no table in data/sound/*.md gives them.
 */
export const RELEASE_MS = [6, 24, 48, 72, 114, 168, 204, 240, 300, 750, 1500, 2400, 3000, 9000, 15000, 24000];
const MARKS: Array<[number, string]> = [[4, "pp"], [6, "p"], [8, "mp"], [10, "mf"], [12, "f"], [15, "ff"]];
const mark = (n: number) => MARKS.find(([v]) => v === Math.round(n))?.[1] ?? String(Math.round(n));

type Note = Arrangement["voices"][number]["notes"][number];

function barOf(beat: number | undefined, meter: number): number { return Math.floor((beat ?? 0) / meter) + 1; }

function rampMid(ramp: SidwaveRamp | undefined): number | undefined {
  if (ramp === undefined) return undefined;
  return typeof ramp === "number" ? ramp : ((ramp.from ?? ramp.to) + ramp.to) / 2;
}

/** Register table value after `frames` calls; steps with `add` are per call. */
export function tableCutoffs(table: NonNullable<Arrangement["instruments"][number]["filtertable"]>, calls: number): number[] {
  const out: number[] = [];
  let value = 0;
  let step = 0;
  let left = table.steps[0]?.frames ?? 1;
  let first = true;
  while (out.length < calls && table.steps.length) {
    const s = table.steps[step]!;
    if (first || left > 0) {
      if (left === (s.frames ?? 1) || first) {
        if (!s.add) value = s.value;
      }
      if (s.add && !(left === (s.frames ?? 1))) value = Math.max(0, Math.min(2047, value + s.value));
      else if (s.add) value = Math.max(0, Math.min(2047, value + s.value));
    }
    first = false;
    out.push(value);
    if (--left <= 0) {
      step++;
      if (step >= table.steps.length) {
        if (table.loop === undefined) { while (out.length < calls) out.push(value); break; }
        step = table.loop;
      }
      left = table.steps[step]!.frames ?? 1;
    }
  }
  return out;
}

function slotsOf(doc: ParsedSidwave): Map<number, number> {
  const bySlot = new Map<number, number>();
  for (const [id, slot] of doc.voiceSlots) bySlot.set(slot, id);
  return bySlot;
}

/** Findings that need the finished arrangement. Compile-time findings are added while arranging. */
export function lintArrangement(doc: ParsedSidwave, full: Arrangement, findings: SidwaveFindings): void {
  // Hidden notes only drive sync and ring sources; they are not part of the music.
  const arr: Arrangement = { ...full, voices: full.voices.map((v) => ({ ...v, notes: v.notes.filter((n) => !n.hidden) })) };
  const meter = doc.song.meter;
  const bySlot = slotsOf(doc);
  const speed = doc.speed;
  const fpb = arr.framesPerBeat;
  const where = (n: Note | undefined, slot: number) => `bar ${barOf(n?.beat, meter)} v${bySlot.get(slot) ?? slot + 1}`;
  const lowest = (() => {
    let best = -1; let bestMidi = Infinity;
    arr.voices.forEach((v, slot) => { for (const n of v.notes) if (n.midi < bestMidi && !doc.voices.find((x) => x.id === bySlot.get(slot))?.echo) { bestMidi = n.midi; best = slot; } });
    return best;
  })();
  const roleOf = (slot: number) => doc.voices.find((v) => v.id === bySlot.get(slot))?.role;
  const chipOf = (slot: number) => Math.floor(slot / 3);
  const modelOf = (slot: number) => doc.sids[chipOf(slot)]?.model;

  // TEMPO-GRID: a sixteenth that is not a whole number of player calls moves onsets by up to half a call.
  const grid = (tempo: number, where_: string) => {
    const calls = arr.fps * 60 / tempo / 4;
    if (Math.abs(calls - Math.round(calls)) > 0.02) {
      const tempos = [Math.floor(calls), Math.ceil(calls)].filter((c) => c > 0).map((c) => Math.round(arr.fps * 60 / (4 * c) * 100) / 100);
      findings.add("TEMPO-GRID", where_, `A sixteenth lasts ${calls.toFixed(2)} calls; use tempo ${tempos.join(" or ")} for an exact grid`);
    }
  };
  grid(doc.song.tempo, "song tempo");
  doc.timeline.forEach((s, i) => { if (typeof s.tempo === "number") grid(s.tempo, `entry ${i + 1}`); });
  doc.voices.forEach((v) => {
    if (v.echo?.delay !== undefined && (v.echo.delay * speed) % (fpb / 4) > 0.02 && Math.abs(((v.echo.delay * speed) % (fpb / 4)) - fpb / 4) > 0.02) {
      findings.add("TEMPO-GRID", `v${v.id} echo`, `Echo delay ${v.echo.delay} frames is not a multiple of a sixteenth (${(fpb / 4 / speed).toFixed(2)} frames); use delay_beats`);
    }
  });

  // Instrument checks.
  const seenInst = new Set<number>();
  const owners = doc.sids.map((sid) => sid.filter?.owner);
  arr.voices.forEach((voice, slot) => {
    for (const note of voice.notes) {
      const inst = arr.instruments[note.inst]!;
      const key = `${slot}:${note.inst}`;
      const first = !seenInst.has(note.inst);
      seenInst.add(note.inst);
      if (!first && !(inst.filtertable && owners[chipOf(slot)] !== undefined)) continue;
      if (inst.restart && inst.restart.frames > 0) {
        const cycles = inst.restart.frames * CLOCK_HZ[arr.system] / arr.fps;
        if (cycles < 32768) findings.once("HR-SHORT", String(note.inst), where(note, slot), `Hard restart of ${inst.restart.frames / speed} frame(s) is under 32768 cycles; use at least 2 frames or frames: 0`);
      }
      const ft = inst.filtertable;
      if (ft) {
        const ownerId = owners[chipOf(slot)];
        if (ownerId !== undefined && doc.voiceSlots.get(ownerId) !== slot) {
          findings.once("FILTER-IGNORED", key, where(note, slot), "Move the filter table to the owner voice or remove it");
        }
        // Stairs: consecutive set steps of 2 or more calls that jump more than 100 units at resonance 10 or more.
        let res = 0;
        ft.steps.forEach((s, i) => {
          if (s.resonance !== undefined) res = s.resonance;
          const prev = ft.steps[i - 1];
          if (!s.add && prev && !prev.add && s.frames >= 2 && prev.frames >= 2 && res >= 10 && Math.abs(s.value - prev.value) > 100) {
            findings.once("FILTER-STEP", `${note.inst}:${i}`, where(note, slot), "Use add steps for a smooth sweep");
          }
        });
        if (arr.chips?.[chipOf(slot)] !== undefined || arr.chips === undefined) {
          if (!doc.sids[chipOf(slot)]?.model) findings.once("FILTER-MODEL", String(chipOf(slot)), where(note, slot), "Declare sids[].model so cutoffs resolve for the chip");
        }
      }
      const pt = inst.pulsetable;
      if (pt) {
        let pw = 0;
        let bad = false;
        const scan = (steps: typeof pt.steps) => {
          for (const s of steps) {
            if (!s.add) pw = s.value <= 1 ? s.value * 4096 : s.value;
            else pw += s.value * s.frames;
            if (pw < 0.05 * 4096 || pw > 0.95 * 4096) bad = true;
          }
        };
        scan(pt.steps);
        if (pt.loop !== undefined) scan(pt.steps.slice(pt.loop));
        if (bad) findings.once("PW-EDGE", String(note.inst), where(note, slot), "Keep pulse width between 5% and 95%");
      }
      if (inst.arp.length && inst.arpSpeed < speed) findings.once("ARP-FAST", String(note.inst), where(note, slot), "Give each arpeggio tone at least one video frame");
      if (inst.wavetable?.some((s) => s.calls !== undefined && s.note !== undefined && s.frames < speed)) {
        findings.once("ARP-FAST", `w${note.inst}`, where(note, slot), "Give each table tone at least one video frame");
      }
    }
  });

  // TABLE-CUT: a non-looping wavetable cut by the next attack on the same voice.
  arr.voices.forEach((voice, slot) => {
    const uses = new Map<number, { count: number; cut: number; need: number; avail: number; at: Note }>();
    voice.notes.forEach((n, i) => {
      const inst = arr.instruments[n.inst]!;
      if (!inst.wavetable?.length || inst.waveloop !== undefined && inst.waveloop < inst.wavetable.length) return;
      const length = inst.wavetable.reduce((sum, s) => sum + (s.frames ?? 1), 0);
      const next = voice.notes[i + 1];
      const hr = arr.instruments[(next ?? n).inst]!.restart?.frames ?? 2;
      const available = next && !next.legato ? next.start - hr - n.start : n.end - n.start;
      const rec = uses.get(n.inst) ?? { count: 0, cut: 0, need: length, avail: Infinity, at: n };
      rec.count++;
      if (available < length) { rec.cut++; rec.avail = Math.min(rec.avail, available); if (rec.cut === 1) rec.at = n; }
      uses.set(n.inst, rec);
    });
    for (const [inst, r] of uses) {
      if (r.cut * 4 > r.count) findings.add("TABLE-CUT", where(r.at, slot), `A wavetable needs ${r.need} frames but only ${r.avail} are available before the next attack or the note end; lengthen the note or shorten the table`);
    }
  });

  // FILTER-SHARED: several voices with filter tables sounding together on one SID without an owner.
  doc.sids.forEach((sid, chip) => {
    if (sid.filter?.owner !== undefined) return;
    const filtered = [0, 1, 2].map((k) => chip * 3 + k).map((slot) => (arr.voices[slot]?.notes ?? []).filter((n) => arr.instruments[n.inst]!.filtertable));
    for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
      const hit = filtered[a]!.find((n) => filtered[b]!.some((m) => m.start < n.end && n.start < m.end));
      if (hit) findings.add("FILTER-SHARED", where(hit, chip * 3 + a), "Name filter.owner so only one voice drives the cutoff");
    }
  });

  // FILTER-BASS and FILTER-MUTED on the filter table of the bass voice or any sounding note.
  arr.voices.forEach((voice, slot) => {
    for (const n of voice.notes) {
      const inst = arr.instruments[n.inst]!;
      const ft = inst.filtertable;
      if (!ft || !(ft.steps.some((s) => (s.type ?? 0x10) & 0x10) || ft.steps.every((s) => s.type === undefined))) continue;
      const model = modelOf(slot) ?? "8580";
      const calls = Math.max(1, n.end - n.start);
      const cuts = tableCutoffs(ft, calls);
      if ((roleOf(slot) === "bass" || slot === lowest) && ft.loop === undefined) {
        const hz = cutoffHz(cuts[cuts.length - 1]!, model);
        if (hz > 2500) findings.once("FILTER-BASS", `${n.inst}`, where(n, slot), `The low-pass settles at ${Math.round(hz)} Hz on a bass voice; lower it below 2.5 kHz`);
      }
      const f0 = midiToHz(n.midi);
      const muted = cuts.filter((c) => cutoffHz(c, model) < f0).length;
      if (muted * 2 > calls && cutoffHz(0, model) < f0) findings.add("FILTER-MUTED", where(n, slot), "Raise the low-pass cutoff above the fundamental");
    }
  });

  // Per-bar content for NO-BASS, REPEAT, DUP, CLASH, HR-GAP and LOOP-TIE.
  const bars = doc.song.length_bars;
  const barFrames = fpb * meter;
  const sounding = (bar: number) => arr.voices.filter((v) => v.notes.some((n) => n.end > bar * barFrames && n.start < (bar + 1) * barFrames)).length;
  let noBass = 0;
  let noBassStart = 0;
  for (let bar = 0; bar < bars; bar++) {
    const low = arr.voices.some((v) => v.notes.some((n) => n.midi < 48 && n.end > bar * barFrames && n.start < (bar + 1) * barFrames));
    if (!low && sounding(bar) >= 2) { if (noBass++ === 0) noBassStart = bar; if (noBass === 8) findings.add("NO-BASS", `bar ${noBassStart + 1}`, "Add a voice below C3 or transpose the bass down"); }
    else noBass = 0;
  }
  // Index each note's onset once. REPEAT and every DUP pair reuse the
  // same per-voice signatures instead of scanning the score for each bar.
  const voiceBars = arr.voices.map(({ notes }) => {
    const onsets: string[][] = Array.from({ length: bars }, () => []);
    for (const n of notes) {
      const bar = Math.floor((n.start + 1e-6) / barFrames);
      onsets[bar]?.push(`${Math.round(n.start - bar * barFrames)}:${n.midi}:${n.inst}`);
    }
    return onsets.map((entries) => entries.join(","));
  });
  const signature = (bar: number) => voiceBars.map((slot) => slot[bar]).join("|");
  if (bars >= 4) {
    const seen = new Set<string>();
    let repeats = 0;
    for (let bar = 0; bar < bars; bar++) { const sig = signature(bar); if (seen.has(sig)) repeats++; seen.add(sig); }
    if (repeats > 0.75 * bars) findings.add("REPEAT", "bar 1", `${Math.round(100 * repeats / bars)}% of bars repeat an earlier bar; vary sections with transpose, levels or other patterns`);
  }
  const plain = (slot: number) => { const v = doc.voices.find((x) => x.id === bySlot.get(slot)); return !!v && !v.echo && !v.unison && !v.detune && !v.center; };
  for (let a = 0; a < arr.voices.length; a++) for (let b = a + 1; b < arr.voices.length; b++) {
    if (!plain(a) || !plain(b)) continue;
    let streak = 0;
    for (let bar = 0; bar < bars; bar++) {
      const sa = voiceBars[a]![bar]!; const sb = voiceBars[b]![bar]!;
      if (sa && sa === sb.replace(/:\d+$/, "") + "" || (sa && sa === sb)) { if (++streak === 2) findings.add("DUP", `bar ${bar} v${bySlot.get(a)}/v${bySlot.get(b)}`, "Detune, echo or offset one of the doubled voices"); } else streak = 0;
    }
  }
  // CLASH: minor second or minor ninth held together for an eighth note or longer, starting on a beat.
  const byOnset = arr.voices.map(({ notes }) => notes.filter((n) => {
    const inst = arr.instruments[n.inst]!;
    return !n.percussion && !(inst.wave & 0x80);
  })).map((notes) => notes.some((note, i) => i > 0 && note.start < notes[i - 1]!.start)
    ? [...notes].sort((a, b) => a.start - b.start) : notes);
  for (let a = 0; a < arr.voices.length; a++) for (let b = a + 1; b < arr.voices.length; b++) {
    const later = byOnset[b]!;
    let first = 0;
    for (const n of byOnset[a]!) {
      // The inputs are in onset order. An expired note can never clash
      // with this note or any later note on the first voice.
      while (first < later.length && later[first]!.end <= n.start) first++;
      for (let j = first; j < later.length && later[j]!.start < n.end; j++) {
        const m = later[j]!;
        const start = Math.max(n.start, m.start);
        const length = Math.min(n.releaseFrame ?? n.end, m.releaseFrame ?? m.end) - start;
        if (length < fpb / 2 - 1e-6) continue;
        const beat = start / fpb;
        if (Math.abs(beat - Math.round(beat)) > 0.02) continue;
        const interval = Math.abs(n.midi - m.midi);
        if (interval === 1 || interval === 13) { findings.add("CLASH", where(n.start >= m.start ? n : m, a), "Move one note a semitone or shorten the overlap"); }
      }
    }
  }
  // HR-GAP: repeated simultaneous hard restarts with no voice or sample bridging the gap.
  const attacksAt = new Map<number, Note[]>();
  for (const { notes } of arr.voices) for (const n of notes) {
    const attacks = attacksAt.get(n.start) ?? [];
    attacks.push(n);
    attacksAt.set(n.start, attacks);
  }
  const pcm = arr.samples ? digiSpans(arr.samples, arr.fps, arr.totalFrames, CLOCK_HZ[arr.system]) : [];
  const cursors = arr.voices.map(() => 0);
  let gap = 0, pcmCursor = 0, pcmEnd = 0;
  for (let beat = 0; beat < bars * meter; beat++) {
    const frame = arr.clock?.frameAt(beat, true) ?? Math.round(beat * fpb);
    const attacks = attacksAt.get(frame) ?? [];
    const hard = attacks.filter((n) => !n.legato && (arr.instruments[n.inst]!.restart?.frames ?? 2) > 0);
    if (hard.length < 2 || hard.length !== attacks.length) {
      gap = 0;
      continue;
    }
    while (pcm[pcmCursor] && pcm[pcmCursor]!.start < frame) pcmEnd = Math.max(pcmEnd, pcm[pcmCursor++]!.end);
    const bridged = pcmEnd > 0 && pcmEnd >= frame ||
      arr.voices.some(({ notes }, slot) => {
        let index = cursors[slot]!;
        while (notes[index] && (notes[index]!.releaseFrame ?? notes[index]!.end) < frame) index++;
        cursors[slot] = index;
        return !!notes[index] && notes[index]!.start < frame;
      });
    if (!bridged) {
      if (++gap === 4) findings.add("HR-GAP", `bar ${Math.floor((beat - 3) / meter) + 1}`, "Stagger attacks or hold one voice with legato so the mix is never silent at once");
    } else gap = 0;
  }
  // LOOP-TIE: the note spanning the loop target differs from the last note of the loop.
  if (arr.clock?.loopFrame !== undefined && arr.clock.loopFrame > 0) {
    const lf = arr.clock.loopFrame;
    arr.voices.forEach((v, slot) => {
      const span = v.notes.find((n) => n.start < lf && n.end > lf);
      const last = v.notes[v.notes.length - 1];
      if (span && last && (span.midi !== last.midi || span.inst !== last.inst)) findings.add("LOOP-TIE", where(span, slot), "Start the loop target with a note instead of a tie");
    });
  }
  // RINGSYNC-SRC: ring or sync without source_note while the source channel changes pitch.
  arr.voices.forEach((voice, slot) => {
    const src = arr.voices[chipOf(slot) * 3 + (slot % 3 + 2) % 3]!;
    let cursor = 0;
    for (const n of voice.notes) {
      const inst = arr.instruments[n.inst]!;
      const uses = (inst.wave & 6) || inst.wavetable?.some((s) => s.ring || s.sync);
      if (!uses || inst.sourceNote) continue;
      let pitch = -1;
      while (src.notes[cursor + 1] && src.notes[cursor + 1]!.start <= n.start) cursor++;
      for (let i = cursor; i < src.notes.length; i++) {
        const m = src.notes[i]!;
        if (m.start >= (n.releaseFrame ?? n.end)) break;
        const source = arr.instruments[m.inst]!;
        const moves = m.portamento || source.arp.length || source.vibRate || source.slideSemis ||
          source.wavetable?.some((step) => step.note !== undefined || step.hz !== undefined);
        if ((m.start > n.start && m.midi !== pitch) || (moves && m.end > n.start)) {
          findings.add("RINGSYNC-SRC", where(n, slot), "Set source_note on the instrument or keep the source channel still");
          break;
        }
        pitch = m.midi;
      }
    }
  });
  // ONE-SIDE only applies to hard pans. Intermediate mixer positions feed both sides.
  const sideOf = (slot: number) => doc.sids[chipOf(slot)]?.pan?.split(" ")[0];
  const centred = new Set(arr.mirrors?.flat() ?? []);
  for (const voice of doc.voices) {
    if (!voice.unison) continue;
    const slot = doc.voiceSlots.get(voice.id)!;
    const source = doc.voiceSlots.get(voice.unison.voice)!;
    if (sideOf(slot) !== sideOf(source) && arr.voices[slot]?.notes.length) {
      centred.add(slot);
      centred.add(source);
    }
  }
  arr.voices.forEach((voice, slot) => {
    const pan = doc.sids[chipOf(slot)]?.pan;
    if (!/^(Left|Right) 5$/.test(pan ?? "") || !voice.notes.length || centred.has(slot)) return;
    const docVoice = doc.voices.find((v) => v.id === bySlot.get(slot));
    const role = docVoice?.role;
    const subject = role ? ["drums", "bass", "lead"].includes(role) : slot === lowest;
    if (subject) findings.add("ONE-SIDE", `v${docVoice?.id ?? slot + 1}`, "Use center: true or an opposite-pan unison copy so the part sounds on both sides");
  });
  // DIGI-SHARED: samples and pitched voices on one SID.
  const digiChips = new Set([...(doc.samples?.triggers.map((t) => t.chip) ?? []), ...(doc.digiVoices?.map((d) => d.chip) ?? [])]);
  for (const chip of digiChips) {
    if ([0, 1, 2].some((k) => arr.voices[chip * 3 + k]?.notes.length)) findings.add("DIGI-SHARED", doc.sids[chip]?.id ?? `sid${chip + 1}`, "Give samples a SID of their own");
  }
  if (doc.sids.some((s) => !s.model) && arr.filter.used) {
    findings.once("FILTER-MODEL", "global", "song", "Declare sids[].model so cutoffs resolve for the chip");
  }
  lintFlat(doc, arr, findings);
}

function sectionStats(doc: ParsedSidwave, arr: Arrangement) {
  const clock = arr.clock!;
  return clock.sections.map((entry) => {
    const startFrame = clock.frameAt(entry.startBeat);
    const endFrame = clock.frameAt(entry.endBeat);
    const span = Math.max(1, endFrame - startFrame);
    let amplitude = 0;
    const voices: number[] = [];
    arr.voices.forEach((voice, slot) => {
      let on = 0;
      let weighted = 0;
      for (const n of voice.notes) {
        const a = Math.max(n.start, startFrame); const b = Math.min(n.end, endFrame);
        if (b <= a) continue;
        const sustain = n.sustain ?? arr.instruments[n.inst]!.sr >> 4;
        const chip = doc.sids[Math.floor(slot / 3)];
        const vol = (n.volume ?? chip?.volume ?? 15) / 15;
        on += b - a;
        weighted += (b - a) * (sustain / 15) * vol;
      }
      if (on > 0) { voices.push(slot); amplitude += weighted / span; }
    });
    return { entry, startFrame, endFrame, amplitude, voices };
  });
}

function lintFlat(doc: ParsedSidwave, arr: Arrangement, findings: SidwaveFindings): void {
  if (!arr.clock) return;
  const stats = sectionStats(doc, arr).filter((s) => s.amplitude > 0);
  if (stats.length < 2) return;
  const db = stats.map((s) => 20 * Math.log10(s.amplitude));
  if (Math.max(...db) - Math.min(...db) < 3) findings.add("FLAT", "bar 1", `Estimated loudness varies by ${(Math.max(...db) - Math.min(...db)).toFixed(1)} dB; set section level or volume to build and release`);
}

function clockText(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One line per timeline entry: number, name, bars, time span, level, estimated loudness and voices. */
export function arrangementReport(doc: ParsedSidwave, arr: Arrangement): string[] | undefined {
  if (!arr.clock) return undefined;
  const meter = doc.song.meter;
  return sectionStats(doc, arr).map(({ entry, amplitude, voices }, i) => {
    const s = entry.section;
    const bars = (entry.endBeat - entry.startBeat) / meter;
    const first = entry.startBeat / meter + 1;
    const level = s.level === undefined ? "ff" : typeof s.level === "number" ? mark(s.level)
      : `${mark(s.level.from ?? 15)}>${mark(s.level.to)}`;
    const est = amplitude > 0 ? `${(20 * Math.log10(amplitude)).toFixed(1)} dB` : "silent";
    const ids = voices.map((slot) => `v${[...doc.voiceSlots].find(([, v]) => v === slot)?.[0] ?? slot + 1}`);
    return `${i + 1} ${s.section || "section"} bars ${first}-${first + bars - 1} ${clockText(entry.startTime)}-${clockText(entry.endTime)} level ${level} est ${est} ${ids.join(",")}`;
  });
}
export { rampMid };
