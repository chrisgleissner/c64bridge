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

test("HARD06 PROGMEM-6 upload_run_basic without verify does not read the screen it cannot interpret yet", async () => {
  let screenReads = 0;
  const client = {
    async uploadAndRunBasic() { return { success: true }; },
    async readScreen() { screenReads += 1; return "READY.\n"; },
  };
  const result = await programRunnersModule.invoke("upload_run_basic", { program: "10 PRINT 1" }, { client, logger, platform: platform("vice") });
  assert.equal(result.isError, undefined);
  assert.equal(screenReads, 0);
  assert.equal(result.structuredContent.data.screen, undefined);
  assert.match(result.content[0].text, /not observed/);
});

test("HARD06 PROGMEM-6 upload_run_basic verify auto-fixes an error that appears only after the first reads", async () => {
  const saved = process.env.C64BRIDGE_POLL_INTERVAL_MS;
  process.env.C64BRIDGE_POLL_INTERVAL_MS = "1";
  try {
    const uploads = [];
    let readsSinceRun = 0;
    const client = {
      async uploadAndRunBasic(program) { uploads.push(program); readsSinceRun = 0; return { success: true }; },
      async readScreen() {
        if (uploads.length === 0) return "READY.\n";
        readsSinceRun += 1;
        // The error shows up only once the program has run for a while.
        if (uploads.length === 1) return readsSinceRun < 3 ? "RUN\n" : "RUN\n?SYNTAX  ERROR IN 10\nREADY.\n";
        return readsSinceRun < 3 ? "RUN\n" : "RUN\nHELLO\nREADY.\n";
      },
    };
    const result = await programRunnersModule.invoke("upload_run_basic", { program: '10 PRINT "HELLO\n20 END', verify: true }, { client, logger, platform: platform("vice") });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(uploads.length, 2);
    assert.equal(result.structuredContent.data.autoFix.applied, true);
    assert.equal(result.structuredContent.data.verified, true);
  } finally {
    if (saved === undefined) delete process.env.C64BRIDGE_POLL_INTERVAL_MS; else process.env.C64BRIDGE_POLL_INTERVAL_MS = saved;
  }
});

test("HARD06 PROGMEM-1 a checkpoint hit inside the program after SYS is a started program with its labels", async () => {
  const { clearViceSymbols, getSymbolAddress } = await import("../src/tools/translation/symbolRegistry.js");
  clearViceSymbols();
  const source = "*=$C000\nstart: lda #1\nloop: sta $d020\n jmp loop\n";
  const { client } = asmClient(source, {
    async uploadAndRunAsm() {
      return { success: false, details: { started: false, entryAddress: 0xc000, keyboard: { status: "stopped", pending: 9, stoppedAt: 0xc000 } } };
    },
  });
  for (const verify of [false, true]) {
    const result = await programRunnersModule.invoke("upload_run_asm", { program: source, verify }, { client, logger, platform: platform("vice") });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(result.structuredContent.data.stopped, true);
    assert.equal(result.structuredContent.data.stoppedAt, "$C000");
    assert.equal(result.structuredContent.data.stoppedAtLabel, "start");
    assert.match(result.content[0].text, /stopped the CPU at \$C000 \(start\)/);
    assert.equal(getSymbolAddress("loop"), 0xc002);
  }
  clearViceSymbols();
});

test("HARD06 PROGMEM-3 reset waitForReady trusts a backend that already saw READY. and skips the grace after the screen changed", async () => {
  const { machineControlModule } = await import("../src/tools/machineControl.js");
  const boot = "    **** COMMODORE 64 BASIC V2 ****\n\nREADY.\n";
  // VICE: the backend reset reports the prompt it waited for.
  const vice = { async readScreen() { return boot; }, async reset() { return { success: true, details: { pointersOk: true, promptOk: true } }; } };
  let started = Date.now();
  let result = await machineControlModule.invoke("reset_c64", { waitForReady: true }, { client: vice, logger, platform: platform("vice") });
  assert.equal(result.isError, undefined);
  assert.equal(result.metadata.ready, true);
  assert.ok(Date.now() - started < 1000, `VICE reset took ${Date.now() - started} ms`);
  // Ultimate: the screen is cleared during the boot and then shows the same boot screen again.
  let reads = 0;
  const ultimate = { async readScreen() { reads += 1; return reads === 2 ? "" : boot; }, async reset() { return { success: true, details: {} }; } };
  started = Date.now();
  result = await machineControlModule.invoke("reset_c64", { waitForReady: true }, { client: ultimate, logger, platform: platform("c64u") });
  assert.equal(result.metadata.ready, true);
  assert.ok(Date.now() - started < 2000, `Ultimate reset took ${Date.now() - started} ms`);
});

function debugStub(overrides = {}) {
  const calls = { available: 0 };
  let pc = 0xc000;
  const client = {
    async viceRegistersAvailable() {
      calls.available += 1;
      return [{ id: 0, name: "PC", bits: 16, size: 2 }, { id: 1, name: "A", bits: 8, size: 1 }, { id: 5, name: "FL", bits: 8, size: 1 }];
    },
    async viceRegistersGet() { return [{ id: 0, size: 2, value: pc }, { id: 1, size: 1, value: 0x2a }, { id: 5, size: 1, value: 0b10100011 }]; },
    async viceStepInstructions() { pc += 3; return { stopped: true }; },
    async viceStepReturn() { pc = 0xc010; return { stopped: true }; },
    async viceWaitForStop() { return { session: true, stopped: true }; },
    async viceCheckpointList() {
      return [
        { id: 4, start: 0xc003, end: 0xc003, enabled: true, operations: { execute: true, load: false, store: false } },
        { id: 5, start: 0xc003, end: 0xc003, enabled: true, operations: { execute: false, load: true, store: false } },
      ];
    },
    ...overrides,
  };
  return { calls, client };
}

test("HARD06 PROGMEM-7/13 step and monitor state report PC, CPU state, hit checkpoint and decoded registers; metadata is read once", async () => {
  const { debugModuleGroup } = await import("../src/tools/debug.js");
  const { calls, client } = debugStub();
  const ctx = { client, logger, platform: platform("vice") };
  const step = await debugModuleGroup.invoke("c64_debug", { op: "step" }, ctx);
  assert.equal(step.isError, undefined);
  assert.match(step.content[0].text, /PC=\$C003/);
  assert.equal(step.structuredContent.data.pc, "$C003");
  const state = await debugModuleGroup.invoke("c64_debug", { op: "get_monitor_state" }, ctx);
  const data = JSON.parse(state.content[0].text);
  assert.equal(data.cpu, "stopped");
  assert.equal(data.pc, "$C003");
  assert.deepEqual(data.checkpointIds, [4]);
  const fl = data.registers.find((r) => r.name === "FL");
  assert.equal(fl.hex, "$A3");
  assert.equal(fl.flags, "N=1 V=0 B=0 D=0 I=0 Z=1 C=1");
  assert.equal(data.registers.find((r) => r.name === "PC").hex, "$C003");
  const regs = JSON.parse((await debugModuleGroup.invoke("c64_debug", { op: "get_registers" }, ctx)).content[0].text);
  assert.equal(regs.cpu, "stopped");
  assert.equal(regs.pc, "$C003");
  const back = await debugModuleGroup.invoke("c64_debug", { op: "step_return" }, ctx);
  assert.equal(back.structuredContent.data.pc, "$C010");
  assert.equal(calls.available, 1, "register metadata is read once per client");
});
