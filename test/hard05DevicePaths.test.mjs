import test from "#test/runner";
import assert from "#test/assert";
import http from "node:http";
import { C64Client } from "../src/c64Client.js";
import { toolRegistry } from "../src/tools/registry/index.js";

// HARD05-003: no tool argument may change the REST route of the device.

const logger = { debug() {}, info() {}, warn() {}, error() {} };

async function withRecordingDevice(fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"errors":[]}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return await fn(new C64Client(baseUrl), seen);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function contextFor(client) {
  const platform = { id: "c64u", features: [], limitedFeatures: [] };
  return { client, logger, rag: {}, platform, setPlatform: () => platform };
}

async function invoke(client, name, args) {
  try {
    const result = await toolRegistry.invoke(name, args, contextFor(client));
    return { isError: result.isError === true, text: JSON.stringify(result.content ?? []) };
  } catch (error) {
    return { isError: true, text: String(error.message) };
  }
}

const BAD_CATEGORIES = ["..", ".", "%2e%2e", "%2E", "a/b", "a\\b", "a\nb", "a%0Ab", "%00"];

test("c64_config set rejects route-changing categories and items before any request", async () => {
  await withRecordingDevice(async (client, seen) => {
    for (const category of BAD_CATEGORIES) {
      const result = await invoke(client, "c64_config", { op: "set", category, item: "machine:poweroff", value: 1 });
      assert.equal(result.isError, true, `category ${JSON.stringify(category)} must be rejected`);
    }
    for (const item of ["..", "a\\b", "x\ty"]) {
      const result = await invoke(client, "c64_config", { op: "set", category: "Audio Mixer", item, value: 1 });
      assert.equal(result.isError, true, `item ${JSON.stringify(item)} must be rejected`);
    }
    const get = await invoke(client, "c64_config", { op: "get", category: ".." });
    assert.equal(get.isError, true);
    const flash = await invoke(client, "c64_config", { op: "save_flash", category: ".." });
    assert.equal(flash.isError, true);
    assert.deepEqual(seen, [], "the device received no request");
  });
});

test("the client encoders reject dot segments even without the tool layer", async () => {
  await withRecordingDevice(async (client, seen) => {
    assert.equal((await client.configSet("..", "machine:poweroff", "1")).success, false);
    await assert.rejects(client.configGet("..", "machine:readmem"));
    assert.equal((await client.configSaveToFlash("..")).success, false);
    await assert.rejects(client.filesInfo("../../v1/machine:reboot"));
    assert.equal((await client.filesCreateD64("/Usb0/%2e%2e/x.d64")).success, false);
    assert.equal((await client.filesCreateD64("/Usb0//x.d64")).success, false);
    assert.deepEqual(seen, []);
  });
});

test("c64_disk create_d64 and file_info reject dot-segment device paths", async () => {
  await withRecordingDevice(async (client, seen) => {
    const create = await invoke(client, "c64_disk", { op: "create_image", format: "d64", path: "../../v1/machine:reboot" });
    const info = await invoke(client, "c64_disk", { op: "file_info", path: "/Usb0/../x" });
    assert.equal(create.isError, true);
    assert.ok(/segment/.test(create.text), create.text);
    assert.equal(info.isError, true);
    assert.ok(/segment/.test(info.text), info.text);
    assert.deepEqual(seen, []);
  });
});

test("ordinary firmware names and device paths still reach the device unchanged", async () => {
  await withRecordingDevice(async (client, seen) => {
    assert.equal((await client.configSet("C64 and Cartridge Settings", "Bus Sharing - I/O1", "Internal")).success, true);
    assert.equal((await client.configSet("Cartridge Preferences", "SuperCPU Detect (D0BC)", "Enabled")).success, true);
    await client.configGet("U64 Specific Settings");
    await client.filesInfo("/Usb0/Games/my game.d64");
    assert.deepEqual(seen, [
      "PUT /v1/configs/C64%20and%20Cartridge%20Settings/Bus%20Sharing%20-%20I%2FO1?value=Internal",
      "PUT /v1/configs/Cartridge%20Preferences/SuperCPU%20Detect%20(D0BC)?value=Enabled",
      "GET /v1/configs/U64%20Specific%20Settings",
      "GET /v1/files/%2FUsb0/Games/my%20game.d64:info".replace("%2FUsb0", "/Usb0"),
    ].map((entry) => entry));
  });
});
