import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import { toolRegistry } from "../src/tools/registry/index.js";

// HARD05-009: doc/hardening-behavior.md describes the implemented handling of bare hex.

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("c64_memory rejects bare 0400 as ambiguous", async () => {
  const platform = { id: "c64u", features: [], limitedFeatures: [] };
  const ctx = {
    client: { async readMemory() { return { success: true, data: "$00" }; } },
    logger,
    rag: {},
    platform,
    setPlatform: () => platform,
  };
  const result = await toolRegistry.invoke("c64_memory", { op: "read", address: "0400", length: 1 }, ctx);
  assert.equal(result.isError, true);
  assert.ok(/mbiguous/.test(JSON.stringify(result.content)));
});

test("the hardening behaviour document does not claim that 0400 means $0400", () => {
  const text = fs.readFileSync(new URL("../doc/hardening-behavior.md", import.meta.url), "utf8");
  assert.equal(text.includes("mean `$0400`"), false);
  assert.ok(/`0400`[^.]*rejected as ambiguous/.test(text));
});
