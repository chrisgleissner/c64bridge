import test from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import { toolRegistry } from "../src/tools/registry/index.js";
import { setPlatform, getPlatformStatus } from "../src/platform.js";

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const originalPlatform = getPlatformStatus().id;

test.after(() => setPlatform(originalPlatform));

function makeCtx({ platformId = "c64u", clientOverrides = {} } = {}) {
  const stubClient = {
    async readMemoryRaw(address, length) {
      return new Uint8Array(length);
    },
    async writeMemoryRaw() {},
    async injectKeyboardQueue() {},
    async getActiveBackendType() { return platformId; },
    async readMemory(addressInput, lengthInput) {
      const length = parseInt(String(lengthInput), 10);
      return {
        success: true,
        details: {
          address: String(addressInput),
          length,
          bytes: "$00",
        },
      };
    },
    async writeMemory(addressInput, bytesInput) {
      return {
        success: true,
        details: { address: String(addressInput), bytes: String(bytesInput) },
      };
    },
    async pause() { return { success: true }; },
    async resume() { return { success: true }; },
    ...clientOverrides,
  };
  return {
    client: stubClient,
    rag: {},
    logger: noopLogger,
    platform: { id: platformId, features: [], limitedFeatures: [] },
    setPlatform,
  };
}

// ---------------------------------------------------------------------------
// c64_batch
// ---------------------------------------------------------------------------

test("c64_batch is registered and supports both backends", () => {
  const tool = toolRegistry.list().find((d) => d.name === "c64_batch");
  assert.ok(tool, "c64_batch should be registered");
  const platforms = tool.metadata?.platforms ?? [];
  assert.ok(platforms.includes("c64u"));
  assert.ok(platforms.includes("vice"));
});

test("c64_batch executes commands in order and aggregates results", async () => {
  let calls = 0;
  const ctx = makeCtx({
    clientOverrides: {
      async readMemory(addressInput, lengthInput) {
        calls++;
        const length = parseInt(String(lengthInput), 10);
        return { success: true, details: { address: String(addressInput), length, bytes: "$00" } };
      },
    },
  });

  const result = await toolRegistry.invoke("c64_batch", {
    commands: [
      { tool: "c64_memory", args: { op: "read", address: "$0400", length: 1 }, description: "first" },
      { tool: "c64_memory", args: { op: "read", address: "$0401", length: 1 }, description: "second" },
    ],
  }, ctx);

  if (result.isError) {
    throw new Error(`batch failed: ${JSON.stringify(result, null, 2)}`);
  }
  assert.equal(result.isError, undefined);
  const data = result.structuredContent?.data;
  if (!data || data.total !== 2) {
    throw new Error(`unexpected batch data: ${JSON.stringify(data, null, 2)}`);
  }
  assert.equal(data.total, 2);
  assert.equal(data.succeeded, 2);
  assert.equal(data.failed, 0);
  assert.equal(data.results.length, 2);
  assert.equal(calls, 2);
});

test("c64_batch stops on first error by default", async () => {
  const ctx = makeCtx();
  const result = await toolRegistry.invoke("c64_batch", {
    commands: [
      { tool: "c64_memory", args: { op: "read", address: "$0400", length: -1 } },
      { tool: "c64_memory", args: { op: "read", address: "$0400", length: 1 } },
    ],
  }, ctx);

  const data = result.structuredContent?.data;
  assert.equal(data.executed, 1, "should stop after first failure");
  assert.equal(data.failed, 1);
  assert.equal(data.succeeded, 0);
});

test("c64_batch with stopOnError=false continues through failures", async () => {
  const ctx = makeCtx();
  const result = await toolRegistry.invoke("c64_batch", {
    stopOnError: false,
    commands: [
      { tool: "c64_memory", args: { op: "read", address: "$0400", length: -1 } },
      { tool: "c64_memory", args: { op: "read", address: "$0400", length: 1 } },
    ],
  }, ctx);
  const data = result.structuredContent?.data;
  assert.equal(data.executed, 2);
  assert.equal(data.failed, 1);
  assert.equal(data.succeeded, 1);
});

test("c64_batch refreshes platform context after backend switches", async () => {
  setPlatform("c64u");
  const ctx = makeCtx({
    platformId: "c64u",
    clientOverrides: {
      getAvailableBackends() {
        return ["c64u", "vice"];
      },
      switchBackend(target) {
        setPlatform(target);
      },
      async viceCheckpointList() {
        return [];
      },
    },
  });

  const result = await toolRegistry.invoke("c64_batch", {
    commands: [
      { tool: "c64_select_backend", args: { op: "select", backend: "vice" } },
      { tool: "c64_debug", args: { op: "list_checkpoints" } },
    ],
  }, ctx);

  assert.equal(result.isError, undefined);
  const data = result.structuredContent?.data;
  assert.equal(data.failed, 0);
  assert.equal(data.succeeded, 2);
  assert.equal(data.results[1].success, true);
});

test("c64_batch rejects nested batch execution", async () => {
  const ctx = makeCtx();
  const result = await toolRegistry.invoke("c64_batch", {
    stopOnError: false,
    commands: [
      { tool: "c64_batch", args: { commands: [{ tool: "c64_memory", args: { op: "read", address: "$0400", length: 1 } }] } },
      { tool: "c64_memory", args: { op: "read", address: "$0400", length: 1 } },
    ],
  }, ctx);

  const data = result.structuredContent?.data;
  assert.equal(data.executed, 2);
  assert.equal(data.failed, 1);
  assert.equal(data.succeeded, 1);
  assert.match(data.results[0].error, /Nested c64_batch execution is not supported/);
});

test("c64_batch rejects unknown tools per command without aborting the batch", async () => {
  const ctx = makeCtx();
  const result = await toolRegistry.invoke("c64_batch", {
    stopOnError: false,
    commands: [
      { tool: "c64_does_not_exist", args: {}, description: "bogus" },
      { tool: "c64_memory", args: { op: "read", address: "$0400", length: 1 } },
    ],
  }, ctx);
  const data = result.structuredContent?.data;
  assert.equal(data.executed, 2);
  assert.equal(data.failed, 1);
  assert.equal(data.succeeded, 1);
  assert.equal(data.results[0].success, false);
  assert.equal(data.results[1].success, true);
});

// ---------------------------------------------------------------------------
// c64_graphics get_display_state
// ---------------------------------------------------------------------------

function buildVicState({ d011 = 0x1B, d016 = 0xC8, d018 = 0x14, dd00 = 0x03, d020 = 0x0E, d021 = 0x06 } = {}) {
  // Construct the 8-byte block returned by readMemoryRaw(0xD011, 8)
  const vicBlock = new Uint8Array(8);
  vicBlock[0] = d011;
  vicBlock[5] = d016;
  vicBlock[7] = d018;
  return {
    async readMemoryRaw(address, length) {
      if (address === 0xD011 && length === 8) return vicBlock;
      if (address === 0xD020 && length === 2) return Uint8Array.of(d020, d021);
      if (address === 0xDD00 && length === 1) return Uint8Array.of(dd00);
      return new Uint8Array(length);
    },
  };
}

test("c64_graphics.get_display_state works on c64u", async () => {
  const ctx = makeCtx({
    platformId: "c64u",
    clientOverrides: buildVicState({ d011: 0x1B }),
  });
  const result = await toolRegistry.invoke("c64_graphics", { op: "get_display_state" }, ctx);
  assert.equal(result.isError, undefined);
  const data = result.structuredContent?.data;
  assert.equal(data.backend, "c64u");
  assert.equal(typeof data.mode, "string");
  assert.equal(data.borderColor, 0x0E);
  assert.equal(data.backgroundColor, 0x06);
  assert.equal(data.screenVisible, true);
});

test("c64_graphics.get_display_state works on vice with same shape", async () => {
  const ctx = makeCtx({
    platformId: "vice",
    clientOverrides: buildVicState({ d011: 0x3B, d016: 0xD8 }), // bitmap+multicolor
  });
  const result = await toolRegistry.invoke("c64_graphics", { op: "get_display_state" }, ctx);
  assert.equal(result.isError, undefined);
  const data = result.structuredContent?.data;
  assert.equal(data.backend, "vice");
  assert.equal(data.mode, "multicolor_bitmap");
  assert.ok(typeof data.screenRamAddress === "string");
  assert.ok(typeof data.charOrBitmapAddress === "string");
});
