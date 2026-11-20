import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import { metaModule } from "../src/tools/meta/index.js";
import { createLogger, tmpPath } from "./meta/helpers.mjs";

// The firmware's GET /v1/configs lists category names only, so the inventory has one entry per
// category. The snapshot still stores every item, because GET /v1/configs/<category> returns them all.
const FIRMWARE = {
  "Audio Mixer": { "Vol Master": " 0 dB", "Vol UltiSid 1": " 0 dB", "Pan UltiSID 1": "Center" },
  "Drive A Settings": { Drive: "Enabled", "Drive Type": "1541" },
};

function categoryNamesClient() {
  return {
    async version() { return { version: "1.0.0" }; },
    async info() { return { product: "C64 Ultimate" }; },
    async configsList() { return { categories: Object.keys(FIRMWARE), errors: [] }; },
    async configGet(category, item) {
      const items = FIRMWARE[category] ?? {};
      if (!item) return { [category]: items, errors: [] };
      return { [category]: { [item]: items[item] }, errors: [] };
    },
  };
}

test("HIL131-5 the snapshot item count counts items when the firmware lists category names only", async () => {
  const { file, dir } = tmpPath("hil131-snapcount", "snap.json");
  await fs.mkdir(dir, { recursive: true });
  const ctx = { platform: { id: "c64u" }, client: categoryNamesClient(), logger: createLogger() };
  const res = await metaModule.invoke("config_snapshot_and_restore", { action: "snapshot", path: file }, ctx);
  assert.equal(res.metadata?.success, true, JSON.stringify(res));
  const data = JSON.parse(res.content[0].text);
  assert.equal(data.categoryCount, 2);
  assert.equal(data.itemCount, 5);
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(Object.keys(saved.categories["Audio Mixer"]["Audio Mixer"]), Object.keys(FIRMWARE["Audio Mixer"]));
});
