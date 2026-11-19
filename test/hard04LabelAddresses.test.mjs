import test from "#test/runner";
import assert from "#test/assert";
import { programRunnersModule } from "../src/tools/programRunners.js";
import { toolRegistry } from "../src/tools/registry/index.js";
import { debugModuleGroup } from "../src/tools/debug.js";
import { assemblyToPrg } from "../src/tools/translation/assembler.js";
import { clearViceSymbols, setViceSymbols } from "../src/tools/translation/symbolRegistry.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = (id) => ({ id, features: [], limitedFeatures: [] });

test.afterEach(() => clearViceSymbols());

function c64uCtx(reads) {
  return {
    client: {
      async uploadAndRunAsm() { return { success: true }; },
      async readMemoryRaw(address, length) {
        // Echo the assembled bytes back so the load readback succeeds.
        return Uint8Array.from({ length }, () => 0);
      },
      async readScreen() { return "READY.\n"; },
      async readMemory(address, length) {
        reads.push(address);
        return { success: true, data: `$${"00".repeat(Number(length))}` };
      },
    },
    logger,
    platform: platform("c64u"),
    setPlatform: () => platform("c64u"),
  };
}

test("HARD04-003 upload_run_asm registers labels on c64u and returns them sorted", async () => {
  const ctx = c64uCtx([]);
  const source = "*=$C000\nstart: lda #1\nloop: jmp loop\n";
  const body = assemblyToPrg(source).subarray(2);
  ctx.client.readMemoryRaw = async (address, length) =>
    address === 0xc000 ? Uint8Array.from(body.subarray(0, length)) : new Uint8Array(length);
  const res = await programRunnersModule.invoke("upload_run_asm", {
    program: source,
  }, ctx);
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  const data = res.structuredContent.data;
  assert.deepEqual(Object.keys(data.symbols), ["start", "loop"]);
  assert.equal(data.symbols.start, "$C000");
  assert.equal(data.symbols.loop, "$C002");
  const read = await toolRegistry.invoke("c64_memory", { op: "read", address: "loop", length: 2 }, ctx);
  assert.equal(read.isError, undefined, JSON.stringify(read.content));
  assert.equal(read.structuredContent.data.address, "$C002");
});

test("HARD04-003 c64_memory read resolves a loaded label and passes the numeric address on", async () => {
  setViceSymbols([["spawn", 0xc123]]);
  const reads = [];
  const res = await toolRegistry.invoke("c64_memory", { op: "read", address: "spawn", length: 2 }, c64uCtx(reads));
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  assert.deepEqual(reads, ["$C123"]);
  assert.equal(res.structuredContent.data.address, "$C123");
});

test("HARD04-003 an unknown name is rejected and numeric forms are unchanged", async () => {
  const reads = [];
  const ctx = c64uCtx(reads);
  const bad = await toolRegistry.invoke("c64_memory", { op: "read", address: "nosuchlabel", length: 2 }, ctx);
  assert.equal(bad.isError, true);
  assert.match(bad.content.map((c) => c.text ?? "").join("\n"), /no such symbol is loaded/);
  assert.equal(reads.length, 0);
  for (const [input, expected] of [["$0400", "$0400"], ["1024", "$0400"]]) {
    const res = await toolRegistry.invoke("c64_memory", { op: "read", address: input, length: 1 }, ctx);
    assert.equal(res.isError, undefined, input);
    assert.equal(res.structuredContent.data.address, expected);
  }
  const bare = await toolRegistry.invoke("c64_memory", { op: "read", address: "0400", length: 1 }, ctx);
  assert.equal(bare.isError, true);
});

test("HARD04-003 c64_debug create_checkpoint accepts a registered label", async () => {
  setViceSymbols([["hit_me", 0x0830]]);
  const calls = [];
  const ctx = {
    client: {
      async viceCheckpointCreate(args) {
        calls.push(args);
        return { checkpointNumber: 1, start: args.start, end: args.end, stopWhenHit: true, enabled: true, temporary: false, hitCount: 0, ignoreCount: 0, hasCondition: false, operations: {} };
      },
    },
    rag: {}, logger, platform: platform("vice"), setPlatform: () => platform("vice"),
  };
  const res = await debugModuleGroup.invoke("c64_debug", { op: "create_checkpoint", address: "hit_me" }, ctx);
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  assert.equal(calls[0].start, 0x0830);
  const unknown = await debugModuleGroup.invoke("c64_debug", { op: "create_checkpoint", address: "nope" }, ctx);
  assert.equal(unknown.isError, true);
  assert.equal(calls.length, 1);
});

test("HARD04-003 a label spelled like bare hex does not shadow the ambiguous-hex rejection", async () => {
  setViceSymbols([["beef", 0xc000]]);
  const reads = [];
  const res = await toolRegistry.invoke("c64_memory", { op: "read", address: "beef", length: 1 }, c64uCtx(reads));
  assert.equal(res.isError, true);
  assert.match(res.content.map((c) => c.text ?? "").join("\n"), /hexadecimal needs a prefix/);
  assert.equal(reads.length, 0);
  const calls = [];
  const ctx = {
    client: { async viceCheckpointCreate(args) { calls.push(args); return {}; } },
    rag: {}, logger, platform: platform("vice"), setPlatform: () => platform("vice"),
  };
  const dbg = await debugModuleGroup.invoke("c64_debug", { op: "create_checkpoint", address: "beef" }, ctx);
  assert.equal(dbg.isError, true);
  assert.equal(calls.length, 0);
});
