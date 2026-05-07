import test from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { debugModuleGroup } from "../src/tools/debug.js";
import { ViceClient } from "../src/vice/viceClient.js";
import { startViceMockServer } from "../src/vice/mockServer.js";
import {
  delay,
  ensureXvfbSocketDir,
  resolveXvfbDisplayForLaunch,
  startViceProcess,
  shouldUseXvfb,
  terminateProcess,
  waitForExit,
  waitForPort,
} from "../src/vice/process.js";
import {
  asciiToScreenCodes,
  buildReadyPattern,
  waitForAnyScreenText,
  waitForBasicReady,
  waitForScreenPattern,
  waitForStableScreenPattern,
} from "../src/vice/readiness.js";

async function createViceSession() {
  const server = await startViceMockServer({ host: "127.0.0.1", port: 0 });
  const client = new ViceClient();
  await client.connect(server.port);
  return {
    server,
    client,
    async close() {
      try {
        client.close();
      } finally {
        await server.stop();
      }
    },
  };
}

function createDebugCtx(client) {
  return {
    client,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: { id: "vice", features: [], limitedFeatures: [] },
    setPlatform() {
      return { id: "vice", features: [], limitedFeatures: [] };
    },
  };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.killCalls = [];
  }

  kill(signal) {
    this.killCalls.push(signal);
    this.signalCode = signal;
    this.emit("exit", null, signal);
    return true;
  }
}

function createFakeViceBinary(t, mode = "listen", options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-vice-process-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const monitorScript = path.join(dir, "fake-vice.mjs");
  const wrapperScript = path.join(dir, "fake-vice");
  const argsFile = options.argsFile ? path.resolve(options.argsFile) : null;
  const trafficFile = options.trafficFile ? path.resolve(options.trafficFile) : null;
  const source = mode === "listen"
    ? `import net from "node:net";
import fs from "node:fs";
const args = process.argv.slice(2);
let host = "127.0.0.1";
let port = 6502;
const argsFile = ${JSON.stringify(argsFile)};
const trafficFile = ${JSON.stringify(trafficFile)};
if (argsFile) {
  fs.writeFileSync(argsFile, JSON.stringify(args), "utf8");
}
if (trafficFile) {
  fs.writeFileSync(trafficFile, "", "utf8");
}
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "-binarymonitoraddress" && typeof args[index + 1] === "string") {
    const [nextHost, nextPort] = args[index + 1].split(":");
    host = nextHost || host;
    port = Number(nextPort || port);
  }
}
const server = net.createServer((socket) => {
  socket.on("data", (chunk) => {
    if (trafficFile) {
      fs.appendFileSync(trafficFile, chunk.toString("hex") + "\\n");
    }
  });
});
server.listen(port, host);
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => {}, 1000);
`
    : `process.stderr.write("synthetic vice failure\\n");
process.exit(1);
`;
  fs.writeFileSync(monitorScript, source, "utf8");
  fs.writeFileSync(wrapperScript, `#!/usr/bin/env bash
exec node "${monitorScript}" "$@"
`, "utf8");
  fs.chmodSync(wrapperScript, 0o755);
  return wrapperScript;
}

test("ViceClient integrates with the VICE mock server for debugger and resource workflows", async (t) => {
  const session = await createViceSession();
  t.after(async () => {
    await session.close();
  });

  await session.client.info();

  const created = await session.client.checkpointCreate({
    start: 0x1000,
    end: 0x1004,
    stopOnHit: true,
    enabled: true,
    operations: { execute: true, load: true, store: false },
    temporary: true,
    memspace: 2,
  });
  assert.equal(created.start, 0x1000);
  assert.equal(created.end, 0x1004);
  assert.equal(created.operations.execute, true);
  assert.equal(created.operations.load, true);
  assert.equal(created.operations.store, false);
  assert.equal(created.memspace, 2);

  const fetched = await session.client.checkpointGet(created.id);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.temporary, true);

  let checkpoints = await session.client.checkpointList();
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].id, created.id);

  await session.client.checkpointToggle(created.id, false);
  await session.client.checkpointSetCondition(created.id, "A == #$01");
  const toggled = await session.client.checkpointGet(created.id);
  assert.equal(toggled.enabled, false);
  assert.equal(toggled.hasCondition, true);

  const metadata = await session.client.registersAvailable();
  assert.ok(metadata.some((entry) => entry.name === "PC"));
  const registersBefore = await session.client.registersGet();
  assert.ok(registersBefore.some((entry) => entry.id === 0));

  const registersAfter = await session.client.registersSet([
    { id: 0, value: 0x1234 },
    { name: "A", value: 0x56 },
  ], { metadata });
  assert.equal(registersAfter.find((entry) => entry.id === 0)?.value, 0x1234);
  assert.equal(registersAfter.find((entry) => entry.id === 1)?.value, 0x56);

  await session.client.stepInstructions(2, { stepOver: true });
  await session.client.stepReturn();

  const display = await session.client.displayGet({ alternateCanvas: true, format: 1 });
  assert.equal(display.debugWidth, 320);
  assert.equal(display.debugHeight, 200);
  assert.equal(display.pixels.length, 64);

  await session.client.resourceSet("Drive8Type", 1581);
  await session.client.resourceSet("Drive8Image", "demo.d64");
  assert.deepEqual(await session.client.resourceGet("Drive8Type"), { type: "int", value: 1581 });
  assert.deepEqual(await session.client.resourceGet("Drive8Image"), { type: "string", value: "demo.d64" });
  assert.deepEqual(await session.client.resourceGet("MissingResource"), { type: "string", value: "" });

  await session.client.checkpointDelete(created.id);
  checkpoints = await session.client.checkpointList();
  assert.equal(checkpoints.length, 0);
});

test("ViceClient validates error cases against the VICE mock server", async (t) => {
  const session = await createViceSession();
  t.after(async () => {
    await session.close();
  });

  await assert.rejects(() => session.client.checkpointGet(999), /BM error 0x83/);
  await assert.rejects(() => session.client.checkpointToggle(999, true), /BM error 0x83/);
  await assert.rejects(() => session.client.checkpointSetCondition(999, "X == 1"), /BM error 0x83/);
  await assert.rejects(() => session.client.registersSet([], {}), /At least one register write must be provided/);
  await assert.rejects(() => session.client.registersSet([{ id: 99, value: 1 }]), /Unknown register id 99/);
  await assert.rejects(() => session.client.registersSet([{ name: "ZZ", value: 1 }]), /Unknown register name ZZ/);
  await assert.rejects(() => session.client.registersSet([{ value: 1 }]), /requires id or name/);
  await assert.rejects(() => session.client.resourceGet("   "), /Resource name must not be empty/);
  await assert.rejects(() => session.client.resourceSet("   ", 1), /Resource name must not be empty/);
  await assert.rejects(() => session.client.resourceSet("Name", "x".repeat(256)), /limited to 255 bytes/);
});

test("VICE readiness helpers work against the VICE mock server", async (t) => {
  const session = await createViceSession();
  t.after(async () => {
    await session.close();
  });

  const anyText = await waitForAnyScreenText(session.client, 100, 10);
  assert.equal(anyText, true);

  const helloPattern = asciiToScreenCodes("HELLO");
  const readyPattern = buildReadyPattern();
  const helloWait = waitForScreenPattern(session.client, helloPattern, 500, 10, undefined, async () => {
    await session.client.keyboardFeed("RUN\r");
  });
  const readyIdx = await waitForScreenPattern(session.client, readyPattern, 100, 10);
  const helloIdx = await helloWait;
  assert.ok(readyIdx >= 0);
  assert.ok(helloIdx >= 0);

  const ptrs = Buffer.alloc(8);
  ptrs.writeUInt16LE(0x0801, 0);
  ptrs.writeUInt16LE(0x0810, 2);
  ptrs.writeUInt16LE(0x0810, 4);
  ptrs.writeUInt16LE(0x0810, 6);
  await session.client.memSet(0x002B, ptrs);

  const ready = await waitForBasicReady(session.client, { timeoutMs: 250, ensurePrompt: true });
  assert.deepEqual(ready, { pointersOk: true, promptOk: true });

  const noPrompt = await waitForBasicReady(session.client, { timeoutMs: 250, ensurePrompt: false });
  assert.deepEqual(noPrompt, { pointersOk: true, promptOk: false });
});

test("VICE readiness helpers handle timeouts and resume errors safely", async () => {
  let exitCalls = 0;
  const blankScreen = Buffer.alloc(1000, 0x20);
  const stubClient = {
    async memGet() {
      return blankScreen;
    },
    async exitMonitor() {
      exitCalls += 1;
      throw new Error("already running");
    },
    async keyboardFeed() {},
  };

  const idx = await waitForScreenPattern(stubClient, asciiToScreenCodes("HELLO"), 30, 5);
  const anyText = await waitForAnyScreenText(stubClient, 30, 5);
  const ready = await waitForBasicReady({
    async memGet(start) {
      if (start === 0x002B) {
        return Buffer.alloc(8, 0x00);
      }
      return blankScreen;
    },
    async exitMonitor() {
      exitCalls += 1;
      throw new Error("already running");
    },
    async keyboardFeed() {},
  }, { timeoutMs: 30, ensurePrompt: true });

  assert.equal(idx, -1);
  assert.equal(anyText, false);
  assert.deepEqual(ready, { pointersOk: false, promptOk: false });
  assert.ok(exitCalls > 0);
});

test("VICE readiness helpers can require a stable prompt across multiple reads", async () => {
  let readCount = 0;
  let exitCalls = 0;
  const stableScreen = Buffer.alloc(1000, 0x20);
  buildReadyPattern().copy(stableScreen, 0);
  const blankScreen = Buffer.alloc(1000, 0x20);

  const stubClient = {
    async memGet() {
      readCount += 1;
      return readCount >= 2 ? stableScreen : blankScreen;
    },
    async exitMonitor() {
      exitCalls += 1;
    },
  };

  const idx = await waitForStableScreenPattern(stubClient, buildReadyPattern(), 100, 5, 2);

  assert.equal(idx, 0);
  assert.ok(readCount >= 3);
  assert.ok(exitCalls > 0);
});

test("debug module manages checkpoints, registers, and errors", async () => {
  const checkpoints = [
    {
      id: 1,
      start: 0x0801,
      end: 0x0804,
      enabled: true,
      stopOnHit: true,
      temporary: false,
      hitCount: 0,
      ignoreCount: 0,
      operations: { execute: true, load: false, store: false },
      memspace: 0,
      hasCondition: false,
    },
  ];
  const calls = [];
  const ctx = createDebugCtx({
    async viceCheckpointList() {
      calls.push("list");
      return checkpoints;
    },
    async viceCheckpointGet(id) {
      calls.push({ op: "get", id });
      return checkpoints[0];
    },
    async viceCheckpointCreate(payload) {
      calls.push({ op: "create", payload });
      return { ...checkpoints[0], start: payload.start, end: payload.end, memspace: payload.memspace };
    },
    async viceCheckpointDelete(id) {
      calls.push({ op: "delete", id });
    },
    async viceCheckpointToggle(id, enabled) {
      calls.push({ op: "toggle", id, enabled });
    },
    async viceCheckpointSetCondition(id, expression) {
      calls.push({ op: "condition", id, expression });
    },
    async viceRegistersAvailable() {
      return [
        { id: 0, name: "PC", bits: 16, size: 2 },
        { id: 1, name: "A", bits: 8, size: 1 },
      ];
    },
    async viceRegistersGet() {
      return [
        { id: 0, size: 2, value: 0x0801 },
        { id: 1, size: 1, value: 0x42 },
        { id: 99, size: 1, value: 0x00 },
      ];
    },
    async viceRegistersSet(writes, options) {
      calls.push({ op: "set", writes, options });
      return [
        { id: 0, size: 2, value: 0x0801 },
        { id: 1, size: 1, value: 0x77 },
      ];
    },
    async viceStepInstructions(count, options) {
      calls.push({ op: "step", count, options });
    },
    async viceStepReturn() {
      calls.push({ op: "return" });
    },
  });

  const listed = await debugModuleGroup.invoke("c64_debug", { op: "list_checkpoints" }, ctx);
  assert.equal(listed.metadata?.count, 1);
  assert.equal(listed.structuredContent?.data?.checkpoints[0]?.start, "$0801");

  const created = await debugModuleGroup.invoke("c64_debug", {
    op: "create_checkpoint",
    address: "$1000",
    endAddress: "0x1004",
    stopOnHit: false,
    enabled: true,
    temporary: true,
    operations: { execute: true, load: true, store: true },
    memspace: 2,
  }, ctx);
  assert.equal(created.metadata?.id, 1);
  assert.equal(calls.find((entry) => entry.op === "create").payload.start, 0x1000);
  assert.equal(calls.find((entry) => entry.op === "create").payload.end, 0x1004);
  assert.equal(calls.find((entry) => entry.op === "create").payload.operations.store, true);

  const fetched = await debugModuleGroup.invoke("c64_debug", { op: "get_checkpoint", id: 1 }, ctx);
  assert.equal(fetched.structuredContent?.data?.checkpoint?.id, 1);

  const toggled = await debugModuleGroup.invoke("c64_debug", { op: "toggle_checkpoint", id: 1, enabled: false }, ctx);
  assert.equal(toggled.metadata?.enabled, false);

  const conditioned = await debugModuleGroup.invoke("c64_debug", { op: "set_condition", id: 1, expression: "A == 1" }, ctx);
  assert.equal(conditioned.metadata?.id, 1);

  const registers = await debugModuleGroup.invoke("c64_debug", { op: "list_registers", memspace: 1 }, ctx);
  assert.equal(registers.metadata?.memspace, 1);
  assert.equal(registers.structuredContent?.data?.registers.length, 2);

  const filtered = await debugModuleGroup.invoke("c64_debug", {
    op: "get_registers",
    registers: [{ id: 0 }, { name: "missing" }],
  }, ctx);
  assert.equal(filtered.metadata?.count, 1);
  assert.equal(filtered.structuredContent?.data?.registers[0]?.id, 0);

  const written = await debugModuleGroup.invoke("c64_debug", {
    op: "set_registers",
    writes: [{ name: "A", value: 0x77 }],
  }, ctx);
  assert.equal(written.structuredContent?.data?.registers.find((entry) => entry.id === 1)?.value, 0x77);

  const stepped = await debugModuleGroup.invoke("c64_debug", { op: "step", count: 2, mode: "over" }, ctx);
  assert.equal(stepped.metadata?.mode, "over");

  const returned = await debugModuleGroup.invoke("c64_debug", { op: "step_return" }, ctx);
  assert.equal(returned.metadata?.success, true);

  const deleted = await debugModuleGroup.invoke("c64_debug", { op: "delete_checkpoint", id: 1 }, ctx);
  assert.equal(deleted.metadata?.id, 1);

  const invalidAddress = await debugModuleGroup.invoke("c64_debug", { op: "create_checkpoint", address: "$10000" }, ctx);
  assert.equal(invalidAddress.isError, true);
  assert.equal(invalidAddress.metadata?.error?.kind, "validation");

  const missingSelector = await debugModuleGroup.invoke("c64_debug", {
    op: "set_registers",
    writes: [{ value: 1 }],
  }, ctx);
  assert.equal(missingSelector.isError, true);
  assert.equal(missingSelector.metadata?.error?.kind, "validation");

  const failingCtx = createDebugCtx({
    async viceCheckpointList() { throw new Error("list failed"); },
    async viceCheckpointGet() { throw new Error("get failed"); },
    async viceCheckpointCreate() { throw new Error("create failed"); },
    async viceCheckpointDelete() { throw new Error("delete failed"); },
    async viceCheckpointToggle() { throw new Error("toggle failed"); },
    async viceCheckpointSetCondition() { throw new Error("condition failed"); },
    async viceRegistersAvailable() { throw new Error("register metadata failed"); },
    async viceRegistersGet() { throw new Error("register read failed"); },
    async viceRegistersSet() { throw new Error("register write failed"); },
    async viceStepInstructions() { throw new Error("step failed"); },
    async viceStepReturn() { throw new Error("return failed"); },
  });

  for (const args of [
    { op: "list_checkpoints" },
    { op: "get_checkpoint", id: 1 },
    { op: "create_checkpoint", address: "$1000" },
    { op: "delete_checkpoint", id: 1 },
    { op: "toggle_checkpoint", id: 1, enabled: true },
    { op: "set_condition", id: 1, expression: "A == 1" },
    { op: "list_registers" },
    { op: "get_registers" },
    { op: "set_registers", writes: [{ id: 1, value: 1 }] },
    { op: "step", count: 1 },
    { op: "step_return" },
  ]) {
    const result = await debugModuleGroup.invoke("c64_debug", args, failingCtx);
    assert.equal(result.isError, true);
    assert.equal(result.metadata?.error?.kind, "unknown");
  }
});

test("VICE process helpers cover environment, sockets, and termination paths", async () => {
  const envKeys = ["CI", "DISPLAY", "DISABLE_XVFB", "FORCE_XVFB", "VICE_XVFB_DISPLAY", "WAYLAND_DISPLAY"];
  const backup = new Map(envKeys.map((key) => [key, process.env[key]]));
  const restoreEnv = () => {
    for (const key of envKeys) {
      const value = backup.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    delete process.env.CI;
    delete process.env.DISABLE_XVFB;
    delete process.env.FORCE_XVFB;
    delete process.env.VICE_XVFB_DISPLAY;
    process.env.DISPLAY = ":1";
    delete process.env.WAYLAND_DISPLAY;
    assert.deepEqual(shouldUseXvfb(true), { useXvfb: false, display: ":1" });
    assert.deepEqual(shouldUseXvfb(undefined), { useXvfb: false, display: ":1" });

    process.env.DISABLE_XVFB = "1";
    assert.deepEqual(shouldUseXvfb(false), { useXvfb: false, display: ":1" });

    delete process.env.DISABLE_XVFB;
    process.env.FORCE_XVFB = "1";
    process.env.VICE_XVFB_DISPLAY = ":77";
    assert.deepEqual(shouldUseXvfb(true), { useXvfb: true, display: ":77" });

    delete process.env.FORCE_XVFB;
    delete process.env.DISPLAY;
    process.env.WAYLAND_DISPLAY = "wayland-0";
    assert.deepEqual(shouldUseXvfb(true), { useXvfb: false, display: "wayland-0" });

    delete process.env.WAYLAND_DISPLAY;
    process.env.CI = "yes";
    assert.deepEqual(shouldUseXvfb(true), { useXvfb: true, display: ":77" });

    delete process.env.CI;
    delete process.env.VICE_XVFB_DISPLAY;
    assert.deepEqual(shouldUseXvfb(undefined), { useXvfb: true, display: ":99" });

    process.env.DISPLAY = ":2";
    assert.deepEqual(shouldUseXvfb(false), { useXvfb: true, display: ":99" });

    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP address");
    }
    await waitForPort("127.0.0.1", address.port, 500);
    await new Promise((resolve) => server.close(resolve));

    await assert.rejects(() => waitForPort("127.0.0.1", 6553, 100), /Timeout waiting for VICE monitor/);

    const exitingChild = new FakeChild();
    const waiting = waitForExit(exitingChild, 100);
    setTimeout(() => {
      exitingChild.exitCode = 0;
      exitingChild.emit("exit", 0, null);
    }, 10);
    await waiting;

    const liveChild = new FakeChild();
    await terminateProcess(liveChild, "SIGTERM", 50);
    assert.deepEqual(liveChild.killCalls, ["SIGTERM"]);

    const exitedChild = new FakeChild();
    exitedChild.exitCode = 0;
    await terminateProcess(exitedChild, "SIGKILL", 10);
    assert.deepEqual(exitedChild.killCalls, []);

    await terminateProcess(null, "SIGTERM", 10);

    ensureXvfbSocketDir(true);
    const start = Date.now();
    await delay(5);
    assert.ok(Date.now() - start >= 0);
  } finally {
    restoreEnv();
  }
});

test("resolveXvfbDisplayForLaunch skips occupied default displays unless explicitly pinned", () => {
  const previousDisplay = process.env.VICE_XVFB_DISPLAY;
  const originalExistsSync = fs.existsSync;
  fs.existsSync = (targetPath) => targetPath === "/tmp/.X99-lock";

  try {
    delete process.env.VICE_XVFB_DISPLAY;
    assert.equal(resolveXvfbDisplayForLaunch(":99"), ":100");

    process.env.VICE_XVFB_DISPLAY = ":99";
    assert.equal(resolveXvfbDisplayForLaunch(":99"), ":99");
  } finally {
    fs.existsSync = originalExistsSync;
    if (previousDisplay === undefined) {
      delete process.env.VICE_XVFB_DISPLAY;
    } else {
      process.env.VICE_XVFB_DISPLAY = previousDisplay;
    }
  }
});

test("startViceProcess starts and stops a monitor process without Xvfb", async (t) => {
  const fakeVice = createFakeViceBinary(t, "listen");
  const previousDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ":1";

  try {
    const handle = await startViceProcess({
      binary: fakeVice,
      host: "127.0.0.1",
      port: 6515,
      visible: true,
      warp: false,
      extraArgs: ["-test-flag"],
    });

    t.after(async () => {
      await handle.stop();
    });

    assert.equal(handle.host, "127.0.0.1");
    assert.equal(handle.port, 6515);
    await waitForPort(handle.host, handle.port, 500);
    await handle.stop();
    assert.ok(handle.process.signalCode !== null || handle.process.exitCode !== null);
  } finally {
    if (previousDisplay === undefined) {
      delete process.env.DISPLAY;
    } else {
      process.env.DISPLAY = previousDisplay;
    }
  }
});

test("startViceProcess resumes emulation immediately after the monitor becomes ready", async (t) => {
  const trafficFile = path.join(os.tmpdir(), `c64bridge-vice-traffic-${process.pid}-${Date.now()}.log`);
  const fakeVice = createFakeViceBinary(t, "listen", { trafficFile });
  const previousDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ":1";

  try {
    const handle = await startViceProcess({
      binary: fakeVice,
      host: "127.0.0.1",
      port: 6519,
      visible: true,
      warp: false,
    });

    t.after(async () => {
      await handle.stop();
      fs.rmSync(trafficFile, { force: true });
    });

    await delay(25);
    const frames = fs.readFileSync(trafficFile, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    assert.equal(frames.some((line) => line.endsWith("aa")), true);
  } finally {
    if (previousDisplay === undefined) {
      delete process.env.DISPLAY;
    } else {
      process.env.DISPLAY = previousDisplay;
    }
    fs.rmSync(trafficFile, { force: true });
  }
});

test("startViceProcess forwards the VICE resource directory when provided", async (t) => {
  const argsFile = path.join(os.tmpdir(), `c64bridge-vice-args-${process.pid}-${Date.now()}.json`);
  const fakeVice = createFakeViceBinary(t, "listen", { argsFile });
  const previousDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ":1";

  try {
    const handle = await startViceProcess({
      binary: fakeVice,
      directory: "/tmp/vice-data",
      host: "127.0.0.1",
      port: 6518,
      visible: true,
      warp: false,
    });

    t.after(async () => {
      await handle.stop();
      fs.rmSync(argsFile, { force: true });
    });

    const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    assert.ok(args.includes("-directory"));
    assert.ok(args.includes("/tmp/vice-data"));
  } finally {
    if (previousDisplay === undefined) {
      delete process.env.DISPLAY;
    } else {
      process.env.DISPLAY = previousDisplay;
    }
    fs.rmSync(argsFile, { force: true });
  }
});

test("startViceProcess can supervise Xvfb-backed sessions", async (t) => {
  const fakeVice = createFakeViceBinary(t, "listen");
  const backup = {
    DISPLAY: process.env.DISPLAY,
    FORCE_XVFB: process.env.FORCE_XVFB,
    VICE_XVFB_DISPLAY: process.env.VICE_XVFB_DISPLAY,
  };
  process.env.DISPLAY = "";
  process.env.FORCE_XVFB = "1";
  process.env.VICE_XVFB_DISPLAY = `:${200 + (process.pid % 200)}`;

  try {
    const handle = await startViceProcess({
      binary: fakeVice,
      host: "127.0.0.1",
      port: 6516,
      visible: false,
    });

    t.after(async () => {
      await handle.stop();
    });

    await waitForPort(handle.host, handle.port, 500);
    await handle.stop();
    assert.ok(handle.process.signalCode !== null || handle.process.exitCode !== null);
  } finally {
    for (const [key, value] of Object.entries(backup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("startViceProcess surfaces startup failures with stderr context", async (t) => {
  const fakeVice = createFakeViceBinary(t, "fail");
  const previousDisplay = process.env.DISPLAY;
  process.env.DISPLAY = ":1";

  try {
    await assert.rejects(
      () => startViceProcess({
        binary: fakeVice,
        host: "127.0.0.1",
        port: 6517,
        visible: true,
      }),
      /synthetic vice failure/,
    );
  } finally {
    if (previousDisplay === undefined) {
      delete process.env.DISPLAY;
    } else {
      process.env.DISPLAY = previousDisplay;
    }
  }
});
