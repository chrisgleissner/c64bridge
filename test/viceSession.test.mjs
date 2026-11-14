import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { C64Client } from "../src/c64Client.js";
import { ViceBackend } from "../src/device.js";
import { startViceMockServer } from "../src/vice/mockServer.js";
import { toolRegistry } from "../src/tools/registry/index.js";
import { getPlatformStatus, setPlatform } from "../src/platform.js";

// These tests drive the same C64Client methods the c64_debug, c64_system and c64_memory tools
// call, against a mock server that behaves like VICE 3.10 (see src/vice/mockServer.ts).

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}

async function withClient(body, serverOptions = {}) {
  const names = ["C64BRIDGE_CONFIG", "C64_MODE", "VICE_TEST_TARGET", "VICE_PORT", "VICE_HOST"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const server = await startViceMockServer({ host: "127.0.0.1", port: 0, ...serverOptions });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vice-session-"));
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
    await waitUntil(() => server.openConnections === 0, "the start-up connections are closed");
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

const pcOf = async (client) => (await client.viceRegistersGet(0)).find((r) => r.id === 0).value;

async function waitForState(client, args) {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const previous = getPlatformStatus().id;
  setPlatform("vice");
  try {
    const result = await toolRegistry.invoke(
      "c64_debug",
      { op: "wait_for_state", ...args },
      { client, rag: {}, logger, platform: getPlatformStatus(), setPlatform },
    );
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return result.structuredContent.data;
  } finally {
    setPlatform(previous);
  }
}

test("a step leaves the CPU stopped across later calls", async () => {
  await withClient(async (client, server) => {
    await client.viceStepInstructions(1);
    assert.equal(server.running, false, "the CPU is stopped after the step");
    const opened = server.connectionsOpened;
    const first = await pcOf(client);
    await client.readMemoryRaw(0x0400, 4);
    await delay(50);
    const second = await pcOf(client);
    assert.equal(first, 3, "one step advances the mock PC by one instruction");
    assert.equal(second, first, "the PC does not move while the CPU is stopped");
    assert.equal(server.running, false, "an ordinary read leaves the stopped CPU stopped");
    assert.equal(server.connectionsOpened, opened, "no new monitor connection was opened");

    await client.viceStepInstructions(1);
    assert.equal(await pcOf(client), 6, "a second step continues from the first");

    await client.viceExitMonitor();
    assert.equal(server.running, true);
    await waitUntil(() => server.openConnections === 0, "the session closes once nothing keeps it open");
  });
});

test("continue resumes the CPU and a later checkpoint hit is observed by wait_for_state", async () => {
  await withClient(async (client, server) => {
    const created = await client.viceCheckpointCreate({ start: 0xc013 });
    assert.equal(server.running, true, "creating a checkpoint leaves a running CPU running");
    assert.equal(server.openConnections, 1, "the connection that holds a stopping checkpoint stays open");

    const waiting = waitForState(client, { timeoutMs: 3_000 });
    // The CPU is only running between the tool's own monitor commands; hit it as soon as it runs.
    await waitUntil(() => server.hitCheckpoint(created.id), "the CPU runs and reaches the checkpoint");
    const first = await waiting;
    assert.equal(first.matched, true);
    assert.equal(server.running, false);

    await client.readMemoryRaw(0x0400, 4);
    assert.equal(server.running, false, "a read while stopped at the checkpoint leaves the CPU stopped");

    await client.viceExitMonitor();
    assert.equal(server.running, true);

    const again = waitForState(client, { timeoutMs: 3_000 });
    await waitUntil(() => server.hitCheckpoint(created.id), "the CPU runs and reaches the checkpoint again");
    assert.equal((await again).matched, true, "the second hit is observed too");

    const timedOut = await (async () => {
      await client.viceExitMonitor();
      return waitForState(client, { timeoutMs: 150 });
    })();
    assert.equal(timedOut.matched, false, "no hit within the timeout is reported as a timeout");
    assert.equal(timedOut.timedOut, true);
  });
});

test("resume with a stopping checkpoint keeps the connection, deleting the last checkpoint closes it", async () => {
  await withClient(async (client, server) => {
    const created = await client.viceCheckpointCreate({ start: 0xc013 });
    server.hitCheckpoint(created.id);
    await waitForState(client, { timeoutMs: 1_000 });

    await client.viceExitMonitor();
    assert.equal(server.running, true);
    const opened = server.connectionsOpened;
    await client.readMemoryRaw(0x0400, 4);
    assert.equal(server.connectionsOpened, opened, "the next call reuses the open session connection");
    assert.equal(server.openConnections, 1);
    assert.equal(server.running, true, "the read leaves the running CPU running");

    await client.viceCheckpointDelete(created.id);
    await waitUntil(() => server.openConnections === 0, "the session closes with the last stopping checkpoint");
    assert.equal(server.running, true);
    assert.equal(server.unsafeCloses, 0, "no connection was closed while a stopping checkpoint existed");
  });
});

test("a checkpoint that does not stop the CPU does not keep a connection open", async () => {
  await withClient(async (client, server) => {
    await client.viceCheckpointCreate({ start: 0xc013, stopOnHit: false });
    await waitUntil(() => server.openConnections === 0, "the connection is closed");
    assert.equal(server.running, true);
  });
});

test("an ordinary read leaves a running CPU running and a stopped CPU stopped", async () => {
  await withClient(async (client, server) => {
    await client.readMemoryRaw(0x0400, 4);
    assert.equal(server.running, true, "a read without a session lets the CPU run again");

    const created = await client.viceCheckpointCreate({ start: 0xc013 });
    await client.readMemoryRaw(0x0400, 4);
    assert.equal(server.running, true, "a read through a session leaves a running CPU running");
    await client.writeMemoryRaw(0x1000, Uint8Array.of(1, 2));
    assert.equal(server.running, true, "a write through a session leaves a running CPU running");
    await client.viceCheckpointDelete(created.id);

    assert.equal((await client.explicitPause()).success, true);
    assert.equal(server.running, false);
    await client.readMemoryRaw(0x0400, 4);
    assert.equal(server.running, false, "a read through a session leaves a stopped CPU stopped");
    assert.equal((await client.explicitResume()).success, true);
    assert.equal(server.running, true);
  });
});

test("an operation that sends exit itself does not undo an explicit pause", async () => {
  await withClient(async (client, server) => {
    await client.explicitPause();
    await client.viceExitMonitor();
    assert.equal(server.running, true, "continue_execution ends the pause");
    await client.explicitPause();
    const result = await client.runPrg(Buffer.from([0x01, 0x08, 0x00, 0x00]));
    assert.equal(result.success, true);
    await client.explicitResume();
  });
});

test("a command that times out loses the session, and the next call reports it once", async () => {
  const saved = process.env.C64BRIDGE_VICE_REQUEST_TIMEOUT_MS;
  process.env.C64BRIDGE_VICE_REQUEST_TIMEOUT_MS = "200";
  try {
    await withClient(async (client, server) => {
      await client.explicitPause();
      server.hang = true;
      await assert.rejects(() => client.readMemoryRaw(0x0400, 4), /timed out/);
      server.hang = false;

      await assert.rejects(() => client.readMemoryRaw(0x0400, 4), (error) => {
        assert.match(String(error.message), /debug session was lost/);
        assert.match(String(error.message), /explicit pause/);
        assert.match(String(error.message), /CPU state is unknown/);
        return true;
      });

      const data = await client.readMemoryRaw(0x0400, 4);
      assert.equal(data.length, 4, "the call after the report works on a fresh connection");
      assert.equal(server.running, true, "the machine runs again; the lost pause is not silently simulated");
      const resume = await client.explicitResume();
      assert.equal(resume.success, true);
      assert.equal(resume.details.warning, undefined, "the loss is reported only once");
    });
  } finally {
    if (saved === undefined) delete process.env.C64BRIDGE_VICE_REQUEST_TIMEOUT_MS;
    else process.env.C64BRIDGE_VICE_REQUEST_TIMEOUT_MS = saved;
  }
});

test("a connection closed by VICE while paused is reported by resume as a warning", async () => {
  await withClient(async (client, server) => {
    await client.explicitPause();
    server.dropConnections();
    await delay(100);
    const resume = await client.explicitResume();
    assert.equal(resume.success, true);
    assert.match(String(resume.details?.warning), /debug session was lost/);
  });
});

test("reset deletes stopping checkpoints before the session closes", async () => {
  await withClient(async (client, server) => {
    await client.viceCheckpointCreate({ start: 0xc013 });
    assert.equal(server.stoppingCheckpoints, 1);
    await client.reset();
    assert.equal(server.unsafeCloses, 0, "the connection was closed only after the checkpoint was deleted");
    assert.ok(server.commands.some(([cmd]) => cmd === 0x13), "a checkpoint delete was sent");
  }, { wedgeOnUnsafeClose: true });
});

test("a debugging session never closes its connection while a stopping checkpoint exists", async () => {
  await withClient(async (client, server) => {
    const created = await client.viceCheckpointCreate({ start: 0xc013 });
    const opened = server.connectionsOpened;
    for (let i = 0; i < 5; i += 1) {
      await client.readMemoryRaw(0x0400, 4);
      await client.viceStepInstructions(1);
      await client.viceExitMonitor();
    }
    await client.explicitPause();
    await client.explicitResume();
    assert.equal(server.connectionsOpened, opened, "one connection served every call");
    assert.equal(server.unsafeCloses, 0);
    await client.viceCheckpointDelete(created.id);
    assert.equal(server.unsafeCloses, 0);
  }, { wedgeOnUnsafeClose: true });
});

test("a tool call's pause does not end a debugger stop", async () => {
  await withClient(async (client, server) => {
    await client.viceStepInstructions(1);
    assert.equal(server.running, false);
    const owned = await client.acquirePause();
    assert.equal(owned.success, true);
    await client.readMemoryRaw(0x0400, 4);
    await client.releasePause();
    assert.equal(server.running, false, "releasing a tool call's pause leaves the debugger stop in place");
    await client.viceExitMonitor();
    assert.equal(server.running, true);
  });
});

async function withBackend(body, serverOptions = {}) {
  const saved = { warp: process.env.VICE_WARP, visible: process.env.VICE_VISIBLE };
  process.env.VICE_WARP = "true"; // short first boot check
  await withClient(async (_client, server) => {
    const backend = new ViceBackend({ host: "127.0.0.1", port: server.port });
    await body(backend, server);
  }, serverOptions);
  for (const [name, value] of [["VICE_WARP", saved.warp], ["VICE_VISIBLE", saved.visible]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function armBreakpointAt(backend, pc) {
  const created = await backend.checkpointOperation(async (c) => {
    await c.registersSet([{ name: "PC", value: pc }]);
    return c.checkpointCreate({ start: pc, stopOnHit: true });
  });
  return created.id;
}

async function hitWhenRunning(server, id) {
  const deadline = Date.now() + 3_000;
  while (!server.hitCheckpoint(id)) {
    if (Date.now() > deadline) assert.fail("the CPU never ran to the checkpoint");
    await delay(1);
  }
}

test("feedKeyboard stops at a checkpoint hit and does not resume the CPU past it", async () => {
  await withBackend(async (backend, server) => {
    const id = await armBreakpointAt(backend, 0xc000);
    const feeding = backend.feedKeyboard(new TextEncoder().encode("SYS49152\r"));
    await waitUntil(() => server.keyboardFeeds.length === 1, "the keys were fed");
    await hitWhenRunning(server, id);
    const result = await feeding;
    assert.equal(result.status, "stopped");
    assert.equal(result.stoppedAt, 0xc000, "the real PC is reported");
    assert.equal(server.running, false, "the CPU is still stopped at the breakpoint");
    const exitsAfterFeed = server.commands.slice(server.commands.findIndex(([cmd]) => cmd === 0x72)).filter(([cmd]) => cmd === 0xaa);
    assert.equal(exitsAfterFeed.length, 1, "the monitor was exited once, before the hit, and never again");
    assert.equal(backend.sessionInfo().debugStop, true);
  });
});

test("run_prg that meets a checkpoint during the reset leaves the CPU stopped and does not start the program", async () => {
  await withBackend(async (backend, server) => {
    const id = await armBreakpointAt(backend, 0xe000);
    const prg = Buffer.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x99, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00]);
    const running = backend.runPrg(prg);
    const settled = running.then(() => null, (error) => error);
    await waitUntil(() => server.commands.some(([cmd]) => cmd === 0xcc), "the reset was sent");
    await hitWhenRunning(server, id);
    const error = await settled;
    assert.match(String(error?.message), /checkpoint stopped the CPU at \$[0-9A-F]{4}/);
    assert.equal(server.running, false, "the CPU was not resumed past the checkpoint");
    assert.equal(server.keyboardFeeds.length, 0, "RUN was not typed");
    assert.equal(backend.sessionInfo().debugStop, true);
  });
});

test("shutdown deletes stopping checkpoints even while a monitor operation is in flight", async () => {
  await withBackend(async (backend, server) => {
    await armBreakpointAt(backend, 0xc000);
    assert.equal(server.stoppingCheckpoints, 1);
    const prg = Buffer.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x99, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00]);
    const inflight = backend.runPrg(prg).then(() => null, (error) => error); // waits for the 4 s boot
    await waitUntil(() => server.commands.some(([cmd]) => cmd === 0xcc), "the reset is in flight");
    const started = Date.now();
    await ViceBackend.endAllSessions();
    assert.ok(Date.now() - started < 1_500, `shutdown did not wait for the operation (${Date.now() - started} ms)`);
    assert.equal(server.stoppingCheckpoints, 0, "the stopping checkpoint was deleted");
    assert.equal(server.unsafeCloses, 0, "the connection was closed only after the delete");
    await inflight;
  }, { bootMs: 4_000, wedgeOnUnsafeClose: true });
});

test("shutdown with a checkpoint creation queued behind it leaves no stopping checkpoint and closes safely", async () => {
  await withBackend(async (backend, server) => {
    await armBreakpointAt(backend, 0xc000);
    assert.equal(server.stoppingCheckpoints, 1);
    // The creation is queued first, then shutdown starts before its command has gone out.
    const queued = backend.checkpointOperation((c) => c.checkpointCreate({ start: 0xc100, stopOnHit: true })).then(() => null, (error) => error);
    await ViceBackend.endAllSessions();
    await queued;
    assert.equal(server.stoppingCheckpoints, 0, "no stopping checkpoint survives the shutdown");
    assert.equal(server.unsafeCloses, 0, "the connection was closed only after every stopping checkpoint was deleted");
  }, { wedgeOnUnsafeClose: true });
});

test("step and step_return wait for the stop that follows the command when VICE acknowledges first", async () => {
  await withClient(async (client, server) => {
    // The acknowledgement arrives 60 ms before the resumed and stopped events.
    const started = Date.now();
    await client.viceStepReturn();
    assert.ok(Date.now() - started >= 50, "the call waited for the stopped event that followed the command");
    assert.equal(await pcOf(client), 0x10, "the PC is the one after the execution, not the one before it");
    assert.equal(server.running, false, "the CPU is stopped, as the session state says");

    await client.viceStepInstructions(1);
    assert.equal(await pcOf(client), 0x13, "a step is waited for in the same way");
    assert.equal(server.running, false);
    await client.viceExitMonitor();
    assert.equal(server.running, true);
  }, { stepEventDelayMs: 60 });
});

test("a tool call's pause that was queued behind a keyboard feed does not resume past a checkpoint hit during the feed", async () => {
  await withClient(async (client, server) => {
    const created = await client.viceCheckpointCreate({ start: 0xc000 });
    const feeding = client.injectKeyboardQueue(new TextEncoder().encode("SYS49152\r")).then(() => null, (error) => error);
    await waitUntil(() => server.keyboardFeeds.length === 1, "the keys were fed and the feed holds the monitor queue");
    const acquiring = client.acquirePause(); // queued behind the feed
    await hitWhenRunning(server, created.id);
    await feeding;
    assert.equal((await acquiring).success, true);
    assert.equal(server.running, false, "the CPU is stopped at the checkpoint");
    await client.readMemoryRaw(0x0400, 4);
    await client.releasePause();
    assert.equal(server.running, false, "releasing the tool call's pause did not resume past the breakpoint");
    await client.viceExitMonitor();
    assert.equal(server.running, true);
  });
});
