import test from "#test/runner";
import assert from "#test/assert";
import { buildCommodoreBitmapBasicProgram, buildEpsonBitmapBasicProgram } from "../src/c64Client.js";
import { basicToPrg } from "../src/tools/translation/basicTokenizer.js";

// HARD06 CLIENT-4 / MEDIA-7: a BASIC V2 string holds at most 255 characters, so a printer bitmap
// row of more columns must be kept in several strings. MEDIA-6: the Epson row is printed once per
// line unless timesPerLine says otherwise.

/** Largest string the program can build: every A$ accumulation must be split by INT(I/n) with n <= 255. */
function largestString(src, columns) {
  if (/A\$=A\$\+CHR\$\(A\)/.test(src)) return columns; // one string for the whole row
  const split = /K=INT\(I\/(\d+)\):A\$\(K\)=A\$\(K\)\+CHR\$\(A\)/.exec(src);
  assert.ok(split, src);
  return Math.min(columns, Number(split[1]));
}

function dataValues(src) {
  return src.split("\n").filter((line) => / DATA /.test(line)).flatMap((line) => line.split(" DATA ")[1].split(",").map(Number));
}

for (const [name, build] of [
  ["Commodore", (columns) => buildCommodoreBitmapBasicProgram({ columns, ensureMsb: false })],
  ["Epson", (columns) => buildEpsonBitmapBasicProgram({ columns, mode: "K" })],
]) {
  test(`${name} rows of 480 columns never build a string above 255 bytes`, () => {
    const columns = Array.from({ length: 480 }, (_, index) => index & 0x7f);
    const src = build(columns);
    assert.ok(largestString(src, columns.length) <= 255, src);
    assert.ok(src.includes("DIM A$(1)"), src);
    assert.deepEqual(dataValues(src), columns);
    assert.ok(basicToPrg(src).length > 0);
  });
}

test("the Epson row is printed once per line by default", () => {
  const src = buildEpsonBitmapBasicProgram({ columns: [1, 2, 3] });
  assert.ok(src.includes("FOR T=1 TO 1"), src);
});
