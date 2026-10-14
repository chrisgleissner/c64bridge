import test from "#test/runner";
import assert from "#test/assert";
import { debugModuleGroup } from "../src/tools/debug.js";
import { metaModule } from "../src/tools/meta/index.js";
import { createLogger, tmpPath } from "./meta/helpers.mjs";

// Strings that Number.parseInt would partially accept ("$08G0" -> $0008,
// "$20ZZ" -> $0020) or misread ("0XC000" -> 0 when the 0x check is case-sensitive).
const MALFORMED = ["$08G0", "$20ZZ", "0x12G4", "12ab", "1e3", "$", "0x", "$-10", "+100", "0x 10", "$1_000"];
const WELL_FORMED = [
  ["$C000", 0xC000],
  ["$c000", 0xC000],
  ["0xC000", 0xC000],
  ["0XC000", 0xC000],
  ["49152", 0xC000],
  ["  $0801  ", 0x0801],
];

function createViceCtx(calls) {
  const stub = { debug() {}, info() {}, warn() {}, error() {} };
  return {
    client: {
      async viceCheckpointCreate(options) {
        calls.push(options);
        return {
          id: 1, hit: false, start: options.start, end: options.end ?? options.start, stopOnHit: true, enabled: true,
          temporary: false, operations: { execute: true, load: false, store: false }, hitCount: 0, ignoreCount: 0,
          hasCondition: false, memspace: 0,
        };
      },
    },
    rag: {},
    logger: stub,
    platform: { id: "vice", features: [], limitedFeatures: [] },
    setPlatform() { return { id: "vice", features: [], limitedFeatures: [] }; },
  };
}

test("c64_debug create_checkpoint rejects malformed addresses and accepts $, 0x/0X and decimal", async () => {
  for (const address of MALFORMED) {
    const calls = [];
    const result = await debugModuleGroup.invoke("c64_debug", { op: "create_checkpoint", address }, createViceCtx(calls));
    assert.equal(result.isError, true, `address ${JSON.stringify(address)} should be rejected`);
    assert.equal(calls.length, 0, `address ${JSON.stringify(address)} must not reach VICE`);
  }
  for (const [address, expected] of WELL_FORMED) {
    const calls = [];
    const result = await debugModuleGroup.invoke("c64_debug", { op: "create_checkpoint", address }, createViceCtx(calls));
    assert.equal(result.isError, undefined, `address ${JSON.stringify(address)} should be accepted`);
    assert.equal(calls[0].start, expected);
  }
});

function createReadCtx(reads) {
  return {
    platform: { id: "vice" },
    client: {
      async readMemory(address, length) {
        reads.push(address);
        return { success: true, data: `$${"00".repeat(Number(length))}` };
      },
    },
    logger: createLogger(),
  };
}

test("extract_sprites_from_ram rejects malformed addresses and accepts $, 0x/0X and decimal", async () => {
  for (const address of MALFORMED) {
    const reads = [];
    const result = await metaModule.invoke("extract_sprites_from_ram", { address, length: 64 }, createReadCtx(reads));
    assert.equal(result.isError, true, `address ${JSON.stringify(address)} should be rejected`);
    assert.equal(reads.length, 0, `address ${JSON.stringify(address)} must not be read`);
  }
  for (const [address, expected] of WELL_FORMED) {
    const reads = [];
    await metaModule.invoke("extract_sprites_from_ram", { address, length: 64, includeBase64: false }, createReadCtx(reads));
    assert.equal(reads[0], `$${expected.toString(16).toUpperCase().padStart(4, "0")}`, `address ${JSON.stringify(address)}`);
  }
});

test("rip_charset_from_ram rejects malformed addresses", async () => {
  for (const address of MALFORMED) {
    const reads = [];
    const result = await metaModule.invoke("rip_charset_from_ram", { address }, createReadCtx(reads));
    assert.equal(result.isError, true, `address ${JSON.stringify(address)} should be rejected`);
    assert.equal(reads.length, 0, `address ${JSON.stringify(address)} must not be read`);
  }
  const reads = [];
  await metaModule.invoke("rip_charset_from_ram", { address: "0X3000" }, createReadCtx(reads));
  assert.equal(reads[0], "$3000");
});

test("memory_dump_to_file rejects malformed addresses and accepts $, 0x/0X and decimal", async () => {
  const { file } = tmpPath("address-parsing", "dump.bin");
  for (const address of MALFORMED) {
    const reads = [];
    const result = await metaModule.invoke("memory_dump_to_file", { address, length: 4, outputPath: file, format: "binary" }, createReadCtx(reads));
    assert.equal(result.isError, true, `address ${JSON.stringify(address)} should be rejected`);
    assert.equal(reads.length, 0, `address ${JSON.stringify(address)} must not be read`);
  }
  for (const [address, expected] of WELL_FORMED) {
    const reads = [];
    const result = await metaModule.invoke("memory_dump_to_file", { address, length: 4, outputPath: file, format: "binary" }, createReadCtx(reads));
    assert.equal(result.isError, undefined, `address ${JSON.stringify(address)} should be accepted`);
    assert.equal(reads[0], `$${expected.toString(16).toUpperCase().padStart(4, "0")}`, `address ${JSON.stringify(address)}`);
  }
});
