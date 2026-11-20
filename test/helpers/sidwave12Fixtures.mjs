// SIDWAVE 1.2 documents used by test/sidwave12*.test.mjs.

/** The skeleton from the 1.2 quick reference. */
export const SKELETON = `sidwave: 1.2
title: Skeleton
tempo: 125
sids:
  - { id: sid1, address: "$D400", model: "8580", filter: { owner: v1, route: [1] } }
kit: { k: lib:kick, s: lib:snare }
instruments:
  bass:
    waveform: sawtooth
    adsr: [0, 6, 9, 2]
    hard_restart: { test: true }
    filtertable: [{ cutoff: 900Hz, resonance: 12, type: lowpass }, { add: -40, frames: 10 }]
  lead:
    waveform: pulse
    adsr: [1, 5, 11, 5]
    pulsetable: { reset: false, loop: 1, steps: [{ set: 0.25 }, { add: 24, frames: 32 }, { add: -24, frames: 32 }] }
voices:
  - id: 1
    role: bass
    instrument: bass
    patterns:
      a: { length: 0.25, groove: "k A1 A1 A2 s A1 A2 A1 k A1 A1 A2 s A1 G1 G2" }
      f: { length: 0.25, groove: "k A1 A1 A2 s A1 A2 A1 k A1 s s k s s s" }
  - id: 2
    role: arp
    level: 9
    patterns:
      am: { length: 2, groove: "Am@arp F@arp" }
  - id: 3
    role: lead
    instrument: lead
    patterns:
      m1: { length: 0.5, groove: "(A4 C5 E5) ~ D5! ~ (C5 B4) | A4 ~ ~ ~ - - E4 G4" }
sections:
  intro:  { bars: 4, level: mp, layers: { v1: a } }
  verse:  { bars: 8, level: mf, layers: { v1: "a*3 f", v2: am, v3: m1 } }
  chorus: { bars: 8, level: ff, filter: { cutoff: { from: 0, to: 300 } }, layers: { v1: "a*3 f", v2: am, v3: "m1+12" } }
timeline: [intro, verse, chorus, "verse+2", { use: chorus, transpose: 2 }, { use: intro, level: { from: mf, to: pp } }]
end: { hold_beats: 2, release: true }
`;
