import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import { developerModule } from "../src/tools/developer.js";
import { metaModule } from "../src/tools/meta/index.js";
import { isSensitiveConfigItem } from "../src/redact.js";
import { createLogger, tmpPath } from "./meta/helpers.mjs";

const NET_PW = "net-pw-VALUE-1";
const FTP_PW = "ftp-pw-VALUE-2";
const WIFI_KEY = "wifi-psk-VALUE-3";

const FIRMWARE = {
  "Network settings": {
    "Network Password": NET_PW,
    "FTP Password": FTP_PW,
    "Telnet Password": "telnet-pw-VALUE-4",
    "Hostname": "c64u",
  },
  "WiFi settings": {
    "Access point name": "home-ap",
    "Password": WIFI_KEY,
  },
  "Audio": { Volume: "10" },
};

function makeClient(batches) {
  return {
    async version() { return { version: "1.0.0" }; },
    async info() { return { device: "u64" }; },
    async configsList() {
      return {
        categories: Object.entries(FIRMWARE).map(([name, items]) => ({ name, items: Object.keys(items) })),
      };
    },
    async configGet(category, item) {
      const items = FIRMWARE[category] ?? {};
      if (!item) return { [category]: items };
      return { [category]: { [item]: items[item] } };
    },
    async configBatchUpdate(payload) { batches.push(payload); return { success: true }; },
    async configSaveToFlash() { return { success: true }; },
  };
}

test("isSensitiveConfigItem matches credential items only", () => {
  for (const item of ["Network Password", "FTP Password", "Telnet Password", "Password", "WPA PSK"]) {
    assert.equal(isSensitiveConfigItem("Network settings", item), true, item);
  }
  for (const item of ["Hostname", "Volume", "Access point name", "Keyboard Layout"]) {
    assert.equal(isSensitiveConfigItem("Network settings", item), false, item);
  }
});

test("config_get redacts credential values and keeps other values", async () => {
  const ctx = { client: makeClient([]), logger: createLogger() };

  const category = await developerModule.invoke("config_get", { category: "Network settings" }, ctx);
  const text = JSON.stringify(category);
  for (const secret of [NET_PW, FTP_PW, "telnet-pw-VALUE-4"]) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(category.structuredContent.data.value, {
    "Network settings": {
      "Network Password": "***",
      "FTP Password": "***",
      "Telnet Password": "***",
      "Hostname": "c64u",
    },
  });

  const single = await developerModule.invoke("config_get", { category: "WiFi settings", item: "Password" }, ctx);
  assert.deepEqual(single.structuredContent.data.value, { "WiFi settings": { Password: "***" } });

  const plain = await developerModule.invoke("config_get", { category: "Audio", item: "Volume" }, ctx);
  assert.deepEqual(plain.structuredContent.data.value, { Audio: { Volume: "10" } });
});

test("config_get returns credentials only with includeSecretValues", async () => {
  const ctx = { client: makeClient([]), logger: createLogger() };
  const result = await developerModule.invoke(
    "config_get",
    { category: "Network settings", item: "FTP Password", includeSecretValues: true },
    ctx,
  );
  assert.equal(result.structuredContent.data.value["Network settings"]["FTP Password"], FTP_PW);
});

test("config snapshot file redacts credentials, other values unchanged, restore skips them", async () => {
  const { file, dir } = tmpPath("config", "config-secret-snapshot.json");
  await fs.mkdir(dir, { recursive: true });
  const batches = [];
  const ctx = { platform: { id: "c64u" }, client: makeClient(batches), logger: createLogger() };

  const snap = await metaModule.invoke("config_snapshot_and_restore", { action: "snapshot", path: file }, ctx);
  assert.equal(snap.metadata?.success, true);
  const raw = await fs.readFile(file, "utf8");
  for (const secret of [NET_PW, FTP_PW, WIFI_KEY, "telnet-pw-VALUE-4"]) assert.ok(!raw.includes(secret), secret);
  const content = JSON.parse(raw);
  // The mock returns one wrapped object per item, as the firmware does for item requests.
  const net = content.categories["Network settings"];
  assert.deepEqual(net["Network Password"], { "Network settings": { "Network Password": "***" } });
  assert.deepEqual(net["FTP Password"], { "Network settings": { "FTP Password": "***" } });
  assert.deepEqual(net["Telnet Password"], { "Network settings": { "Telnet Password": "***" } });
  assert.deepEqual(net.Hostname, { "Network settings": { Hostname: "c64u" } });
  assert.deepEqual(content.categories["WiFi settings"], {
    "Access point name": { "WiFi settings": { "Access point name": "home-ap" } },
    Password: { "WiFi settings": { Password: "***" } },
  });
  assert.deepEqual(content.categories.Audio, { Volume: { Audio: { Volume: "10" } } });

  const restore = await metaModule.invoke("config_snapshot_and_restore", { action: "restore", path: file }, ctx);
  assert.equal(restore.metadata?.success, true);
  assert.equal(JSON.stringify(batches[0]).includes("***"), false, "placeholder must never be written to the device");
  assert.deepEqual(batches[0]["Network settings"].Hostname, { "Network settings": { Hostname: "c64u" } });
  assert.deepEqual(batches[0]["Network settings"]["Network Password"], { "Network settings": {} });

  const { file: plainFile } = tmpPath("config", "config-secret-snapshot-plain.json");
  await metaModule.invoke(
    "config_snapshot_and_restore",
    { action: "snapshot", path: plainFile, includeSecretValues: true },
    ctx,
  );
  const plain = JSON.parse(await fs.readFile(plainFile, "utf8"));
  assert.equal(plain.categories["Network settings"]["Network Password"]["Network settings"]["Network Password"], NET_PW);
});
