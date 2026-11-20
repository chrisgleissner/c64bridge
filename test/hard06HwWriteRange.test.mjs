import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

// Measured on an Ultimate 64 Elite (firmware 3.15a, 2026-11-20, results.md row 6): a POST writemem of
// 65537 bytes at $0000 was answered 200 and wrote only $0000-$FFFF; the extra byte was dropped silently.
// The mock server reproduces that answer, so a range that runs past $FFFF must be refused before sending.

async function rejects(promise, pattern) {
  let error;
  try { await promise; } catch (caught) { error = caught; }
  assert.ok(error instanceof Error, "expected a rejection");
  assert.match(error.message, pattern);
}

test("HW6-6 the Ultimate backend refuses a write that runs past $FFFF before sending it", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  const facade = await client.facadePromise;
  await rejects(facade.writeMemory(0x0000, new Uint8Array(0x10001)), /does not fit within \$0000-\$FFFF/);
  await rejects(facade.writeMemory(0xffff, new Uint8Array(2)), /does not fit/);
  await rejects(facade.writeMemoryBlocks([{ address: 0xfe00, bytes: new Uint8Array(0x100) }, { address: 0xff80, bytes: new Uint8Array(0x81) }]), /later blocks were not written.*does not fit/);
  assert.equal(mock.state.writeLog.length, 1); // the first block is valid and was written
  mock.state.writeLog.length = 0;
  await facade.writeMemory(0xff00, new Uint8Array(0x100).fill(7));
  assert.equal(mock.state.writeLog.length, 1);
});

test("HW6-6 client writes past $FFFF are refused without a request", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  const client = new C64Client(mock.baseUrl);
  await rejects(client.writeMemoryRaw(0x0000, new Uint8Array(0x10001)), /within 0x0000 - 0xFFFF/);
  const result = await client.writeMemory("$FFF0", "00".repeat(17));
  assert.equal(result.success, false);
  assert.equal(mock.state.writeLog.length, 0);
});
