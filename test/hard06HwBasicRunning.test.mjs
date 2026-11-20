import test from "#test/runner";
import assert from "#test/assert";
import { pollForProgramOutcome } from "../src/tools/pollValidator.js";
import { programRunnersModule } from "../src/tools/programRunners.js";
import { basicToPrg } from "../src/tools/translation/basicTokenizer.js";

function createLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

// Measured on an Ultimate 64 Elite (firmware 3.15a, 2026-11-20, results.md row 24):
// `10 GOTO 10` left the screen ending in RUN and was reported "executed successfully (verified)".
const BEFORE = "\n    **** COMMODORE 64 BASIC V2 ****\n\n 64K RAM SYSTEM  38911 BASIC BYTES FREE\n\nREADY.\n";
const RUNNING = `${BEFORE}LOAD"...LOAD/TEMP00A1",8,1\n\nSEARCHING FOR ...LOAD/TEMP00A1\nLOADING\nREADY.\nRUN\n`;

function runningClient(program) {
  const prg = basicToPrg(program);
  const body = prg.subarray(2);
  let reads = 0;
  return {
    async uploadAndRunBasic() { return { success: true }; },
    async readScreen() { reads += 1; return reads === 1 ? BEFORE : RUNNING; },
    async readMemoryRaw(address, length) {
      if (address === 0x0801) return Uint8Array.from(body.subarray(0, length));
      const bytes = new Uint8Array(length);
      if (address <= 0xcc && address + length > 0xcc) bytes[0xcc - address] = 0x01; // a key arrived: not waiting
      return bytes;
    },
  };
}

test("HW6-24b the poll reports a program without a READY. prompt as not finished", async () => {
  const client = runningClient("10 GOTO 10\n");
  await client.readScreen();
  const result = await pollForProgramOutcome("BASIC", client, createLogger(), { maxMs: 120, intervalMs: 10, stabilizeMs: 0 }, undefined, BEFORE);
  assert.equal(result.status, "ok");
  assert.equal(result.finished, false);
  assert.ok(result.observedMs >= 100, `observedMs ${result.observedMs}`);
});

test("HW6-24b upload_run_basic says an endless program is still running instead of verified", async () => {
  const saved = { max: process.env.C64BRIDGE_POLL_MAX_MS, interval: process.env.C64BRIDGE_POLL_INTERVAL_MS };
  process.env.C64BRIDGE_POLL_MAX_MS = "120";
  process.env.C64BRIDGE_POLL_INTERVAL_MS = "10";
  try {
    const ctx = { client: runningClient("10 GOTO 10\n"), logger: createLogger() };
    const result = await programRunnersModule.invoke("upload_run_basic", { program: "10 GOTO 10\n", verify: true }, ctx);
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(!/verified/.test(text), text);
    assert.match(text, /still running/);
    assert.match(text, /no READY\. prompt was observed/);
    assert.equal(result.metadata.verified, false);
    assert.equal(result.metadata.running, true);
    assert.equal(result.structuredContent.data.verified, false);
    assert.equal(result.structuredContent.data.running, true);
  } finally {
    for (const [key, value] of [["C64BRIDGE_POLL_MAX_MS", saved.max], ["C64BRIDGE_POLL_INTERVAL_MS", saved.interval]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
