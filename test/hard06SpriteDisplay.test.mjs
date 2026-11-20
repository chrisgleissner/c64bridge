import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";

// HARD06 WORKFLOW-8: render_sprite keeps the VIC bank and screen mode in use and places the sprite
// in that bank. CLIENT-6: it reads the VIC state in two reads and writes in one block write.

function stubClient(registers, { blocks = true } = {}) {
  const mem = new Uint8Array(65536);
  for (const [address, value] of Object.entries(registers)) mem[Number(address)] = value;
  const calls = { reads: 0, writes: [], blockCalls: 0 };
  const facade = {
    type: "vice",
    async readMemory(address, length) { calls.reads += 1; return mem.slice(address, address + length); },
    async writeMemory(address, bytes) { calls.writes.push({ address, bytes: Uint8Array.from(bytes) }); },
  };
  if (blocks) facade.writeMemoryBlocks = async (list) => { calls.blockCalls += 1; for (const block of list) calls.writes.push({ address: block.address, bytes: Uint8Array.from(block.bytes) }); };
  const client = new C64Client("http://127.0.0.1:1");
  client.facadePromise = Promise.resolve(facade);
  return { client, calls };
}

const modeRegisters = [0xDD00, 0xD011, 0xD016, 0xD018, 0xD020, 0xD021];

test("a sprite in VIC bank 1 goes into bank 1 and the bank and mode registers stay untouched", async () => {
  // $DD00 bits 0-1 = %10 selects bank 1 ($4000); $D018 = $10 puts the screen at $4400.
  const { client, calls } = stubClient({ 0xDD00: 0x96, 0xD011: 0x1B, 0xD018: 0x10 });
  const result = await client.displaySprite({ spriteBytes: new Uint8Array(63).fill(0xFF), spriteIndex: 1, x: 300, y: 80 });
  assert.equal(result.success, true, JSON.stringify(result.details));
  assert.equal(result.details.bank, 1);
  assert.equal(result.details.spriteAddress, "6040");
  assert.equal(result.details.pointerAddress, "47F9");
  assert.equal(result.details.pointerValue, 0x81);
  assert.ok(calls.writes.every((write) => !modeRegisters.includes(write.address)), JSON.stringify(calls.writes.map((w) => w.address)));
  const pointer = calls.writes.find((write) => write.address === 0x47F9);
  assert.deepEqual(Array.from(pointer.bytes), [0x81]);
  assert.equal(calls.reads, 2);
  assert.equal(calls.blockCalls, 1);
});

test("in bitmap mode the default sprite block avoids the bitmap and the screen", async () => {
  // Bitmap mode ($D011 bit 5) with the bitmap at $2000 ($D018 bit 3) and the screen at $0400.
  const { client } = stubClient({ 0xDD00: 0x97, 0xD011: 0x3B, 0xD018: 0x18 });
  const result = await client.displaySprite({ spriteBytes: new Uint8Array(63) });
  assert.equal(result.success, true, JSON.stringify(result.details));
  assert.equal(result.details.spriteAddress, "0800");
});

test("dataAddress places the block and must lie in the current bank", async () => {
  const placed = stubClient({ 0xDD00: 0x97, 0xD011: 0x1B, 0xD018: 0x14 });
  const ok = await placed.client.displaySprite({ spriteBytes: new Uint8Array(63), dataAddress: 0x3E00 });
  assert.equal(ok.success, true);
  assert.equal(ok.details.pointerValue, 0xF8);
  assert.ok(placed.calls.writes.some((write) => write.address === 0x3E00 && write.bytes.length === 64));
  const outside = stubClient({ 0xDD00: 0x97, 0xD011: 0x1B, 0xD018: 0x14 });
  const rejected = await outside.client.displaySprite({ spriteBytes: new Uint8Array(63), dataAddress: 0x8000 });
  assert.equal(rejected.success, false);
  assert.match(rejected.details.message, /outside the VIC bank in use/);
  assert.equal(outside.calls.writes.length, 0);
});
