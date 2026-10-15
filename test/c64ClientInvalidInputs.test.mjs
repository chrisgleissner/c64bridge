import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";

test("C64Client: readMemory fails on invalid inputs", async () => {
  const client = new C64Client("http://example.invalid");

  // Invalid length (<=0)
  const r1 = await client.readMemory("$0400", "0");
  assert.equal(r1.success, false);
  assert.ok(String(r1.details?.message || r1.details).toLowerCase().includes("length"));

  // Invalid address
  const r2 = await client.readMemory("GARBAGE", "1");
  assert.equal(r2.success, false);
  assert.ok(String(r2.details?.message || r2.details).toLowerCase().includes("unable to parse"));

  const r3 = await client.readMemory("$04ZZ", "1");
  assert.equal(r3.success, false);
  assert.ok(String(r3.details?.message || r3.details).toLowerCase().includes("unable to parse"));

  const r4 = await client.readMemory("$FFFF", "2");
  assert.equal(r4.success, false);
  assert.ok(String(r4.details?.message || r4.details).toLowerCase().includes("range"));
});

test("C64Client: writeMemory validates hex string", async () => {
  const client = new C64Client("http://example.invalid");

  const e1 = await client.writeMemory("$0400", "$");
  assert.equal(e1.success, false);
  assert.ok(String(e1.details?.message || e1.details).toLowerCase().includes("no hexadecimal"));

  const e2 = await client.writeMemory("$0400", "$A");
  assert.equal(e2.success, false);
  assert.ok(String(e2.details?.message || e2.details).toLowerCase().includes("even number"));

  const e3 = await client.writeMemory("$0400", "$AAZZ");
  assert.equal(e3.success, false);
  assert.ok(String(e3.details?.message || e3.details).toLowerCase().includes("non-hexadecimal"));

  const e4 = await client.writeMemory("$FFFF", "$AABB");
  assert.equal(e4.success, false);
  assert.ok(String(e4.details?.message || e4.details).toLowerCase().includes("range"));

  // "$" on each byte group parses as two bytes, so the failure is the range
  // check rather than a hex parse error.
  const e5 = await client.writeMemory("$FFFF", "$AA $BB");
  assert.equal(e5.success, false);
  assert.ok(String(e5.details?.message || e5.details).toLowerCase().includes("range"));
});

test("C64Client: sid helpers validate inputs", async () => {
  const client = new C64Client("http://example.invalid");

  const badVoice = await client.sidNoteOn({ voice: 0, note: "A4" });
  assert.equal(badVoice.success, false);
  assert.ok(String(badVoice.details?.message || badVoice.details).includes("Voice"));
});

test("C64Client: sidNoteOn reports notes above the SID frequency range instead of clamping", async () => {
  const client = new C64Client("http://example.invalid");
  const pal = await client.sidNoteOn({ voice: 1, note: "B7", system: "PAL" });
  assert.equal(pal.success, false);
  assert.ok(String(pal.details?.message).includes("3848"));
  const hz = await client.sidNoteOn({ voice: 1, frequencyHz: 5000, system: "NTSC" });
  assert.equal(hz.success, false);
  assert.ok(String(hz.details?.message).includes("NTSC"));
});
