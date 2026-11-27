import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findDrift, listSyncedFiles } from "../scripts/sync-sidwave-data.mjs";

test("data/sound holds exact copies of the SIDWAVE specification, schema and examples from the sidwave package", () => {
  assert.ok(listSyncedFiles().length > 3);
  assert.deepEqual(findDrift(), [], "run node scripts/sync-sidwave-data.mjs");
});

test("the drift check reports a changed, missing and orphaned copy", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-drift-"));
  try {
    const source = path.join(dir, "source"), target = path.join(dir, "target");
    fs.mkdirSync(path.join(source, "examples"), { recursive: true });
    fs.mkdirSync(path.join(target, "examples"), { recursive: true });
    fs.writeFileSync(path.join(source, "sidwave.md"), "a");
    fs.writeFileSync(path.join(source, "sidwave.schema.json"), "{}");
    fs.writeFileSync(path.join(source, "examples", "x.yaml"), "x");
    fs.writeFileSync(path.join(target, "sidwave.md"), "b");
    fs.writeFileSync(path.join(target, "examples", "old.yaml"), "o");
    assert.deepEqual(findDrift(source, target), [
      "sidwave.md: differs",
      "sidwave.schema.json: missing",
      "examples/x.yaml: missing",
      "examples/old.yaml: no source in the package",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
