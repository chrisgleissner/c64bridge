import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "#test/runner";
import assert from "#test/assert";

const sourceCli = fileURLToPath(new URL("../../scripts/cli.js", import.meta.url));

for (const dirname of ["C#project", "C%project"]) {
  test(`CLI imports the compiled entry from an install path containing ${dirname}`, (t) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-cli-"));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const installed = path.join(fixture, dirname);
    fs.mkdirSync(path.join(installed, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(installed, "dist"));
    fs.copyFileSync(sourceCli, path.join(installed, "scripts", "cli.js"));
    fs.writeFileSync(path.join(installed, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(installed, "dist", "index.js"), 'console.log("compiled-entry-loaded");');
    const result = spawnSync(process.env.C64BRIDGE_TEST_NODE_BIN || "node", [path.join(installed, "scripts", "cli.js")], {
      cwd: fixture,
      env: process.env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "compiled-entry-loaded");
  });
}
