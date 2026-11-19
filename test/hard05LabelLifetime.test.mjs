import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { clearViceSymbols, getSymbolAddress, setViceSymbols } from "../src/tools/translation/symbolRegistry.js";

// HARD05-005 (D5): labels belong to one program on one backend.

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test.afterEach(() => clearViceSymbols());

function makeContext() {
  const platform = { id: "c64u", features: [], limitedFeatures: [] };
  const switched = [];
  return {
    switched,
    client: {
      async uploadAndRunBasic() { return { success: true }; },
      async runCrtFile() { return { success: true }; },
      async loadPrg() { return { success: true }; },
      async reset() { return { success: true }; },
      async reboot() { return { success: true }; },
      async powerCycle() { return { success: true }; },
      async poweroff() { return { success: true }; },
      getAvailableBackends() { return ["c64u", "vice"]; },
      switchBackend(backend) { switched.push(backend); },
      async readMemoryRaw(address, length) { return new Uint8Array(length); },
      async loadPrgFile() { return { success: true }; },
      async readScreen() { return "READY.\n"; },
      async readMemory(address, length) { return { success: true, data: `$${"00".repeat(Number(length))}` }; },
    },
    logger,
    rag: {},
    platform,
    setPlatform: () => platform,
  };
}

// The state upload_run_asm leaves behind (its own test covers the registration).
async function registerLabels() {
  setViceSymbols([["start", 0xc000], ["score", 0xc002]]);
  assert.equal(getSymbolAddress("score"), 0xc002);
}

const cases = [
  ["upload_run_basic", "c64_program", { op: "upload_run_basic", program: '10 PRINT "NEW PROGRAM"', verify: false }],
  ["run_crt", "c64_program", { op: "run_crt", path: "/Usb0/game.crt" }],
  ["reset", "c64_system", { op: "reset" }],
  ["reboot", "c64_system", { op: "reboot" }],
  ["power_cycle", "c64_system", { op: "power_cycle" }],
  ["backend switch", "c64_select_backend", { op: "select", backend: "vice" }],
];

for (const [name, tool, args] of cases) {
  test(`labels of an earlier program are cleared by ${name}`, async () => {
    const ctx = makeContext();
    await registerLabels(ctx);
    const result = await toolRegistry.invoke(tool, args, ctx);
    assert.ok(!result.isError, JSON.stringify(result.content));
    assert.equal(getSymbolAddress("score"), undefined);
    const read = await toolRegistry.invoke("c64_memory", { op: "read", address: "score", length: 1 }, ctx);
    assert.equal(read.isError, true, "a stale label must not resolve to the old address");
  });
}

test("load_prg keeps the labels of the running program", async () => {
  const ctx = makeContext();
  await registerLabels(ctx);
  const result = await toolRegistry.invoke("c64_program", { op: "load_prg", path: "/Usb0/data.prg" }, ctx);
  assert.ok(!result.isError, JSON.stringify(result.content));
  assert.equal(getSymbolAddress("score"), 0xc002);
});
