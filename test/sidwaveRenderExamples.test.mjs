import test from "#test/runner";
import assert from "#test/assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SIDWAVE_EXAMPLES } from "sidwave";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the example renderer accepts the public examples of the installed sidwave package", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-render-count-"));
  try {
    fs.writeFileSync(path.join(output, "occupied"), "");
    // A non-empty output directory stops the script after its example check and before any rendering.
    const run = spawnSync(process.execPath, [path.join(root, "scripts/render-sidwave-examples.mjs"), "--out-dir", output],
      { cwd: root, encoding: "utf8", timeout: 60_000 });
    assert.match(run.stderr, /output directory is not empty/);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("the release workflow expects one rendered song for each public example", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/release.yaml"), "utf8");
  const count = SIDWAVE_EXAMPLES.length;
  assert.ok(workflow.includes(`names.length !== ${count} || new Set(names).size !== ${count}`));
});
