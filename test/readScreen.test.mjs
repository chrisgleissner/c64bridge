import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";
import { screenCodesToAscii } from "../src/petscii.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

// Screen codes 1, 2, 0x41, 0x42 then a space: "AB" + graphics in the upper-case set, "abAB" in the lower-case set.
const CODES = [0x01, 0x02, 0x41, 0x42];

test("screenCodesToAscii shows letters with the right case in each character set", () => {
  const bytes = Uint8Array.from([...CODES, 0x20]);
  assert.equal(screenCodesToAscii(bytes, { columns: 40, rows: 25 }).slice(0, 2), "AB");
  assert.equal(screenCodesToAscii(bytes, { columns: 40, rows: 25, charset: "lower" }), "abAB");
  // Reverse-video letters show the same letter.
  assert.equal(screenCodesToAscii(Uint8Array.of(0x81, 0xc1), { charset: "lower" }), "aA");
});

test("readScreen follows the VIC bank, screen base and character set", async (t) => {
  const mock = await startMockC64Server();
  t.after(async () => { await mock.close(); });
  const client = new C64Client(mock.baseUrl);
  const memory = mock.state.memory;

  // Default state: $0400, upper-case set. $D018=$14 and $DD00 bank 0.
  memory[0xd018] = 0x14;
  memory[0xdd00] = 0x03;
  let detailed = await client.readScreenDetailed();
  assert.equal(detailed.baseAddress, 0x0400);
  assert.equal(detailed.charset, "upper");
  assert.ok(detailed.text.includes("READY."));

  // Lower-case set ($D018 bit 1), same screen: "READY." is stored as upper-case-set screen codes 18,5,1,4,25.
  memory[0xd018] = 0x16;
  detailed = await client.readScreenDetailed();
  assert.equal(detailed.charset, "lower");
  assert.ok(detailed.text.includes("ready."), detailed.text);

  // Screen moved to $0800 in bank 0 ($D018 high nibble 2) holding "abAB" as lower-case-set codes.
  memory.fill(0x20, 0x0800, 0x0800 + 1000);
  memory.set(CODES, 0x0800);
  memory[0xd018] = 0x26;
  assert.equal(await client.readScreen(), "abAB");

  // VIC bank 1 ($DD00 bits 0-1 = %10): base $4000 + $0400 * 1.
  memory.fill(0x20, 0x4400, 0x4400 + 1000);
  memory.set(CODES, 0x4400);
  memory[0xdd00] = 0x02;
  memory[0xd018] = 0x16 | 0x10;
  detailed = await client.readScreenDetailed();
  assert.equal(detailed.baseAddress, 0x4400);
  assert.equal(detailed.text, "abAB");
});

test("readScreen falls back to $0400 when the VIC registers read as zero", async (t) => {
  const mock = await startMockC64Server();
  t.after(async () => { await mock.close(); });
  const client = new C64Client(mock.baseUrl);
  mock.state.memory[0xd018] = 0;
  mock.state.memory[0xdd00] = 0;
  const detailed = await client.readScreenDetailed();
  assert.equal(detailed.baseAddress, 0x0400);
  assert.equal(detailed.charset, "upper");
});

test("read_screen reports the screen base and character set", async () => {
  const { memoryModule } = await import("../src/tools/memory.js");
  const ctx = {
    client: {
      async readScreen() { return "X"; },
      async readScreenDetailed() { return { text: "abAB", baseAddress: 0x0800, charset: "lower" }; },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const res = await memoryModule.invoke("read_screen", {}, ctx);
  assert.equal(res.metadata.screen, "abAB");
  assert.equal(res.metadata.screenBase, "$0800");
  assert.equal(res.metadata.charset, "lower");
});
