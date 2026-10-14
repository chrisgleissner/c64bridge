import test from "#test/runner";
import assert from "#test/assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { basicToPrg } from "../src/tools/translation/basicTokenizer.js";
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

test("encodeStringWithNames maps {heart} to the PETSCII heart glyph", () => {
  const bytes = encodeStringWithNames("A{heart}B");
  // PETSCII $73 (shifted S) is the heart; $51 would print the letter Q.
  assert.deepEqual(Array.from(bytes), [0x41, 0x73, 0x42]);
});

function lineBodies(prg) {
  // Walk the linked line list and return [lineNumber, bodyBytes] pairs.
  const loadAddress = prg.readUInt16LE(0);
  const lines = [];
  let offset = 2;
  while (prg.readUInt16LE(offset) !== 0) {
    const next = prg.readUInt16LE(offset) - loadAddress + 2;
    lines.push([prg.readUInt16LE(offset + 2), Array.from(prg.subarray(offset + 4, next - 1))]);
    offset = next;
  }
  return lines;
}

const ascii = (text) => Array.from(text, (ch) => ch.charCodeAt(0));

test("basicToPrg copies DATA items literally until the end of the statement", () => {
  const prg = basicToPrg(`10 DATA STOP,TO,ON:PRINT "A:B"\n20 DATA "X:Y",GOTO:GOTO 10\n`);
  const [[, first], [, second]] = lineBodies(prg);
  // Keywords inside DATA stay as text; the statement after ':' is tokenised again.
  assert.deepEqual(first, [0x83, ...ascii(" STOP,TO,ON:"), 0x99, ...ascii(' "A:B"')]);
  // A ':' inside a quoted DATA item does not end the DATA statement.
  assert.deepEqual(second, [0x83, ...ascii(' "X:Y",GOTO:'), 0x89, ...ascii(" 10")]);
});

test("basicToPrg converts ? to PRINT outside strings, REM, and DATA", () => {
  const prg = basicToPrg(`10 ?"A?":? 1\n20 REM ?\n30 DATA ?\n`);
  const lines = lineBodies(prg);
  assert.deepEqual(lines[0][1], [0x99, ...ascii('"A?":'), 0x99, ...ascii(" 1")]);
  assert.deepEqual(lines[1][1], [0x8f, ...ascii(" ?")]);
  assert.deepEqual(lines[2][1], [0x83, ...ascii(" ?")]);
});

test("basicToPrg sorts lines and lets a later duplicate replace or delete a line", () => {
  const prg = basicToPrg(`30 END\n10 PRINT\n20 GOTO 10\n10 STOP\n20\n`);
  const lines = lineBodies(prg);
  assert.deepEqual(lines, [
    [10, [0x90]],
    [30, [0x80]],
  ]);
  // Line links must point at the next line in sorted order.
  assert.equal(prg.readUInt16LE(2), 0x0801 + 4 + 1 + 1);
});

test("basicToPrg rejects line numbers above 63999", () => {
  assert.doesNotThrow(() => basicToPrg("63999 END"));
  assert.throws(() => basicToPrg("64000 END"), /63999/);
});
