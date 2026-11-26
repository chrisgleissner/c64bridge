import { parseLayerSequence, patternBeats, sectionBarBeats, type ParsedSidwave, type SidwavePattern, type SidwaveRamp, type SidwaveTimelineSection } from "./sidwave.js";

const EPSILON = 1e-9;

export function makeTimelineClock(doc: ParsedSidwave, fps: number) {
  const sections: Array<{ index: number; section: SidwaveTimelineSection; startBeat: number; endBeat: number; at: (beat: number) => number; startTime: number; endTime: number; endTempo: number }> = [];
  let seconds = 0;
  // Bar lines in beats. Each section counts its bars in its own metre (SIDWAVE 1.3); a beat is a quarter note.
  const barStarts = [0];
  let beat = 0;
  for (let bar = 0, i = 0; bar < doc.song.length_bars; i++) {
    const index = i % doc.timeline.length;
    const section = doc.timeline[index]!;
    const bars = Math.min(section.bars, doc.song.length_bars - bar);
    const meter = sectionBarBeats(section, doc.song.meter);
    const startBeat = beat;
    const endBeat = beat + bars * meter;
    for (let b = 1; b <= bars; b++) barStarts.push(startBeat + b * meter);
    beat = endBeat;
    const tempo = typeof section.tempo === "number" ? section.tempo : doc.song.tempo;
    const slope = typeof section.tempo === "object" ? (section.tempo.to - tempo) / (section.bars * meter) : 0;
    const origin = seconds;
    // Integrate seconds per beat against a tempo that is linear in beat position.
    const at = (beat: number) => origin + (slope
      ? 60 * Math.log1p(slope * (beat - startBeat) / tempo) / slope
      : 60 * (beat - startBeat) / tempo);
    seconds = at(endBeat);
    sections.push({ index, section, startBeat, endBeat, at, startTime: origin, endTime: seconds, endTempo: tempo + slope * (endBeat - startBeat) });
    bar += bars;
  }
  const last = sections[sections.length - 1]!;
  const find = (beat: number) => {
    let lo = 0;
    let hi = sections.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (beat < sections[mid]!.endBeat - EPSILON) hi = mid;
      else lo = mid + 1;
    }
    return sections[lo]!;
  };
  const frameAt = (beat: number, swing = false) => {
    const item = find(beat);
    const unit = doc.swingUnit ?? 0.25;
    const swingAmount = item.section.swing ?? doc.swing ?? 0.5;
    const local = beat - item.startBeat;
    const slot = Math.round(local / unit);
    const delayed = swing && slot % 2 === 1 && Math.abs(slot * unit - local) < EPSILON
      ? Math.min(item.endBeat, beat + (2 * swingAmount - 1) * unit) : beat;
    const time = delayed > last.endBeat
      ? last.endTime + (delayed - last.endBeat) * 60 / last.endTempo : item.at(delayed);
    return Math.round(time * fps + EPSILON);
  };
  /** One-based number of the bar that contains `beat`. */
  const barOf = (beat: number) => {
    let lo = 0;
    let hi = barStarts.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (barStarts[mid]! <= beat) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return { sections, frameAt, barStarts, barOf, totalFrames: frameAt(last.endBeat), endBeat: last.endBeat,
    loopFrame: doc.loopTo === undefined ? undefined : frameAt(sections[doc.loopTo]!.startBeat) };
}

export type TimelineClock = ReturnType<typeof makeTimelineClock>;

/** Shared by pitched and PCM tracks, with absolute beat positions for every pass. */
export function* timelinePatternPasses(ref: string, patterns: Record<string, SidwavePattern>, start: number,
  end: number, meter: number, path: string) {
  const { items, sequence } = parseLayerSequence(ref, Object.keys(patterns), path);
  const lengths = items.map((item) => item.pattern ? patternBeats(patterns[item.pattern]!) : meter);
  const period = lengths.reduce((a, b) => a + b, 0);
  const iterations = new Map<string, number>();
  for (let cycle = 0; start + cycle * period < end - EPSILON; cycle++) {
    let offset = 0;
    for (const [index, item] of items.entries()) {
      const beat = start + cycle * period + offset;
      const length = lengths[index]!;
      offset += length;
      if (beat >= end - EPSILON) break;
      const repetition = item.pattern ? iterations.get(item.pattern) ?? 0 : 0;
      if (item.pattern) iterations.set(item.pattern, repetition + 1);
      yield { ...item, sequence, repetition, beat, length, cut: beat + length > end + EPSILON };
    }
  }
}

export function rampValue(ramp: SidwaveRamp | undefined, initial: number, beat: number, span: number, meter: number): number {
  if (typeof ramp === "number" || ramp === undefined) return ramp ?? initial;
  const from = ramp.from ?? initial;
  const fraction = Math.max(0, Math.min(1, beat / (ramp.bars === undefined ? span : ramp.bars * meter)));
  return from + (ramp.to - from) * fraction;
}

/**
 * Maps the digi voices' timeline layers to player calls: one entry per sample trigger, in absolute beats of
 * every pass, with sequence items, section repeats and loop targets resolved exactly as for pitched voices.
 * A kit token whose instrument is `sample:<name>` starts that sample; transposition never applies to it.
 * The PCM code calls this function, so triggers follow the timeline.
 */
export function digiTriggers(doc: ParsedSidwave, clock: TimelineClock): Array<{ chip: number; name: string; beat: number; frame: number; path: string }> {
  const out: Array<{ chip: number; name: string; beat: number; frame: number; path: string }> = [];
  for (const digi of doc.digiVoices ?? []) {
    for (const entry of clock.sections) {
      const ref = entry.section.layers[digi.id];
      if (ref === undefined) continue;
      const path = `$.timeline[${entry.index}].layers.${digi.id}`;
      const meter = sectionBarBeats(entry.section, doc.song.meter);
      for (const pass of timelinePatternPasses(ref, digi.patterns, entry.startBeat, entry.endBeat, meter, path)) {
        if (!pass.pattern) continue;
        const pattern = digi.patterns[pass.pattern]!;
        if (!("groove" in pattern)) continue;
        const length = pattern.length ?? 1;
        let beat = pass.beat;
        for (const item of pattern.groove) {
          const span = typeof item === "object" ? Number(item.len ?? length) : length;
          if (beat >= entry.endBeat - EPSILON) break;
          const inst = typeof item === "object" && "inst" in item ? item.inst : undefined;
          if (inst?.startsWith("sample:")) {
            out.push({ chip: digi.chip, name: inst.slice(7), beat, frame: clock.frameAt(beat, true), path });
          }
          beat += span;
        }
      }
    }
  }
  return out;
}
