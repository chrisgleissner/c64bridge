import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { C64Client } from "../src/c64Client.js";
import { diagnoseCrash, returnAddresses } from "../src/testing/crashDiagnosis.js";
import { debugModuleGroup } from "../src/tools/debug.js";
import { clearViceSymbols, setViceSymbols } from "../src/tools/translation/symbolRegistry.js";
import { startViceMockServer } from "../src/vice/mockServer.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";
import { realVice, realViceSession } from "./helpers/gd1Vice.mjs";

const SYMBOLS = new Map([[0xc000, "main"], [0xc007, "sub"], [0xc100, "table"]]);

/** 64 KB with `jsr sub` at main+1 and its return address on a stack with SP = $FB. */
function memory(bytes = {}) {
  const image = new Uint8Array(0x10000);
  image.set([0x78, 0x20, 0x07, 0xc0], 0xc000);
  image.set([0x03, 0xc0], 0x1fc);
  image[0x01] = 0x37;
  image.set([0x31, 0xea], 0x0314);
  for (const [address, values] of Object.entries(bytes)) image.set(values, Number(address));
  return image;
}

const diagnose = (pcs, extra = {}) => diagnoseCrash({
  samples: pcs.map((pc) => ({ pc, sp: 0xfb })), memory: memory(), stackDepth: 16, symbols: SYMBOLS, ...extra,
});

test("a JAM opcode with an unchanged PC is reported with its address", () => {
  const report = diagnose([0xc102, 0xc102, 0xc102], { memory: memory({ 0xc102: [0x02] }) });
  assert.equal(report.verdict, "jam");
  assert.deepEqual(report.pc, { address: "$C102", symbol: "table+2" });
  assert.equal(report.opcodeAtPc, "$02");
  assert.ok(report.notes.some((note) => note.includes("table+2 ($C102)")));
});

test("a jump to itself is reported as a PC that does not move", () => {
  const report = diagnose([0xc007, 0xc007], { memory: memory({ 0xc007: [0x4c, 0x07, 0xc0] }) });
  assert.equal(report.verdict, "stuck_pc");
  assert.ok(report.notes.some((note) => /JMP/.test(note) && note.includes("sub ($C007)")), report.notes.join(" "));
});

test("a PC outside the code range is reported with label+offset and the caller", () => {
  const report = diagnose([0xc102, 0xc102], {
    memory: memory({ 0xc102: [0x4c, 0x02, 0xc1] }), codeRange: { start: 0xc000, end: 0xc0ff },
  });
  assert.equal(report.verdict, "pc_outside_code");
  assert.equal(report.pc.symbol, "table+2");
  assert.deepEqual(report.stack, [{ returnAddress: "$C004", symbol: "main+4" }]);
  assert.ok(report.notes.some((note) => note.includes("called from main+1 ($C001)")), report.notes.join(" "));
});

test("one sample inside the code range keeps the verdict running", () => {
  const report = diagnose([0xc001, 0xea31], { codeRange: { start: 0xc000, end: 0xc0ff } });
  assert.equal(report.verdict, "running");
  assert.ok(report.notes.some((note) => note.includes("interrupt")));
});

test("a moving PC is running, a low SP is stack_low, and one halted sample is not stuck", () => {
  assert.equal(diagnose([0xc001, 0xc004]).verdict, "running");
  assert.equal(diagnose([0xc001, 0xc004], { samples: [{ pc: 0xc001, sp: 0x0f }, { pc: 0xc004, sp: 0x0f }] }).verdict, "stack_low");
  const halted = diagnose([0xc001], { halted: true });
  assert.equal(halted.verdict, "running");
  assert.ok(halted.notes.some((note) => note.includes("already stopped")));
});

test("a changing frame counter shows that a repeated PC is a wait loop", () => {
  const bytes = { memory: memory({ 0xc007: [0x4c, 0x07, 0xc0] }) };
  assert.equal(diagnose([0xc007, 0xc007], { ...bytes, frameCounter: { first: 5, last: 7 } }).verdict, "running");
  assert.equal(diagnose([0xc007, 0xc007], { ...bytes, frameCounter: { first: 5, last: 5 } }).verdict, "stuck_pc");
});

test("a stop during sampling is reported as such", () => {
  const report = diagnose([0xc001, 0xc001], { halted: true });
  assert.equal(report.verdict, "running");
  assert.ok(report.notes[0].includes("stopped during sampling"), report.notes[0]);
});

test("vectors and the processor port come from the memory image; without labels addresses are hex", () => {
  const report = diagnose([0xc001, 0xc004], { symbols: new Map() });
  assert.deepEqual(report.vectors.irq0314, { address: "$EA31" });
  assert.equal(report.port01, "$37");
  assert.deepEqual(report.pc, { address: "$C004" });
});

test("only byte pairs that follow a JSR count as return addresses", () => {
  const image = memory({ 0x1fa: [0x34, 0x12] });
  assert.deepEqual(returnAddresses(image, 0xf9, 16), [0xc004]);
  assert.deepEqual(returnAddresses(image, 0xfb, 1), []);
});

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const context = (client, id) => ({
  client, logger, platform: { id, features: [], limitedFeatures: [] }, setPlatform: () => ({ id }),
});

/** Runs `fn` with a client whose two backends are mock servers. */
async function withMocks(mode, fn) {
  const c64u = await startMockC64Server();
  const vice = await startViceMockServer({ host: "127.0.0.1", port: 0 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-gd1-mock-"));
  const config = path.join(directory, "config.json");
  fs.writeFileSync(config, JSON.stringify({ c64u: { baseUrl: c64u.baseUrl }, vice: { host: "127.0.0.1", port: vice.port } }));
  const previous = { C64BRIDGE_CONFIG: process.env.C64BRIDGE_CONFIG, C64_MODE: process.env.C64_MODE };
  Object.assign(process.env, { C64BRIDGE_CONFIG: config, C64_MODE: mode });
  try {
    await fn(new C64Client(c64u.baseUrl, { forceC64uFacade: false }), vice);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearViceSymbols();
    await Promise.all([c64u.close(), vice.stop()]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** A running program at `$C000`: `jmp $C000`, with a half-used stack. */
async function loop(client) {
  await client.writeMemory("$C000", "$4C00C0");
  await client.viceRegistersSet([{ name: "PC", value: 0xc000 }, { name: "SP", value: 0xfb }]);
}

/** A Display Get body of a whole 384 x 272 frame: colour 2 in ten rows, otherwise 0. */
function display() {
  const width = 384;
  const height = 272;
  const body = Buffer.alloc(21 + width * height);
  body.writeUInt32LE(13, 0);
  for (const [offset, value] of [[4, width], [6, height], [8, 32], [10, 35], [12, 320], [14, 200]]) body.writeUInt16LE(value, offset);
  body[16] = 8;
  body.writeUInt32LE(width * height, 17);
  body.fill(2, 21 + 100 * width, 21 + 110 * width);
  return body;
}

test("c64_debug diagnose against the VICE mock returns the documented shape", async () => {
  await withMocks("vice", async (client, vice) => {
    await loop(client);
    setViceSymbols([["main", 0xc000]]);
    const result = await debugModuleGroup.invoke("c64_debug", {
      op: "diagnose", sampleIntervalMs: 10, codeRange: { start: "main", end: "main+2" }, frameCounter: "$C100",
    }, context(client, "vice"));
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const data = result.structuredContent.data;
    assert.deepEqual(Object.keys(data), ["verdict", "pc", "opcodeAtPc", "registers", "port01", "vectors", "stack", "frameCounter", "notes"]);
    assert.equal(data.verdict, "stuck_pc");
    assert.deepEqual(data.pc, { address: "$C000", symbol: "main" });
    assert.equal(data.opcodeAtPc, "$4C");
    assert.deepEqual(data.frameCounter, { address: "$C100", symbol: "main+256", first: 0, last: 0 });
    assert.deepEqual(Object.keys(data.vectors), ["irq0314", "brk0316", "nmi0318", "hardwareIrq", "hardwareNmi", "hardwareReset"]);
    assert.equal(vice.running, true, "a running CPU is left running");
  });
});

test("c64_debug diagnose leaves a paused CPU paused and takes one sample", async () => {
  await withMocks("vice", async (client, vice) => {
    await loop(client);
    assert.equal((await client.explicitPause()).success, true);
    const result = await debugModuleGroup.invoke("c64_debug", { op: "diagnose" }, context(client, "vice"));
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(result.structuredContent.data.verdict, "running");
    assert.ok(result.structuredContent.data.notes[0].includes("already stopped"));
    assert.equal(vice.running, false, "a paused CPU stays paused");
    await client.explicitResume();
  });
});

test("c64_debug profile_border against the VICE mock returns the documented shape", async () => {
  await withMocks("vice", async (client, vice) => {
    vice.encodeDisplay = display;
    const result = await debugModuleGroup.invoke("c64_debug", {
      op: "profile_border", markers: [{ name: "work", color: 2 }], idleColor: 0, frames: 2,
    }, context(client, "vice"));
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const data = result.structuredContent.data;
    assert.equal(data.source, "vice");
    assert.equal(data.standard, "pal");
    assert.equal(data.framesCaptured, 2);
    assert.equal(data.framesLost, 0);
    assert.deepEqual(data.markers[0].lines, { min: 10, max: 10, mean: 10 });
  });
});

test("on c64u diagnose is refused and profile_border captures the video stream", async () => {
  await withMocks("c64u", async (client) => {
    const refused = await debugModuleGroup.invoke("c64_debug", { op: "diagnose" }, context(client, "c64u"));
    assert.equal(refused.isError, true);
    assert.ok(refused.content[0].text.includes("not implemented yet"), refused.content[0].text);
    const result = await debugModuleGroup.invoke("c64_debug", {
      op: "profile_border", markers: [{ name: "work", color: 2 }], idleColor: 15, frames: 1,
    }, context(client, "c64u"));
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(result.structuredContent.data.source, "video-stream");
    assert.equal(result.structuredContent.data.framesCaptured, 1);
  });
});

test("profile_border refuses a paused VICE, which renders no new frames", async () => {
  await withMocks("vice", async (client) => {
    assert.equal((await client.explicitPause()).success, true);
    const result = await debugModuleGroup.invoke("c64_debug", {
      op: "profile_border", markers: [{ name: "work", color: 2 }], idleColor: 0,
    }, context(client, "vice"));
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("running CPU"), result.content[0].text);
    await client.explicitResume();
  });
});

test("profile_border refuses a shared marker colour and a backend without frame capture", async () => {
  const request = { op: "profile_border", markers: [{ name: "a", color: 2 }], idleColor: 2 };
  const same = await debugModuleGroup.invoke("c64_debug", request, context({}, "vice"));
  assert.equal(same.isError, true);
  await assert.rejects(() => debugModuleGroup.invoke("c64_debug", { ...request, idleColor: 0 }, context({}, "u2")), /requires backend c64u or vice/);
});

const jumpIntoData = `
* = $C000
main:    sei
         jsr sub
         jmp main
sub:     jmp table+2
codeend:
         .byte 0
table:   .byte 1, 2
         .byte $4c
         .word table+2
`;

const jam = `
* = $C000
main:    sei
         lda #$01
halt:    .byte $02
`;

test("real VICE: a jump into data and a JAM opcode are diagnosed", { skip: !realVice }, async () => {
  await realViceSession({ port: 6521, display: ":121" }, async (call) => {
    await call("c64_program", { op: "upload_run_asm", program: jumpIntoData });
    await delay(3_000);
    const outside = await call("c64_debug", { op: "diagnose", codeRange: { start: "main", end: "codeend-1" } });
    console.log(JSON.stringify({ verdict: outside.verdict, pc: outside.pc, stack: outside.stack, notes: outside.notes }));
    assert.equal(outside.verdict, "pc_outside_code");
    assert.equal(outside.pc.symbol, "table+2");
    assert.ok(outside.notes.some((note) => note.includes("table+2") && note.includes("called from main+1")), outside.notes.join(" "));

    await call("c64_program", { op: "upload_run_asm", program: jam });
    await delay(3_000);
    const halted = await call("c64_debug", { op: "diagnose" });
    console.log(JSON.stringify({ verdict: halted.verdict, pc: halted.pc, opcodeAtPc: halted.opcodeAtPc, notes: halted.notes }));
    assert.equal(halted.verdict, "jam");
    assert.deepEqual(halted.pc, { address: "$C003", symbol: "halt" });
  });
});
