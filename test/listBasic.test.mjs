import test from "#test/runner";
import assert from "#test/assert";
import { basicToPrg } from "../src/tools/translation/basicTokenizer.js";
import { toolRegistry } from "../src/tools/registry/index.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Stub client whose RAM is the 64 KiB array `memory`. */
function clientWith(memory) {
  return {
    async pause() { return { success: true }; },
    async resume() { return { success: true }; },
    async readMemory(address, length) {
      const start = Number.parseInt(String(address).replace("$", ""), 16);
      const bytes = memory.subarray(start, start + Number(length));
      return { success: true, data: `$${Buffer.from(bytes).toString("hex").toUpperCase()}`, details: {} };
    },
  };
}

function loadPrg(prg, endOverride) {
  const memory = new Uint8Array(0x10000);
  const base = prg[0] | (prg[1] << 8);
  memory.set(prg.subarray(2), base);
  const end = endOverride ?? base + prg.length - 2 - 2; // exclude the 00 00 terminator, as VARTAB does not
  memory[0x2b] = base & 0xff; memory[0x2c] = base >> 8;
  memory[0x2d] = (end + 2) & 0xff; memory[0x2e] = (end + 2) >> 8;
  return memory;
}

const ctxFor = (memory) => ({ client: clientWith(memory), rag: {}, logger, platform: { id: "c64u", features: [], limitedFeatures: [] }, setPlatform() {} });

test("list_basic round-trips a tokenised program including quoted keywords", async () => {
  const source = '10 PRINT "GOTO THEN"\n20 FOR I=1 TO 10:NEXT I\n30 REM LOOP FOREVER\n40 DATA 1,2,3\n50 IF A>1 THEN GOTO 10';
  const memory = loadPrg(basicToPrg(source));
  const res = await toolRegistry.invoke("c64_memory", { op: "list_basic" }, ctxFor(memory));
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent.data.listing, source);
  assert.equal(res.metadata.lineCount, 5);
  assert.deepEqual(res.structuredContent.data.lines[0], { number: 10, text: 'PRINT "GOTO THEN"' });
});

test("list_basic returns an empty listing for an empty program", async () => {
  const memory = new Uint8Array(0x10000);
  memory[0x2b] = 0x01; memory[0x2c] = 0x08; memory[0x2d] = 0x03; memory[0x2e] = 0x08;
  memory[0x0801] = 0; memory[0x0802] = 0;
  const res = await toolRegistry.invoke("c64_memory", { op: "list_basic" }, ctxFor(memory));
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent.data.listing, "");
});

test("list_basic reports a link loop and an out-of-range link as errors", async () => {
  const prg = basicToPrg('10 PRINT "A"\n20 PRINT "B"');
  const loop = loadPrg(prg);
  // The link of line 10 sits at $0801/$0802; make it point at its own address.
  loop[0x0801] = 0x01; loop[0x0802] = 0x08;
  const loopRes = await toolRegistry.invoke("c64_memory", { op: "list_basic" }, ctxFor(loop));
  assert.equal(loopRes.isError, true);
  assert.match(loopRes.content[0].text, /Corrupt BASIC link/);

  const far = loadPrg(prg);
  far[0x0801] = 0x00; far[0x0802] = 0x90; // link to $9000, beyond the program
  const farRes = await toolRegistry.invoke("c64_memory", { op: "list_basic" }, ctxFor(far));
  assert.equal(farRes.isError, true);
  assert.match(farRes.content[0].text, /outside the program area/);
});

test("list_basic treats an end pointer below the start pointer as an empty program", async () => {
  const memory = new Uint8Array(0x10000);
  memory[0x2b] = 0x01; memory[0x2c] = 0x08; memory[0x2d] = 0x00; memory[0x2e] = 0x08;
  const res = await toolRegistry.invoke("c64_memory", { op: "list_basic" }, ctxFor(memory));
  assert.equal(res.isError, undefined);
  assert.equal(res.metadata.lineCount, 0);
});

test("list_basic reports a program whose last link points to the end pointer as corrupt", async () => {
  const prg = basicToPrg('10 PRINT "A"\n20 PRINT "B"');
  // Place the end pointer exactly after the last line, so the 00 00 terminator is outside the image read.
  const memory = loadPrg(prg, 0x0801 + prg.length - 2 - 4);
  const res = await toolRegistry.invoke("c64_memory", { op: "list_basic" }, ctxFor(memory));
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Corrupt BASIC program: no 00 00 terminator/);
});

test("list_basic holds one owned pause for the whole read on c64u and none on vice", async () => {
  const memory = loadPrg(basicToPrg('10 PRINT "A"'));
  const make = (platformId) => {
    const calls = [];
    const client = {
      ...clientWith(memory),
      async pinFacade() { return "facade"; },
      async acquirePause(facade) { calls.push(["acquire", facade]); return { success: true }; },
      async releasePause(facade) { calls.push(["release", facade]); return { success: true }; },
    };
    const reads = client.readMemory;
    client.readMemory = async (address, length, facade) => { calls.push(["read", facade]); return reads(address, length); };
    return { calls, ctx: { client, rag: {}, logger, platform: { id: platformId, features: [], limitedFeatures: [] }, setPlatform() {} } };
  };

  const c64u = make("c64u");
  const res = await toolRegistry.invoke("c64_memory", { op: "list_basic" }, c64u.ctx);
  assert.equal(res.isError, undefined);
  assert.deepEqual(c64u.calls.map((c) => c[0]), ["acquire", "read", "read", "release"]);
  assert.ok(c64u.calls.every((c) => c[1] === "facade"));

  const vice = make("vice");
  await toolRegistry.invoke("c64_memory", { op: "list_basic" }, vice.ctx);
  assert.deepEqual(vice.calls.map((c) => c[0]), ["read", "read"]);

  // The pause is released even when a read fails.
  const failing = make("c64u");
  failing.ctx.client.readMemory = async () => ({ success: false, details: {} });
  const bad = await toolRegistry.invoke("c64_memory", { op: "list_basic" }, failing.ctx);
  assert.equal(bad.isError, true);
  assert.deepEqual(failing.calls.map((c) => c[0]), ["acquire", "release"]);
});

test("list_basic rejects an implausible end pointer before reading the program and still resumes", async () => {
  const memory = new Uint8Array(0x10000);
  memory[0x2b] = 0x01; memory[0x2c] = 0x08; // start $0801
  memory[0x2d] = 0x01; memory[0x2e] = 0xf0; // end $F001, a 60 KB range
  const reads = [];
  const events = [];
  const base = clientWith(memory);
  const client = {
    async pause() { events.push("pause"); return { success: true }; },
    async resume() { events.push("resume"); return { success: true }; },
    async readMemory(address, length) { reads.push(address); return base.readMemory(address, length); },
  };
  const res = await toolRegistry.invoke("c64_memory", { op: "list_basic" }, { client, rag: {}, logger, platform: { id: "c64u", features: [], limitedFeatures: [] }, setPlatform() {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /end pointer is implausible/);
  assert.deepEqual(reads, ["$002B"]);
  assert.deepEqual(events, ["pause", "resume"]);
});
