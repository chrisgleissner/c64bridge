import test from "#test/runner";
import assert from "#test/assert";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeInto } from "../../scripts/postbuild.mjs";

test("postbuild keeps unchanged modules when an incremental build emits only some files into dist/src", async () => {
  const root = mkdtempSync(join(tmpdir(), "c64bridge-postbuild-"));
  try {
    const dist = join(root, "dist");
    mkdirSync(join(dist, "tools", "translation"), { recursive: true });
    writeFileSync(join(dist, "tools", "hex.js"), "old hex");
    writeFileSync(join(dist, "tools", "translation", "assembler.js"), "assembler");
    mkdirSync(join(dist, "src", "tools"), { recursive: true });
    writeFileSync(join(dist, "src", "tools", "hex.js"), "new hex");
    await mergeInto(join(dist, "src"), dist);
    assert.equal(readFileSync(join(dist, "tools", "hex.js"), "utf8"), "new hex");
    assert.ok(existsSync(join(dist, "tools", "translation", "assembler.js")), "unchanged module kept");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
