import test from "#test/runner";
import assert from "#test/assert";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

// Expected values in this file were read from an Ultimate 64 Elite running
// firmware 3.15 (git 7dbbd05e9) with machine:readmem after each step.

function hex(memory, address, length) {
  return Buffer.from(memory.subarray(address, address + length)).toString("hex");
}

async function loadPrg(mock, bytes) {
  const response = await fetch(`${mock.baseUrl}/v1/runners:load_prg`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from(bytes),
  });
  assert.equal(response.status, 200);
}

test("mock C64U starts with the BASIC pointers and screen of a reset machine", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());

  // TXTTAB=$0801, VARTAB/ARYTAB/STREND=$0803, FRETOP=$A000.
  assert.equal(hex(mock.state.memory, 0x2b, 10), "010803080308030800a0");
  assert.equal(hex(mock.state.memory, 0x0801, 2), "0000");
  // Screen RAM is cleared to spaces, not zero (screen code 0 is "@").
  assert.equal(mock.state.memory[0x0400 + 40 * 10], 0x20);
});

test("mock C64U load_prg sets the BASIC end pointers like the Ultimate 64", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());

  await loadPrg(mock, [0x00, 0xc0, 0xee, 0x20, 0xd0, 0x60]);
  assert.equal(hex(mock.state.memory, 0xc000, 4), "ee20d060");
  // VARTAB/ARYTAB/STREND point at the end of the loaded data; $0801 is untouched.
  assert.equal(hex(mock.state.memory, 0x2b, 10), "010804c004c004c000a0");
  assert.equal(hex(mock.state.memory, 0x0801, 2), "0000");
});

test("mock C64U load_prg relinks raw machine code at $0801 like the Ultimate 64", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());

  await loadPrg(mock, [0x01, 0x08, 0xa9, 0x02, 0x8d, 0x20, 0xd0, 0x60, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x00]);
  // BASIC relinks the "line" at $0801: LDA #$02 becomes the link pointer $080E.
  assert.equal(hex(mock.state.memory, 0x0801, 13), "0e088d20d060112233445566" + "00");
  assert.equal(hex(mock.state.memory, 0x2b, 10), "01080e080e080e0800a0");
});

test("mock C64U reads the write-only SID registers as $00 like the Ultimate 64", async (t) => {
  const mock = await startMockC64Server();
  t.after(() => mock.close());
  await fetch(`${mock.baseUrl}/v1/machine:writemem?address=D404&data=11`, { method: "PUT" });
  const response = await fetch(`${mock.baseUrl}/v1/machine:readmem?address=D404&length=1`, { headers: { Accept: "application/octet-stream" } });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x00]);
});
