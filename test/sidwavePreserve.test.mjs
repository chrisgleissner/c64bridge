// `c64_sound` op `preserve`: a preservation bundle of a SID file is created, verified and tamper evident.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import { sidFile } from "./helpers/musicFixtures.mjs";
import { blockedWhenReadOnly, ok, rejected, workspace } from "./helpers/sidwaveCalls.mjs";

const { at, write } = workspace("sidwave-preserve");
const bytes = sidFile();
const tune = write("Tune.sid", bytes);

test("a bundle holds the score, report and manifest, and verifies", async () => {
  const data = await ok({ op: "preserve", inputPath: tune, durationSeconds: 4, ladder: false, outputDir: at("bundle") });
  assert.deepEqual(data.files.map((file) => file.file).sort(), ["preservation.json", "reconstruction-report.json", "score.yaml"]);
  assert.deepEqual([data.action, data.rights.redistribution, data.horizon.seconds], ["create", "unknown", 4]);
  assert.equal(typeof data.verdict.strict, "boolean");
  const verified = await ok({ op: "preserve", action: "verify", inputPath: at("bundle") });
  assert.equal(verified.ok, true, JSON.stringify(verified.checks));
  fs.appendFileSync(at("bundle/score.yaml"), "# changed\n");
  const tampered = await ok({ op: "preserve", action: "verify", inputPath: at("bundle") });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.checks[0].ok, false, "failed checks come first");
});

test("the original is stored only with the caller's statement of rights, with the STIL entry", async () => {
  await rejected({ op: "preserve", inputPath: tune, includeOriginal: true }, /rightsPermitted: true/);
  const stil = write("STIL.txt", "#  STIL\n\n/MUSICIANS/T/Tune.sid\nCOMMENT: Written for the tests.\n");
  const data = await ok({ op: "preserve", inputPath: tune, durationSeconds: 3, ladder: false, outputDir: at("full"), includeOriginal: true, rightsPermitted: true, stilPath: stil, hvscPath: "/MUSICIANS/T/Tune.sid" });
  assert.deepEqual(fs.readFileSync(at("full/original.sid")), bytes);
  assert.equal(data.rights.redistribution, "permitted");
  assert.match(data.rights.stil.text, /Written for the tests/);
});

test("preserve refuses used directories, protected paths, links out of a bundle and read-only mode", async () => {
  await rejected({ op: "preserve", inputPath: tune, outputDir: at("bundle") }, /exists; pass overwrite/);
  await rejected({ op: "preserve", inputPath: tune, outputDir: "/etc/c64bridge-bundle" }, /outside the allowed directories/);
  await rejected({ op: "preserve", inputPath: write("not.sid", "text") }, /not a SID file/);
  await rejected({ op: "preserve", action: "verify", inputPath: "/etc" }, /outside the allowed directories/);
  await rejected({ op: "preserve", action: "verify", inputPath: tune }, /Not a bundle directory/);
  await rejected({ op: "preserve", action: "verify", inputPath: at(".") }, /preservation\.json/);
  fs.symlinkSync("/etc/passwd", at("bundle/link.txt"));
  await rejected({ op: "preserve", action: "verify", inputPath: at("bundle") }, /outside the allowed directories/);
  await blockedWhenReadOnly({ op: "preserve", inputPath: tune });
  await blockedWhenReadOnly({ op: "preserve", action: "create", inputPath: tune });
});

test("verifying a bundle is allowed in read-only mode", async () => {
  await ok({ op: "preserve", inputPath: tune, durationSeconds: 2, ladder: false, outputDir: at("readable") });
  const previous = process.env.C64BRIDGE_ACCESS;
  process.env.C64BRIDGE_ACCESS = "read-only";
  try {
    assert.equal((await ok({ op: "preserve", action: "verify", inputPath: at("readable") })).ok, true);
  } finally {
    if (previous === undefined) delete process.env.C64BRIDGE_ACCESS;
    else process.env.C64BRIDGE_ACCESS = previous;
  }
});
