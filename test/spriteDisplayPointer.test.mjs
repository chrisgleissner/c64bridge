import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";

test("displaySprite writes only the sprite pointer and leaves screen RAM alone", async () => {
  const client = new C64Client("http://127.0.0.1:1");
  const writes = [];
  client.facadePromise = Promise.resolve({
    async readMemory(_address, length) {
      return new Uint8Array(length);
    },
    async writeMemory(address, bytes) {
      writes.push({ address, bytes: Uint8Array.from(bytes) });
    },
  });
  const result = await client.displaySprite({ spriteBytes: new Uint8Array(63), spriteIndex: 2 });
  assert.equal(result.success, true);
  const pointerWrites = writes.filter((w) => w.address === 0x07f8 + 2);
  assert.equal(pointerWrites.length, 1);
  assert.deepEqual(Array.from(pointerWrites[0].bytes), [128 + 2]);
  const touchesScreen = writes.some((w) => w.address < 0x07e8 && w.address + w.bytes.length > 0x0400);
  assert.equal(touchesScreen, false);
  const touchesColour = writes.some((w) => w.address >= 0xd800 && w.address < 0xdbe8);
  assert.equal(touchesColour, false);
});
