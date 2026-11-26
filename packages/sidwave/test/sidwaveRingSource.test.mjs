import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arrangeSidwave } from "../src/sidwaveCompiler.js";
import { noteNameToMidi, parseSidwave } from "../src/sidwave.js";
import { SIDWAVE_EXAMPLES } from "../src/sidwaveExamples.js";

const examplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "sound", "examples");

test("every resolved example ring note has a same-span source note on the preceding SID channel", () => {
  let ringNotes = 0;
  for (const { name } of SIDWAVE_EXAMPLES) {
    const doc = parseSidwave(fs.readFileSync(path.join(examplesDir, `${name}.yaml`), "utf8"));
    const arranged = arrangeSidwave(doc);
    for (let voiceIndex = 0; voiceIndex < arranged.voices.length; voiceIndex += 1) {
      for (const note of arranged.voices[voiceIndex].notes) {
        const instrument = arranged.instruments[note.inst];
        if (!instrument?.wavetable?.some((frame) => frame.ring)) continue;
        ringNotes += 1;
        assert.ok(instrument.sourceNote, `${name}: ring instrument at ${note.path} must specify source_note`);
        const sourceVoice = Math.floor(voiceIndex / 3) * 3 + ((voiceIndex % 3 + 2) % 3);
        const sourceMidi = /^[+-]/.test(instrument.sourceNote)
          ? note.midi + Number(instrument.sourceNote)
          : noteNameToMidi(instrument.sourceNote);
        const source = arranged.voices[sourceVoice].notes.find((candidate) =>
          candidate.hidden && candidate.start === note.start && candidate.end === note.end && candidate.midi === sourceMidi);
        assert.ok(source, `${name}: ring note at ${note.path} needs same-span source oscillator ${instrument.sourceNote}`);
      }
    }
  }
  assert.equal(ringNotes, 29, "keep the resolved ring-note audit exhaustive over current public examples");
});
