import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import { metaModule } from "../../src/tools/meta/index.js";
import {
  captureConfigSnapshot,
  normalizeConfigInventory,
  validateSnapshotCategories,
} from "../../src/tools/meta/configInventory.js";
import { createLogger, tmpPath } from "./helpers.mjs";

test("config_snapshot_and_restore snapshot and restore", async () => {
  const { file, dir } = tmpPath("config", "config-snapshot.json");
  await fs.mkdir(dir, { recursive: true });
  let batchUpdated = false;
  const ctx = {
    platform: { id: "c64u" },
    client: {
      async version() { return { version: "1.0.0" }; },
      async info() { return { device: "u64" }; },
      async configsList() { return { categories: ["Audio"] }; },
      async configGet(cat) { return cat === "Audio" ? { Volume: "10" } : {}; },
      async configBatchUpdate() { batchUpdated = true; return { success: true }; },
      async configSaveToFlash() { return { success: true }; },
    },
    logger: createLogger(),
  };

  const snap = await metaModule.invoke("config_snapshot_and_restore", { action: "snapshot", path: file }, ctx);
  assert.equal(snap.metadata?.success, true);
  const content = JSON.parse(await fs.readFile(file, "utf8"));
  assert.ok(content.categories?.Audio);

  const restore = await metaModule.invoke("config_snapshot_and_restore", { action: "restore", path: file, applyToFlash: true }, ctx);
  assert.equal(restore.metadata?.success, true);
  assert.equal(batchUpdated, true);
});

test("config_snapshot_and_restore diff reports changes", async () => {
  const { file, dir } = tmpPath("config", "config-diff.json");
  await fs.mkdir(dir, { recursive: true });
  const snapshot = {
    createdAt: new Date().toISOString(),
    version: { v: 1 },
    info: { device: "u64" },
    categories: { Audio: { Volume: "10" } },
  };
  await fs.writeFile(file, JSON.stringify(snapshot, null, 2), "utf8");

  const ctx = {
    platform: { id: "c64u" },
    client: {
      async configsList() { return { categories: ["Audio"] }; },
      async configGet(cat) { return cat === "Audio" ? { Volume: "11" } : {}; },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("config_snapshot_and_restore", { action: "diff", path: file }, ctx);
  assert.equal(res.metadata?.success, true);
  assert.equal(res.metadata?.changed, 1);
  const diff = res.structuredContent?.data?.diff ?? {};
  assert.ok(diff.Audio);
});

test("config_snapshot_and_restore supports vice-style config inventory", async () => {
  const { file, dir } = tmpPath("config", "config-vice-snapshot.json");
  await fs.mkdir(dir, { recursive: true });
  let batchPayload = null;

  const ctx = {
    client: {
      type: "vice",
      async version() { return { version: "1.0.0" }; },
      async info() { return { emulator: "vice" }; },
      async configsList() {
        return { categories: [{ name: "VICE", items: ["WarpMode", "SoundVolume"] }] };
      },
      async configGet(category, item) {
        if (category !== "VICE") return { value: "" };
        if (item === "WarpMode") return { value: "0" };
        if (item === "SoundVolume") return { value: "80" };
        return { value: "" };
      },
      async configBatchUpdate(payload) {
        batchPayload = payload;
        return { success: true };
      },
    },
    logger: createLogger(),
    platform: { id: "vice" },
  };

  const snapshot = await metaModule.invoke("config_snapshot_and_restore", { action: "snapshot", path: file }, ctx);
  assert.equal(snapshot.metadata?.success, true);

  const content = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(content.inventory, [{ category: "VICE", item: "WarpMode" }, { category: "VICE", item: "SoundVolume" }]);
  assert.deepEqual(content.categories?.VICE, { WarpMode: "0", SoundVolume: "80" });

  const restore = await metaModule.invoke("config_snapshot_and_restore", { action: "restore", path: file }, ctx);
  assert.equal(restore.metadata?.success, true);
  assert.deepEqual(batchPayload, { VICE: { WarpMode: "0", SoundVolume: "80" } });
});

test("config_snapshot_and_restore validates snapshot input", async () => {
  const { file, dir } = tmpPath("config", "invalid.json");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, "not json", "utf8");
  const ctx = { client: {}, logger: createLogger() };
  const res = await metaModule.invoke("config_snapshot_and_restore", { action: "restore", path: file }, ctx);
  assert.equal(res.isError, true);
});

test("normalizeConfigInventory deduplicates string and object categories", () => {
  const inventory = normalizeConfigInventory({
    categories: [
      "Audio",
      " Audio ",
      { name: "Video", items: ["Mode", " Mode ", "", null] },
      { name: "Storage", items: [] },
      { name: " ", items: ["Ignored"] },
      null,
    ],
  });

  assert.deepEqual(inventory, [
    { category: "Audio" },
    { category: "Video", item: "Mode" },
    { category: "Storage" },
  ]);
});

test("captureConfigSnapshot records config read failures inline", async () => {
  const snapshot = await captureConfigSnapshot({
    async configsList() {
      return { categories: [{ name: "VICE", items: ["WarpMode", "Broken"] }] };
    },
    async configGet(category, item) {
      if (category === "VICE" && item === "WarpMode") {
        return { value: "1" };
      }
      throw new Error("boom");
    },
  });

  assert.deepEqual(snapshot.inventory, [
    { category: "VICE", item: "WarpMode" },
    { category: "VICE", item: "Broken" },
  ]);
  assert.deepEqual(snapshot.categories, {
    VICE: {
      WarpMode: "1",
      Broken: { _error: "boom" },
    },
  });
});

test("validateSnapshotCategories rejects non-object payloads", () => {
  assert.throws(() => validateSnapshotCategories(null), /must be an object/);
  assert.throws(() => validateSnapshotCategories([]), /must be an object/);
  assert.deepEqual(validateSnapshotCategories({ Audio: { Volume: "10" } }), { Audio: { Volume: "10" } });
});
