import test from "#test/runner";
import assert from "#test/assert";
import {
  formatAddress,
  getAsmQuickReference,
  getBasicV2Spec,
  getVicIISpec,
  listMemoryMap,
  listSymbols,
  resolveAddressSymbol,
  searchAsmQuickReference,
  searchBasicV2Spec,
  searchVicIISpec,
} from "../src/knowledge.js";

test("knowledge helpers expose stable symbols and memory regions", () => {
  assert.equal(formatAddress(0x2a), "002A");
  assert.equal(resolveAddressSymbol("screen ram"), 0x0400);
  assert.equal(resolveAddressSymbol("SID"), 0xD400);
  assert.equal(resolveAddressSymbol("missing"), undefined);

  const symbols = listSymbols();
  assert.ok(symbols.length > 0);
  assert.equal(symbols[0].name, "basic");
  assert.ok(symbols.some((entry) => entry.name === "screen" && entry.hex === "$0400"));

  const memoryMap = listMemoryMap();
  assert.ok(memoryMap.length > 0);
  assert.equal(memoryMap[0].name, "zero_page");
  assert.ok(memoryMap.some((entry) => entry.name === "sid_registers"));
});

test("HARD01-032 the BASIC spec's documented SID frequency formula matches the 24-bit phase accumulator, not the old 2^16 formula", () => {
  const spec = getBasicV2Spec();
  assert.match(spec, /freq_value = round\(\(frequency_Hz.*16777216.*clock_rate\)/);
  assert.equal(spec.includes("× 65536"), false);
  assert.equal(spec.includes("x 65536"), false);
});

test("knowledge search returns BASIC, ASM, and VIC-II sections", () => {
  const basicSpec = getBasicV2Spec();
  assert.match(basicSpec, /Commodore BASIC v2/i);
  const basicResults = searchBasicV2Spec("sid sound generation");
  assert.ok(basicResults.length > 0);
  assert.match(basicResults[0].heading, /SID Sound Generation/i);
  assert.deepEqual(searchBasicV2Spec(""), []);

  const asmSpec = getAsmQuickReference();
  assert.ok(asmSpec.length > 100);
  const asmResults = searchAsmQuickReference("LDA");
  assert.ok(asmResults.length > 0);
  assert.ok(asmResults.some((entry) => /LDA/i.test(entry.content) || /LDA/i.test(entry.heading)));

  const vicSpec = getVicIISpec();
  assert.match(vicSpec, /VIC-II/i);
  const vicResults = searchVicIISpec("sprites");
  assert.ok(vicResults.length > 0);
  assert.ok(vicResults.some((entry) => /Sprite System/i.test(entry.heading)));
  assert.deepEqual(searchVicIISpec("definitely-no-match"), []);
});
