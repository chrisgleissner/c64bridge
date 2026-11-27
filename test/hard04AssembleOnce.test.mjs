import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";
import { programRunnersModule } from "../src/tools/programRunners.js";
import { assemblyToPrgDetailed } from "../src/tools/translation/assembler.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = (id) => ({ id, features: [], limitedFeatures: [] });
const SOURCE = "*=$C000\nstart: lda #1\n sta $0400\n rts\n";

test("HARD04-004 upload_run_asm hands its assembly result to the client instead of assembling again", async () => {
  const seen = [];
  const prg = assemblyToPrgDetailed(SOURCE).prg;
  const ctx = {
    client: {
      async uploadAndRunAsm(program, assembled) { seen.push({ program, assembled }); return { success: true }; },
      async readMemoryRaw(address, length) { return address === 0xc000 ? Uint8Array.from(prg.subarray(2, 2 + length)) : new Uint8Array(length); },
      async readScreen() { return "READY.\n"; },
    },
    logger, platform: platform("c64u"), setPlatform: () => platform("c64u"),
  };
  const res = await programRunnersModule.invoke("upload_run_asm", { program: SOURCE }, ctx);
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].program, SOURCE);
  assert.ok(seen[0].assembled && seen[0].assembled.prg instanceof Uint8Array, "assembled result passed as second argument");
  assert.equal(seen[0].assembled.entryAddress, 0xc000);
});

test("HARD04-004 C64Client.uploadAndRunAsm behaves the same with and without a pre-assembled result", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  const one = await client.uploadAndRunAsm(SOURCE);
  const first = Buffer.from(mock.state.lastLoadedPrg);
  const two = await client.uploadAndRunAsm(SOURCE, assemblyToPrgDetailed(SOURCE));
  assert.equal(one.success, true);
  assert.equal(two.success, true);
  assert.deepEqual([...mock.state.lastLoadedPrg], [...first]);
  const refused = await client.uploadAndRunAsm(".org $0801\nlda #1\nrts", assemblyToPrgDetailed(".org $0801\nlda #1\nrts"));
  assert.equal(refused.success, false);
});
