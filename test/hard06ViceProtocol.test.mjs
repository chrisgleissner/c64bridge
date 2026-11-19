import test from "#test/runner";
import assert from "#test/assert";
import { ViceClient, describeMonitorError } from "../src/vice/viceClient.js";
import { startViceMockServer } from "../src/vice/mockServer.js";

async function withMock(body, options) {
  const server = await startViceMockServer(options);
  const client = new ViceClient();
  await client.connect(server.port);
  try {
    await body(client, server);
  } finally {
    client.close();
    await server.stop();
  }
}

test("VICE-9 monitor errors name the command and the meaning of the code", async () => {
  assert.equal(describeMonitorError(0x81, 0x01), "BM error 0x81 (invalid parameter value) in memory get 0x01");
  assert.equal(describeMonitorError(0x77), "BM error 0x77");
  await withMock(async (client) => {
    await assert.rejects(() => client.checkpointGet(999), /BM error 0x1 \(object does not exist\) in checkpoint get 0x11/);
    await assert.rejects(() => client.checkpointDelete(999), /object does not exist\) in checkpoint delete 0x13/);
    await assert.rejects(() => client.checkpointCreate({ start: 0x1000 }).then(() => client.checkpointToggle(77, true)), /in checkpoint toggle 0x15/);
  });
});

test("VICE-18 mock sets TCP_NODELAY so the exit response is not delayed by Nagle", async () => {
  await withMock(async (client) => {
    await client.memGet(0x0400, 0x0403);
    const started = process.hrtime.bigint();
    for (let i = 0; i < 3; i += 1) {
      await client.memGet(0x0400, 0x0403);
      await client.exitMonitor();
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 60, `3 exit round trips took ${ms} ms`);
  });
});

test("mock follows the specification: memory set validation, checkpoint list count, vice info body", async () => {
  await withMock(async (client, server) => {
    // 10 bytes at $FFFF wrap the 16-bit end address: the specification's length check rejects it.
    await assert.rejects(() => client.memSet(0xffff, Buffer.alloc(10, 0xaa)), /in memory set 0x02/);
    assert.equal((await client.memGet(0xffff, 0xffff))[0], 0);
    await client.checkpointCreate({ start: 0x1000 });
    const frames = [];
    const original = client.onData.bind(client);
    client.onData = (chunk) => { frames.push(Buffer.from(chunk)); original(chunk); };
    await client.checkpointList();
    const last = Buffer.concat(frames).subarray(-16);
    assert.equal(last[6], 0x14);
    assert.equal(last.readUInt32LE(12), 1, "CC is the total checkpoint count");
    frames.length = 0;
    await client.info();
    assert.deepEqual([...Buffer.concat(frames).subarray(-10)], [4, 3, 10, 0, 0, 4, 0, 0, 0, 0]);
    void server;
  });
});

test("VICE-11 resource_set rejects a number that does not fit 32 bits instead of truncating it", async () => {
  await withMock(async (client) => {
    await assert.rejects(() => client.resourceSet("SoundVolume", 4294967296 + 50), /not a 32-bit integer/);
    await assert.rejects(() => client.resourceSet("SoundVolume", 1.5), /not a 32-bit integer/);
    assert.deepEqual(await client.resourceGet("SoundVolume"), { type: "int", value: 100 });
    await client.resourceSet("SoundVolume", -5);
    assert.deepEqual(await client.resourceGet("SoundVolume"), { type: "int", value: -5 });
  });
});

test("VICE-16 a step wait ends at once when the connection drops", async () => {
  await withMock(async (client, server) => {
    const started = Date.now();
    setTimeout(() => server.dropConnections(), 50);
    const stopped = await client.stepInstructions(1, { waitForStopMs: 3_000 });
    assert.equal(stopped, false);
    assert.ok(Date.now() - started < 1_500, `waited ${Date.now() - started} ms`);
  }, { stepEventDelayMs: 5_000 });
});

test("VICE-13 a missing explicit VICE binary is an error when a launch is needed, not a silent other emulator", async () => {
  const { ViceBackend } = await import("../src/device.js");
  const saved = { VICE_BINARY: process.env.VICE_BINARY, VICE_TEST_TARGET: process.env.VICE_TEST_TARGET };
  process.env.VICE_BINARY = "/nonexistent/dir/x64sc";
  delete process.env.VICE_TEST_TARGET;
  try {
    const backend = new ViceBackend({ host: "127.0.0.1", port: 1 });
    await assert.rejects(() => backend.readMemory(0x400, 1), /VICE binary '\/nonexistent\/dir\/x64sc' from VICE_BINARY was not found/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("VICE-14 poweroff of an emulator that is not running does not launch one", async () => {
  const { ViceBackend } = await import("../src/device.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vice-off-"));
  const marker = path.join(dir, "launched");
  const fake = path.join(dir, "x64sc");
  fs.writeFileSync(fake, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const saved = { VICE_BINARY: process.env.VICE_BINARY, VICE_TEST_TARGET: process.env.VICE_TEST_TARGET };
  process.env.VICE_BINARY = fake;
  delete process.env.VICE_TEST_TARGET;
  try {
    const free = await startViceMockServer();
    const port = free.port;
    await free.stop();
    const backend = new ViceBackend({ host: "127.0.0.1", port });
    const result = await backend.poweroff();
    assert.equal(result.success, true);
    assert.equal(result.details.running, false);
    assert.equal(fs.existsSync(marker), false, "no emulator was launched");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("VICE-1 reset keeps stop-on-hit breakpoints and the session stays open", async () => {
  const { ViceBackend } = await import("../src/device.js");
  const saved = process.env.VICE_TEST_TARGET;
  process.env.VICE_TEST_TARGET = "mock";
  const server = await startViceMockServer();
  try {
    const backend = new ViceBackend({ host: "127.0.0.1", port: server.port });
    const cp = await backend.checkpointOperation((c) => c.checkpointCreate({ start: 0xc000 }));
    await backend.pause();
    const result = await backend.reset();
    assert.equal(result.success, true);
    assert.equal(server.stoppingCheckpoints, 1, "the breakpoint survived the reset");
    assert.equal(backend.sessionInfo().open, true);
    assert.equal(backend.sessionInfo().explicitPause, false);
    assert.equal(server.unsafeCloses, 0);
    const list = await backend.withMonitor((c) => c.checkpointList());
    assert.deepEqual(list.map((c) => c.id), [cp.id]);
    await backend.checkpointOperation((c) => c.checkpointDelete(cp.id));
  } finally {
    await server.stop();
    if (saved === undefined) delete process.env.VICE_TEST_TARGET; else process.env.VICE_TEST_TARGET = saved;
  }
});

test("VICE-2 an emulator that answered one probe is not probed again before every operation", async () => {
  const { ViceBackend } = await import("../src/device.js");
  const saved = process.env.VICE_TEST_TARGET;
  delete process.env.VICE_TEST_TARGET;
  const server = await startViceMockServer();
  try {
    const backend = new ViceBackend({ host: "127.0.0.1", port: server.port });
    await backend.readMemory(0x0400, 4);
    const opened = server.connectionsOpened;
    const commands = server.commands.length;
    for (let i = 0; i < 3; i += 1) await backend.readMemory(0x0400, 4);
    assert.equal(server.connectionsOpened - opened, 3, "one connection per call");
    assert.equal(server.commands.length - commands, 6, "memory get and exit per call, no info probe");
    assert.ok(!server.commands.slice(commands).some(([cmd]) => cmd === 0x85));
  } finally {
    await server.stop();
    if (saved === undefined) delete process.env.VICE_TEST_TARGET; else process.env.VICE_TEST_TARGET = saved;
  }
});

test("VICE-2 a verified emulator that went away is probed again, which launches a managed one", async () => {
  const { ViceBackend } = await import("../src/device.js");
  const saved = { VICE_TEST_TARGET: process.env.VICE_TEST_TARGET, VICE_BINARY: process.env.VICE_BINARY };
  delete process.env.VICE_TEST_TARGET;
  process.env.VICE_BINARY = "/nonexistent/dir/x64sc";
  const server = await startViceMockServer();
  try {
    const backend = new ViceBackend({ host: "127.0.0.1", port: server.port });
    await backend.readMemory(0x0400, 4);
    await server.stop();
    // The probe is repeated after the connection fails; with nothing listening it reaches the launch step.
    await assert.rejects(() => backend.readMemory(0x0400, 4), /VICE binary '\/nonexistent\/dir\/x64sc' from VICE_BINARY was not found/);
  } finally {
    await server.stop();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
