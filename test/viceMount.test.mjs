import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ViceBackend } from "../src/device.js";

// A fake Binary Monitor client whose machine state follows a script of autoload phases.
function createAutoloadClient(phases) {
  const memory = new Uint8Array(0x10000);
  let polls = 0;
  const calls = [];
  const client = {
    async resourceGet() { return { type: "int", value: 1541 }; },
    async resourceSet() {},
    async exitMonitor() {
      polls += 1;
      const phase = phases[Math.min(polls - 1, phases.length - 1)];
      phase(memory);
    },
    async memSet(start, payload) { memory.set(payload, start); },
    async memGet(start, end) { return Buffer.from(memory.subarray(start, end + 1)); },
    async autostart(filename) { calls.push(filename); },
  };
  return { client, calls, polls: () => polls };
}

const notResetYet = () => {};
// Right after the power cycle RAM holds an init pattern: the marker is gone but BASIC is not set up yet.
function ramPattern(memory) {
  for (let i = 0; i < 0x0800; i += 1) memory[i] = (i & 0x40) ? 0xff : 0x00;
  memory[0xc6] = 0; // an empty-looking keyboard buffer, as seen on VICE
}
// BASIC's cold start has set TXTTAB but not yet VARTAB.
function basicHalfInitialised(memory) {
  ramPattern(memory);
  memory.set([0x01, 0x08], 0x2b);
}
function powerCycled(memory) {
  memory.fill(0, 0x0200, 0x0400);
  memory.fill(0x20, 0x0400, 0x07e8);
  memory.set([0x01, 0x08, 0x03, 0x08], 0x2b);
}
function loadedOverScreen(memory) {
  powerCycled(memory);
  memory.fill(0x41, 0x0400, 0x07e8); // the loaded program covers screen RAM, so no LOAD text is visible
  memory.set([0xe8, 0x07], 0x2d); // BASIC's LOAD set VARTAB to the end of the file
  memory[0xc6] = 0;
}

function diskImage(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-vice-mount-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "disk.d64");
  fs.writeFileSync(file, Buffer.alloc(174848));
  return file;
}

test("VICE mount waits for the autoload reset and detects a load that covers screen RAM", async (t) => {
  const image = diskImage(t);
  const backend = new ViceBackend({ host: "127.0.0.1", port: 6502 });
  const { client, polls } = createAutoloadClient([notResetYet, notResetYet, ramPattern, basicHalfInitialised, powerCycled, loadedOverScreen]);
  backend.withClient = async (fn) => fn(client);

  const result = await backend.driveMount("drive8", image);
  assert.equal(result.success, true);
  // It kept polling while the marker was still there, while RAM held the init pattern, while BASIC was
  // half initialised and until the loaded end pointer was seen on two consecutive polls.
  assert.equal(polls(), 7);
});

test("VICE mount keeps its record when the mount itself starts VICE, and forgets it after a restart", async (t) => {
  const image = diskImage(t);
  const backend = new ViceBackend({ host: "127.0.0.1", port: 6502 });
  const { client } = createAutoloadClient([loadedOverScreen]);
  let starts = 0;
  backend.withClient = async (fn) => {
    if (starts === 0) { starts += 1; backend.lastProcessStart = 1000; } // the first call starts VICE
    return fn(client);
  };

  await backend.driveMount("drive8", image);
  assert.equal((await backend.drivesList())[0].image, image);

  backend.lastProcessStart = 2000; // VICE restarted (for example power_cycle)
  assert.equal((await backend.drivesList())[0].image, null);
});

test("VICE mount of an empty disk succeeds and says there was nothing to load", async (t) => {
  const image = diskImage(t);
  const backend = new ViceBackend({ host: "127.0.0.1", port: 6502 });
  const fileNotFound = (memory) => {
    powerCycled(memory);
    const line = [0x0c, 0x0f, 0x01, 0x04, 0x22, 0x2a, 0x22]; // LOAD"*"
    memory.set(line, 0x0400);
    memory.set([0x3f, 0x06, 0x09, 0x0c, 0x05, 0x20, 0x0e, 0x0f, 0x14, 0x20, 0x06, 0x0f, 0x15, 0x0e, 0x04], 0x0400 + 80); // ?FILE NOT FOUND
  };
  const { client } = createAutoloadClient([fileNotFound]);
  backend.withClient = async (fn) => fn(client);
  const result = await backend.driveMount("drive8", image);
  assert.equal(result.success, true);
  assert.equal(result.details.loadedFirstProgram, false);
  assert.match(result.details.note, /no program to load/);
});
