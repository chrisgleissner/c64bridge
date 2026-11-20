import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { C64Client } from "../src/c64Client.js";
import { toolRegistry } from "../src/tools/registry/index.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = { id: "c64u", features: [], limitedFeatures: [] };

async function withAccess(value, fn) {
  const previous = process.env.C64BRIDGE_ACCESS;
  process.env.C64BRIDGE_ACCESS = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.C64BRIDGE_ACCESS;
    else process.env.C64BRIDGE_ACCESS = previous;
  }
}

async function setup() {
  const mock = await startMockC64Server();
  mock.state.configs["Network settings"] = { "Use DHCP": "Enabled", "Static IP": "192.168.1.64" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h6-restore-"));
  const client = new C64Client(mock.baseUrl);
  const ctx = { client, logger, platform, setPlatform: () => platform };
  const file = path.join(dir, "snapshot.json");
  const snap = await toolRegistry.invoke("c64_config", { op: "snapshot", path: file }, ctx);
  assert.notEqual(snap.isError, true);
  return { mock, dir, ctx, file, close: async () => { fs.rmSync(dir, { recursive: true, force: true }); await mock.close(); } };
}

test("MCP-1 restore that changes a network category is blocked in no-destructive mode", async () => {
  const env = await setup();
  try {
    const snapshot = JSON.parse(fs.readFileSync(env.file, "utf8"));
    snapshot.categories["Network settings"]["Use DHCP"] = "Disabled";
    fs.writeFileSync(env.file, JSON.stringify(snapshot));
    await withAccess("no-destructive", async () => {
      await assert.rejects(
        () => toolRegistry.invoke("c64_config", { op: "restore", path: env.file }, env.ctx),
        /restore" is blocked: it has effect "destructive"/,
      );
    });
    assert.equal(env.mock.state.configs["Network settings"]["Use DHCP"], "Enabled");
  } finally {
    await env.close();
  }
});

test("MCP-1 restore with unchanged network items still runs in no-destructive mode", async () => {
  const env = await setup();
  try {
    const snapshot = JSON.parse(fs.readFileSync(env.file, "utf8"));
    snapshot.categories.Audio.Volume = "3";
    fs.writeFileSync(env.file, JSON.stringify(snapshot));
    await withAccess("no-destructive", async () => {
      const result = await toolRegistry.invoke("c64_config", { op: "restore", path: env.file }, env.ctx);
      assert.notEqual(result.isError, true, result.content[0].text);
    });
    assert.equal(env.mock.state.configs.Audio.Volume, "3");
  } finally {
    await env.close();
  }
});
