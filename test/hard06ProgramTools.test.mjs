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
  const load = prg[0] | (prg[1] << 8);
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

test("HARD06 PROGMEM-8 wait_for_state returns at once when the CPU is stopped at another address", async () => {
  const { debugModuleGroup } = await import("../src/tools/debug.js");
  const { client } = debugStub();
  const started = Date.now();
  const result = await debugModuleGroup.invoke("c64_debug", { op: "wait_for_state", expectedPC: "$D000", timeoutMs: 2000, pollMs: 10 }, { client, logger, platform: platform("vice") });
  const data = JSON.parse(result.content[0].text);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  assert.equal(data.matched, false);
  assert.equal(data.timedOut, false);
  assert.equal(data.stoppedElsewhere, true);
  assert.equal(data.pc, "$C000");
});

test("HARD06 PROGMEM-9 / WORKFLOW-12 c64_memory and c64_debug share one address parser with documented names, offsets and suggestions", async () => {
  const { debugModuleGroup } = await import("../src/tools/debug.js");
  const memory = await import("../src/tools/memory.js");
  const { memoryModule } = memory;
  const { setViceSymbols, clearViceSymbols } = await import("../src/tools/translation/symbolRegistry.js");
  const created = [];
  const reads = [];
  const ctx = {
    client: {
      async viceCheckpointCreate(options) {
        created.push(options.start);
        return { id: 1, start: options.start, end: options.end, enabled: true, stopOnHit: true, temporary: false, hitCount: 0, ignoreCount: 0, operations: { execute: true, load: false, store: false }, memspace: 0, hasCondition: false };
      },
      async readMemory(address, length) { reads.push(address); return { success: true, data: "$" + "00".repeat(Number(length)), details: { address, length: Number(length) } }; },
    },
    logger,
    platform: platform("vice"),
  };
  setViceSymbols([["main_loop", 0xc010], ["sprite_data", 0x2000]]);
  try {
    for (const address of ["screen", "CHROUT", "main_loop+3", "sprite_data-$10", "main_loop + 0x10"]) {
      const result = await debugModuleGroup.invoke("c64_debug", { op: "create_checkpoint", address }, ctx);
      assert.equal(result.isError, undefined, `${address}: ${result.content[0].text}`);
    }
    assert.deepEqual(created, [0x0400, 0xffd2, 0xc013, 0x1ff0, 0xc020]);
    const read = await memoryModule.invoke("read", { address: "main_loop+1", length: 1 }, ctx);
    assert.equal(read.isError, undefined);
    assert.equal(reads[0], "$C011");
    const typo = await debugModuleGroup.invoke("c64_debug", { op: "create_checkpoint", address: "mainloop" }, ctx);
    assert.equal(typo.isError, true);
    assert.match(typo.content[0].text, /closest are: main_loop/);
    const outside = await memoryModule.invoke("read", { address: "CHROUT+$100", length: 1 }, ctx);
    assert.equal(outside.isError, true);
  } finally {
    clearViceSymbols();
  }
});

test("HARD06 PROGMEM-11 program results state load range and entry in $HHHH, also for a VICE host PRG", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const source = "start: lda #1\n sta $0400\nloop: jmp loop\n";
  const { client } = asmClient(source);
  const asm = await programRunnersModule.invoke("upload_run_asm", { program: source }, { client, logger, platform: platform("c64u") });
  assert.deepEqual(asm.structuredContent.data.addresses, { load: "$0801", end: "$0815", entry: "$080E" });
  assert.match(asm.content[0].text, /\$0801-\$0815, entry \$080E \(SYS 2062\)/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h6-prg-"));
  try {
    const file = path.join(dir, "demo.prg");
    fs.writeFileSync(file, Buffer.from([0x00, 0xc0, 0xa9, 0x01, 0x60]));
    const vice = { async loadPrgFile() { return { success: true }; } };
    const loaded = await programRunnersModule.invoke("load_prg", { path: file }, { client: vice, logger, platform: platform("vice") });
    assert.equal(loaded.isError, undefined, JSON.stringify(loaded.content));
    assert.deepEqual(loaded.structuredContent.data.addresses, { load: "$C000", end: "$C002" });
    assert.match(loaded.content[0].text, /Load range \$C000-\$C002/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const basic = await programRunnersModule.invoke("upload_run_basic", { program: "10 PRINT 1" }, { client: { async uploadAndRunBasic() { return { success: true }; } }, logger, platform: platform("vice") });
  assert.match(basic.content[0].text, /\$0801-\$08/);
});

test("HARD06 WORKFLOW-12 run_prg with a symbols file names a bounded sample of the loaded labels", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { clearViceSymbols } = await import("../src/tools/translation/symbolRegistry.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h6-labels-"));
  try {
    const file = path.join(dir, "game.prg");
    fs.writeFileSync(file, Buffer.from([0x00, 0xc0, 0x60]));
    const labelsFile = path.join(dir, "game.vs");
    fs.writeFileSync(labelsFile, Array.from({ length: 25 }, (_, i) => `al C:${(0xc000 + i).toString(16)} .label${String(i).padStart(2, "0")}`).join("\n"));
    const vice = { async runPrgFile() { return { success: true }; } };
    const result = await programRunnersModule.invoke("run_prg", { path: file, symbolsFile: labelsFile }, { client: vice, logger, platform: platform("vice") });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const data = result.structuredContent.data;
    assert.equal(data.symbolsLoaded, 25);
    assert.equal(Object.keys(data.labels).length, 20);
    assert.equal(data.labels.label00, "$C000");
    assert.equal(data.labelsTruncated, true);
    assert.match(result.content[0].text, /label00=\$C000/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    clearViceSymbols();
  }
});

test("HARD06 WORKFLOW-7 a device 404 for a path that exists on the host suggests location host", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h6-host-"));
  try {
    const file = path.join(dir, "demo.prg");
    fs.writeFileSync(file, Buffer.from([0x01, 0x08, 0x00, 0x00, 0x00]));
    const notFound = { success: false, details: { message: "Request failed with status code 404" } };
    const client = { async runPrgFile() { return notFound; }, async loadPrgFile() { return notFound; } };
    for (const op of ["run_prg", "load_prg"]) {
      const result = await programRunnersModule.invoke(op, { path: file }, { client, logger, platform: platform("c64u") });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /location: "host"/, op);
    }
    const missing = await programRunnersModule.invoke("run_prg", { path: "//USB0/demo.prg" }, { client, logger, platform: platform("c64u") });
    assert.ok(!/location: "host"/.test(missing.content[0].text));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HARD06 PROGMEM-10 set_registers rejects values wider than the register and accepts address strings and labels", async () => {
  const { debugModuleGroup } = await import("../src/tools/debug.js");
  const { setViceSymbols, clearViceSymbols } = await import("../src/tools/translation/symbolRegistry.js");
  const sent = [];
  const { client } = debugStub({ async viceRegistersSet(writes) { sent.push(...writes); return []; } });
  const ctx = { client, logger, platform: platform("vice") };
  const tooWide = await debugModuleGroup.invoke("c64_debug", { op: "set_registers", writes: [{ name: "A", value: 300 }] }, ctx);
  assert.equal(tooWide.isError, true);
  assert.match(tooWide.content[0].text, /8-bit register/);
  const pcTooWide = await debugModuleGroup.invoke("c64_debug", { op: "set_registers", writes: [{ name: "PC", value: 0x1c000 }] }, ctx);
  assert.equal(pcTooWide.isError, true);
  assert.equal(sent.length, 0);
  setViceSymbols([["start", 0xc000]]);
  try {
    const ok = await debugModuleGroup.invoke("c64_debug", { op: "set_registers", writes: [{ name: "PC", value: "start+2" }, { name: "A", value: "$FF" }] }, ctx);
    assert.equal(ok.isError, undefined, ok.content[0].text);
    assert.deepEqual(sent.map((w) => w.value), [0xc002, 0xff]);
  } finally {
    clearViceSymbols();
  }
});

test("HARD06 PROGMEM-12 default lengths stop at $FFFF and every hex pattern accepts _ separators", async () => {
  const { toolRegistry } = await import("../src/tools/registry/index.js");
  const reads = [];
  const written = [];
  const client = {
    async readMemory(address, length) { reads.push([address, Number(length)]); return { success: true, data: "$" + "EA".repeat(Number(length)), details: { address, length: Number(length) } }; },
    async readMemoryRaw(address, length) { reads.push([address, length]); return new Uint8Array(length).fill(0xea); },
    async writeMemoryRaw(address, bytes) { written.push([address, [...bytes]]); },
  };
  const ctx = { client, logger, platform: platform("vice"), setPlatform: () => platform("vice"), rag: {} };
  const read = await toolRegistry.invoke("c64_memory", { op: "read", address: "$FF80" }, ctx);
  assert.equal(read.isError, undefined, read.content[0].text);
  assert.deepEqual(reads.at(-1), ["$FF80", 128]);
  const explicit = await toolRegistry.invoke("c64_memory", { op: "read", address: "$FF80", length: 256 }, ctx);
  assert.equal(explicit.isError, true);
  const dis = await toolRegistry.invoke("c64_memory", { op: "disassemble", address: "$FFF0" }, ctx);
  assert.equal(dis.isError, undefined, dis.content[0].text);
  assert.deepEqual(reads.at(-1), [0xfff0, 16]);
  const fill = await toolRegistry.invoke("c64_memory", { op: "fill_memory", address: "$C000", length: 4, pattern: "AA_55" }, ctx);
  assert.equal(fill.isError, undefined, fill.content[0].text);
  assert.deepEqual(written.at(-1), [0xc000, [0xaa, 0x55, 0xaa, 0x55]]);
  const search = await toolRegistry.invoke("c64_memory", { op: "search_memory", startAddress: "$C000", endAddress: "$C00F", pattern: "EA_EA" }, ctx);
  assert.equal(search.isError, undefined, search.content[0].text);
});

test("HARD06 PROGMEM-14 range operations leave $D000-$DFFF alone on Ultimate hardware unless includeIo is set", async () => {
  const { toolRegistry } = await import("../src/tools/registry/index.js");
  const invoke = (op, args, ctx) => toolRegistry.invoke("c64_memory", { op, ...args }, { ...ctx, setPlatform: () => ctx.platform, rag: {} });
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const reads = [];
  const client = {
    async readMemoryRaw(address, length) { reads.push([address, length]); return new Uint8Array(length).fill(0x60); },
    async writeMemoryRaw() {},
  };
  const touchesIo = () => reads.some(([a, l]) => a <= 0xdfff && a + l - 1 >= 0xd000);
  const c64u = { client, logger, platform: platform("c64u") };
  const search = await invoke("search_memory", { startAddress: "$C000", endAddress: "$E00F", pattern: "60 60" }, c64u);
  assert.equal(search.isError, undefined, search.content[0].text);
  assert.equal(touchesIo(), false);
  const data = JSON.parse(search.content[0].text);
  assert.equal(data.skippedIo, "$D000-$DFFF");
  assert.ok(!data.matches.some((m) => m >= "$D000" && m <= "$DFFF"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h6-io-"));
  try {
    for (const [op, args] of [
      ["compare_memory", { address1: "$D000", address2: "$C000", length: 16 }],
      ["copy_memory", { source: "$DC00", dest: "$C000", length: 16 }],
      ["save_memory", { startAddress: "$C000", endAddress: "$DFFF", filePath: path.join(dir, "dump.prg") }],
    ]) {
      const refused = await invoke(op, args, c64u);
      assert.equal(refused.isError, true, op);
      assert.match(refused.content[0].text, /includeIo/);
    }
    assert.equal(touchesIo(), false);
    const allowed = await invoke("copy_memory", { source: "$DC00", dest: "$C000", length: 16, includeIo: true }, c64u);
    assert.equal(allowed.isError, undefined);
    assert.equal(touchesIo(), true);
    reads.length = 0;
    const vice = await invoke("compare_memory", { address1: "$D000", address2: "$C000", length: 16 }, { client, logger, platform: platform("vice") });
    assert.equal(vice.isError, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HARD06 WORKFLOW-11 address and file parameter descriptions state the accepted forms", async () => {
  const memory = await import("../src/tools/memory.js");
  const { memoryModule } = memory;
  const { debugModuleGroup } = await import("../src/tools/debug.js");
  const addressFields = new Set(["address", "endAddress", "source", "dest", "startAddress", "address1", "address2", "expectedPC"]);
  const found = [];
  const visit = (node, tool) => {
    if (!node || typeof node !== "object") return;
    if (node.properties && typeof node.properties === "object") {
      for (const [name, schema] of Object.entries(node.properties)) {
        if (addressFields.has(name) && [schema?.type].flat().includes("string")) found.push({ tool, name, description: schema.description ?? "" });
      }
    }
    for (const value of Object.values(node)) visit(value, tool);
  };
  for (const descriptor of [...memoryModule.describeTools(), ...debugModuleGroup.describeTools()]) {
    visit(descriptor.inputSchema, descriptor.name);
  }
  for (const key of ["disassembleArgsSchema", "copyMemoryArgsSchema", "fillMemoryArgsSchema", "searchMemoryArgsSchema", "compareMemoryArgsSchema", "saveMemoryArgsSchema"]) {
    visit(memory[key].jsonSchema, key.replace("ArgsSchema", ""));
  }
  const names = new Set(found.map((entry) => `${entry.tool}.${entry.name}`));
  for (const expected of ["read.address", "write.address", "disassemble.address", "copyMemory.source", "copyMemory.dest", "fillMemory.address", "searchMemory.startAddress", "searchMemory.endAddress", "compareMemory.address1", "saveMemory.startAddress", "c64_debug.endAddress", "c64_debug.address", "c64_debug.expectedPC"]) {
    assert.ok(names.has(expected), `${expected} in ${[...names].join(", ")}`);
  }
  for (const { tool, name, description } of found) {
    assert.ok(/loaded program label|same forms as|address syntax/.test(description), `${tool}.${name}: ${description}`);
  }
  const primary = found.filter((entry) => !/same forms as/.test(entry.description));
  for (const { tool, name, description } of primary) {
    assert.match(description, /\+n or -n/, `${tool}.${name}`);
  }

  const [loadPrg] = programRunnersModule.describeTools().filter((descriptor) => descriptor.name === "load_prg");
  assert.match(loadPrg.inputSchema.properties.symbolsFile.description, /c64_memory and c64_debug take an address/);
  assert.match(loadPrg.inputSchema.properties.path.description, /location host/);
  const [runCrt] = programRunnersModule.describeTools().filter((descriptor) => descriptor.name === "run_crt");
  assert.match(runCrt.inputSchema.properties.path.description, /c64u and u2/);
});
