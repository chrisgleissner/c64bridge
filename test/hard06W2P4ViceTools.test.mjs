import test from "#test/runner";
import assert from "#test/assert";
import os from "node:os";
import path from "node:path";
import { C64Client } from "../src/c64Client.js";
import { ViceBackend } from "../src/device.js";
import { viceModuleGroup } from "../src/tools/vice.js";
import { memoryModule } from "../src/tools/memory.js";
import { inputModule } from "../src/tools/input.js";
import { setPlatform } from "../src/platform.js";

// HARD06 wave 2 P4: VICE-10 snapshot and version tools, VICE bank selection from the banks VICE
// reports (0x82), and DEVICE-4 caller side (input tools pass the request abort signal).

const logger = { debug() {}, info() {}, warn() {}, error() {} };
setPlatform("vice");
const BANKS = [{ id: 7, name: "cpu" }, { id: 9, name: "ram" }, { id: 3, name: "io" }];

function viceClient(monitor) {
  const backend = Object.create(ViceBackend.prototype);
  backend.withMonitor = async (fn) => fn(monitor);
  Object.defineProperty(backend, "type", { value: "vice" });
  const client = new C64Client("http://127.0.0.1:1");
  client.facadePromise = Promise.resolve(backend);
  client.activeType = "vice";
  return client;
}

const tool = (group, name) => group.describeTools().find((t) => t.name === name);

test("snapshot_save, snapshot_restore and version reach the monitor", async () => {
  const calls = [];
  const client = viceClient({
    dumpSnapshot: async (p, o) => { calls.push(["dump", p, o]); },
    undumpSnapshot: async (p) => { calls.push(["undump", p]); return 0x080d; },
    versionInfo: async () => ({ version: "3.10.0.0", svnRevision: 5 }),
  });
  const ctx = { client, logger };
  const file = path.join(os.tmpdir(), "h6p4.vsf");
  const saved = await viceModuleGroup.invoke("c64_vice", { op: "snapshot_save", path: file }, ctx);
  assert.equal(saved.isError, undefined);
  assert.deepEqual(calls[0].slice(0, 1), ["dump"]);
    const restored = await viceModuleGroup.invoke("c64_vice", { op: "snapshot_restore", path: file }, ctx);
  assert.match(restored.content[0].text, /program counter \$080D/);
  const version = await viceModuleGroup.invoke("c64_vice", { op: "version" }, ctx);
  assert.match(version.content[0].text, /VICE 3\.10\.0\.0 \(SVN revision 5\)/);
});

test("snapshot paths outside the allowed directories are rejected", async () => {
  const client = viceClient({ dumpSnapshot: async () => { throw new Error("must not be called"); } });
  const res = await viceModuleGroup.invoke("c64_vice", { op: "snapshot_save", path: "/etc/h6p4.vsf" }, { client, logger });
  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res.content), /outside the allowed directories/);
});

test("bank read resolves the name against the reported banks", async () => {
  let asked;
  const client = viceClient({
    banksAvailable: async () => BANKS,
    memGetBank: async (start, end, id) => { asked = [start, end, id]; return Buffer.from([1, 2, 3, 4]); },
  });
  const res = await memoryModule.invoke("read", { address: "$D000", length: 4, bank: "RAM" }, { client, logger });
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  assert.deepEqual(asked, [0xd000, 0xd003, 9]);
  assert.equal(res.structuredContent.data.hexData, "$01020304");
  assert.equal(res.structuredContent.data.details.bank, "ram");
});

test("an unknown bank lists the reported names", async () => {
  const client = viceClient({ banksAvailable: async () => BANKS, memGetBank: async () => { throw new Error("no"); } });
  const res = await memoryModule.invoke("read", { address: "$D000", length: 4, bank: "rom" }, { client, logger });
  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res.content), /Available banks: cpu, ram, io/);
});

test("bank is rejected on Ultimate hardware", async () => {
  const client = { getBackendType: async () => "c64u", readMemory: async () => { throw new Error("must not be called"); } };
  const res = await memoryModule.invoke("read", { address: "$D000", length: 4, bank: "ram" }, { client, logger });
  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res.content), /only supported on the VICE backend/);
});

test("write_text hands the request abort signal to injectKeyboardQueue", async () => {
  const seen = [];
  const client = { injectKeyboardQueue: async (_b, o) => { seen.push(o?.signal); return { delivered: 1, status: "drained" }; } };
  const controller = new AbortController();
  await inputModule.invoke("c64_input", { op: "write_text", text: "A" }, { client, logger, signal: controller.signal });
  assert.equal(seen[0], controller.signal);
});
