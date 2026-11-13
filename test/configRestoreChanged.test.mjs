import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { C64Client } from "../src/c64Client.js";
import { metaModule } from "../src/tools/meta/index.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-config-restore-changed-"));
}

function jsonBody(res) {
  return JSON.parse(res.content[0].text);
}

test("restore of an unchanged device writes nothing", async () => {
  const mock = await startMockC64Server();
  const dir = makeTempDir();
  try {
    const client = new C64Client(mock.baseUrl);
    const ctx = { platform: { id: "c64u" }, client, logger };
    const file = path.join(dir, "snapshot.json");

    const snap = await metaModule.invoke("config_snapshot_and_restore", { action: "snapshot", path: file }, ctx);
    assert.notEqual(snap.isError, true);

    const res = await metaModule.invoke("config_snapshot_and_restore", { action: "restore", path: file }, ctx);
    assert.notEqual(res.isError, true, res.content[0].text);
    const body = jsonBody(res);
    assert.equal(body.restored, true);
    assert.equal(body.changedItems, 0);
    assert.equal(body.categories, 0);
    assert.deepEqual(mock.state.configWrites, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("restore writes back only the one changed item and restores its value", async () => {
  const mock = await startMockC64Server();
  const dir = makeTempDir();
  try {
    const client = new C64Client(mock.baseUrl);
    const ctx = { platform: { id: "c64u" }, client, logger };
    const file = path.join(dir, "snapshot.json");

    const snapshotValue = mock.state.configs.Audio.Volume;
    assert.equal(snapshotValue, "6");

    await metaModule.invoke("config_snapshot_and_restore", { action: "snapshot", path: file }, ctx);
    await client.configSet("Audio", "Volume", "3");
    assert.equal(mock.state.configs.Audio.Volume, "3");

    const res = await metaModule.invoke("config_snapshot_and_restore", { action: "restore", path: file }, ctx);
    assert.notEqual(res.isError, true, res.content[0].text);
    const body = jsonBody(res);
    assert.equal(body.restored, true);
    assert.equal(body.changedItems, 1);
    assert.equal(body.categories, 1);

    assert.equal(mock.state.configWrites.length, 1);
    assert.deepEqual(mock.state.configWrites[0], { Audio: { Volume: snapshotValue } });
    assert.equal(mock.state.configs.Audio.Volume, snapshotValue);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("restore with applyToFlash reports the refused category and skips the flash save", async () => {
  const mock = await startMockC64Server({ forbiddenConfigCategories: ["Video"] });
  const dir = makeTempDir();
  try {
    const client = new C64Client(mock.baseUrl);
    const ctx = { platform: { id: "c64u" }, client, logger };
    const file = path.join(dir, "snapshot.json");

    await metaModule.invoke("config_snapshot_and_restore", { action: "snapshot", path: file }, ctx);
    const flashBefore = mock.state.flashSnapshot;
    assert.equal(flashBefore, null);

    // Audio is writable; Video is refused by the mock with 403.
    await client.configSet("Audio", "Volume", "3");
    await client.configSet("Video", "Mode", "NTSC");

    const res = await metaModule.invoke(
      "config_snapshot_and_restore",
      { action: "restore", path: file, applyToFlash: true },
      ctx,
    );
    assert.equal(res.isError, true);
    const error = res.metadata?.error;
    assert.equal(error?.kind, "execution");
    assert.ok(error?.details, "error details are present");

    const failed = error.details.failedCategories;
    assert.equal(failed.length, 1);
    assert.equal(failed[0].category, "Video");
    assert.equal(failed[0].status, 403);
    assert.match(failed[0].message, /network password is missing or wrong/);
    assert.deepEqual(error.details.restoredCategories, ["Audio"]);

    // The allowed category is restored; the refused one keeps its changed value.
    assert.equal(mock.state.configs.Audio.Volume, "6");
    assert.equal(mock.state.configs.Video.Mode, "NTSC");

    // Flash is not written after a failed restore.
    assert.deepEqual(mock.state.flashSnapshot, flashBefore);
    assert.notEqual(mock.state.lastConfigAction?.action, "save_to_flash");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("restore of firmware-style category reads writes the flat { category: { item: value } } form", async () => {
  const dir = makeTempDir();
  const file = path.join(dir, "snapshot.json");
  const device = { "Audio Mixer": { "Vol Master": " 0 dB", "Vol Drive 1": "-13 dB" }, "Network Settings": { "Network Password": "secret-pw", Hostname: "u64" } };
  const batches = [];
  const client = {
    async version() { return {}; },
    async info() { return {}; },
    async configsList() { return { categories: Object.keys(device) }; },
    // The firmware wraps a category read as { "<category>": { items } }.
    async configGet(category) { return { [category]: { ...device[category] }, errors: [] }; },
    async configBatchUpdate(payload) { batches.push(payload); return { success: true }; },
  };
  const ctx = { platform: { id: "c64u" }, client, logger };
  try {
    await metaModule.invoke("config_snapshot_and_restore", { action: "snapshot", path: file }, ctx);
    device["Audio Mixer"]["Vol Master"] = "-6 dB";
    device["Network Settings"].Hostname = "other";
    const res = await metaModule.invoke("config_snapshot_and_restore", { action: "restore", path: file }, ctx);
    assert.notEqual(res.isError, true, res.content[0].text);
    assert.deepEqual(batches, [{ "Audio Mixer": { "Vol Master": " 0 dB" }, "Network Settings": { Hostname: "u64" } }]);
    assert.equal(JSON.stringify(batches).includes("***"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
