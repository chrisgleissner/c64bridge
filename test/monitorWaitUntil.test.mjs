import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolRegistry } from "../src/tools/registry/index.js";
import { C64Client } from "../src/c64Client.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";
import { startViceMockServer } from "../src/vice/mockServer.js";
import { setViceSymbols, clearViceSymbols } from "../src/tools/translation/symbolRegistry.js";
import { parseWaitUntilArgs } from "../src/monitor/waitUntil.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = { id: "c64u", features: [], limitedFeatures: [] };

test.afterEach(() => clearViceSymbols());

/** Stub client over a flat memory image; every read is recorded with the facade it was given. */
function stubClient({ type = "c64u", memory = new Uint8Array(0x10000), facade, onRead } = {}) {
  const pinned = facade ?? { type };
  const client = {
    reads: [],
    memory,
    pinned,
    async pinFacade() { return client.pinned; },
    async getActiveBackendType() { return client.pinned.type; },
    async readMemoryRaw(address, length, usedFacade) {
      client.reads.push({ address, length, facade: usedFacade });
      onRead?.(client.reads.length, client);
      return memory.slice(address, address + length);
    },
  };
  return client;
}

function makeCtx(client, extra = {}) {
  return { client, rag: {}, logger, platform, setPlatform: () => platform, ...extra };
}

const run = (ctx, args) => toolRegistry.invoke("c64_memory", { op: "wait_until", ...args }, ctx);
const data = (result) => result.structuredContent.data;

// ---------------------------------------------------------------- registration and argument validation
test("wait_until is a read operation of the existing c64_memory tool and no new top-level tool exists", () => {
  const descriptor = toolRegistry.list().find((entry) => entry.name === "c64_memory");
  const ops = JSON.stringify(descriptor.inputSchema);
  assert.match(ops, /wait_until/);
  assert.equal(toolRegistry.list().some((entry) => /wait_until/.test(entry.name)), false);
  assert.equal(descriptor.metadata.operationEffects?.wait_until ?? descriptor.operationEffects?.wait_until, "read");
});

const badArgs = [
  ["timeoutMs missing", { condition: { type: "screen_changed" } }, "$.timeoutMs"],
  ["timeoutMs 0", { condition: { type: "screen_changed" }, timeoutMs: 0 }, "$.timeoutMs"],
  ["timeoutMs above 1 hour", { condition: { type: "screen_changed" }, timeoutMs: 3_600_001 }, "$.timeoutMs"],
  ["timeoutMs fractional", { condition: { type: "screen_changed" }, timeoutMs: 1.5 }, "$.timeoutMs"],
  ["timeoutMs string", { condition: { type: "screen_changed" }, timeoutMs: "100" }, "$.timeoutMs"],
  ["pollIntervalMs below 50", { condition: { type: "screen_changed" }, timeoutMs: 100, pollIntervalMs: 49 }, "$.pollIntervalMs"],
  ["pollIntervalMs above 60000", { condition: { type: "screen_changed" }, timeoutMs: 100, pollIntervalMs: 60_001 }, "$.pollIntervalMs"],
  ["maxIterations 0", { condition: { type: "screen_changed" }, timeoutMs: 100, maxIterations: 0 }, "$.maxIterations"],
  ["maxIterations above 100000", { condition: { type: "screen_changed" }, timeoutMs: 100, maxIterations: 100_001 }, "$.maxIterations"],
  ["condition missing", { timeoutMs: 100 }, "$.condition"],
  ["unknown top-level key", { condition: { type: "screen_changed" }, timeoutMs: 100, pattern: "x" }, "$.pattern"],
  ["includeIo not boolean", { condition: { type: "screen_changed" }, timeoutMs: 100, includeIo: "yes" }, "$.includeIo"],
  ["bare hex address", { condition: { type: "equals", address: "C000", bytes: "01" }, timeoutMs: 100 }, "$.condition.address"],
  ["address overflow", { condition: { type: "equals", address: "$FFFF", bytes: "0102" }, timeoutMs: 100 }, "$.condition.address"],
  ["width 3", { condition: { type: "range", address: "$C000", width: 3, min: 0, max: 1 }, timeoutMs: 100 }, "$.condition.width"],
  ["mask above 255", { condition: { type: "masked", address: "$C000", mask: 256, value: 0 }, timeoutMs: 100 }, "$.condition.mask"],
];
for (const [name, args, expectedPath] of badArgs) {
  test(`wait_until validation: ${name}`, async () => {
    const client = stubClient();
    const result = await run(makeCtx(client), args);
    assert.equal(result.isError, true);
    assert.equal(result.metadata.error.kind, "validation");
    assert.equal(result.metadata.error.path, expectedPath, result.content[0].text);
    assert.equal(client.reads.length, 0, "validation failures read nothing");
  });
}

test("parseWaitUntilArgs applies the documented defaults", () => {
  const parsed = parseWaitUntilArgs({ condition: {}, timeoutMs: 5 });
  assert.equal(parsed.pollIntervalMs, 250);
  assert.equal(parsed.maxIterations, 10_000);
  assert.equal(parsed.includeIo, false);
});

// ---------------------------------------------------------------- results through the registry
test("a condition met on the first read returns a success result with the C7 fields and reads through the pinned facade", async () => {
  const client = stubClient();
  client.memory[0xc000] = 0x2a;
  const result = await run(makeCtx(client), { condition: { type: "equals", address: "$C000", bytes: "2A" }, timeoutMs: 1000 });
  assert.equal(result.isError, undefined);
  const d = data(result);
  assert.equal(d.met, true);
  assert.equal(d.reason, "condition_met");
  assert.deepEqual(d.target, { type: "memory", address: "$C000", length: 1 });
  assert.equal(d.observed, "$2A");
  assert.equal(d.iterations, 1);
  assert.equal(typeof d.elapsedMs, "number");
  assert.equal(d.backend, "c64u");
  assert.equal(d.firstObservation.value, "$2A");
  assert.equal(client.reads.length, 1);
  assert.equal(client.reads[0].facade, client.pinned, "the read goes to the pinned facade");
});

test("timeout and max_iterations are successful results with met false", async () => {
  const client = stubClient();
  const timeout = await run(makeCtx(client), { condition: { type: "equals", address: "$C000", bytes: "01" }, timeoutMs: 60, pollIntervalMs: 50 });
  assert.equal(timeout.isError, undefined);
  assert.equal(data(timeout).met, false);
  assert.equal(data(timeout).reason, "timeout");
  const capped = await run(makeCtx(client), { condition: { type: "equals", address: "$C000", bytes: "01" }, timeoutMs: 60_000, maxIterations: 2, pollIntervalMs: 50 });
  assert.equal(capped.isError, undefined);
  assert.equal(data(capped).reason, "max_iterations");
  assert.equal(data(capped).iterations, 2);
});

test("a delayed change is seen on a later iteration", async () => {
  const client = stubClient({ onRead: (count, c) => { if (count === 2) c.memory[0xc000] = 7; } });
  const result = await run(makeCtx(client), { condition: { type: "threshold", address: "$C000", comparison: "gte", value: 5, width: 1 }, timeoutMs: 5000, pollIntervalMs: 50 });
  assert.equal(data(result).reason, "condition_met");
  assert.equal(data(result).iterations, 2);
  assert.equal(data(result).firstObservation.value, 0);
  assert.equal(data(result).lastObservation.value, 7);
});

test("a read error is an error result with reason communication_failure that still carries the fields", async () => {
  let reads = 0;
  const client = stubClient();
  client.readMemoryRaw = async () => { reads += 1; if (reads === 2) throw new Error("connection reset"); return Uint8Array.of(0); };
  const result = await run(makeCtx(client), { condition: { type: "equals", address: "$C000", bytes: "01" }, timeoutMs: 5000, pollIntervalMs: 50 });
  assert.equal(result.isError, true);
  assert.equal(result.metadata.reason, "communication_failure");
  const d = data(result);
  assert.equal(d.reason, "communication_failure");
  assert.equal(d.met, false);
  assert.equal(d.iterations, 1);
  assert.equal(d.error, "connection reset");
  assert.equal(d.backend, "c64u");
  assert.equal(d.firstObservation.value, "$00");
  assert.match(result.content[0].text, /connection reset/);
  assert.equal(reads, 2, "no retry");
});

test("cancellation through ctx.signal returns a cancelled error result and reads nothing more", async () => {
  const controller = new AbortController();
  const client = stubClient({ onRead: (count) => { if (count === 1) setTimeout(() => controller.abort(), 10); } });
  const started = Date.now();
  const result = await run(makeCtx(client, { signal: controller.signal }), { condition: { type: "equals", address: "$C000", bytes: "01" }, timeoutMs: 600_000, pollIntervalMs: 60_000 });
  assert.equal(result.isError, true);
  assert.equal(result.metadata.cancelled, true);
  assert.equal(data(result).reason, "cancelled");
  assert.ok(Date.now() - started < 2000, "returns promptly, not after the poll interval");
  assert.equal(client.reads.length, 1);
});

test("an already aborted signal reads nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = stubClient();
  const result = await run(makeCtx(client, { signal: controller.signal }), { condition: { type: "screen_changed" }, timeoutMs: 1000 });
  assert.equal(result.metadata.cancelled, true);
  assert.equal(client.reads.length, 0);
});

test("progress is reported through ctx.reportProgress", async () => {
  const progress = [];
  const client = stubClient();
  await run(makeCtx(client, { reportProgress: (...a) => progress.push(a) }), { condition: { type: "equals", address: "$C000", bytes: "01" }, timeoutMs: 5000, maxIterations: 2, pollIntervalMs: 50 });
  assert.equal(progress.length, 2);
  assert.deepEqual(progress.map(([done, total]) => [done, total]), [[1, 2], [2, 2]]);
});

// ---------------------------------------------------------------- one-time resolution and pinning
test("symbols are resolved once at the start; a new symbol table cannot retarget a running wait", async () => {
  setViceSymbols([["counter", 0xc000]]);
  const client = stubClient({ onRead: (count) => { if (count === 1) setViceSymbols([["counter", 0xd800]]); } });
  const result = await run(makeCtx(client), { condition: { type: "equals", address: "counter", bytes: "01" }, timeoutMs: 5000, maxIterations: 3, pollIntervalMs: 50 });
  assert.deepEqual(client.reads.map((read) => read.address), [0xc000, 0xc000, 0xc000]);
  assert.equal(data(result).target.address, "$C000");
});

test("a backend switch during the wait does not retarget it", async () => {
  const first = { type: "c64u", id: "first" };
  const client = stubClient({ facade: first, onRead: (count, c) => { if (count === 1) c.pinned = { type: "vice", id: "other" }; } });
  const result = await run(makeCtx(client), { condition: { type: "equals", address: "$C000", bytes: "01" }, timeoutMs: 5000, maxIterations: 3, pollIntervalMs: 50 });
  assert.ok(client.reads.every((read) => read.facade === first), "every read uses the facade pinned at the start");
  assert.equal(data(result).backend, "c64u");
});

// ---------------------------------------------------------------- I/O area and backend rules
test("on Ultimate hardware $D000-$DFFF is refused unless includeIo is true; VICE reads it freely", async () => {
  const ioCondition = { type: "masked", address: "$D012", mask: 255, value: 0 };
  const refused = await run(makeCtx(stubClient()), { condition: ioCondition, timeoutMs: 100 });
  assert.equal(refused.isError, true);
  assert.equal(refused.metadata.error.path, "$.condition.address");
  assert.match(refused.content[0].text, /includeIo/);
  const overlapping = await run(makeCtx(stubClient()), { condition: { type: "changed", address: "$CFFF", length: 2 }, timeoutMs: 100 });
  assert.equal(overlapping.isError, true);
  const allowed = await run(makeCtx(stubClient()), { condition: ioCondition, timeoutMs: 100, includeIo: true });
  assert.equal(allowed.isError, undefined);
  assert.equal(data(allowed).met, true);
  const vice = await run(makeCtx(stubClient({ type: "vice" })), { condition: ioCondition, timeoutMs: 100 });
  assert.equal(vice.isError, undefined);
  const justBelow = await run(makeCtx(stubClient()), { condition: { type: "changed", address: "$CFFF", length: 1 }, timeoutMs: 1, pollIntervalMs: 50, maxIterations: 1 });
  assert.equal(justBelow.isError, undefined);
});

for (const backend of ["c64u", "u2"]) {
  test(`the checkpoint condition is a validation error on ${backend} and names the backend`, async () => {
    const client = stubClient({ type: backend });
    const result = await run(makeCtx(client), { condition: { type: "checkpoint", address: "$C000" }, timeoutMs: 100 });
    assert.equal(result.isError, true);
    assert.equal(result.metadata.error.kind, "validation");
    assert.equal(result.metadata.error.path, "$.condition.type");
    assert.match(result.content[0].text, new RegExp(backend));
    assert.equal(client.reads.length, 0);
  });
}

// ---------------------------------------------------------------- screen
test("screen_text matches the screen where the VIC-II shows it, case-insensitively, and reads through the pinned facade", async () => {
  const memory = new Uint8Array(0x10000);
  memory[0xd018] = 0x27; // screen at $0800, lower-case character set
  memory[0xdd00] = 0x03; // VIC bank 0
  memory.set([0x08, 0x05, 0x0c, 0x0c, 0x0f], 0x0800); // "hello" in screen codes
  memory.set([0x20, 0x20, 0x20], 0x0400);
  const client = stubClient({ memory });
  const result = await run(makeCtx(client), { condition: { type: "screen_text", text: "HELLO" }, timeoutMs: 1000, includeIo: true });
  assert.equal(data(result).reason, "condition_met", JSON.stringify(data(result)));
  assert.deepEqual(data(result).target, { type: "screen" });
  assert.ok(client.reads.some((read) => read.address === 0x0800 && read.facade === client.pinned));
  assert.ok(!client.reads.some((read) => read.address === 0x0400), "the default screen is not read when the VIC-II shows another");
});

test("screen_text uses the backend's own screen state when it has one", async () => {
  const facade = { type: "vice", async readScreenState() { return { baseAddress: 0x0400, charset: "upper", bytes: Uint8Array.from([0x12, 0x05, 0x01, 0x04, 0x19, 0x2e, ...new Array(994).fill(0x20)]) }; } };
  const client = stubClient({ facade });
  const result = await run(makeCtx(client), { condition: { type: "screen_text", text: "ready." }, timeoutMs: 1000 });
  assert.equal(data(result).reason, "condition_met");
  assert.equal(client.reads.length, 0);
});

test("screen_changed is met when the screen differs from the first read", async () => {
  // Each screen read is three reads: $D018, $DD00, the screen; the screen changes from the third screen read on.
  const memory = new Uint8Array(0x10000);
  const client = stubClient({ memory, onRead: (count, c) => { if (count >= 7) c.memory[0x0400] = 0x01; } });
  const result = await run(makeCtx(client), { condition: { type: "screen_changed" }, timeoutMs: 5000, pollIntervalMs: 50, includeIo: true });
  assert.equal(data(result).reason, "condition_met");
});

// ---------------------------------------------------------------- mock C64 server
test("against the mock C64 server: equals, range and changed see memory written by the server state", async () => {
  const mock = await startMockC64Server();
  const client = new C64Client(mock.baseUrl);
  try {
    mock.state.memory.set([0x34, 0x12], 0xc000);
    const ctx = makeCtx(client);
    const met = await run(ctx, { condition: { type: "range", address: "$C000", width: 2, min: 0x1200, max: 0x12ff }, timeoutMs: 3000 });
    assert.equal(data(met).reason, "condition_met", JSON.stringify(met.content));
    assert.equal(data(met).observed, 0x1234);
    assert.equal(data(met).backend, "c64u");

    const timer = setTimeout(() => { mock.state.memory[0xc001] = 0x99; }, 120);
    try {
      const changed = await run(ctx, { condition: { type: "changed", address: "$C000", length: 2 }, timeoutMs: 5000, pollIntervalMs: 50 });
      assert.equal(data(changed).reason, "condition_met");
      assert.equal(data(changed).observed, "$3499");
      assert.ok(data(changed).iterations >= 2);
    } finally { clearTimeout(timer); }

    const screen = await run(ctx, { condition: { type: "screen_text", text: "ready." }, timeoutMs: 3000 });
    assert.equal(data(screen).reason, "condition_met", JSON.stringify(data(screen)));

    const never = await run(ctx, { condition: { type: "equals", address: "$C000", bytes: "FFFF" }, timeoutMs: 80, pollIntervalMs: 50 });
    assert.equal(never.isError, undefined);
    assert.equal(data(never).reason, "timeout");
  } finally {
    await mock.close();
  }
});

// ---------------------------------------------------------------- VICE mock: checkpoint condition
async function withViceClient(body) {
  const names = ["C64BRIDGE_CONFIG", "C64_MODE", "VICE_TEST_TARGET", "VICE_PORT", "VICE_HOST"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const server = await startViceMockServer({ host: "127.0.0.1", port: 0 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wait-until-vice-"));
  const configPath = path.join(dir, "c64bridge.json");
  fs.writeFileSync(configPath, JSON.stringify({ vice: { host: "127.0.0.1", port: server.port } }), "utf8");
  process.env.C64BRIDGE_CONFIG = configPath;
  process.env.C64_MODE = "vice";
  process.env.VICE_TEST_TARGET = "mock";
  delete process.env.VICE_PORT;
  delete process.env.VICE_HOST;
  try {
    const client = new C64Client("http://unused.local", { forceC64uFacade: false });
    await client.info();
    await body(client, server);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) { assert.ok(Date.now() < deadline, message); await delay(10); }
}

test("VICE mock: the checkpoint condition is met by a hit, never stops the CPU, and the checkpoint is removed", async () => {
  await withViceClient(async (client, server) => {
    const pending = run(makeCtx(client), { condition: { type: "checkpoint", address: "$0810", kind: "exec" }, timeoutMs: 10_000, pollIntervalMs: 50 });
    await until(async () => (await client.viceCheckpointList()).length === 1, "the wait creates its checkpoint");
    const [created] = await client.viceCheckpointList();
    assert.equal(created.stopOnHit, false, "the checkpoint must not stop the CPU");
    assert.equal(created.temporary, false);
    assert.equal(created.start, 0x0810);
    assert.equal(created.operations.execute, true);
    await until(() => server.hitCheckpoint(created.id), "the CPU reaches the checkpoint");
    const result = await pending;
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(data(result).reason, "condition_met");
    assert.equal(data(result).backend, "vice");
    assert.deepEqual(data(result).target, { type: "checkpoint", address: "$0810", kind: "exec" });
    assert.equal(data(result).observed, 1);
    assert.deepEqual(await client.viceCheckpointList(), [], "the checkpoint is removed");
    assert.equal(server.stoppingCheckpoints, 0);
  });
});

for (const kind of ["load", "store"]) {
  test(`VICE mock: kind ${kind} sets only the matching access flag`, async () => {
    await withViceClient(async (client) => {
      const controller = new AbortController();
      const pending = run(makeCtx(client, { signal: controller.signal }), { condition: { type: "checkpoint", address: "$C000", kind }, timeoutMs: 60_000, pollIntervalMs: 60_000 });
      await until(async () => (await client.viceCheckpointList()).length === 1, "checkpoint exists");
      const [created] = await client.viceCheckpointList();
      assert.deepEqual(created.operations, { execute: false, load: kind === "load", store: kind === "store" });
      controller.abort();
      await pending;
      assert.deepEqual(await client.viceCheckpointList(), []);
    });
  });
}

test("VICE mock: timeout removes the checkpoint and is a successful met false result", async () => {
  await withViceClient(async (client) => {
    const result = await run(makeCtx(client), { condition: { type: "checkpoint", address: "$0810" }, timeoutMs: 120, pollIntervalMs: 50 });
    assert.equal(result.isError, undefined);
    assert.equal(data(result).reason, "timeout");
    assert.equal(data(result).met, false);
    assert.equal(data(result).observed, 0);
    assert.deepEqual(await client.viceCheckpointList(), []);
  });
});

test("VICE mock: cancellation removes the checkpoint", async () => {
  await withViceClient(async (client) => {
    const controller = new AbortController();
    const pending = run(makeCtx(client, { signal: controller.signal }), { condition: { type: "checkpoint", address: "$0810" }, timeoutMs: 60_000, pollIntervalMs: 60_000 });
    await until(async () => (await client.viceCheckpointList()).length === 1, "checkpoint exists");
    controller.abort();
    const result = await pending;
    assert.equal(result.metadata.cancelled, true);
    assert.equal(data(result).reason, "cancelled");
    assert.deepEqual(await client.viceCheckpointList(), []);
  });
});

test("VICE mock: memory conditions work on the VICE backend too", async () => {
  await withViceClient(async (client) => {
    const result = await run(makeCtx(client), { condition: { type: "equals", address: "$0400", bytes: "0000" }, timeoutMs: 2000, maxIterations: 1 });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(data(result).backend, "vice");
  });
});
