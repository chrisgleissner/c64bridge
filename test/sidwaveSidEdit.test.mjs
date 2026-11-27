// `c64_sound` op `sid_edit` and the HVSC lookups of `sid_info`, against a small collection built here.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import { parseSidFile, parseSonglengths, lookupSonglength } from "sidwave";
import { sidFile } from "./helpers/musicFixtures.mjs";
import { blockedWhenReadOnly, ok, rejected, workspace } from "./helpers/sidwaveCalls.mjs";

const { at, write } = workspace("sidwave-hvsc");
fs.mkdirSync(at("hvsc/DOCUMENTS"), { recursive: true });
fs.mkdirSync(at("hvsc/MUSICIANS/T"), { recursive: true });
const bytes = sidFile();
const tune = write("hvsc/MUSICIANS/T/Tune.sid", bytes);
const DATABASE = "[Database]\n; /MUSICIANS/A/Other.sid\n00000000000000000000000000000000=1:00\n";
const database = write("hvsc/DOCUMENTS/Songlengths.md5", Buffer.from(DATABASE, "latin1"));
write("hvsc/DOCUMENTS/STIL.txt", "#  STIL\n\n/MUSICIANS/T/Tune.sid\nCOMMENT: Written for the tests.\n");

test("a header edit changes the named fields in a copy", async () => {
  const data = await ok({ op: "sid_edit", inputPath: tune, action: "header", fields: { name: "New Name", author: "Tester", clock: "NTSC", sidModel: "8580" }, outputPath: at("edited.sid") });
  assert.deepEqual(data.changes.map((change) => change.field).filter((field) => ["name", "author"].includes(field)), ["name", "author"]);
  const edited = parseSidFile(fs.readFileSync(data.outputPath));
  assert.deepEqual([edited.name, edited.author, edited.clock], ["New Name", "Tester", "NTSC"]);
  assert.deepEqual(fs.readFileSync(tune), bytes);
  assert.notEqual(data.md5.old, data.md5.new);
  await rejected({ op: "sid_edit", inputPath: tune, action: "header", fields: { colour: "red" } }, /unknown field "colour"/);
  await rejected({ op: "sid_edit", inputPath: tune, action: "header" }, /fields/);
});

test("a song length is written to a copy of the database or, on request, into it", async () => {
  const copy = await ok({ op: "sid_edit", inputPath: tune, action: "songlength", durations: "3:05", hvscDir: at("hvsc") });
  assert.equal(copy.result, "added");
  assert.equal(fs.readFileSync(database, "latin1"), DATABASE);
  assert.match(copy.note, /database is unchanged/);
  assert.equal(lookupSonglength(parseSonglengths(fs.readFileSync(copy.outputPath, "latin1")), bytes, 1), 185_000);
  const placed = await ok({ op: "sid_edit", inputPath: tune, action: "songlength", durations: "0:41", hvscDir: at("hvsc"), outputPath: database, overwrite: true });
  assert.deepEqual([placed.result, placed.note], ["added", undefined]);
  const info = await ok({ op: "sid_info", inputPath: tune, hvscDir: at("hvsc") });
  assert.equal(info.hvscPath, "/MUSICIANS/T/Tune.sid");
  assert.match(JSON.stringify(info.stil), /Written for the tests/);
  assert.match(JSON.stringify(info), /41/);
  const updated = await ok({ op: "sid_edit", inputPath: tune, action: "songlength", durations: "0:52", songlengthsPath: database });
  assert.equal(updated.result, "updated");
});

test("sid_edit refuses wrong counts, protected paths and read-only mode", async () => {
  const base = { op: "sid_edit", inputPath: tune, action: "songlength", hvscDir: at("hvsc") };
  await rejected({ ...base, durations: "1:00 2:00" }, /has 1 song; give one duration per song/);
  await rejected({ op: "sid_edit", inputPath: tune, action: "songlength", durations: "1:00" }, /songlengthsPath or hvscDir/);
  await rejected({ ...base, durations: "1:00", outputPath: "/etc/c64bridge.md5" }, /outside the allowed directories/);
  await rejected({ op: "sid_edit", inputPath: tune, action: "songlength", durations: "1:00", songlengthsPath: "/etc/passwd" }, /outside the allowed directories/);
  await rejected({ op: "sid_edit", inputPath: tune, action: "header", fields: { name: "x" }, outputPath: tune, overwrite: true }, /input file/);
  await rejected({ op: "sid_edit", inputPath: database, action: "header", fields: { name: "x" } }, /not a SID file/);
  await rejected({ op: "sid_edit", inputPath: tune, action: "rewrite" }, /allowed: header, songlength/);
  await blockedWhenReadOnly({ op: "sid_edit", inputPath: tune, action: "header", fields: { name: "x" } });
});
