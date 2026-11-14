import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import { metaModule } from "../src/tools/meta/index.js";
import { developerModule } from "../src/tools/developer.js";
import { createLogger, tmpPath } from "./meta/helpers.mjs";

function makeClient(state) {
  return {
    async version() { return { version: "1.0.0" }; },
    async info() { return { device: "u64" }; },
    async configsList() {
      return { categories: Object.entries(state.firmware).map(([name, items]) => ({ name, items: Object.keys(items) })) };
    },
    async configGet(category, item) {
      state.reads.push(item ? `${category}/${item}` : category);
      const items = state.firmware[category] ?? {};
      if (!item) return { [category]: items };
      return { [category]: { [item]: items[item] } };
    },
    async configBatchUpdate(payload) { state.batches.push(payload); return { success: true }; },
    async configSaveToFlash() { state.saves += 1; return { success: true }; },
  };
}

function newState(firmware) {
  return { firmware, reads: [], batches: [], saves: 0 };
}

async function writeSnapshot(name, text) {
  const { file, dir } = tmpPath("config", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, text);
  return file;
}

test("restore rejects a __proto__ category and leaves Object.prototype unchanged", async () => {
  const state = newState({ Audio: { Volume: "10" } });
  const ctx = { platform: { id: "c64u" }, client: makeClient(state), logger: createLogger() };
  const file = await writeSnapshot("restore-proto.json", '{"categories":{"__proto__":{"polluted":"yes"}}}');
  const result = await metaModule.invoke("config_snapshot_and_restore", { action: "restore", path: file }, ctx);
  assert.notEqual(result.metadata?.success, true);
  assert.match(JSON.stringify(result), /__proto__/);
  assert.equal({}.polluted, undefined, "Object.prototype must not be modified");
  assert.equal(state.batches.length, 0);
});

test("restore and diff reject constructor and prototype names at category and item level", async () => {
  const state = newState({ Audio: { Volume: "10" } });
  const ctx = { platform: { id: "c64u" }, client: makeClient(state), logger: createLogger() };
  const cases = [
    '{"categories":{"constructor":{"Volume":"1"}}}',
    '{"categories":{"Audio":{"prototype":"1"}}}',
    '{"categories":{"Audio":{"Volume":{"Audio":{"__proto__":{"x":"1"}}}}}}',
  ];
  for (const [index, text] of cases.entries()) {
    const file = await writeSnapshot(`restore-unsafe-${index}.json`, text);
    for (const action of ["restore", "diff"]) {
      const result = await metaModule.invoke("config_snapshot_and_restore", { action, path: file }, ctx);
      assert.notEqual(result.metadata?.success, true, `${action} ${text}`);
    }
  }
  assert.equal(state.batches.length, 0);
});

test("config batch_update rejects __proto__ category names without polluting Object.prototype", async () => {
  const state = newState({ Audio: { Volume: "10" } });
  const ctx = { platform: { id: "c64u" }, client: makeClient(state), logger: createLogger() };
  const args = JSON.parse('{"updates":{"__proto__":{"polluted":"yes"}}}');
  const result = await developerModule.invoke("config_batch_update", args, ctx);
  assert.notEqual(result.metadata?.success, true);
  assert.equal({}.polluted, undefined);
  assert.equal(state.batches.length, 0);
});
