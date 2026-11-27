import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeSpec, findDrift, listSyncedFiles, syncData } from "../scripts/sync-sidwave-data.mjs";
import { readKnowledgeResource } from "../src/rag/knowledgeIndex.js";

const SCHEMA_URL = "https://raw.githubusercontent.com/chrisgleissner/c64bridge/refs/heads/main/data/sound/sidwave.schema.json";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("data/sound holds the generated SIDWAVE specification, schema and examples", () => {
  assert.ok(listSyncedFiles().length > 3);
  assert.deepEqual(findDrift(), [], "run node scripts/sync-sidwave-data.mjs");
});

test("the published specification keeps the c64bridge guidance, schema URL and resource links", () => {
  const spec = readKnowledgeResource("c64://sound/sidwave/spec", root).text;
  for (const guidance of [
    "`c64_sound` with `op: generate` plays a seeded eight-bar piece",
    "start a SIDWave PRG without a reset",
    "These operations accept `configure: true`",
    "It restores the changed settings when playback stops",
    "VICE playback through the server automatically sets and restores `SidStereo`",
    "`op: sample_render`",
    "Never send raw PCM through tool arguments",
    "[host path and size rules](../../doc/hardening-behavior.md)",
    "[composition index](c64://sound/examples)",
    "`wall_of_sid` needs `configure: true`",
  ]) assert.ok(spec.includes(guidance), guidance);

  assert.equal(spec.split(SCHEMA_URL).length - 1, 2, "yaml-language-server line and yaml.schemas setting");
  assert.ok(!spec.includes("chrisgleissner/sidwave/"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "data/sound/sidwave.schema.json"), "utf8")).$id, SCHEMA_URL);

  const links = [...new Set([...spec.matchAll(/\]\((c64:\/\/[^)]+)\)/g)].map((match) => match[1]))];
  for (const name of ["chiptune_drive", "game_songs", "wall_of_sid"]) assert.ok(links.includes(`c64://sound/examples/${name}`), name);
  for (const uri of links) assert.ok(readKnowledgeResource(uri, root)?.text, uri);
  for (const [, target] of spec.matchAll(/\]\((\.\.?\/[^)#]+)/g)) assert.ok(fs.existsSync(path.join(root, "data/sound", target)), target);
});

test("composing fails when a heading the additions need is missing or repeated", () => {
  const addendum = "<!-- after: ## Here -->\nadded\n";
  assert.equal(composeSpec("## Here\n\ntext", addendum), "## Here\n\nadded\n\ntext");
  assert.throws(() => composeSpec("## Elsewhere", addendum), /occurs 0 times/);
  assert.throws(() => composeSpec("## Here\n## Here", addendum), /occurs 2 times/);
});

test("the drift check reports a change in either source, and changed, missing and orphaned files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-drift-"));
  try {
    const source = path.join(dir, "source"), target = path.join(dir, "target"), addendum = path.join(dir, "addendum.md");
    fs.mkdirSync(path.join(source, "examples"), { recursive: true });
    fs.writeFileSync(path.join(source, "sidwave.md"), "## Here\n");
    fs.writeFileSync(path.join(source, "sidwave.schema.json"), "{}");
    fs.writeFileSync(path.join(source, "examples", "x.yaml"), "x");
    fs.writeFileSync(addendum, "<!-- after: ## Here -->\nadded\n");
    const drift = () => findDrift(source, target, addendum);
    syncData(source, target, addendum);
    assert.deepEqual(drift(), []);

    fs.appendFileSync(path.join(source, "sidwave.md"), "new package text\n");
    assert.deepEqual(drift(), ["sidwave.md: differs"]);
    syncData(source, target, addendum);
    fs.appendFileSync(addendum, "new c64bridge text\n");
    assert.deepEqual(drift(), ["sidwave.md: differs"]);

    syncData(source, target, addendum);
    fs.rmSync(path.join(target, "sidwave.schema.json"));
    fs.rmSync(path.join(target, "examples", "x.yaml"));
    fs.writeFileSync(path.join(target, "examples", "old.yaml"), "o");
    assert.deepEqual(drift(), [
      "sidwave.schema.json: missing",
      "examples/x.yaml: missing",
      "examples/old.yaml: no source in the package",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
