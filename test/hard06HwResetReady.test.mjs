import test from "#test/runner";
import assert from "#test/assert";
import { machineControlModule } from "../src/tools/machineControl.js";
import { screenCodesToAscii } from "../src/petscii.js";

function createLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

const BOOT_LINES = ["", "    **** COMMODORE 64 BASIC V2 ****", "", " 64K RAM SYSTEM  38911 BASIC BYTES FREE", "", "READY."];

function toScreenCode(ch) {
  const code = ch.charCodeAt(0);
  return code >= 0x41 && code <= 0x5a ? code - 0x40 : code;
}

function writeBootScreen(ram) {
  ram.fill(0x20, 0x0400, 0x07e8);
  BOOT_LINES.forEach((line, row) => {
    [...line].forEach((ch, column) => { ram[0x0400 + row * 40 + column] = toScreenCode(ch); });
  });
}

// Measured on an Ultimate 64 Elite (firmware 3.15a, 2026-11-20, results.md row 23): with the boot
// screen already showing, reset reached READY. after ~220 ms (reboot ~300 ms), but waitForReady
// reported 3204-3207 ms because the unchanged screen was ignored for a 3 s grace period.
function bootScreenMachine({ bootDelayMs = 220, resets = true } = {}) {
  const ram = new Uint8Array(0x10000);
  writeBootScreen(ram);
  const machine = {
    writes: [],
    client: {
      async reset() {
        if (resets) setTimeout(() => writeBootScreen(ram), bootDelayMs); // CINT clears the screen, then the banner and READY. appear
        return { success: true, details: {} };
      },
      async reboot() { return machine.client.reset(); },
      async readMemoryRaw(address, length) { return ram.slice(address, address + length); },
      async writeMemoryRaw(address, bytes) { machine.writes.push([address, [...bytes]]); ram.set(bytes, address); },
      async readScreenDetailed() {
        return { text: screenCodesToAscii(ram.subarray(0x0400, 0x07e8), { columns: 40, rows: 25 }), baseAddress: 0x0400, charset: "upper" };
      },
      async readScreen() { return (await machine.client.readScreenDetailed()).text; },
    },
    ram,
  };
  return machine;
}

for (const tool of ["reset_c64", "reboot_c64"]) {
  test(`HW6-23 ${tool} waitForReady reports READY. soon after the boot screen returns, without a 3 s grace`, async () => {
    const machine = bootScreenMachine();
    const res = await machineControlModule.invoke(tool, { waitForReady: true, readyTimeoutMs: 5000 }, { client: machine.client, logger: createLogger() });
    assert.equal(res.metadata.ready, true);
    assert.ok(res.metadata.readyElapsedMs >= 200, `readyElapsedMs ${res.metadata.readyElapsedMs}`);
    assert.ok(res.metadata.readyElapsedMs < 1000, `readyElapsedMs ${res.metadata.readyElapsedMs}`);
    assert.equal(machine.writes.length, 1);
    assert.equal(machine.writes[0][0], 0x0400);
  });
}

test("HW6-23 the READY. left on screen before the reset is never taken for the new prompt", async () => {
  const machine = bootScreenMachine({ resets: false });
  const res = await machineControlModule.invoke("reset_c64", { waitForReady: true, readyTimeoutMs: 600 }, { client: machine.client, logger: createLogger() });
  assert.equal(res.metadata.ready, false);
});

test("HW6-23 the marker is removed when the reset fails", async () => {
  const machine = bootScreenMachine();
  machine.client.reset = async () => ({ success: false, details: { error: "offline" } });
  const res = await machineControlModule.invoke("reset_c64", { waitForReady: true }, { client: machine.client, logger: createLogger() });
  assert.equal(res.isError, true);
  assert.equal(machine.ram[0x0400], 0x20);
});
