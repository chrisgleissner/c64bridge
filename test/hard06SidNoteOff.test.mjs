import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";

// HARD06 MEDIA-5 / SOUND-10: note_off clears only the gate bit (bit 0) of the voice control
// register, so the waveform keeps sounding through the release phase.

function stubClient() {
  const writes = [];
  const client = new C64Client("http://127.0.0.1:1");
  client.facadePromise = Promise.resolve({
    type: "vice",
    async readMemory(_address, length) { return new Uint8Array(length); },
    async writeMemory(address, bytes) { writes.push({ address, bytes: Array.from(bytes) }); },
  });
  return { client, writes };
}

test("note off after a pulse note on voice 2 keeps the pulse waveform", async () => {
  const { client, writes } = stubClient();
  assert.equal((await client.sidNoteOn({ voice: 2, note: "C4", waveform: "pulse" })).success, true);
  const result = await client.sidNoteOff(2);
  assert.equal(result.success, true);
  const off = writes.at(-1);
  assert.equal(off.address, 0xD40B);
  assert.deepEqual(off.bytes, [0x40]); // pulse (bit 6) with the gate (bit 0) cleared
});

test("note off without a known waveform says so", async () => {
  const { client, writes } = stubClient();
  const result = await client.sidNoteOff(3);
  assert.equal(result.success, true);
  assert.deepEqual(writes.at(-1), { address: 0xD412, bytes: [0x00] });
  assert.match(result.details.notice, /waveform is unknown/);
});
