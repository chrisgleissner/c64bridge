import test from "#test/runner";
import assert from "#test/assert";
import { programRunnersModule } from "../src/tools/programRunners.js";
import { assemblyToPrgDetailed } from "../src/tools/translation/assembler.js";
import { pollForProgramOutcome } from "../src/tools/pollValidator.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = (id) => ({ id, features: [], limitedFeatures: [] });

/** A client whose memory holds the assembled program; counts every read. */
function asmClient(source, extra = {}) {
  const prg = assemblyToPrgDetailed(source).prg;
  const load = prg.readUInt16LE(0);
  const calls = { screen: 0, memory: 0 };
  return {
    calls,
    client: {
      async uploadAndRunAsm() { return { success: true }; },
      async readScreen() { calls.screen += 1; return "READY.\nSYS49152\n"; },
      async readMemoryRaw(address, length) {
        calls.memory += 1;
        const out = new Uint8Array(length);
        for (let i = 0; i < length; i += 1) {
          const offset = address + i - load;
          if (offset >= 0 && offset < prg.length - 2) out[i] = prg[2 + offset];
        }
        return out;
      },
      ...extra,
    },
  };
}

test("HARD06 PROGMEM-5 upload_run_asm with verify:false checks the load with one read and does not poll", async () => {
  const restore = process.env.C64BRIDGE_POLL_MAX_MS;
  process.env.C64BRIDGE_POLL_MAX_MS = "400";
  try {
    const source = "*=$C000\nloop: inc $d020\n jmp loop\n";
    const { client, calls } = asmClient(source);
    const started = Date.now();
    const result = await programRunnersModule.invoke("upload_run_asm", { program: source }, { client, logger, platform: platform("c64u") });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms`);
    assert.equal(calls.screen, 0);
    assert.equal(calls.memory, 1);
    assert.equal(result.structuredContent.data.execution, "unconfirmed");
    assert.equal(result.structuredContent.data.loadCheck, "matched");
  } finally {
    if (restore === undefined) delete process.env.C64BRIDGE_POLL_MAX_MS; else process.env.C64BRIDGE_POLL_MAX_MS = restore;
  }
});

test("HARD06 PROGMEM-5 ASM liveness follows the screen the VIC-II shows and reads it once per poll", async () => {
  let n = 0;
  const reads = [];
  const client = {
    // The program moved the screen away from $0400 and animates it there; $0400 never changes.
    async readScreenDetailed() { n += 1; return { text: `FRAME ${n}`, baseAddress: 0xc400, charset: "upper" }; },
    async readScreen() { throw new Error("readScreen must not be used when readScreenDetailed exists"); },
    async readMemoryRaw(address, length) { reads.push(address); return new Uint8Array(length); },
  };
  const outcome = await pollForProgramOutcome("ASM", client, logger, { maxMs: 300, intervalMs: 5, stabilizeMs: 0 });
  assert.equal(outcome.status, "ok");
  assert.ok(!reads.includes(0x0400), "screen RAM at $0400 is not read separately");
});
