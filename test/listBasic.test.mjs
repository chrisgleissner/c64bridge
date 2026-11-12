import test from "#test/runner";
import assert from "#test/assert";
import { basicToPrg } from "../src/tools/translation/basicTokenizer.js";
import { toolRegistry } from "../src/tools/registry/index.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Stub client whose RAM is the 64 KiB array `memory`. */
function clientWith(memory) {
  return {
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
