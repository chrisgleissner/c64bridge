import test from "#test/runner";
import assert from "#test/assert";
import { pollForProgramOutcome } from "../src/tools/pollValidator.js";

function createLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

// Zero page as measured on an Ultimate 64 Elite (firmware 3.15a, 2026-11-20) after
// `10 PRINT "H6 OK"` had ended: CURLIN $39/$3A = $0A $00, never $FF. The cursor
// enable flag $CC is $00 while the KERNAL waits for a key at $E5CD.
function finishedProgramMemory(address, length) {
  const zeroPage = new Uint8Array(256);
  zeroPage[0x39] = 0x0a;
  zeroPage[0x3a] = 0x00;
  zeroPage[0xcc] = 0x00;
  return zeroPage.slice(address, address + length);
}

test("HW6-24a a finished BASIC program is reported at the first READY. poll, not after the window", async () => {
  let reads = 0;
  const client = {
    async readScreen() { reads += 1; return "READY.\nRUN\nH6 OK\n\nREADY.\n"; },
    async readMemoryRaw(address, length) { return finishedProgramMemory(address, length); },
  };
  const started = Date.now();
  const result = await pollForProgramOutcome("BASIC", client, createLogger(), { maxMs: 2000, intervalMs: 200, stabilizeMs: 0 }, undefined, "READY.\n");
  const elapsed = Date.now() - started;
  assert.equal(result.status, "ok");
  assert.equal(reads, 1);
  assert.ok(elapsed < 500, `took ${elapsed} ms`);
});

test("HW6-24a a running program that printed READY. is not taken as finished while $CC is non-zero", async () => {
  const screens = ["RUN\nREADY.\n", "RUN\nREADY.\n", "RUN\nREADY.\n?OUT OF DATA  ERROR IN 30\nREADY.\n"];
  let index = 0;
  const client = {
    async readScreen() { return screens[Math.min(index++, screens.length - 1)]; },
    // $3A is $FF here to show that it is not what decides: a running program keeps $CC non-zero.
    async readMemoryRaw(address, length) {
      const zeroPage = new Uint8Array(256);
      zeroPage[0x3a] = 0xff;
      zeroPage[0xcc] = 0x01;
      return zeroPage.slice(address, address + length);
    },
  };
  const result = await pollForProgramOutcome("BASIC", client, createLogger(), { maxMs: 500, intervalMs: 5, stabilizeMs: 0 });
  assert.equal(result.status, "error");
  assert.equal(result.line, 30);
});
