import test from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import { toolRegistry } from "../src/tools/registry/index.js";
import { setPlatform, getPlatformStatus } from "../src/platform.js";

const noopLogger = {
  debug() {}, info() {}, warn() {}, error() {},
};

function createInputContext({ platformId = "c64u", recorder } = {}) {
  const writes = [];
  const reads = [];
  const inputBatches = [];
  let ndx = 0;
  const memory = new Map();

  const stubClient = {
    async injectKeyboardQueue(bytes, options) {
      const data = Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
      writes.push({ kind: "kbd_queue", bytes: Uint8Array.from(data), options });
      if (recorder?.onInject) recorder.onInject({ data, options });
    },
    async writeMemoryRaw(address, bytes) {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      writes.push({ kind: "mem_write", address, bytes: Uint8Array.from(buf) });
      memory.set(address, Uint8Array.from(buf));
    },
    async viceMemSet(address, bytes) {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      writes.push({ kind: "vice_mem_set", address, bytes: Uint8Array.from(buf) });
    },
    async readMemoryRaw(address, length) {
      reads.push({ address, length });
      return new Uint8Array(length);
    },
    async getActiveBackendType() {
      return platformId;
    },
    async sendInputEvents(batch) {
      inputBatches.push(batch);
      return { errors: [], keyboard: { inputs: [] }, joysticks: [] };
    },
    async getInputState() {
      return { errors: [], keyboard: { inputs: ["left_shift"] }, joysticks: [{ port: 2, inputs: ["fire2"] }] };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: noopLogger,
    platform: { id: platformId, features: [], limitedFeatures: [] },
    setPlatform,
  };

  return { ctx, writes, reads, memory, inputBatches, ndxRef: () => ndx };
}

test("c64_input is registered as a grouped tool with both backends", () => {
  const tool = toolRegistry.list().find((d) => d.name === "c64_input");
  assert.ok(tool, "c64_input should be registered");
  const platforms = tool.metadata?.platforms ?? [];
  assert.ok(platforms.includes("c64u"), "c64_input must be C64U-capable");
  assert.ok(platforms.includes("vice"), "c64_input must be VICE-capable");
  // Native REST-only operations are clearly marked for discovery.
  const opPlatforms = tool.metadata?.operationPlatforms ?? {};
  assert.deepEqual(opPlatforms.keyboard, ["c64u"]);
  assert.deepEqual(opPlatforms.release_all, ["c64u"]);
  assert.equal(tool.inputSchema.oneOf, undefined, "schema must be flattened for MCP client compatibility");
  assert.equal(tool.inputSchema.discriminator, undefined, "schema must not use top-level discriminator metadata");
  assert.deepEqual(tool.inputSchema.properties.op.enum, ["write_text", "key", "joystick", "keyboard", "release_all", "state"]);
  assert.ok(Array.isArray(tool.inputSchema["x-c64bridge-operations"]));
  assert.ok(tool.metadata.resources.includes("c64://memory/map"));
  assert.ok(!tool.metadata.resources.some((uri) => uri.startsWith("c64://specs/")));
});

test("c64_input.write_text injects PETSCII bytes via the shared keyboard queue (C64U)", async () => {
  const { ctx, writes } = createInputContext({ platformId: "c64u" });
  const result = await toolRegistry.invoke("c64_input", {
    op: "write_text",
    text: "HELLO{RETURN}",
  }, ctx);
  assert.equal(result.isError, undefined);
  const inject = writes.find((w) => w.kind === "kbd_queue");
  assert.ok(inject, "expected injectKeyboardQueue to be called");
  // HELLO + carriage return (13)
  assert.equal(inject.bytes.length, 6);
  assert.equal(inject.bytes[5], 13);
});

test("c64_input.write_text works the same way under VICE", async () => {
  const { ctx, writes } = createInputContext({ platformId: "vice" });
  const result = await toolRegistry.invoke("c64_input", {
    op: "write_text",
    text: "RUN{RETURN}",
  }, ctx);
  assert.equal(result.isError, undefined);
  const inject = writes.find((w) => w.kind === "kbd_queue");
  assert.ok(inject);
  assert.equal(inject.bytes.length, 4);
});

test("c64_input.write_text expands numeric PETSCII tokens and preserves unknown tokens", async () => {
  const { ctx, writes } = createInputContext({ platformId: "c64u" });
  const result = await toolRegistry.invoke("c64_input", {
    op: "write_text",
    text: "A{$1D}{29}{unknown}",
  }, ctx);

  assert.equal(result.isError, undefined);
  const inject = writes.find((w) => w.kind === "kbd_queue");
  assert.ok(inject);
  assert.deepEqual(Array.from(inject.bytes.slice(0, 3)), [65, 29, 29]);
  assert.equal(String.fromCharCode(...inject.bytes.slice(3)), "{unknown}");
});

test("c64_input.key sends single-byte injections for token names", async () => {
  const { ctx, writes } = createInputContext({ platformId: "c64u" });
  const result = await toolRegistry.invoke("c64_input", {
    op: "key",
    key: "F1",
    count: 2,
  }, ctx);
  assert.equal(result.isError, undefined);
  const injects = writes.filter((w) => w.kind === "kbd_queue");
  assert.equal(injects.length, 2, "F1 pressed twice");
  for (const inject of injects) {
    assert.equal(inject.bytes.length, 1);
    assert.equal(inject.bytes[0], 133, "F1 PETSCII = 133");
  }
});

test("c64_input.key accepts single printable characters and reports duration metadata", async () => {
  const { ctx, writes } = createInputContext({ platformId: "vice" });
  const result = await toolRegistry.invoke("c64_input", {
    op: "key",
    key: "A",
    durationMs: 1,
  }, ctx);

  assert.equal(result.isError, undefined);
  assert.equal(result.metadata?.durationMs, 1);
  const inject = writes.find((w) => w.kind === "kbd_queue");
  assert.ok(inject);
  assert.deepEqual(Array.from(inject.bytes), [65]);
});

test("c64_input.joystick uses native REST input on c64u and VICE memory on vice", async () => {
  const { ctx: c64uCtx, inputBatches } = createInputContext({ platformId: "c64u" });
  const c64uResult = await toolRegistry.invoke("c64_input", {
    op: "joystick", port: 2, controls: ["right", "fire2"], action: "press",
  }, c64uCtx);
  assert.equal(c64uResult.isError, undefined);
  assert.deepEqual(inputBatches, [{ events: [{ kind: "joystick", port: 2, inputs: ["right", "fire2"], transition: "press" }] }]);

  const { ctx: viceCtx, writes } = createInputContext({ platformId: "vice" });
  const result = await toolRegistry.invoke("c64_input", {
    op: "joystick", port: 2, controls: ["right"], action: "press",
  }, viceCtx);
  assert.equal(result.isError, undefined);
  const memSet = writes.find((w) => w.kind === "vice_mem_set");
  assert.ok(memSet, "joystick press must perform a memory write");
  assert.equal(memSet.address, 0xDC00);
});

test("c64_input keyboard, release_all, and state expose Ultimate REST input", async () => {
  const { ctx, inputBatches } = createInputContext({ platformId: "c64u" });
  const keyboard = await toolRegistry.invoke("c64_input", {
    op: "keyboard", inputs: ["left_shift", "a"], transition: "tap",
  }, ctx);
  assert.equal(keyboard.isError, undefined);
  const release = await toolRegistry.invoke("c64_input", { op: "release_all" }, ctx);
  assert.equal(release.isError, undefined);
  const state = await toolRegistry.invoke("c64_input", { op: "state" }, ctx);
  assert.equal(state.isError, undefined);
  assert.deepEqual(inputBatches, [
    { events: [{ kind: "keyboard", inputs: ["left_shift", "a"], transition: "tap" }] },
    { events: [{ kind: "release_all" }] },
  ]);
  assert.deepEqual(state.structuredContent?.data.keyboard.inputs, ["left_shift"]);
});

test("c64_input.joystick supports release and tap actions on vice", async () => {
  const { ctx, writes } = createInputContext({ platformId: "vice" });
  const releaseResult = await toolRegistry.invoke("c64_input", {
    op: "joystick", port: 1, controls: [], action: "release",
  }, ctx);
  const tapResult = await toolRegistry.invoke("c64_input", {
    op: "joystick", port: 2, controls: ["up", "fire"], action: "tap", durationMs: 10,
  }, ctx);

  assert.equal(releaseResult.isError, undefined);
  assert.equal(tapResult.isError, undefined);
  const viceWrites = writes.filter((w) => w.kind === "vice_mem_set");
  assert.deepEqual(
    viceWrites.map((entry) => ({ address: entry.address, bytes: Array.from(entry.bytes) })),
    [
      { address: 0xDC01, bytes: [0xFF] },
      { address: 0xDC00, bytes: [0xEE] },
      { address: 0xDC00, bytes: [0xFF] },
    ],
  );
});

test("c64_input.write_text rejects unrecognised key tokens cleanly", async () => {
  const { ctx } = createInputContext({ platformId: "vice" });
  const result = await toolRegistry.invoke("c64_input", {
    op: "key", key: "WHATEVER",
  }, ctx);
  assert.equal(result.isError, true);
});
