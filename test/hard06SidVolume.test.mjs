import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";

// HARD06 CLIENT-9 / SOUND-14: $D418 holds the volume (bits 0-3) and the filter mode (bits 4-6,
// bit 7 = voice 3 off) and is write-only, so setting the volume says that it cleared the filter
// mode, and filterMode sets the upper bits.

function stubClient() {
  const writes = [];
  const client = new C64Client("http://127.0.0.1:1");
  client.facadePromise = Promise.resolve({
    type: "vice",
    async writeMemory(address, bytes) { writes.push({ address, bytes: Array.from(bytes) }); },
  });
  return { client, writes };
}

test("setting the volume states that the filter mode bits were cleared", async () => {
  const { client, writes } = stubClient();
  const result = await client.sidSetVolume(12);
  assert.equal(result.success, true);
  assert.deepEqual(writes, [{ address: 0xD418, bytes: [0x0C] }]);
  assert.equal(result.details.value, 0x0C);
  assert.match(result.details.notice, /filter mode bits 4-7 were set to 0/);
});

test("filterMode sets the upper nibble", async () => {
  const { client, writes } = stubClient();
  const result = await client.sidSetVolume(15, undefined, { filterMode: 0x1 });
  assert.equal(result.success, true);
  assert.deepEqual(writes, [{ address: 0xD418, bytes: [0x1F] }]);
  assert.equal(result.details.notice, undefined);
});
