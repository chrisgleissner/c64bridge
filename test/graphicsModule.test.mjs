import test from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Jimp } from "jimp";
import { graphicsModule } from "../src/tools/graphics.js";

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

async function writeSampleImage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-graphics-"));
  const filePath = path.join(dir, "sample.png");
  const image = new Jimp({ width: 16, height: 16, color: 0x000000FF });

  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const colour = x < 8 ? 0x813338FF : 0x2E2C9BFF;
      image.setPixelColor(colour, x, y);
    }
  }

  await image.write(filePath);
  return {
    filePath,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("render_sprite accepts base64 sprite data and delegates to client", async () => {
  const sprite = Buffer.alloc(63, 0x11).toString("base64");
  const calls = [];
  const ctx = {
    client: {
      async generateAndRunSpritePrg(options) {
        calls.push(options);
        return { success: true, details: { prgBytes: 2048 } };
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke(
    "render_sprite",
    { sprite, index: 2, x: 120, y: 150, color: 5, multicolour: true },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.index, 2);
  assert.equal(result.metadata.spriteByteLength, 63);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].spriteBytes instanceof Uint8Array);
  assert.equal(calls[0].spriteBytes.length, 63);
  assert.equal(calls[0].spriteIndex, 2);
  assert.equal(calls[0].multicolour, true);
});

test("render_sprite rejects invalid sprite definition", async () => {
  const ctx = {
    client: {
      async generateAndRunSpritePrg() {
        throw new Error("should not be called");
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke("render_sprite", { sprite: "AA==" }, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.error.kind, "validation");
});

test("render_petscii_text delegates to client", async () => {
  const calls = [];
  const ctx = {
    client: {
      async renderPetsciiScreenAndRun(payload) {
        calls.push(payload);
        return { success: true, details: { lines: 3 } };
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke(
    "render_petscii_text",
    { text: "HELLO", borderColor: 4 },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.textLength, 5);
  assert.equal(result.metadata.borderColor, 4);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { text: "HELLO", borderColor: 4 });
});

test("render_petscii_art generates art and uploads program", async () => {
  const uploads = [];
  const ctx = {
    client: {
      async uploadAndRunBasic(program) {
        uploads.push(program);
        return { success: true, details: { programLength: program.length } };
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke(
    "render_petscii_art",
    { prompt: "Draw a star with PETSCII" },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.ranOnC64, true);
  assert.equal(result.metadata.dryRun, false);
  assert.equal(uploads.length, 1);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(result.structuredContent?.type, "json");
  assert.deepEqual(result.structuredContent?.data, payload);
  assert.ok(typeof payload.program === "string" && payload.program.length > 0);
  assert.equal(payload.success, true);
  assert.equal(payload.ranOnC64, true);
  assert.equal(typeof payload.bitmapHex, "string");
  assert.ok(Array.isArray(payload.rowHex));
});

test("render_petscii_art dry run skips upload", async () => {
  const ctx = {
    client: {
      async uploadAndRunBasic() {
        throw new Error("dry run should not upload");
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke(
    "render_petscii_art",
    { text: "HELLO", dryRun: true, borderColor: 3, backgroundColor: 0 },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.dryRun, true);
  assert.equal(result.metadata.ranOnC64, false);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(result.structuredContent?.type, "json");
  assert.deepEqual(result.structuredContent?.data, payload);
  assert.equal(payload.ranOnC64, false);
  assert.equal(payload.success, true);
});

test("render_sprite handles firmware failure", async () => {
  const sprite = Buffer.alloc(63, 0x11).toString("base64");
  const ctx = {
    client: {
      async generateAndRunSpritePrg() {
        return { success: false, details: { error: "sprite error" } };
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke(
    "render_sprite",
    { sprite, index: 0, x: 100, y: 100, color: 1 },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("backend reported failure"));
});

test("render_sprite reports unexpected execution errors with sprite-specific message", async () => {
  const sprite = Buffer.alloc(63, 0x11).toString("base64");
  const ctx = {
    client: {
      async generateAndRunSpritePrg() {
        throw new Error("socket hung up");
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke(
    "render_sprite",
    { sprite, index: 0, x: 100, y: 100, color: 1 },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("Unable to render sprite"));
});

test("render_petscii_text handles firmware failure", async () => {
  const ctx = {
    client: {
      async renderPetsciiScreenAndRun() {
        return { success: false, details: { error: "render error" } };
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke(
    "render_petscii_text",
    { text: "TEST" },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("backend reported failure"));
});

test("render_petscii_text reports unexpected execution errors with petscii-specific message", async () => {
  const ctx = {
    client: {
      async renderPetsciiScreenAndRun() {
        throw new Error("transport closed");
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke(
    "render_petscii_text",
    { text: "TEST" },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("Unable to render PETSCII screen"));
});

test("render_petscii_art handles upload failure", async () => {
  const ctx = {
    client: {
      async uploadAndRunBasic() {
        return { success: false, details: { error: "upload error" } };
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke(
    "render_petscii_art",
    { text: "TEST" },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("backend reported failure"));
});

test("render_petscii_art validates input requirements", async () => {
  const ctx = {
    client: {
      async uploadAndRunBasic() {
        throw new Error("should not be called");
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke("render_petscii_art", {}, ctx);

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "validation");
});

test("render_petscii_art includes preview fields and executes PRG", async () => {
  const uploads = [];
  const ctx = {
    client: {
      async uploadAndRunBasic(program) {
        uploads.push(program);
        return { success: true, details: { programLength: program.length } };
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke(
    "render_petscii_art",
    { text: "HI", borderColor: 1, backgroundColor: 0, foregroundColor: 7, dryRun: false },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  const payload = JSON.parse(result.content[0].text);
  
  // Verify PRG execution
  assert.equal(payload.success, true);
  assert.equal(payload.ranOnC64, true);
  assert.equal(uploads.length, 1);
  assert.ok(typeof payload.program === "string" && payload.program.length > 0);
  
  // Verify preview fields are present
  assert.ok(Array.isArray(payload.petsciiCodes), "petsciiCodes should be an array");
  assert.ok(payload.petsciiCodes.length > 0, "petsciiCodes should contain codes");
  assert.ok(typeof payload.bitmapHex === "string", "bitmapHex should be a string");
  assert.ok(Array.isArray(payload.rowHex), "rowHex should be an array");
  assert.ok(typeof payload.width === "number", "width should be a number");
  assert.ok(typeof payload.height === "number", "height should be a number");
  assert.ok(typeof payload.charColumns === "number", "charColumns should be a number");
  assert.ok(typeof payload.charRows === "number", "charRows should be a number");
});

test("render_sprite verifies sprite bytes, coordinates, and colour", async () => {
  const sprite = Buffer.alloc(63, 0xFF).toString("base64");
  const calls = [];
  const ctx = {
    client: {
      async generateAndRunSpritePrg(options) {
        calls.push(options);
        return { success: true, details: { prgBytes: 2048, spriteVisible: true } };
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke(
    "render_sprite",
    { sprite, index: 1, x: 100, y: 80, color: 3, multicolour: false },
    ctx,
  );

  assert.equal(result.content[0].type, "text");
  assert.equal(result.metadata.success, true);
  
  // Verify sprite bytes copied correctly
  assert.equal(result.metadata.spriteByteLength, 63);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].spriteBytes instanceof Uint8Array);
  assert.equal(calls[0].spriteBytes.length, 63);
  
  // Verify coordinates applied
  assert.equal(calls[0].x, 100);
  assert.equal(calls[0].y, 80);
  assert.equal(result.metadata.x, 100);
  assert.equal(result.metadata.y, 80);
  
  // Verify colour applied  
  assert.equal(calls[0].color, 3);
  assert.equal(result.metadata.color, 3);
  
  // Verify sprite index
  assert.equal(calls[0].spriteIndex, 1);
  assert.equal(result.metadata.index, 1);
});

test("render_bitmap imports an image and delegates to client displayBitmap", async () => {
  const { filePath, cleanup } = await writeSampleImage();
  const calls = [];
  const ctx = {
    client: {
      async displayBitmap(prepared, options) {
        calls.push({ prepared, options });
        return {
          success: true,
          details: {
            bitmapAddress: 0x2000,
            screenAddress: 0x0400,
            colorRamAddress: 0xD800,
            bank: 0,
            registerValues: {
              dd00: 0xFF,
              d011: 0x3B,
              d016: 0x08,
              d018: 0x18,
              d020: 6,
              d021: 0,
            },
          },
        };
      },
    },
    logger: createLogger(),
  };

  try {
    const result = await graphicsModule.invoke(
      "render_bitmap",
      {
        imagePath: filePath,
        format: "hires",
        bitmapAddress: "$2000",
        screenAddress: "$0400",
        backgroundColor: 0,
        borderColor: 6,
      },
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].type, "text");
    assert.equal(result.metadata.success, true);
    assert.equal(result.metadata.mode, "hires");
    assert.equal(result.metadata.bitmapAddress, 0x2000);
    assert.equal(result.metadata.screenAddress, 0x0400);
    assert.equal(result.metadata.bank, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].prepared.mode, "hires");
    assert.equal(calls[0].prepared.sourceWidth, 16);
    assert.equal(calls[0].prepared.sourceHeight, 16);
    assert.equal(calls[0].options.bitmapAddress, 0x2000);
    assert.equal(calls[0].options.screenAddress, 0x0400);
  } finally {
    cleanup();
  }
});

test("render_bitmap surfaces image import failures as execution errors", async () => {
  const ctx = {
    client: {
      async displayBitmap() {
        throw new Error("should not be called");
      },
    },
    logger: createLogger(),
  };

  const result = await graphicsModule.invoke(
    "render_bitmap",
    { imagePath: "/missing/sample.png", format: "hires" },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "execution");
});

test("render_bitmap reports a display failure with its cause", async () => {
  const { filePath, cleanup } = await writeSampleImage();
  const ctx = {
    client: { async displayBitmap() { return { success: false, details: { message: "dma refused" } }; } },
    logger: createLogger(),
  };
  try {
    const result = await graphicsModule.invoke("render_bitmap", { imagePath: filePath, format: "hires" }, ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^C64 backend reported failure while displaying bitmap image: dma refused$/);
  } finally {
    cleanup();
  }
});
