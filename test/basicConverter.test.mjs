import test from "#test/runner";
import assert from "#test/assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { basicToPrg } from "../src/tools/basicTokenizer.js";
import { encodeStringWithNames } from "../src/petscii.js";

test("basicToPrg encodes line pointers, tokens, and terminator", () => {
  const program = `10 PRINT "HI"\n20 GOTO 10\n`;
  const prg = basicToPrg(program);

  const artifactsDir = join(process.cwd(), "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const prgPath = join(artifactsDir, "demo-basic.prg");
  writeFileSync(prgPath, prg);

  const expected = Buffer.from([
    0x01, 0x08, // load address
    0x0c, 0x08, // pointer to second line
    0x0a, 0x00, // line number 10
    0x99, // PRINT token
    0x20, // space
    0x22, 0x48, 0x49, 0x22, // "HI"
    0x00, // line terminator
    0x15, 0x08, // pointer to final zero word
    0x14, 0x00, // line number 20
    0x89, // GOTO token
    0x20, 0x31, 0x30, // " 10"
    0x00, // line terminator
    0x00, 0x00, // program terminator
  ]);

  assert.equal(prg.length, expected.length, "PRG length mismatch");
  assert.deepEqual(Array.from(prg), Array.from(expected));
});

test("basicToPrg respects strings and remarks", () => {
  const program = `10 PRINT "ONE" : REM keep tokens\n20 PRINT "TWO"\n`;
  const prg = basicToPrg(program);

  // locate first line body (skip load address and pointer/line number words)
  const firstLineBody = prg.subarray(6, prg.indexOf(0x00, 6));
  assert.equal(firstLineBody[0], 0x99); // PRINT token
  assert.equal(firstLineBody[1], 0x20); // space before string
  assert.equal(firstLineBody[2], 0x22); // opening quote
  assert.equal(String.fromCharCode(firstLineBody[3]), "O");

  const remarkIndex = firstLineBody.indexOf(0x8f);
  assert.ok(remarkIndex > -1, "REM token missing");

  const bytesAfterRem = firstLineBody.slice(remarkIndex + 1);
  const textAfterRem = String.fromCharCode(...bytesAfterRem);
  assert.ok(textAfterRem.includes("keep tokens"));
  assert.ok(!bytesAfterRem.includes(0x99), "Tokens must not appear after REM");
});

test("encodeStringWithNames maps {heart} to a PETSCII byte", () => {
  const bytes = encodeStringWithNames("A{heart}B");
  // Expect three bytes: 'A', heart, 'B'
  assert.equal(bytes.length, 3);
  // Middle byte should be a non-ASCII graphic; ensure it's not 'A' or 'B'
  assert.notEqual(bytes[1], "A".charCodeAt(0));
  assert.notEqual(bytes[1], "B".charCodeAt(0));
});
