// `c64_sound` op `extract_instruments`: the library a score or SID file yields is importable.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { midiFile, SCORE, sidFile } from "./helpers/musicFixtures.mjs";
import { blockedWhenReadOnly, ok, rejected, workspace } from "./helpers/sidwaveCalls.mjs";

const { at, write } = workspace("sidwave-instruments");
const INSTRUMENTS = SCORE.replace("voices:", "instruments:\n  bell: { waveform: triangle, adsr: [0, 9, 0, 0] }\nvoices:").replace("waveform: triangle\n", "instrument: bell\n");
const score = write("tune.sidwave.yaml", INSTRUMENTS);

test("the extracted library of a score compiles where it is imported", async () => {
  const data = await ok({ op: "extract_instruments", inputPath: score, name: "bells", licence: "CC0-1.0", author: "Tester", outputPath: at("bells.sidwave.yaml") });
  assert.equal(data.libraryName, "bells");
  const bell = data.instruments.find((instrument) => instrument.sourceName === "bell");
  assert.deepEqual(bell.usedByVoices, [1]);
  assert.match(fs.readFileSync(data.outputPath, "utf8"), /CC0-1\.0/);
  assert.match(data.use, /from: bells\.sidwave\.yaml/);
  const user = write("user.sidwave.yaml", `sidwave: 1.4\ntempo: 120\nimports:\n  - { as: x, from: ${path.basename(data.outputPath)} }\nvoices:\n  - { id: 1, instrument: x.${bell.name}, patterns: { a: { notes: [C4] } } }\ntimeline:\n  - { bars: 1, layers: { v1: a } }\n`);
  assert.equal((await ok({ op: "validate", inputPath: user })).valid, true);
});

test("instruments come from SID files and from converted formats", async () => {
  const fromSid = await ok({ op: "extract_instruments", inputPath: write("tune.sid", sidFile()), durationSeconds: 3, includeScore: true });
  assert.equal(fromSid.provenance.source.kind, "sid");
  assert.equal(typeof fromSid.provenance.reconstructionStrictExact, "boolean");
  assert.ok(fromSid.count >= 1 && fromSid.sidwave.includes("library:"));
  const fromMidi = await ok({ op: "extract_instruments", inputPath: write("tune.mid", await midiFile()) });
  assert.ok(fromMidi.count >= 1);
});

test("extraction refuses bad input, protected paths and read-only mode", async () => {
  await rejected({ op: "extract_instruments", inputPath: score, name: "no spaces allowed" }, /name/);
  await rejected({ op: "extract_instruments", inputPath: score, outputPath: "/etc/c64bridge-lib.yaml" }, /outside the allowed directories/);
  await rejected({ op: "extract_instruments", inputPath: write(".secret.yaml", INSTRUMENTS) }, /hidden component/);
  await rejected({ op: "extract_instruments", inputPath: score, outputPath: score, overwrite: true }, /input file/);
  await blockedWhenReadOnly({ op: "extract_instruments", inputPath: score });
});
