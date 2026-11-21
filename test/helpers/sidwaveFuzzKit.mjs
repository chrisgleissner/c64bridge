// Shared pieces of the SIDWAVE fuzz and soak tests: seeded PRNG, document grammar, a harness that parses,
// compiles and plays a document in the 6502 emulator while checking invariants, and a document minimiser.
import { compileSidwaveToPrg, compileSidwaveToSid, SIDWAVE_MEMORY_END } from "../../src/sidwaveCompiler.js";
import { parseSidwave, SidwaveValidationError } from "../../src/sidwave.js";
import { Cpu } from "./sidwaveEmulator.mjs";

// ---------------------------------------------------------------------------
// PRNG (mulberry32) and small helpers

export function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), s | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 0x100000000;
  };
}
export const pick = (r, list) => list[Math.floor(r() * list.length)];
export const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
export const chance = (r, p) => r() < p;
export const weighted = (r, pairs) => {
  let total = 0;
  for (const [, w] of pairs) total += w;
  let x = r() * total;
  for (const [v, w] of pairs) { if ((x -= w) < 0) return v; }
  return pairs[pairs.length - 1][0];
};
const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
export const noteName = (midi) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

// ---------------------------------------------------------------------------
// Document grammar

const LIB = ["lib:kick", "lib:snare", "lib:hat", "lib:bass_pluck", "lib:filter_bass", "lib:lead_pwm", "lib:chip_arp_major",
  "lib:chip_arp_minor", "lib:bell_ring", "lib:sync_lead", "lib:pad_slow", "lib:tom", "lib:clap", "lib:open_hat", "lib:crash",
  "lib:octave_bass", "lib:wide_pwm_pad", "lib:pluck_arp", "lib:noise_lead_attack"];
const WAVES = ["pulse", "sawtooth", "saw", "triangle", "tri", "noise"];
const TABLE_WAVES = ["tri", "saw", "pulse", "noise", "tri+pulse", "saw+pulse", "tri+saw", "tri+saw+pulse"];
const CHORDS = ["C", "Cm", "Cdim", "Caug", "Csus2", "Csus4", "C6", "Cm6", "C7", "Cmaj7", "Cm7", "Cdim7", "Cm7b5", "C9", "Cmaj9", "Cm9", "Cadd9"];
const FILTER_TYPES = ["lowpass", "bandpass", "highpass", "lowpass+highpass", "bandpass+highpass", "all"];
const ODD = [-1, 0, 16, 256, 65536, 1e9, -0.5, 0.001, "7", "x", "", null, true, [], {}, 2 ** 31, -(2 ** 31)];

export function genDoc(r, { chaos = 0, big = false, badInstruments = 0 } = {}) {
  const odd = (value) => (chaos > 0 && chance(r, chaos) ? pick(r, ODD) : value);
  const version = weighted(r, [["1.0", 2], ["1.1", 3], ["1.2", 5]]);
  const modern = version === "1.2";
  const doc = {};
  doc.sidwave = chance(r, 0.5) ? Number(version) === 1 ? 1.0 : version : version;
  if (typeof doc.sidwave === "string" && chance(r, 0.5)) doc.sidwave = Number(version);
  if (chance(r, 0.8)) doc.title = pick(r, ["Fuzz", "Ünïcode ♪ title", "x".repeat(40), "", "T".repeat(3)]);
  if (chance(r, 0.5)) doc.author = pick(r, ["A", "Author with a long name that exceeds thirty-two characters", "日本語"]);
  doc.tempo = odd(chance(r, 0.15) ? pick(r, [30, 220, 219.5, 31]) : int(r, 60, 200));
  doc.mode = chance(r, 0.5) ? "PAL" : "NTSC";
  if (chance(r, 0.6)) doc.speed = odd(int(r, 1, 4));
  if (modern && chance(r, 0.2)) doc.meter = 3;
  if (modern && chance(r, 0.25)) doc.cpu = "turbo";
  if (chance(r, 0.15)) {
    doc.global_fx = {};
    if (chance(r, 0.6)) doc.global_fx.reverb_sim = { depth: pick(r, [0.1, 0.5, 1]), delay_frames: odd(int(r, 1, 50)) };
    if (chance(r, 0.6)) doc.global_fx.filter_env = filterEnv(r, odd, false);
  }

  // SID map
  let sids;
  let sidIds = ["sid1"];
  const sidMode = weighted(r, [["default", modern ? 4 : 8], ["list", modern ? 3 : 1], ["layout", modern ? 3 : 0.3]]);
  if (sidMode === "list") {
    const count = big ? int(r, 4, 10) : weighted(r, [[1, 2], [2, 4], [3, 3], [4, 1.5], [int(r, 5, 10), 1.5]]);
    const addrs = [];
    for (let hi = 4; hi <= 7; hi++) for (const lo of [0, 2, 4, 6, 8, 10, 12, 14]) addrs.push(`$D${hi}${lo.toString(16).toUpperCase()}0`);
    const chosen = ["$D400"];
    while (chosen.length < count) { const a = pick(r, addrs); if (!chosen.includes(a)) chosen.push(a); }
    if (chance(r, 0.1)) chosen[0] = pick(r, addrs);
    sids = chosen.map((address, i) => {
      const entry = { id: chance(r, 0.15) ? i + 1 : `s${i}`, address };
      if (chance(r, 0.4)) entry.model = pick(r, ["6581", "8580"]);
      if (chance(r, 0.4)) entry.volume = odd(int(r, 0, 15));
      if (chance(r, 0.2)) entry.pan = pick(r, ["Center", "Left 3", "Right 5", "Left 1"]);
      if (chance(r, 0.2)) {
        entry.filter = chance(r, 0.5) ? { filter_env: filterEnv(r, odd, true) } : { filter_mod: { sweep: int(r, -500, 500), beats: pick(r, [1, 2, 4]) } };
      }
      return entry;
    });
    sidIds = sids.map(({ id }) => String(id));
    doc.sids = sids;
  } else if (sidMode === "layout") {
    const layout = pick(r, ["ultisid8", "ultisid8+socket1", "ultisid8+sockets"]);
    const count = { ultisid8: 8, "ultisid8+socket1": 9, "ultisid8+sockets": 10 }[layout];
    sidIds = Array.from({ length: count }, (_, i) => `sid${i + 1}`);
    doc.sids = { layout };
    if (chance(r, 0.5)) doc.sids.overrides = { [pick(r, sidIds)]: { volume: int(r, 0, 15), ...(chance(r, 0.5) ? { pan: "Left 5" } : {}) } };
  }
  const capacity = sidIds.length * 3;

  // Instruments
  const instNames = [];
  let badName;
  if (chance(r, 0.6)) {
    doc.instruments = {};
    const count = int(r, 1, 4);
    for (let i = 0; i < count; i++) {
      const name = pick(r, ["bass", "lead", "pad", "hit", "x1", "Zz"]);
      doc.instruments[name] = genInstrument(r, odd, modern);
      if (badInstruments > 0 && chance(r, badInstruments)) { Object.assign(doc.instruments[name], badInstrumentField(r)); badName = name; }
      if (!instNames.includes(name)) instNames.push(name);
    }
  }
  const instRef = () => (instNames.length && chance(r, 0.5) ? pick(r, instNames) : pick(r, LIB));

  // Voices
  const voiceCount = big ? capacity : Math.min(capacity, weighted(r, [[1, 3], [2, 4], [3, 5], [int(r, 4, 12), modern ? 2 : 0], [int(r, 13, 30), modern ? 1 : 0]]));
  const slots = Array.from({ length: capacity }, (_, i) => i).sort(() => r() - 0.5).slice(0, voiceCount);
  if (!big && chance(r, 0.5)) slots.sort((a, b) => a - b);
  doc.voices = [];
  const players = [];
  for (const slot of slots) {
    const voice = {};
    if (chance(r, 0.75)) voice.id = slot + 1;
    else { voice.sid = sidIds[Math.floor(slot / 3)]; if (/^\d+$/.test(voice.sid)) voice.sid = Number(voice.sid); voice.channel = (slot % 3) + 1; }
    if (voice.id === undefined && chance(r, 0.3)) voice.id = slot + 1;
    if (chance(r, 0.3)) voice.name = pick(r, ["Lead", "", "Bäss", "n".repeat(50)]);
    if (chance(r, 0.6)) voice.waveform = pick(r, WAVES);
    if (chance(r, 0.3)) voice.pulse_width = odd(pick(r, [0.1, 0.5, 0.9, 2048, 4094, 100]));
    if (chance(r, 0.4)) voice.adsr = [0, 1, 2, 3].map(() => odd(int(r, 0, 15)));
    if (chance(r, 0.4)) voice.instrument = instRef();
    if (modern && chance(r, 0.1)) voice.detune = odd(int(r, -100, 100));
    voice.patterns = {};
    const names = ["A", "B", "C", "Lead", "p1"].slice(0, int(r, 1, 3));
    for (const name of names) voice.patterns[name] = genPattern(r, odd, modern, instRef);
    doc.voices.push(voice);
    players.push({ voice, id: voice.id ?? slot + 1, slot, names });
  }
  if (badName && doc.voices.length) doc.voices[0].instrument = badName;
  // Echo and unison copies replace the pattern set of an extra voice.
  if (modern && players.length && chance(r, 0.3)) {
    const used = new Set(slots);
    for (let n = 0; n < int(r, 1, 3); n++) {
      const slot = Array.from({ length: capacity }, (_, i) => i).find((s) => !used.has(s) && chance(r, 0.5));
      if (slot === undefined) break;
      used.add(slot);
      const source = pick(r, players);
      const copy = { id: slot + 1 };
      copy[chance(r, 0.5) ? "echo" : "unison"] = undefined;
      delete copy.echo; delete copy.unison;
      if (chance(r, 0.5)) copy.echo = { voice: source.id, delay: odd(int(r, 1, 40)), volume: pick(r, [0, 0.25, 0.5, 1]), ...(chance(r, 0.5) ? { detune: int(r, -100, 100) } : {}) };
      else copy.unison = { voice: source.id, ...(chance(r, 0.5) ? { detune: int(r, -100, 100) } : {}) };
      doc.voices.push(copy);
    }
  }

  // Timeline
  const sections = big ? int(r, 4, 12) : int(r, 1, 5);
  doc.timeline = [];
  for (let s = 0; s < sections; s++) {
    const section = { bars: odd(big ? int(r, 4, 32) : weighted(r, [[1, 3], [2, 4], [4, 3], [8, 2], [int(r, 9, 40), 0.3]])) };
    if (chance(r, 0.5)) section.section = pick(r, ["Intro", "", "Ünï", "s".repeat(80)]);
    if (chance(r, 0.15)) section.tempo = int(r, 40, 210);
    if (chance(r, 0.1)) section.swing = pick(r, [0, 0.25, 0.5]);
    section.layers = {};
    for (const p of players) {
      if (!chance(r, big ? 0.95 : 0.7)) { if (chance(r, 0.3)) section.layers[`v${p.id}`] = "-"; continue; }
      section.layers[`v${p.id}`] = pick(r, p.names) + pick(r, ["", "", "", "", "↑", "↓", "^", "+5", "-3", "–", "—", "-", "+0", "+12"]);
    }
    doc.timeline.push(section);
  }
  if (chance(r, 0.1)) doc.length_bars = odd(int(r, 1, 20));

  // Samples (digis)
  if (modern && chance(r, big ? 0.9 : 0.2)) {
    const rate = weighted(r, [[int(r, 16, 500), 1], [int(r, 500, 3000), 3], [int(r, 3000, 8000), 2], [8000, 1], [4000, 2]]);
    const defs = {};
    const loops = [];
    const defCount = big ? int(r, 20, 80) : int(r, 1, 4);
    for (let i = 0; i < defCount; i++) {
      const name = `d${i}`;
      const kind = pick(r, ["kit", "synth", "b64", "hex", "synth", "kit"]);
      const loop = chance(r, 0.15);
      defs[name] = kind === "kit" ? { kit: pick(r, ["kick", "snare", "clap", "hat", "tom", "zap"]) }
        : kind === "b64" ? { b64: Buffer.from(Array.from({ length: int(r, 1, 40) }, () => int(r, 0, 255))).toString("base64") }
        : kind === "hex" ? { hex: Array.from({ length: int(r, 1, 40) }, () => int(r, 0, 15).toString(16)).join("") }
        : { synth: { layers: [{ osc: pick(r, ["sine", "triangle", "square", "saw", "noise"]), freq: int(r, 60, 2000), ...(chance(r, 0.3) ? { to: int(r, 60, 2000) } : {}), ms: int(r, 5, big ? 40 : 200) }],
          ...(chance(r, 0.3) ? { env: { a: 2, d: 20, s: 0.5, r: 30 } } : {}), ...(chance(r, 0.2) ? { seed: int(r, 0, 99) } : {}) } };
      if (loop) { defs[name].loop = true; loops.push(name); }
    }
    const names = Object.keys(defs);
    const triggers = [];
    const total = 4;
    for (let i = 0; i < (big ? int(r, 5, 40) : int(r, 1, 4)); i++) {
      const name = pick(r, names);
      const t = { sid: pick(r, sidIds), sample: name };
      if (!chance(r, 0.6)) delete t.sid;
      if (loops.includes(name)) t.length_beats = pick(r, [1, 2, 0.5]);
      if (chance(r, 0.15)) t.pitch = int(r, -12, 12);
      const form = pick(r, ["at", "bar", "at_beat", "pattern"]);
      if (form === "at") t.at = Array.from({ length: int(r, 1, 6) }, () => int(r, 0, 400));
      else if (form === "bar") { t.bar = int(r, 1, 2); t.beat = pick(r, [1, 2, 1.5, 3.25]); }
      else if (form === "at_beat") t.at_beat = [pick(r, [0, 1, 2.5]), { bar: 1, beat: 3 }];
      else {
        delete t.sample; delete t.length_beats;
        t.pattern = { steps: pick(r, ["k...s.k.", "k.s.", "a.b.c.d."]), map: { k: names[0], s: pick(r, names), a: names[0], b: pick(r, names), c: pick(r, names), d: pick(r, names) },
          ...(chance(r, 0.3) ? { from_bar: 1, to_bar: 2, every: 1 } : {}) };
        if (names.some((n) => loops.includes(n)) && [t.pattern.map.k, t.pattern.map.s].some((n) => loops.includes(n))) t.pattern.map = { k: names.find((n) => !loops.includes(n)) ?? names[0] };
      }
      triggers.push(t);
    }
    doc.samples = { rate: odd(rate), defs, [pick(r, ["voices", "triggers"])]: triggers };
    if (!doc.voices.length || chance(r, 0.05)) { doc.voices = []; doc.timeline = [{ bars: int(r, 1, 4), layers: {} }]; }
    void total;
  }
  if (!doc.voices.length && !doc.samples) doc.voices.push({ id: 1, patterns: { A: { groove: ["C3"] } } }), doc.timeline = [{ bars: 1, layers: { v1: "A" } }];
  return doc;
}

/** Legal timing and disjoint mixer duties give each R2 feature an executable case. */
export function genRound2Doc(r, i) {
  const meter = chance(r, 0.2) ? 3 : 4;
  const model = pick(r, ["6581", "8580"]);
  const pattern = Array.from({ length: meter }, (_, beat) =>
    beat === 0 ? pick(r, ["C3!", "D3!", "E3!"]) : beat === 1 ? "/G3" : "-").join(" ");
  const sample = pick(r, [
    { hex: "03f2e" }, { b64: "A/5I" },
    { synth: { osc: "triangle", freq: 330, ms: 40, gain: 0.35, env: { a: 2, s: 0.75, r: 10 } } },
  ]);
  const doc = {
    sidwave: "1.2", title: "Round 2 grammar", mode: pick(r, ["PAL", "NTSC"]),
    tempo: int(r, 82, 128), meter, speed: int(r, 1, 4), cpu: "turbo", accent: int(r, 0, 8),
    sids: [
      { id: "main", address: "$D400", model, pan: "Left 5", filter: { owner: "v1", route: [1, 2] } },
      { id: "mirror", address: "$D420", model, pan: "Right 5" },
      { id: "digi", address: "$D440", volume: 8 },
    ],
    instruments: {
      bass: { waveform: "pulse", adsr: [0, 5, 10, 3],
        filtertable: { reset: chance(r, 0.5), steps: [{ cutoff: pick(r, ["500Hz", "900Hz", "1.2kHz", "2kHz"]), resonance: 6, type: "lowpass" }, { add: -7, frames: 5 }] },
        pulsetable: { reset: false, loop: 1, steps: [{ set: 0.25 }, { add: 7, frames: 12 }, { add: -7, frames: 12 }] } },
      sync: { waveform: "sawtooth", sync: true, source_note: pick(r, ["+7", "+0", "E3"]),
        wavetable: [{ wave: "saw", note: "+7", slide_to: "+0", frames: int(r, 2, 5) }, { wave: "saw", calls: 2 }] },
    },
    voices: [
      { id: 1, role: "bass", level: "mf", instrument: "bass", patterns: { A: { groove: pattern, bars: 1 } } },
      { id: 3, role: "lead", instrument: "sync", patterns: { M: { length: 0.5, groove: "(A3 C4) E4! - E4 - - -" } } },
      { id: "d1", digi: "digi", patterns: { P: { length: 1, drums: { kit: { k: "sample:hit" }, steps: meter === 3 ? "k.." : "k..." } } } },
    ],
    samples: { rate: int(r, 1500, 3000), defs: { hit: sample, ping: { hex: "057eff" } },
      triggers: [{ sid: "digi", sample: "ping", at_beat: [{ bar: 2, beat: 2 }], pitch: int(r, -3, 3) }] },
    sections: {
      intro: { bars: 1, level: "p", layers: { v1: "A" } },
      part: { bars: 2, level: { from: "mp", to: "ff" }, levels: { v3: "f" }, volume: { main: { from: 12, to: 15 } },
        filter: { main: { cutoff: { from: -40, to: 210 }, resonance: 10 } },
        tempo: { to: int(r, 78, 96) }, swing: pick(r, [0.55, 0.625, 0.7]), layers: { v1: "(A A+2)*1", v3: "M -*1", d1: "P*2" } },
    },
    timeline: ["intro", { use: "part", transpose: int(r, -3, 3) }, "intro*1"],
    swing: 0.6, swing_unit: pick(r, [0.25, 0.5]),
  };
  // A source oscillator on v3 occupies v2, leaving v1 and its opposite SID free.
  if (i % 5 === 4) {
    doc.sids = { layout: "ultisid8+socket1", pan: pick(r, ["wide", "narrow"]),
      overrides: { sid1: { model }, sid5: { model }, sid9: { volume: 8 } } };
    delete doc.sections.part.filter;
    doc.sections.part.volume = { sid1: 13 };
    doc.voices[0].center = true;
    doc.voices[2].digi = "sid9";
    doc.samples.triggers[0].sid = "sid9";
  } else if (i % 3 === 1) {
    doc.voices[0].center = { sid: "mirror", channel: 1, level: int(r, 8, 12) };
  }
  if (i % 2 === 0) doc.loop_to = chance(r, 0.5) ? "part" : 2;
  else doc.end = { hold_beats: pick(r, [0, 0.5, 1]), release: chance(r, 0.75) };
  return doc;
}

function filterEnv(r, odd, local) {
  const env = { cutoff_base: odd(int(r, 0, 2047)) };
  if (chance(r, 0.6)) { env.sweep = int(r, -2047, 2047); env.speed = pick(r, [0.5, 1, 4, 3.99, 16]); }
  if (chance(r, 0.4)) env.resonance = int(r, 0, 15);
  if (chance(r, 0.4)) env.type = pick(r, ["lowpass", "bandpass", "highpass"]);
  if (chance(r, 0.3)) env.voices = Array.from({ length: int(r, 1, 3) }, () => int(r, 1, 3));
  void local;
  return env;
}

function genInstrument(r, odd, modern) {
  const inst = {};
  if (chance(r, 0.6)) inst.waveform = pick(r, WAVES);
  if (chance(r, 0.5)) inst.adsr = [0, 1, 2, 3].map(() => odd(int(r, 0, 15)));
  if (chance(r, 0.3)) inst.pulse_width = odd(pick(r, [0.25, 1024, 3000]));
  if (chance(r, 0.4)) {
    inst.wavetable = Array.from({ length: int(r, 1, 6) }, () => {
      const step = {};
      if (chance(r, 0.7)) step.wave = pick(r, TABLE_WAVES);
      if (chance(r, 0.5)) step.note = pick(r, ["+0", "+12", "-5", "C5", "A2", "C3", "B7", "C0"]);
      if (chance(r, 0.5)) step.frames = odd(int(r, 1, 8));
      for (const flag of ["ring", "sync", "test"]) if (chance(r, 0.1)) step[flag] = true;
      if (chance(r, 0.1)) step.gate = false;
      return step;
    });
    if (chance(r, 0.4)) inst.loop = int(r, 0, inst.wavetable.length - 1);
  }
  if (chance(r, 0.3)) {
    const steps = Array.from({ length: int(r, 1, 5) }, () => (chance(r, 0.5) ? { set: pick(r, [0.25, 0.5, 1, 1000, 4094, 2048]), ...(chance(r, 0.3) ? { frames: int(r, 1, 20) } : {}) }
      : { add: int(r, -100, 100), frames: int(r, 1, 30) }));
    inst.pulsetable = chance(r, 0.5) ? steps : { steps, ...(chance(r, 0.5) ? { loop: int(r, 0, steps.length - 1) } : {}) };
  }
  if (chance(r, 0.25)) {
    const steps = Array.from({ length: int(r, 1, 5) }, () => ({
      ...(chance(r, 0.5) ? { cutoff: int(r, 0, 2047) } : { add: int(r, -300, 300) }),
      ...(chance(r, 0.5) ? { frames: int(r, 1, 30) } : {}), ...(chance(r, 0.4) ? { resonance: int(r, 0, 15) } : {}), ...(chance(r, 0.4) ? { type: pick(r, FILTER_TYPES) } : {}),
    }));
    inst.filtertable = chance(r, 0.5) ? steps : { steps, ...(chance(r, 0.4) ? { loop: int(r, 0, steps.length - 1) } : {}) };
  }
  if (chance(r, 0.2)) inst.vibrato = { depth: pick(r, [0.1, 0.5, 2]), rate: pick(r, [1, 5, 10]), ...(chance(r, 0.5) ? { delay: int(r, 0, 30) } : {}) };
  if (chance(r, 0.15)) inst.slide = { depth: pick(r, [-12, 2, 5]), speed: int(r, 1, 20) };
  if (chance(r, 0.2)) inst.portamento = odd(int(r, 0, 40));
  if (chance(r, 0.15)) inst.legato = chance(r, 0.5);
  if (chance(r, 0.1)) inst.ring = true;
  if (chance(r, 0.1)) inst.sync = true;
  if (modern && chance(r, 0.25)) {
    const frames = odd(int(r, 0, 5));
    inst.hard_restart = frames === 0 ? { frames: 0 } : { frames, ...(chance(r, 0.5) ? { adsr: [0, 1, 2, 3].map(() => int(r, 0, 15)) } : {}), ...(chance(r, 0.4) ? { test: true } : {}) };
  }
  return inst;
}

/** Invalid instrument fields for the parser rejection path. */
function badInstrumentField(r) {
  return pick(r, [
    () => ({ adsr: [99, 0, 0, 0] }), () => ({ adsr: [-1, 2, 3, 4] }), () => ({ adsr: ["x", 0, 0, 0] }), () => ({ adsr: [1.5, 0, 0, 0] }), () => ({ adsr: [null, null, null, null] }),
    () => ({ pulse_width: 99999 }), () => ({ pulse_width: -5 }), () => ({ pulse_width: "x" }), () => ({ pulse_width: 0 }),
    () => ({ waveform: [] }), () => ({ waveform: 7 }), () => ({ waveform: "banana" }), () => ({ waveform: null }),
    () => ({ vibrato: "x" }), () => ({ vibrato: { depth: -5, rate: -1 } }), () => ({ vibrato: {} }), () => ({ vibrato: { depth: 1e9, rate: 1e9 } }), () => ({ vibrato: { depth: 5, rate: 5, delay: -3 } }),
    () => ({ slide: "x" }), () => ({ slide: {} }), () => ({ slide: { depth: 1e6, speed: 0 } }), () => ({ slide: { depth: 3, speed: 0 } }),
    () => ({ ring: "yes" }), () => ({ sync: 5 }), () => ({ wave: "banana" }), () => ({ loop: 99 }), () => ({ loop: -1 }),
    () => ({ hard_restart: { frames: 3, adsr: [99, 99, 99, 99], test: "x" } }), () => ({ hard_restart: "x" }),
  ])();
}

function genNote(r, wide) {
  const lo = wide ? 12 : 24;
  const hi = wide ? 107 : 84;
  return noteName(int(r, lo, hi));
}

function genGrooveEntry(r, odd, modern, instRef, wide) {
  const kind = weighted(r, [["note", 6], ["rest", 2], ["tie", 1.5], ["inst", 2], ["obj", 3], ["chord", modern ? 1.5 : 0.2], ["arpobj", modern ? 1 : 0.2], ["dot", 0.3]]);
  if (kind === "note") return genNote(r, wide);
  if (kind === "rest") return "-";
  if (kind === "dot") return ".";
  if (kind === "tie") return chance(r, 0.8) ? "~" : null;
  if (kind === "inst") return `${genNote(r, wide)}@${instRef()}`;
  if (kind === "chord") return `${pick(r, CHORDS).replace("C", pick(r, ["C", "D", "Eb", "A"]))}@arp`;
  if (kind === "arpobj") {
    const e = { chord: pick(r, CHORDS), ...(chance(r, 0.5) ? { arp: Array.from({ length: int(r, 1, 6) }, () => int(r, -12, 24)).join(",") } : {}), ...(chance(r, 0.5) ? { speed: odd(int(r, 1, 6)) } : {}) };
    if (chance(r, 0.3)) e.len = pick(r, [0.5, 1, 2]);
    return e;
  }
  const e = { note: genNote(r, wide) };
  if (chance(r, 0.3)) e.inst = instRef();
  if (chance(r, 0.4)) e.len = odd(pick(r, [0.25, 0.5, 1, 1.5, 2, 4]));
  if (chance(r, 0.3)) e.legato = chance(r, 0.7);
  const style = weighted(r, [["none", 5], ["porta", 1], ["slide_from", 1], ["bend", modern ? 1.5 : 0], ["gate_off", modern ? 1 : 0]]);
  if (style === "porta") e.portamento = odd(int(r, 0, 20));
  else if (style === "slide_from") { e.slide_from = genNote(r, false); if (chance(r, 0.5)) e.portamento = int(r, 1, 10); }
  else if (style === "bend") e.bend = { to: chance(r, 0.5) ? int(r, -12, 12) : genNote(r, false), frames: odd(int(r, 1, 20)) };
  else if (style === "gate_off") e.gate_off = odd(int(r, 0, 10));
  return e;
}

function genPattern(r, odd, modern, instRef) {
  const type = weighted(r, [["groove", 6], ["drums", 1.5], ["arp", 2], ["motif", 2]]);
  const wide = chance(r, 0.05);
  const pattern = {};
  if (chance(r, 0.7)) pattern.length = odd(pick(r, [0.25, 0.5, 0.5, 1, 1, 1.5, 2, 0.125, 4, 1 / 64]));
  if (type === "groove") pattern.groove = Array.from({ length: weighted(r, [[int(r, 1, 6), 3], [int(r, 7, 16), 3], [int(r, 17, 64), 1]]) }, () => genGrooveEntry(r, odd, modern, instRef, wide));
  else if (type === "drums") {
    const letters = ["k", "s", "h", "x"].slice(0, int(r, 1, 4));
    pattern.drums = { kit: Object.fromEntries(letters.map((l) => [l, pick(r, LIB)])), steps: Array.from({ length: int(r, 1, 24) }, () => (chance(r, 0.4) ? "." : pick(r, letters))).join("") };
  } else if (type === "arp") {
    pattern.type = "arpeggio";
    pattern.notes = Array.from({ length: int(r, 1, 6) }, () => genNote(r, wide));
    if (chance(r, 0.6)) pattern.frame_rate = odd(int(r, 1, 8));
  } else {
    pattern.motif = Array.from({ length: int(r, 1, 10) }, () => pick(r, [genNote(r, false), "0", "4", "7", "12", "-", "~", "Cm9", "Am7", "pad", "F", "Gsus4"])).join(pick(r, [" ", ",", ", "]));
    if (chance(r, 0.4)) pattern.root = genNote(r, false);
  }
  if (chance(r, 0.3)) pattern.transpositions = Array.from({ length: int(r, 1, 4) }, () => int(r, -12, 12));
  if (chance(r, 0.35)) {
    pattern.fx = {};
    if (chance(r, 0.5)) pattern.fx.vibrato = { depth: odd(pick(r, [0.05, 0.3, 1, 3])), rate: odd(pick(r, [0.5, 4, 8, 12])), ...(chance(r, 0.5) ? { delay: int(r, 0, 30) } : {}) };
    if (chance(r, 0.3)) pattern.fx.pwm_sweep = { depth: odd(pick(r, [0.1, 0.3, 500])), speed: odd(pick(r, [0.5, 1, 4])) };
    if (chance(r, 0.3)) pattern.fx.slide = { depth: odd(pick(r, [-12, -2, 3, 12])), speed: odd(int(r, 1, 30)) };
    if (chance(r, 0.3)) pattern.fx.filter_mod = chance(r, 0.5) ? { sweep: pick(r, ["+500 over 8 steps", "-300 over 2 beats", "100"]) } : { sweep: int(r, -2000, 2000), [pick(r, ["steps", "beats", "bars", "frames"])]: pick(r, [1, 2, 8]) };
  }
  return pattern;
}

// ---------------------------------------------------------------------------
// Harness

/** Addresses the player may write besides the SID windows (digi banking, zero page, stack, vectors, CIA, turbo). */
function allowedElsewhere(a) {
  return a === 0x01 || (a >= 0xfb && a <= 0xfe) || (a >= 0x100 && a <= 0x1ff) || a === 0x314 || a === 0x315 || a === 0x318 || a === 0x319
    || (a >= 0xdc00 && a <= 0xdc0f) || (a >= 0xdd00 && a <= 0xdd0f) || a === 0xd030 || a === 0xd031;
}

const norm = (s) => String(s).replace(/0x[0-9a-f]+|\$[0-9a-f]+|-?\d+(\.\d+)?/gi, "#").slice(0, 90);
export const signature = (f) => `${f.kind}|${norm(f.detail ?? "")}`;

function cleanError(stage, error, fault) {
  if (error instanceof SidwaveValidationError) {
    if (typeof error.path !== "string" || !error.path.startsWith("$") || !error.message.includes(error.path)) fault(`${stage}-error-without-path`, `${error.path}: ${error.message}`);
    return;
  }
  const name = error?.constructor?.name ?? typeof error;
  fault(`${stage}-unclean-error:${name}`, `${error?.message ?? error}`.split("\n")[0]);
}

/**
 * Parses, compiles and plays one document and returns the invariant violations found.
 * `input` is a document object or text. Returns { outcome, faults, stats }.
 */
export function exercise(input, { loop = true, maxCalls = 1500, checkPsid = true, label = "", compileBudgetMs = 15_000, determinism = false } = {}) {
  const faults = [];
  const fault = (kind, detail) => faults.push({ kind, detail });
  const stats = { calls: 0, totalFrames: 0, compileMs: 0, maxCycles: 0, estimate: 0, prgBytes: 0 };
  const before = typeof input === "object" ? safeJson(input) : undefined;
  const t0 = performance.now();
  let doc;
  try { doc = parseSidwave(input); } catch (error) { cleanError("parse", error, fault); return { outcome: "invalid", faults, stats, error }; }
  if (before !== undefined && safeJson(input) !== before) fault("parse-mutated-input", "parseSidwave modified the object it was given");
  const parseMs = performance.now() - t0;
  if (parseMs > 3000) fault("parse-slow", `parse took ${Math.round(parseMs)} ms`);

  let compiled;
  const t1 = performance.now();
  try { compiled = compileSidwaveToPrg(doc, { loop }); } catch (error) { cleanError("compile", error, fault); stats.compileMs = performance.now() - t1; return { outcome: "refused", faults, stats, doc, error }; }
  stats.compileMs = performance.now() - t1;
  if (stats.compileMs > compileBudgetMs) fault("compile-slow", `compile took ${Math.round(stats.compileMs)} ms`);
  Object.assign(stats, { totalFrames: compiled.totalFrames, estimate: compiled.worstCaseCyclesPerCall, prgBytes: compiled.prg.length });

  checkCompiled(doc, compiled, fault);
  if (determinism) {
    const again = compileSidwaveToPrg(doc, { loop });
    if (!again.prg.equals(compiled.prg)) fault("compile-nondeterministic", "two compiles of the same parsed document differ");
  }
  try { emulate(doc, compiled, { loop, maxCalls }, fault, stats); } catch (error) { fault("emulation-harness-error", `${error?.stack ?? error}`.split("\n").slice(0, 2).join(" ")); }
  if (checkPsid) checkPsidRoundTrip(doc, compiled, fault);
  void label;
  return { outcome: "played", faults, stats, doc, compiled };
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return "unserialisable"; }
}

function checkCompiled(doc, c, fault) {
  if (!Buffer.isBuffer(c.prg)) return fault("prg-not-buffer", typeof c.prg);
  if (c.prg.readUInt16LE(0) !== 0x0801) fault("prg-load-address", `load address ${c.prg.readUInt16LE(0)}`);
  const end = 0x0801 + c.prg.length - 2;
  if (end !== c.endAddress) fault("prg-end-mismatch", `end ${end} vs reported ${c.endAddress}`);
  if (c.endAddress + 3 > SIDWAVE_MEMORY_END) fault("prg-above-d000", `PRG ends at $${c.endAddress.toString(16)}`);
  if (c.bytesBelowD000 < 0) fault("prg-negative-headroom", `${c.bytesBelowD000}`);
  for (const key of ["totalFrames", "framesPerSecond", "worstCaseCyclesPerCall"]) {
    if (!Number.isFinite(c[key]) || c[key] < 0) fault("compile-result-not-finite", `${key} = ${c[key]}`);
  }
  if (!(c.totalFrames > 0)) fault("compile-result-empty-song", `totalFrames = ${c.totalFrames}`);
  if (c.streamBytes.length !== doc.voices.length && c.streamBytes.length !== doc.sids.length * 3) fault("compile-result-stream-count", `${c.streamBytes.length} streams for ${doc.voices.length} voices`);
  if (c.requiresTurbo && !doc.cpu && doc.sids.length > 0 && c.warnings.length === 0 && doc.version === "1.2") fault("turbo-needed-but-not-declared", `estimate ${c.worstCaseCyclesPerCall}`);
}

export function emulate(doc, compiled, { loop, maxCalls }, fault, stats = {}) {
  const mem = new Uint8Array(65536);
  mem.set(compiled.prg.subarray(2), compiled.loadAddress);
  mem[0xea31] = 0x60;
  mem[0x02a6] = 1;
  const windows = doc.sids.map(({ address }) => address);
  const own = [compiled.loadAddress, compiled.endAddress + 3];
  const stray = new Map();
  const junk = new Map();
  let sidWrites = 0;
  let raster = 100;
  let pending = 0;
  let installing = false;
  const cpu = new Cpu(mem, {
    write(a, v) {
      if (a >= 0xd400 && a <= 0xd7ff) {
        const base = windows.find((b) => a >= b && a <= b + 24);
        if (base !== undefined) {
          sidWrites++;
          const off = a - base;
          // The unused high bits of the pulse width and cutoff registers stay clear in a correct player.
          if ((off === 3 || off === 10 || off === 17) && v > 0x0f) junk.set(`pulse width high byte ${off}`, v);
          if (off === 21 && v > 7) junk.set("filter cutoff low register", v);
        } else stray.set(a, (stray.get(a) ?? 0) + 1);
      } else if (!(allowedElsewhere(a) || (installing && a >= 0x2b && a <= 0x32) || (a >= own[0] && a < own[1]))) stray.set(a, (stray.get(a) ?? 0) + 1);
    },
    read(a) {
      if (a === 0xd012) return (raster = (raster + 1) % 312) & 0xff;
      if (a === 0xdd0d) { const value = pending; pending = 0; return value; }
    },
  });
  mem[0xfb] = 0x12; mem[0xfc] = 0x34; mem[0xfd] = 0x56; mem[0xfe] = 0x78;
  loop = loop && !doc.end;
  const total = compiled.totalFrames;
  // The 1.2 player fades the master volume by one step per video frame, i.e. per `speed` play calls.
  const tail = 16 * doc.speed + 10;
  const calls = Math.min(maxCalls, loop ? total + 10 : total + tail + 30);
  const stop = (kind, detail) => { fault(kind, detail); };
  try {
    if (compiled.digiNmiAddress !== undefined) {
      if (doc.song.mode === "NTSC") raster = 0;
      mem.set([0x78, 0x6c, 0x18, 0x03], 0xfe43);
      mem.set([0x43, 0xfe], 0xfffa);
      mem.set([0, 0xfe], 0x0318);
      mem[0xfe00] = 0x40;
      installing = true;
      cpu.call(compiled.entryAddress, 0, 2_000_000);
      installing = false;
      if ((mem[0x0318] | (mem[0x0319] << 8)) !== compiled.digiNmiAddress) fault("digi-vector-uninstalled", "CIA2 NMI vector did not install");
    } else cpu.call(compiled.initAddress, 0, 2_000_000);
    const phi2 = doc.song.mode === "NTSC" ? 1_022_727 : 985_248;
    let ciaElapsed = 0;
    let previousPeriod = 0;
    let maxCycles = 0;
    let lateWrites = 0;
    for (let i = 0; i < calls; i++) {
      const w0 = sidWrites;
      let cycles = cpu.call(compiled.playAddress, 0, 400_000);
      if (compiled.digiNmiAddress !== undefined && (mem[0xdd0e] & 1)) {
        const period = (mem[0xdd04] | (mem[0xdd05] << 8)) + 1;
        if (period !== previousPeriod) ciaElapsed = 0;
        previousPeriod = period;
        ciaElapsed += phi2 / compiled.framesPerSecond;
        while (ciaElapsed >= period && (mem[0xdd0e] & 1)) {
          pending = 0x81;
          const nmiCycles = cpu.nmi();
          if (nmiCycles > compiled.digiWorstCaseCyclesPerNmi) {
            fault("digi-cycles-above-estimate", `NMI took ${nmiCycles}, estimate ${compiled.digiWorstCaseCyclesPerNmi}`);
          }
          cycles += nmiCycles;
          ciaElapsed -= period;
        }
      } else ciaElapsed = previousPeriod = 0;
      maxCycles = Math.max(maxCycles, cycles);
      if (!loop && i >= total + tail && sidWrites > w0) lateWrites++;
      stats.calls = i + 1;
    }
    stats.maxCycles = maxCycles;
    if (maxCycles > compiled.worstCaseCyclesPerCall) stop(maxCycles > compiled.worstCaseCyclesPerCall * 1.15 ? "cycles-far-above-estimate" : "cycles-above-estimate", `play call took ${maxCycles} cycles, estimate ${compiled.worstCaseCyclesPerCall}`);
    if (lateWrites) stop("writes-after-song-end", `${lateWrites} play calls after the song end and fade still wrote SID registers (loop: false)`);
    for (let k = 0xfb; k <= 0xfe; k++) if (mem[k] !== [0x12, 0x34, 0x56, 0x78][k - 0xfb]) stop("zero-page-clobbered", `$${k.toString(16)} changed`);
  } catch (error) {
    stop("emulation-fault", `${error?.message ?? error}`);
  }
  for (const [what, value] of junk) stop("register-reserved-bits-set", `${what} written as $${value.toString(16)}`);
  for (const [address, count] of stray) stop("stray-write", `write to $${address.toString(16)} (${count}x)`);
}

/** Checks the PSID header against the document, or that the compiler refuses cleanly when PSID cannot hold it. */
export function checkPsidRoundTrip(doc, compiled, fault) {
  const primary = doc.sids.find(({ address }) => address === 0xd400);
  const psidOk = doc.sids.length <= 3 && primary && !doc.samples;
  let sid;
  try { ({ sid } = compileSidwaveToSid(doc, compiled.prg)); } catch (error) {
    if (psidOk) fault("psid-refused-valid-doc", `${error?.message}`.split("\n")[0]);
    else cleanError("psid", error, fault);
    return;
  }
  if (!psidOk) { fault("psid-accepted-unsupported-doc", `${doc.sids.length} SIDs, samples ${!!doc.samples}, primary ${!!primary}`); return; }
  const expectedVersion = doc.sids.length >= 3 ? 4 : doc.sids.length === 2 ? 3 : 2;
  const bad = (what, got, want) => fault(`psid-header-${what}`, `${what}: got ${got}, expected ${want}`);
  if (sid.subarray(0, 4).toString("ascii") !== "PSID") bad("magic", sid.subarray(0, 4), "PSID");
  if (sid.readUInt16BE(4) !== expectedVersion) bad("version", sid.readUInt16BE(4), expectedVersion);
  if (sid.readUInt16BE(6) !== 0x7c) bad("data-offset", sid.readUInt16BE(6), 0x7c);
  if (sid.readUInt16BE(8) !== 0) bad("load", sid.readUInt16BE(8), 0);
  if (sid.readUInt16BE(10) !== compiled.initAddress) bad("init", sid.readUInt16BE(10), compiled.initAddress);
  if (sid.readUInt16BE(12) !== compiled.playAddress) bad("play", sid.readUInt16BE(12), compiled.playAddress);
  if (sid.readUInt16BE(14) !== 1 || sid.readUInt16BE(16) !== 1) bad("songs", `${sid.readUInt16BE(14)}/${sid.readUInt16BE(16)}`, "1/1");
  if (sid.readUInt32BE(18) !== (doc.speed > 1 ? 1 : 0)) bad("speed", sid.readUInt32BE(18), doc.speed > 1 ? 1 : 0);
  const latin = (offset) => { const raw = sid.subarray(offset, offset + 32); const z = raw.indexOf(0); return raw.subarray(0, z < 0 ? 32 : z).toString("latin1"); };
  const text = (s) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/[^\u0000-\u00ff]/gu, "?").slice(0, 32);
  if (latin(0x16) !== text(doc.song.title)) bad("title", JSON.stringify(latin(0x16)), JSON.stringify(text(doc.song.title)));
  if (latin(0x36) !== text(doc.song.author ?? "SIDWAVE")) bad("author", JSON.stringify(latin(0x36)), JSON.stringify(text(doc.song.author ?? "SIDWAVE")));
  const flags = sid.readUInt16BE(0x76);
  const clock = (flags >> 2) & 3;
  if (clock !== (doc.song.mode === "NTSC" ? 2 : 1)) bad("clock", clock, doc.song.mode);
  if (flags & 3) bad("flags-low", flags & 3, 0);
  const ordered = [primary, ...doc.sids.filter((s) => s !== primary)];
  ordered.forEach((s, i) => {
    const model = (flags >> (4 + 2 * i)) & 3;
    const want = s.model === "6581" ? 1 : s.model === "8580" ? 2 : 0;
    if (model !== want) bad(`sid${i + 1}-model`, model, want);
  });
  if (flags >> (4 + 2 * ordered.length) !== 0) bad("flags-high", flags >> (4 + 2 * ordered.length), 0);
  for (let i = 1; i < 3; i++) {
    const want = ordered[i] ? (ordered[i].address - 0xd000) >> 4 : 0;
    if (sid[0x79 + i] !== want) bad(`sid${i + 1}-address-byte`, sid[0x79 + i].toString(16), want.toString(16));
  }
  if (sid[0x78] !== 0 || sid[0x79] !== 0) bad("reloc", `${sid[0x78]},${sid[0x79]}`, "0,0");
  if (!sid.subarray(0x7c).equals(compiled.prg)) bad("body", "differs", "the PRG bytes");
}

// ---------------------------------------------------------------------------
// Minimiser

/** Shrinks a JSON-like document while `still(doc)` stays true. Returns the smallest document found. */
export function minimize(original, still, { maxTests = 400, maxMs = 60_000 } = {}) {
  let best = JSON.parse(JSON.stringify(original));
  const start = performance.now();
  let tests = 0;
  const test = (candidate) => {
    if (tests >= maxTests || performance.now() - start > maxMs) return false;
    tests++;
    try { return still(candidate); } catch { return false; }
  };
  const paths = (value, prefix = []) => {
    const out = [];
    if (value && typeof value === "object") for (const key of Object.keys(value)) { out.push([...prefix, key]); out.push(...paths(value[key], [...prefix, key])); }
    return out;
  };
  const get = (doc, path) => path.reduce((o, k) => o?.[k], doc);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  let changed = true;
  while (changed && tests < maxTests && performance.now() - start < maxMs) {
    changed = false;
    // Shallow paths first removes whole subtrees early; each round walks the paths of the current best once.
    for (const path of paths(best).sort((a, b) => a.length - b.length)) {
      const parent = get(best, path.slice(0, -1));
      const key = path[path.length - 1];
      if (parent === undefined || parent === null || typeof parent !== "object" || !(key in parent)) continue;
      const candidate = clone(best);
      const holder = get(candidate, path.slice(0, -1));
      if (Array.isArray(holder)) holder.splice(Number(key), 1); else delete holder[key];
      if (test(candidate)) { best = candidate; changed = true; continue; }
      const value = parent[key];
      const simpler = typeof value === "number" ? [0, 1, Math.trunc(value / 2)].filter((v) => v !== value)
        : typeof value === "string" && value.length > 1 ? [value.slice(0, Math.ceil(value.length / 2))]
        : Array.isArray(value) && value.length > 1 ? [value.slice(0, Math.ceil(value.length / 2)), value.slice(Math.floor(value.length / 2))] : [];
      for (const replacement of simpler) {
        const c2 = clone(best);
        get(c2, path.slice(0, -1))[key] = replacement;
        if (test(c2)) { best = c2; changed = true; break; }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Metamorphic checks: equivalent spellings of one document must compile to the same PRG.

function mapJson(value, fn) {
  if (Array.isArray(value)) return value.map((v) => mapJson(v, fn));
  if (value && typeof value === "object") return Object.fromEntries(fn.keys(Object.entries(value)).map(([k, v]) => [k, mapJson(v, fn)]));
  return fn.leaf(value);
}

/**
 * Variants of `doc` that must compile to the same bytes: numbers written as numeric strings, and keys of the document,
 * voices, sections and SID entries in a different order. Named maps (instruments, patterns, sample definitions) keep their order
 * because their order legitimately decides instrument numbers and sample layout.
 */
export function equivalentVariants(r, doc) {
  const numeric = mapJson(doc, { keys: (e) => e, leaf: (v) => (typeof v === "number" && Number.isFinite(v) && (r === null || chance(r, 0.5)) ? String(v) : v) });
  const order = (object) => Object.fromEntries(r === null ? Object.entries(object).reverse() : Object.entries(object).sort(() => r() - 0.5));
  const shuffled = order(doc);
  for (const key of ["voices", "timeline", "sids"]) {
    if (Array.isArray(shuffled[key])) shuffled[key] = shuffled[key].map((entry) => (entry && typeof entry === "object" && !Array.isArray(entry) ? order(entry) : entry));
  }
  return { "numbers written as strings": numeric, "keys in a different order": shuffled };
}

/** Compiles `doc` and each equivalent variant; reports variants that are rejected or compile to different bytes. */
export function checkEquivalence(r, doc, { loop = false } = {}) {
  const faults = [];
  let base;
  try { base = compileSidwaveToPrg(parseSidwave(doc), { loop }).prg; } catch { return faults; }
  for (const [what, variant] of Object.entries(equivalentVariants(r, doc))) {
    let other;
    try { other = compileSidwaveToPrg(parseSidwave(variant), { loop }).prg; } catch (error) {
      faults.push({ kind: "equivalent-variant-rejected", detail: `${what}: ${String(error?.message).split("\n")[0]}`, variant });
      continue;
    }
    if (!other.equals(base)) faults.push({ kind: "equivalent-variant-differs", detail: `${what} compile to different bytes`, variant });
  }
  return faults;
}
