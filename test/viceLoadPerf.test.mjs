import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { C64Client } from "../src/c64Client.js";
import { startViceMockServer } from "../src/vice/mockServer.js";

// Counts the monitor commands and connections the VICE backend needs for common operations.
// On real VICE every monitor command stops the CPU, so polling the monitor while the KERNAL
// boots slows the boot itself. The mock models that: its boot time only advances while the
// CPU runs (see ViceMockServerOptions.bootMs).

const CMD_MEM_GET = 0x01;
const CMD_KEYBOARD_FEED = 0x72;

async function withClient(body, serverOptions = {}) {
  const names = ["C64BRIDGE_CONFIG", "C64_MODE", "VICE_TEST_TARGET", "VICE_PORT", "VICE_HOST"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const server = await startViceMockServer({ host: "127.0.0.1", port: 0, ...serverOptions });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vice-load-perf-"));
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
    const deadline = Date.now() + 2_000;
    while (server.openConnections !== 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
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

const count = (server, from, cmd) => server.commands.slice(from).filter(([c]) => c === cmd).length;

// A BASIC program: 10 PRINT "HI"
const PRG = Buffer.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x99, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00]);

test("a PRG load waits for the boot with few monitor reads and one connection", async () => {
  await withClient(async (client, server) => {
    const commandsBefore = server.commands.length;
    const connectionsBefore = server.connectionsOpened;
    const result = await client.runPrg(PRG);
    assert.equal(result.success, true, JSON.stringify(result.details));
    const reads = count(server, commandsBefore, CMD_MEM_GET);
    assert.equal(server.connectionsOpened - connectionsBefore, 1, "one connection for the whole load");
    // One read confirms the boot (plus at most one retry); the old polling used about one read per 50 ms of boot.
    assert.ok(reads <= 3, `at most 3 memory reads during the boot, saw ${reads}`);
    assert.equal(count(server, commandsBefore, CMD_KEYBOARD_FEED), 1, "RUN is the only keyboard feed (no RETURN coaxing)");
    assert.equal(server.keyboardFeeds.at(-1).toString("ascii"), "RUN\r");
  }, { bootMs: 700 });
});

test("a reset reports the prompt only after the KERNAL boot has run", async () => {
  await withClient(async (client, server) => {
    const commandsBefore = server.commands.length;
    const result = await client.reset();
    assert.equal(result.success, true, JSON.stringify(result.details));
    assert.ok(count(server, commandsBefore, CMD_MEM_GET) <= 3);
    const screen = await client.readScreen();
    assert.ok(screen.includes("READY."), "the prompt is on the screen when reset returns");
  }, { bootMs: 700 });
});

test("readScreen uses one connection and two memory reads", async () => {
  await withClient(async (client, server) => {
    const commandsBefore = server.commands.length;
    const connectionsBefore = server.connectionsOpened;
    const screen = await client.readScreen();
    assert.ok(screen.includes("READY."));
    assert.equal(server.connectionsOpened - connectionsBefore, 1, "one connection");
    assert.equal(count(server, commandsBefore, CMD_MEM_GET), 2, "one read for the VIC registers and one for the screen");
  });
});

test("readScreen follows the VIC registers to a relocated screen", async () => {
  await withClient(async (client) => {
    // $D018 = $24 puts the screen at $0800; $DD00 = $03 selects VIC bank 0.
    await client.writeMemoryRaw(0xd018, Uint8Array.of(0x24));
    await client.writeMemoryRaw(0xdd00, Uint8Array.of(0x03));
    await client.writeMemoryRaw(0x0800, Uint8Array.of(0x08, 0x09)); // "HI" in screen codes
    const detailed = await client.readScreenDetailed();
    assert.equal(detailed.baseAddress, 0x0800);
    assert.equal(detailed.charset, "upper");
    assert.deepEqual(detailed.registers, { d018: 0x24, dd00: 0x03 });
    assert.ok(detailed.text.startsWith("HI"));
  });
});
