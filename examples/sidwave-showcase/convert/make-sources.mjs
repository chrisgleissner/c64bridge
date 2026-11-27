#!/usr/bin/env node
// Writes the two source files of the conversion demo from the note lists below. Both pieces are original music
// written for this example; the MOD samples are synthesised here.
//   harbour_lights.mid   Standard MIDI file, G major, 104 BPM, 16 bars: flute, plucked bass arpeggio, drums
//   tin_robot.mod        ProTracker M.K. module, A minor, 125 BPM: drums, saw bass, triangle lead, echo
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const NAMES = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };
const midiNote = (name) => {
  const [, pitch, octave] = /^([A-G]#?)(\d)$/.exec(name);
  return 12 * (Number(octave) + 1) + NAMES[pitch];
};

// ---------------------------------------------------------------------------------------------- Harbour Lights
const PPQ = 480;
// "note:beats" per bar; "-" is a rest.
const melody = [
  "D5:1.5 B4:.5 G4:1 B4:1", "A4:1.5 F#4:.5 D4:1 A4:1", "G4:.5 A4:.5 B4:1 E5:1.5 D5:.5", "C5:2 G4:1 A4:1",
  "B4:1.5 D5:.5 G5:1 D5:1", "F#5:1.5 E5:.5 D5:1 A4:1", "E5:1 C5:1 G4:.5 C5:.5 E5:1", "D5:3 -:1",
  "E5:.5 F#5:.5 G5:1.5 F#5:.5 E5:1", "G5:1 E5:1 C5:2", "D5:.5 E5:.5 D5:1 B4:1 G4:1", "A4:1.5 B4:.5 A4:1 F#4:1",
  "C5:1 E5:1 A5:1.5 G5:.5", "G5:1.5 E5:.5 C5:1 E5:1", "F#5:1 D5:1 A4:.5 D5:.5 F#5:1", "G5:4",
];
const chords = ["G", "DF", "Em", "C", "G", "D", "C", "D", "Em", "C", "G", "D", "Am", "C", "D", "G"];
// Rolling bass arpeggios, one bar of eighth notes each (the same four notes twice).
const ARPS = { G: "G2 D3 G3 B3", DF: "F#2 D3 F#3 A3", Em: "E2 B2 E3 G3", C: "C3 G3 C4 E4", D: "D3 A3 D4 F#4", Am: "A2 E3 A3 C4" };

function midiFile() {
  const vlq = (value) => {
    const bytes = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) bytes.unshift((v & 0x7f) | 0x80);
    return bytes;
  };
  const text = (type, value) => [0xff, type, value.length, ...Buffer.from(value, "latin1")];
  const track = (events) => {
    events.sort((a, b) => a.at - b.at || a.order - b.order);
    let time = 0;
    const bytes = [];
    for (const event of events) {
      bytes.push(...vlq(event.at - time), ...event.data);
      time = event.at;
    }
    bytes.push(0, 0xff, 0x2f, 0);
    const head = Buffer.alloc(8);
    head.write("MTrk", 0);
    head.writeUInt32BE(bytes.length, 4);
    return Buffer.concat([head, Buffer.from(bytes)]);
  };
  const part = (name, channel, program, notes) => {
    const events = [{ at: 0, order: 0, data: text(3, name) }];
    if (program !== undefined) events.push({ at: 0, order: 1, data: [0xc0 | channel, program] });
    for (const { beat, beats, note, velocity } of notes) {
      events.push({ at: Math.round(beat * PPQ), order: 3, data: [0x90 | channel, note, velocity] });
      events.push({ at: Math.round((beat + beats) * PPQ) - 10, order: 2, data: [0x80 | channel, note, 0] });
    }
    return track(events);
  };
  const lead = melody.flatMap((bar, i) => {
    let beat = i * 4;
    return bar.split(" ").flatMap((token) => {
      const [name, length] = token.split(":");
      const start = beat;
      beat += Number(length);
      return name === "-" ? [] : [{ beat: start, beats: Number(length), note: midiNote(name), velocity: start % 4 === 0 ? 104 : 92 }];
    });
  });
  const arp = chords.flatMap((chord, i) => (i === 15 ? "G2 D3 G3 B3".split(" ") : `${ARPS[chord]} ${ARPS[chord]}`.split(" "))
    .map((name, step) => ({ beat: i * 4 + step * 0.5, beats: i === 15 && step === 3 ? 2.5 : 0.5, note: midiNote(name), velocity: step % 4 === 0 ? 100 : 70 })));
  const drums = chords.flatMap((_, i) => {
    const hit = (at, note, velocity) => ({ beat: i * 4 + at, beats: 0.25, note, velocity });
    if (i === 15) return [hit(0, 36, 110), hit(0, 49, 90)];
    const hats = [0.5, 1.5, 3.5].map((at) => hit(at, 42, 60));
    return [hit(0, 36, 108), hit(1, 38, 90), hit(2, 36, 100), hit(2.5, 36, 80), hit(3, 38, 92), ...hats];
  });
  const tempo = track([{ at: 0, order: 0, data: text(3, "Harbour Lights") }, { at: 0, order: 1, data: [0xff, 0x51, 3, ...[16, 8, 0].map((s) => (Math.round(60e6 / 104) >> s) & 0xff)] }, { at: 0, order: 2, data: [0xff, 0x58, 4, 4, 2, 24, 8] }]);
  const tracks = [tempo, part("Flute", 0, 73, lead), part("Pluck", 1, 24, arp), part("Drums", 9, undefined, drums)];
  const header = Buffer.from([...Buffer.from("MThd"), 0, 0, 0, 6, 0, 1, 0, tracks.length, PPQ >> 8, PPQ & 0xff]);
  return Buffer.concat([header, ...tracks]);
}

// ---------------------------------------------------------------------------------------------- Tin Robot
const PERIODS = [856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453, 428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226, 214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113];
/** A tracker note such as "A-2": C-1 is index 0 of the period table. */
const period = (name) => PERIODS[(Number(name[2]) - 1) * 12 + NAMES[name.slice(0, 2).replace("-", "")]];

function samples() {
  let seed = 0x1234;
  const noise = () => {
    seed = (seed * 25173 + 13849) & 0xffff;
    return seed / 32768 - 1;
  };
  const make = (length, f) => Int8Array.from({ length }, (_, i) => Math.max(-127, Math.min(127, Math.round(f(i)))));
  let phase = 0;
  let previous = 0;
  return [
    { name: "kick", volume: 64, data: make(1800, (i) => { phase += (2 * Math.PI * (45 + 120 * Math.exp(-i / 220))) / 8287; return 120 * Math.sin(phase) * Math.exp(-i / 650); }) },
    { name: "snare", volume: 48, data: make(1600, (i) => (80 * noise() + 40 * Math.sin((2 * Math.PI * 190 * i) / 8287)) * Math.exp(-i / 380)) },
    { name: "hat", volume: 26, data: make(500, (i) => { const n = noise(); const high = n - previous; previous = n; return 60 * high * Math.exp(-i / 110); }) },
    { name: "saw bass", volume: 52, loop: true, data: make(64, (i) => 90 - (180 * i) / 63) },
    { name: "triangle lead", volume: 48, loop: true, data: make(64, (i) => (i < 32 ? -100 + (200 * i) / 32 : 100 - (200 * (i - 32)) / 32)) },
  ];
}

function modFile() {
  const kit = { k: [1, "C-2"], s: [2, "C-2"], h: [3, "C-3"] };
  const ROWS = 64;
  const empty = () => Array.from({ length: ROWS }, () => [null, null, null, null]);
  const put = (pattern, channel, row, sample, note, effect = 0, param = 0) => {
    pattern[row][channel] = { sample, note, effect, param };
  };
  const drums = (pattern, bars) => bars.forEach((bar, b) => [...bar].forEach((c, i) => c !== "." && put(pattern, 0, b * 16 + i, kit[c][0], kit[c][1])));
  const beat = "k.h.s.h.k.k.s.h.";
  const fill = "k.h.s.h.k.s.ssss";
  // Bass: one bar of eight eighth notes per chord. "~" holds, "." stops the note.
  const line = (pattern, channel, sample, bars, step) => bars.forEach((bar, b) => bar.split(" ").forEach((token, i) => {
    const row = b * 16 + i * step;
    if (token === ".") put(pattern, channel, row, 0, null, 0xc, 0);
    else if (token !== "~") put(pattern, channel, row, sample, token);
  }));
  const bassA = ["A-1 A-2 . A-1 E-2 . G-2 A-2", "F-1 F-2 . F-1 C-2 . E-2 F-2", "C-2 C-3 . C-2 G-2 . B-2 C-3", "G-1 G-2 . G-1 D-2 . F#2 G-2"];
  const bassB = ["D-2 D-3 . D-2 A-2 . C-3 D-3", "A-1 A-2 . A-1 E-2 . G-2 A-2", "F-1 F-2 . F-1 C-2 . E-2 F-2", "E-1 E-2 . E-1 B-1 . G#1 E-2"];
  const tuneA = ["A-2 ~ C-3 E-3 ~ D-3 C-3 .", "C-3 ~ A-2 ~ F-2 A-2 C-3 ~", "E-3 ~ G-3 ~ E-3 D-3 C-3 ~", "D-3 ~ B-2 ~ G-2 ~ . ."];
  const tuneB = ["F-3 ~ E-3 D-3 ~ A-2 D-3 F-3", "E-3 ~ ~ C-3 ~ A-2 . .", "A-2 C-3 F-3 ~ E-3 C-3 A-2 ~", "B-2 ~ G#2 ~ E-2 ~ ~ ."];
  const intro = empty();
  drums(intro, ["k.h.h.h.k.h.h.h.", "k.h.h.h.k.h.h.h.", beat, fill]);
  line(intro, 1, 4, bassA, 2);
  const a = empty();
  drums(a, [beat, beat, beat, fill]);
  line(a, 1, 4, bassA, 2);
  line(a, 2, 5, tuneA, 2);
  const b = empty();
  drums(b, [beat, beat, beat, fill]);
  line(b, 1, 4, bassB, 2);
  line(b, 2, 5, tuneB, 2);
  // The fourth channel echoes the lead three rows later at low volume.
  for (const pattern of [a, b]) {
    for (let row = 0; row + 3 < ROWS; row += 1) {
      const cell = pattern[row][2];
      if (cell?.note) put(pattern, 3, row + 3, 5, cell.note, 0xc, 14);
    }
  }
  const patterns = [intro, a, b];
  const order = [0, 1, 1, 2, 1];
  const sounds = samples();
  const header = Buffer.alloc(1084);
  header.write("tin robot", 0, "latin1");
  for (let i = 0; i < 31; i += 1) {
    const at = 20 + i * 30;
    const sound = sounds[i];
    if (sound) {
      header.write(sound.name, at, "latin1");
      header.writeUInt16BE(sound.data.length / 2, at + 22);
      header[at + 25] = sound.volume;
    }
    header.writeUInt16BE(0, at + 26);
    header.writeUInt16BE(sound?.loop ? sound.data.length / 2 : 1, at + 28);
  }
  header[950] = order.length;
  header[951] = 127;
  header.set(order, 952);
  header.write("M.K.", 1080, "latin1");
  const body = patterns.map((pattern) => Buffer.from(pattern.flatMap((row) => row.flatMap((cell) => {
    if (!cell) return [0, 0, 0, 0];
    const p = cell.note ? period(cell.note) : 0;
    return [(cell.sample & 0xf0) | (p >> 8), p & 0xff, ((cell.sample & 0x0f) << 4) | cell.effect, cell.param];
  }))));
  return Buffer.concat([header, ...body, ...sounds.map((s) => Buffer.from(s.data.buffer))]);
}

export function writeSources(dir = here) {
  fs.writeFileSync(path.join(dir, "harbour_lights.mid"), midiFile());
  fs.writeFileSync(path.join(dir, "tin_robot.mod"), modFile());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) writeSources();
