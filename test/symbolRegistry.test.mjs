import test from "#test/runner";
import assert from "#test/assert";
import { clearViceSymbols, getViceSymbol, getViceSymbols, parseViceSymbolFile, setViceSymbols } from "../src/tools/translation/symbolRegistry.js";

test.afterEach(() => {
  clearViceSymbols();
});

test("parseViceSymbolFile accepts bare, $-prefixed, and 0x-prefixed addresses", () => {
  const symbols = parseViceSymbolFile([
    "add_label 0810 .main",
    "add_label $0811 .next",
    "add_label 0x0812 .prefixed",
    "al C:0813 .banked",
  ].join("\n"));

  assert.equal(symbols.get("main"), 0x0810);
  assert.equal(symbols.get("next"), 0x0811);
  assert.equal(symbols.get("prefixed"), 0x0812);
  assert.equal(symbols.get("banked"), 0x0813);
});

test("setViceSymbols clears old mappings before loading new ones", () => {
  setViceSymbols([["start", 0x0801]]);
  assert.equal(getViceSymbol(0x0801), "start");

  setViceSymbols([["next", 0x0810]]);

  assert.equal(getViceSymbol(0x0801), undefined);
  assert.equal(getViceSymbol(0x0810), "next");
  assert.equal(getViceSymbols().size, 1);
});

test("parseViceSymbolFile ignores comments, malformed rows, and out-of-range addresses", () => {
  const symbols = parseViceSymbolFile([
    "",
    "; comment",
    "# comment",
    "garbage row",
    "add_label 10000 .too_high",
    "add_label 0810 .valid",
  ].join("\n"));

  assert.equal(symbols.size, 1);
  assert.equal(symbols.get("valid"), 0x0810);
  assert.equal(symbols.get("too_high"), undefined);
});

test("clearViceSymbols empties the shared registry", () => {
  setViceSymbols([
    ["start", 0x0801],
    ["ignored_negative", -1],
  ]);
  assert.equal(getViceSymbols().size, 1);

  clearViceSymbols();

  assert.equal(getViceSymbols().size, 0);
  assert.equal(getViceSymbol(0x0801), undefined);
});