import test from "#test/runner";
import assert from "#test/assert";
import { bitmapToHexRows, bitmapToPetsciiCodes, createPetsciiArt } from "../src/petsciiArt.js";
import { findGlyphByBasicChar, getChargenGlyphs } from "../src/chargen.js";

test("bitmapToHexRows encodes binary rows into concatenated hex", () => {
  const width = 16;
  const height = 2;
  const pixels = new Uint8Array(width * height);
  // First row all white (0), second row all black (1)
  for (let x = 0; x < width; x += 1) {
    pixels[width + x] = 1;
  }
  const rows = bitmapToHexRows({ width, height, pixels });
  assert.equal(rows.length, 2);
  assert.equal(rows[0], "0000");
  assert.equal(rows[1], "ffff");
});

test("bitmapToPetsciiCodes maps an 8x8 bitmap block to the expected glyph", () => {
  const glyph = findGlyphByBasicChar("A");
  assert.ok(glyph, "Expected to find glyph for 'A'");
  const bitmap = {
    width: 8,
    height: 8,
    pixels: new Uint8Array(64),
  };

  for (let row = 0; row < 8; row += 1) {
    const byte = glyph.bitmap[row] ?? 0;
    for (let col = 0; col < 8; col += 1) {
      const bit = (byte >> (7 - col)) & 0x1;
      bitmap.pixels[row * 8 + col] = bit;
    }
  }

  const converted = bitmapToPetsciiCodes(bitmap);
  assert.equal(converted.codes.length, 1);
  assert.equal(converted.codes[0], glyph.petsciiCode);
});

test("createPetsciiArt builds BASIC program and metadata for text prompts", () => {
  const art = createPetsciiArt({ text: "HI", maxWidth: 320, maxHeight: 200, foregroundColor: 1 });
  assert.equal(art.charColumns, 2);
  assert.equal(art.charRows, 1);
  assert.deepEqual(art.petsciiCodes.slice(0, 2), [72, 73]);
  assert.ok(art.program.includes("FORY=0TO0"));
  assert.ok(art.program.includes("DATA 72,73"));
  assert.equal(art.sourceText, "HI");
});

test("createPetsciiArt recognises heart prompts via shape templates", () => {
  const art = createPetsciiArt({ prompt: "Please make a heart ASCII art" });
  assert.equal(art.usedShape, "heart");
  assert.ok(art.bitmap.width > 0);
  assert.ok(art.bitmap.height > 0);
  assert.ok(art.bitmapHex.length > 0);
});

function bitmapFromBlocks(blocks) {
  // blocks: array of 8-byte glyph bitmaps laid out left to right in one character row.
  const width = blocks.length * 8;
  const pixels = new Uint8Array(width * 8);
  blocks.forEach((rows, index) => {
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        pixels[y * width + index * 8 + x] = (rows[y] >> (7 - x)) & 1;
      }
    }
  });
  return { width, height: 8, pixels };
}

function printedScreenCodes(stream) {
  // Replay a PETSCII PRINT stream: RVS ON (18) / RVS OFF (146) toggle bit 7 of the screen code.
  const byPetscii = new Map();
  for (const glyph of getChargenGlyphs()) {
    if (glyph.screenCode < 0x80 && !byPetscii.has(glyph.petsciiCode)) byPetscii.set(glyph.petsciiCode, glyph.screenCode);
  }
  const cells = [];
  let reverse = false;
  for (const code of stream) {
    if (code === 18) reverse = true;
    else if (code === 146) reverse = false;
    else cells.push(byPetscii.get(code) | (reverse ? 0x80 : 0));
  }
  return cells;
}

test("bitmapToPetsciiCodes wraps reverse-video glyphs in RVS ON/OFF runs", () => {
  const solid = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  const blank = [0, 0, 0, 0, 0, 0, 0, 0];
  const converted = bitmapToPetsciiCodes(bitmapFromBlocks([solid, solid, blank, solid]));
  assert.deepEqual(converted.codes, [18, 32, 32, 146, 32, 18, 32, 146]);
  assert.equal(converted.glyphs.length, 4);
  assert.deepEqual(printedScreenCodes(converted.codes), converted.glyphs.map((glyph) => glyph.screenCode));
});

test("createPetsciiArt prints reverse glyphs of the heart shape in reverse video", () => {
  const art = createPetsciiArt({ prompt: "a heart" });
  assert.ok(art.petsciiCodes.includes(18), `expected RVS ON in ${art.petsciiCodes}`);
  assert.deepEqual(printedScreenCodes(art.petsciiCodes), art.glyphs.map((glyph) => glyph.screenCode));
  // The program must print the RVS codes from DATA rather than a fixed cell count per row.
  const dataValues = art.program
    .split("\n")
    .filter((line) => / DATA /.test(line))
    .flatMap((line) => line.replace(/^\d+ DATA /, "").split(",").map(Number));
  assert.deepEqual(dataValues.filter((value) => value >= 0), art.petsciiCodes);
  assert.equal(dataValues.filter((value) => value < 0).length, art.charRows);
});
