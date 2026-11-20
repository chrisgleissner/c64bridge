import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";

// HARD06 CLIENT-6 / MEDIA-8 / WORKFLOW-13: related register writes go out as one block write
// (decision D1), so VICE needs one monitor session and the Ultimate no extra round trips.

function stubClient() {
  const calls = { reads: 0, writes: 0, blockCalls: 0, blocks: [] };
  const client = new C64Client("http://127.0.0.1:1");
  client.facadePromise = Promise.resolve({
    type: "vice",
    async readMemory(address, length) { calls.reads += 1; return address === 0x0314 ? Uint8Array.of(0x31, 0xEA) : new Uint8Array(length); },
    async writeMemory() { calls.writes += 1; },
    async writeMemoryBlocks(list) { calls.blockCalls += 1; calls.blocks.push(...list.map((block) => block.address)); },
  });
  return { client, calls };
}

test("render_bitmap writes data and registers in one batch", async () => {
  const { client, calls } = stubClient();
  const result = await client.displayBitmap({
    mode: "hires", bitmapData: new Uint8Array(8000), screenRam: new Uint8Array(1000), colorRam: new Uint8Array(1000), backgroundColor: 0, borderColor: 0,
  });
  assert.equal(result.success, true, JSON.stringify(result.details));
  assert.equal(calls.writes, 0);
  assert.equal(calls.blockCalls, 1);
  assert.deepEqual(calls.blocks, [0x2000, 0x0400, 0xD800, 0xDD00, 0xD011, 0xD016, 0xD018, 0xD020]);
});

test("a soft and a hard SID reset each write in one batch", async () => {
  for (const hard of [false, true]) {
    const { client, calls } = stubClient();
    const result = await client.sidReset(hard);
    assert.equal(result.success, true);
    assert.equal(calls.writes, 0);
    assert.equal(calls.blockCalls, 1);
  }
});
