import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Jimp } from "jimp";
import {
  buildVicBitmapRegisters,
  convertRgbaToVicBitmap,
  importImageAsVicBitmap,
  resolveVicBitmapMemoryLayout,
} from "../src/vicBitmap.js";

function rgbaImage(width, height, fill = [0, 0, 0, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    data[offset] = fill[0];
    data[offset + 1] = fill[1];
    data[offset + 2] = fill[2];
    data[offset + 3] = fill[3];
  }
  return { width, height, data };
}

function setPixel(image, x, y, rgba) {
  const offset = ((y * image.width) + x) * 4;
  image.data[offset] = rgba[0];
  image.data[offset + 1] = rgba[1];
  image.data[offset + 2] = rgba[2];
  image.data[offset + 3] = rgba[3];
}

test("convertRgbaToVicBitmap packs hires bitmap and screen RAM", () => {
  const image = rgbaImage(320, 200, [0, 0, 0, 255]);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      setPixel(image, x, y, [0x81, 0x33, 0x38, 0xFF]);
    }
    for (let x = 4; x < 8; x += 1) {
      setPixel(image, x, y, [0x2E, 0x2C, 0x9B, 0xFF]);
    }
  }

  const prepared = convertRgbaToVicBitmap(image, { mode: "hires", backgroundColor: 0, borderColor: 6 });

  assert.equal(prepared.mode, "hires");
  assert.equal(prepared.bitmapData.length, 8000);
  assert.equal(prepared.screenRam.length, 1000);
  assert.equal(prepared.colorRam.length, 1000);
  assert.equal(prepared.screenRam[0], 0x62);
  assert.deepEqual(Array.from(prepared.bitmapData.slice(0, 8)), Array(8).fill(0x0F));
});

test("convertRgbaToVicBitmap packs multicolor bitmap bytes and color RAM", () => {
  const image = rgbaImage(160, 200, [0, 0, 0, 255]);
  for (let y = 0; y < 8; y += 1) {
    setPixel(image, 0, y, [0x00, 0x00, 0x00, 0xFF]);
    setPixel(image, 1, y, [0x81, 0x33, 0x38, 0xFF]);
    setPixel(image, 2, y, [0x2E, 0x2C, 0x9B, 0xFF]);
    setPixel(image, 3, y, [0xFF, 0xFF, 0xFF, 0xFF]);
  }

  const prepared = convertRgbaToVicBitmap(image, { mode: "multicolor", backgroundColor: 0, borderColor: 3 });

  assert.equal(prepared.mode, "multicolor");
  assert.equal(prepared.bitmapData.length, 8000);
  assert.equal(prepared.screenRam[0], 0x12);
  assert.equal(prepared.colorRam[0], 0x06);
  assert.deepEqual(Array.from(prepared.bitmapData.slice(0, 8)), Array(8).fill(0x2D));
});

test("resolveVicBitmapMemoryLayout validates bank alignment and computes D018", () => {
  const layout = resolveVicBitmapMemoryLayout(0x2000, 0x0400);
  assert.equal(layout.bank, 0);
  assert.equal(layout.bankBase, 0x0000);
  assert.equal(layout.d018, 0x18);

  const registers = buildVicBitmapRegisters(layout, {
    mode: "multicolor",
    backgroundColor: 0,
    borderColor: 6,
    currentDd00: 0xFC,
  });
  assert.equal(registers.dd00, 0xFF);
  assert.equal(registers.d011, 0x3B);
  assert.equal(registers.d016, 0x18);
  assert.equal(registers.d020, 6);
  assert.equal(registers.d021, 0);
});

test("resolveVicBitmapMemoryLayout rejects mismatched banks", () => {
  assert.throws(
    () => resolveVicBitmapMemoryLayout(0x2000, 0x4400),
    /same 16 KB VIC bank/,
  );
});

test("resolveVicBitmapMemoryLayout rejects screen RAM in the character ROM shadow of banks 0 and 2", () => {
  for (const screen of [0x1000, 0x1400, 0x1800, 0x1C00]) {
    assert.throws(() => resolveVicBitmapMemoryLayout(0x2000, screen), /character ROM/);
    assert.throws(() => resolveVicBitmapMemoryLayout(0xA000, screen + 0x8000), /character ROM/);
  }
});

test("resolveVicBitmapMemoryLayout rejects bitmap RAM in the character ROM shadow of banks 0 and 2", () => {
  // A bitmap at bank offset $0000 occupies $0000-$1F3F, which covers $1000-$1FFF.
  assert.throws(() => resolveVicBitmapMemoryLayout(0x0000, 0x2000), /character ROM/);
  assert.throws(() => resolveVicBitmapMemoryLayout(0x8000, 0xA000), /character ROM/);
});

test("resolveVicBitmapMemoryLayout accepts common layouts outside the character ROM shadow", () => {
  assert.equal(resolveVicBitmapMemoryLayout(0x2000, 0x0400).d018, 0x18);
  assert.equal(resolveVicBitmapMemoryLayout(0x2000, 0x0C00).d018, 0x38);
  assert.equal(resolveVicBitmapMemoryLayout(0xA000, 0x8400).d018, 0x18);
  // Banks 1 and 3 have no character ROM shadow, so offsets $0000 and $1000-$1FFF are usable.
  assert.equal(resolveVicBitmapMemoryLayout(0x6000, 0x4000).d018, 0x08);
  assert.equal(resolveVicBitmapMemoryLayout(0x6000, 0x5C00).d018, 0x78);
  assert.equal(resolveVicBitmapMemoryLayout(0x4000, 0x6000).d018, 0x80);
  assert.equal(resolveVicBitmapMemoryLayout(0xE000, 0xC000).d018, 0x08);
  assert.equal(resolveVicBitmapMemoryLayout(0xC000, 0xE000).bank, 3);
});

test("importImageAsVicBitmap reads image files and preserves source dimensions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-vicbitmap-"));
  const filePath = path.join(dir, "sample.png");
  try {
    const image = new Jimp({ width: 32, height: 16, color: 0x813338FF });
    await image.write(filePath);

    const prepared = await importImageAsVicBitmap({
      imagePath: filePath,
      mode: "hires",
      preserveAspect: true,
      backgroundColor: 0,
      borderColor: 2,
    });

    assert.equal(prepared.sourceWidth, 32);
    assert.equal(prepared.sourceHeight, 16);
    assert.equal(prepared.logicalWidth, 320);
    assert.equal(prepared.logicalHeight, 200);
    assert.equal(prepared.displayWidth, 320);
    assert.equal(prepared.displayHeight, 200);
    assert.equal(prepared.bitmapData.length, 8000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});