import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";

// HARD06 CLIENT-7: the register and screen reads of one read_screen go to the backend that was
// active when the call started, even when the backend is switched in between.

test("a backend switch during a screen read does not mix machines", async () => {
  const client = new C64Client("http://127.0.0.1:1");
  const seen = [];
  const other = { type: "vice", async readMemory(address, length) { seen.push(["other", address]); return new Uint8Array(length).fill(0x02); } };
  const first = {
    type: "c64u",
    async readMemory(address, length) {
      seen.push(["first", address]);
      if (address === 0xD018) client.facadePromise = Promise.resolve(other); // c64_select_backend in between
      return new Uint8Array(length).fill(address === 0xD018 ? 0x14 : address === 0xDD00 ? 0x97 : 0x01);
    },
  };
  client.facadePromise = Promise.resolve(first);
  const screen = await client.readScreenDetailed();
  assert.deepEqual(seen.map(([name]) => name), ["first", "first", "first"]);
  assert.equal(screen.baseAddress, 0x0400);
  assert.ok(screen.text.startsWith("A"));
});
