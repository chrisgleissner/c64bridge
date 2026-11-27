// `c64_sound` op `compile` for game developers: assembler includes, symbols, relocation and a cycle limit.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { compileSidwave, parseSidwave, renderSidwaveGameInclude, sidwaveRelocationTable, verifySidwaveRelocation } from "sidwave";
import { SCORE } from "./helpers/musicFixtures.mjs";
import { ok, rejected, workspace } from "./helpers/sidwaveCalls.mjs";

const { at, write } = workspace("sidwave-game");
const score = write("level.sidwave.yaml", SCORE);
const game = { op: "compile", inputPath: score, output: "game", origin: 0x8000 };

test("a game build writes an include for each assembler, 64tass symbols and a relocation table", async () => {
  for (const assembler of ["64tass", "acme", "kickass", "ca65"]) {
    const data = await ok({ ...game, assembler, symbols: ["64tass"], relocation: true, outputDir: at(assembler) });
    const names = data.files.map((file) => path.basename(file.outputPath)).sort();
    assert.deepEqual(names, ["level.64tass", "level.bin", "level.inc", "level.reloc.json"]);
    const document = parseSidwave(SCORE);
    const build = compileSidwave(document, { target: "game", origin: 0x8000, symbols: ["64tass"] });
    const include = fs.readFileSync(at(`${assembler}/level.inc`), "utf8");
    assert.equal(include, renderSidwaveGameInclude(build, assembler, document.song.title));
    assert.match(fs.readFileSync(at(`${assembler}/level.64tass`), "utf8"), /=\s*\$8000/);
    const table = JSON.parse(fs.readFileSync(at(`${assembler}/level.reloc.json`), "utf8"));
    assert.deepEqual(data.relocation, { playerOffsets: table.player.length, dataOffsets: table.data.length, granularity: 256 });
    // Applying the table moves the build: byte for byte a build at the other address.
    const moved = compileSidwave(document, { target: "game", origin: 0x9000 });
    verifySidwaveRelocation(build.player, moved.player, [{ offsets: table.player, pages: 0x10 }]);
    assert.deepEqual(table, sidwaveRelocationTable(document, { target: "game", origin: 0x8000, symbols: ["64tass"] }));
  }
});

test("maxCycles accepts a build within the limit and writes nothing above it", async () => {
  const data = await ok({ ...game, maxCycles: 19_000, outputDir: at("fits") });
  assert.ok(data.cycles.worst <= 19_000);
  await rejected({ ...game, maxCycles: 100, outputDir: at("slow") }, /cycle limit 100 exceeded.*limit: 100|cycle limit 100 exceeded/);
  assert.equal(fs.existsSync(at("slow")), false);
});

test("game developer options need a game build and confined paths", async () => {
  for (const extra of [{ assembler: "acme" }, { relocation: true }, { maxCycles: 5000 }]) {
    await rejected({ op: "compile", inputPath: score, output: "prg", ...extra }, /output: "game"/);
  }
  await rejected({ ...game, assembler: "acme", outputDir: "/etc/c64bridge-game" }, /outside the allowed directories/);
  write("blocked", "keep");
  fs.mkdirSync(at("taken"));
  write("taken/level.inc", "keep");
  await rejected({ ...game, assembler: "acme", outputDir: at("taken") }, /exists; pass overwrite/);
  assert.deepEqual(fs.readdirSync(at("taken")), ["level.inc"]);
});
