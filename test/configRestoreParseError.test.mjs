import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { metaModule } from "../src/tools/meta/index.js";

function createLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

test("config restore of a non-JSON file reports the path only (S-02)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h2-s02-"));
  const file = path.join(dir, "not-json.txt");
  fs.writeFileSync(file, "SECRET-TOKEN-xyz not json");
  try {
    const ctx = { platform: { id: "c64u" }, client: { async configBatchUpdate() { return { success: true }; } }, logger: createLogger() };
    for (const action of ["restore", "diff"]) {
      const res = await metaModule.invoke("config_snapshot_and_restore", { action, path: file }, ctx);
      assert.equal(res.isError, true, action);
      const serialised = JSON.stringify(res);
      assert.ok(!serialised.includes("SECRET"), `${action}: ${serialised}`);
      assert.ok(!serialised.includes("not json"), action);
      assert.ok(serialised.includes(file), action);
      assert.equal(res.metadata?.error?.kind, "validation", action);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
