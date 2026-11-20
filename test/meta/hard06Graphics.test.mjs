import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import { metaModule } from "../../src/tools/meta/index.js";
import { createLogger, tmpPath } from "./helpers.mjs";

function memoryCtx(memory, reads = []) {
  return {
    platform: { id: "c64u" },
    logger: createLogger(),
    client: {
      async pause() { return { success: true }; },
      async resume() { return { success: true }; },
      async readMemory(address, length) {
        const start = Number.parseInt(String(address).replace("$", ""), 16);
        const count = Number(length);
        reads.push({ start, count });
        return { success: true, data: `$${Buffer.from(memory.subarray(start, start + count)).toString("hex").toUpperCase()}` };
      },
    },
  };
}

function charsetBytes() {
  const bytes = Buffer.alloc(2048);
  for (let i = 0; i < 2048; i += 1) bytes[i] = (i * 37 + 11) & 0xff || 0x18;
  return bytes;
}

test("HARD06 META-12 sprite results are compact, carry the pointer value and warn on an unaligned start", async () => {
  const memory = Buffer.alloc(65536);
  for (let s = 0; s < 4; s += 1) for (let i = 0; i < 63; i += 1) memory[0x2000 + s * 64 + i] = ((i * 37 + s) & 0xff) || 1;
  const res = await metaModule.invoke("extract_sprites_from_ram", { address: "$2000", length: 256 }, memoryCtx(memory));
  const data = res.structuredContent.data;
  assert.equal(data.sprites.length, 4);
  assert.equal(data.sprites[1].address, "$2040");
  assert.equal(data.sprites[1].pointer, "$81");
  assert.equal(data.sprites[1].vicBank, 0);
  assert.equal(data.sprites[0].base64, undefined);
  assert.equal(data.sprites[0].rowActivations, undefined);
  assert.ok(res.content[0].text.length / 4 < 400, `response per sprite ${res.content[0].text.length / 4}`);
  const detailed = await metaModule.invoke("extract_sprites_from_ram", { address: "$2000", length: 128, includeRows: true, includeBase64: true }, memoryCtx(memory));
  assert.equal(detailed.structuredContent.data.sprites[0].rowActivations.length, 21);
  assert.ok(detailed.structuredContent.data.sprites[0].base64);
  const unaligned = await metaModule.invoke("extract_sprites_from_ram", { address: "$2010", length: 256 }, memoryCtx(memory));
  assert.match(unaligned.structuredContent.data.warnings[0], /multiple of 64/);
});

test("HARD06 META-13 the charset in use ($D018/$DD00) is checked first, including $2800 and $3800", async () => {
  const memory = Buffer.alloc(65536);
  charsetBytes().copy(memory, 0x2800);
  memory[0xd018] = 0x0a << 0; // bits 1-3 = 5 -> offset $2800; screen bits 4-7 = 0
  memory[0xdd00] = 0x03; // bits 0-1 = 3 -> VIC bank 0
  const res = await metaModule.invoke("rip_charset_from_ram", {}, memoryCtx(memory));
  const data = res.structuredContent.data;
  assert.equal(data.found, true);
  assert.equal(data.charset.address, "$2800");
  assert.deepEqual(data.activeCharset, { address: "$2800", inRom: false });
  // Without registers the common list still finds $3800.
  const other = Buffer.alloc(65536);
  charsetBytes().copy(other, 0x3800);
  const found = await metaModule.invoke("rip_charset_from_ram", {}, memoryCtx(other));
  assert.equal(found.structuredContent.data.charset.address, "$3800");
});

test("HARD06 META-13 a charset pointing at the character ROM image is reported, not scanned as RAM", async () => {
  const memory = Buffer.alloc(65536);
  memory[0xd018] = 0x04; // offset $1000
  memory[0xdd00] = 0x03; // bank 0
  const res = await metaModule.invoke("rip_charset_from_ram", {}, memoryCtx(memory));
  assert.equal(res.structuredContent.data.activeCharset.inRom, true);
  assert.equal(res.structuredContent.data.found, false);
});

test("HARD06 META-13 the full scan reads two large blocks instead of one request per 2 KB", async () => {
  const reads = [];
  await metaModule.invoke("rip_charset_from_ram", { scanRange: "full" }, memoryCtx(Buffer.alloc(65536), reads));
  assert.ok(reads.filter((r) => r.count > 1).length <= 2, JSON.stringify(reads));
});

test("HARD06 META-11 memory_dump_to_file reads the whole range in one request by default", async () => {
  const { file, dir } = tmpPath("h6mem", "dump.hex");
  await fs.mkdir(dir, { recursive: true });
  const reads = [];
  const res = await metaModule.invoke("memory_dump_to_file", { address: "$0000", length: 65536, outputPath: file }, memoryCtx(Buffer.alloc(65536), reads));
  assert.equal(res.metadata?.success, true, JSON.stringify(res.content));
  assert.equal(reads.length, 1);
});
