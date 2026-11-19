import test from "#test/runner";
import assert from "#test/assert";
import { buildPetsciiScreenBasic } from "../src/c64Client.js";
import { basicToPrg } from "../src/tools/translation/basicTokenizer.js";
import { listBasicProgram } from "../src/tools/translation/basicDetokenizer.js";

// HARD05-004: render_petscii_text text is data, never BASIC statements.

function listing(source) {
  const prg = basicToPrg(source);
  return listBasicProgram(new Uint8Array(prg.subarray(2)), prg.readUInt16LE(0)).lines;
}

// Statement text with every string literal removed.
const outsideStrings = (line) => line.replace(/"[^"]*"/g, '""');

test("a quote in the text cannot end the string and start BASIC statements", () => {
  const text = 'HI":POKE53280,2:SYS64738:REM';
  const source = buildPetsciiScreenBasic({ text });
  const lines = source.split("\n");
  assert.ok(lines.length >= 3, "clear line, print lines, wait line");
  assert.ok(source.includes("CHR$(34)"));
  for (const line of lines.slice(1, -1)) {
    assert.match(outsideStrings(line), /^\d+ PRINT (""|CHR\$\(\d+\))(;(""|CHR\$\(\d+\)))*;?$/, line);
  }
  const tokenized = listing(source);
  assert.equal(tokenized.length, lines.length);
  for (const line of tokenized.slice(1, -1)) {
    assert.equal(/SYS|POKE|REM/.test(outsideStrings(line.text)), false, line.text);
  }
});

test("line breaks print on separate lines instead of the characters backslash N", () => {
  const source = buildPetsciiScreenBasic({ text: "LINE ONE\r\nLINE TWO\n\nEND" });
  assert.equal(source.includes("\\N") || source.includes("\\n"), false);
  const lines = source.split("\n");
  assert.deepEqual(lines.slice(1, 5), ['20 PRINT "LINE ONE"', '30 PRINT "LINE TWO"', "40 PRINT", '50 PRINT "END"']);
  assert.match(lines[5], /^60 GETA\$:IFA\$=""THEN60/);
});

test("long lines are split into short BASIC lines joined with semicolons", () => {
  const source = buildPetsciiScreenBasic({ text: "ABCDEFGHIJ".repeat(20) });
  const printLines = source.split("\n").filter((line) => / PRINT "/.test(line));
  assert.ok(printLines.length > 1);
  for (const line of printLines) assert.ok(line.length <= 78, line);
  assert.ok(printLines.slice(0, -1).every((line) => line.endsWith(";")));
});
