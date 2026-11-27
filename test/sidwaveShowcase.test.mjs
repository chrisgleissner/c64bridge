// examples/sidwave-showcase: the game builds with the installed sidwave and 6502-toolkit packages, and the committed
// conversion sources are what their script writes. Nothing here starts an emulator or plays sound.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGame } from "../examples/sidwave-showcase/build.mjs";
import { writeSources } from "../examples/sidwave-showcase/convert/make-sources.mjs";

const showcase = fileURLToPath(new URL("../examples/sidwave-showcase", import.meta.url));

test("the showcase game builds with the installed packages", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-showcase-"));
  const chosen = process.env.SIDWAVE_DIR;
  delete process.env.SIDWAVE_DIR;
  t.after(() => {
    if (chosen !== undefined) process.env.SIDWAVE_DIR = chosen;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const game = await buildGame({ quiet: true, dir });
  assert.deepEqual([game.prg[0], game.prg[1]], [0x01, 0x08]);
  assert.equal(fs.statSync(game.file).size, game.prg.length);
  assert.equal(game.info.effects.length, 9);
  assert.equal(game.info.cycles.songs.length, 5);
  assert.ok(game.info.cycles.worstWithEffects < 19656, "one play call per frame fits into a PAL frame");

  writeSources(dir);
  for (const name of ["harbour_lights.mid", "tin_robot.mod"]) {
    assert.ok(fs.readFileSync(path.join(dir, name)).equals(fs.readFileSync(path.join(showcase, "convert", name))), `${name} differs from what make-sources.mjs writes`);
  }
});
