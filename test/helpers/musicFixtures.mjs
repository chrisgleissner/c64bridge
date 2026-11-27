// Music files built by the tests: a SIDWave score and the MIDI, PSID and ProTracker MOD files made from original
// material. No third-party music is used.
import { Buffer } from "node:buffer";
import { compileSidwaveBytes, convert, parseSidwave } from "sidwave";

export const MELODY = ["C4", "E4", "G4", "C5", "B4", "G4", "D4", "F4"];
export const BASS = ["C2", "G2", "A2", "E2", "F2", "C2", "G2", "B2"];

export const SCORE = `sidwave: 1.3
title: Fixture Tune
tempo: 150
mode: PAL
voices:
  - id: 1
    waveform: triangle
    patterns:
      main: { notes: [${MELODY.join(", ")}] }
  - id: 2
    waveform: pulse
    patterns:
      main: { notes: [${BASS.join(", ")}] }
timeline:
  - { bars: 4, layers: { v1: main, v2: main } }
`;

export const midiFile = async () => Buffer.from((await convert(Buffer.from(SCORE), { to: "midi", inputName: "tune.yaml" })).output);

export const sidFile = () => Buffer.from(compileSidwaveBytes(parseSidwave(SCORE), { format: "sid" }).bytes);

/** ProTracker period of each note of the module (octaves 1 to 3 of the Amiga period table). */
const PERIODS = { "C-1": 856, "E-1": 678, "G-1": 570, "A-1": 508, "C-2": 428, "E-2": 339, "G-2": 285, "C-3": 214 };
export const MOD_NOTES = ["C-2", "E-2", "G-2", "C-3", "G-2", "E-2", "C-2", "E-2"];

/** A four-channel "M.K." module with one looped square-wave sample: a melody on channel 1 and a bass on channel 2. */
export function modFile() {
  const header = Buffer.alloc(1084);
  header.write("fixture module", 0, "latin1");
  const sample = Buffer.alloc(64, 0).map((_, index) => (index < 32 ? 0x40 : 0xc0));
  header.write("square", 20, "latin1");
  header.writeUInt16BE(sample.length / 2, 42); // length in words
  header[45] = 64; // volume
  header.writeUInt16BE(0, 46); // loop start
  header.writeUInt16BE(sample.length / 2, 48); // loop length
  for (let index = 1; index < 31; index += 1) header.writeUInt16BE(1, 20 + index * 30 + 28);
  header[950] = 1; // song length
  header[951] = 127;
  header.write("M.K.", 1080, "latin1");
  const pattern = Buffer.alloc(64 * 4 * 4);
  const note = (row, channel, name) => {
    const period = PERIODS[name];
    pattern.set([period >> 8, period & 0xff, 0x10, 0], (row * 4 + channel) * 4);
  };
  for (let step = 0; step < 16; step += 1) {
    note(step * 4, 0, MOD_NOTES[step % MOD_NOTES.length]);
    note(step * 4, 1, step % 2 ? "G-1" : "C-1");
  }
  return Buffer.concat([header, pattern, sample]);
}
