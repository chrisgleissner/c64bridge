import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import { metaModule } from "../../src/tools/meta/index.js";
import { createLogger, tmpPath } from "./helpers.mjs";

function makeCtx(state) {
  const requested = [];
  const writes = [];
  return {
    requested,
    writes,
    ctx: {
      platform: { id: "c64u" },
      logger: createLogger(),
      client: {
        async version() { return { version: "1" }; },
        async info() { return { device: "u64" }; },
        async configsList() { return { categories: ["Audio", "Video", "Flaky"] }; },
        async configGet(category) {
          requested.push(category);
          if (category === "Flaky" && state.flakyFails) throw new Error("timeout reading Flaky");
          return { [category]: state.data[category] ?? { Item: 1 } };
        },
        async configBatchUpdate(payload) { writes.push(payload); return { success: true }; },
        async configSaveToFlash() { return { success: true }; },
      },
    },
  };
}

test("HARD06 META-3 a snapshot reports failed reads and restore never writes the stored _error", async () => {
  const { file, dir } = tmpPath("h6config", "snap.json");
  await fs.mkdir(dir, { recursive: true });
  const state = { flakyFails: true, data: { Audio: { Volume: 5 } } };
  const { ctx, writes } = makeCtx(state);
  const snap = await metaModule.invoke("config_snapshot_and_restore", { action: "snapshot", path: file }, ctx);
  const data = snap.structuredContent.data;
  assert.equal(data.partial, true);
  assert.equal(data.failedReads[0].category, "Flaky");
  assert.match(data.warning, /failed/);
  state.flakyFails = false;
  state.data.Audio = { Volume: 7 };
  const restore = await metaModule.invoke("config_snapshot_and_restore", { action: "restore", path: file }, ctx);
  assert.equal(restore.isError, undefined, JSON.stringify(restore.content));
  assert.deepEqual(writes, [{ Audio: { Volume: 5 } }]);
});

test("HARD06 META-3 diff lists changed items only and reads only the snapshot categories", async () => {
  const { file, dir } = tmpPath("h6config", "diff.json");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ categories: { Audio: { Volume: 5, Balance: 0 } } }));
  const state = { data: { Audio: { Volume: 7, Balance: 0 } } };
  const { ctx, requested } = makeCtx(state);
  const res = await metaModule.invoke("config_snapshot_and_restore", { action: "diff", path: file }, ctx);
  assert.deepEqual(res.structuredContent.data.diff, { Audio: { Volume: { expected: 5, actual: 7 } } });
  assert.deepEqual(requested, ["Audio"]);
});
