import test from "#test/runner";
import assert from "#test/assert";
import { programRunnersModule } from "../src/tools/programRunners.js";
import { assemblyToPrg } from "../src/tools/translation/assembler.js";
import { clearViceSymbols } from "../src/tools/translation/symbolRegistry.js";

// HARD05-007: every label name is an own property of the symbols result.

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test.afterEach(() => clearViceSymbols());

// Short execution polling keeps the test fast.
const POLL = { C64BRIDGE_POLL_MAX_MS: "100", C64BRIDGE_POLL_INTERVAL_MS: "20", C64BRIDGE_POLL_STABILIZE_MS: "0" };

test("a label named __proto__ appears in the symbols of upload_run_asm", async () => {
  const source = "* = $c000\n__proto__: rts\nconstructor: rts\nhasOwnProperty: rts\n";
  const body = assemblyToPrg(source).subarray(2);
  const platform = { id: "c64u", features: [], limitedFeatures: [] };
  const ctx = {
    client: {
      async uploadAndRunAsm() { return { success: true }; },
      async readMemoryRaw(address, length) { return address === 0xc000 ? Uint8Array.from(body.subarray(0, length)) : new Uint8Array(length); },
      async readScreen() { return "READY.\n"; },
      async readMemory(address, length) { return { success: true, data: `$${"00".repeat(Number(length))}` }; },
    },
    logger,
    platform,
    setPlatform: () => platform,
  };
  const previous = Object.fromEntries(Object.keys(POLL).map((key) => [key, process.env[key]]));
  Object.assign(process.env, POLL);
  let result;
  try {
    result = await programRunnersModule.invoke("upload_run_asm", { program: source }, ctx);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  const symbols = result.structuredContent.data.symbols;
  assert.deepEqual(Object.keys(symbols), ["__proto__", "constructor", "hasOwnProperty"]);
  assert.equal(Object.getOwnPropertyDescriptor(symbols, "__proto__").value, "$C000");
  assert.equal(Object.getPrototypeOf(symbols), Object.prototype, "the prototype is untouched");
});
