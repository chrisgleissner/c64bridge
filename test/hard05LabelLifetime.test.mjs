import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// Review correction: the meta runners and the VICE restart start programs too.
function withProgramRunners(ctx) {
  const programPath = "/Usb0/game.prg";
  Object.assign(ctx.client, {
    async filesInfo() { return { files: { path: programPath, filename: "game.prg", size: 100, extension: "prg" }, errors: [] }; },
    async runPrgFile() { return { success: true }; },
    async viceNuclearReset() { return { success: true }; },
  });
  return programPath;
}

const outputDirs = [];
const outputDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hard05-labels-")); outputDirs.push(dir); return dir; };
test.after(() => { for (const dir of outputDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const metaCases = [
  ["find_and_run", "c64_disk", () => ({ op: "find_and_run", root: "/Usb0", nameContains: "game" })],
  ["shuffle", "c64_config", () => ({ op: "shuffle", root: "/Usb0", durationMs: 1, maxPrograms: 1, resetDelayMs: 0, outputPath: outputDir() })],
  ["batch_run", "c64_program", (programPath) => ({ op: "batch_run", programs: [{ path: programPath }], durationMs: 1, resetDelayMs: 0, outputPath: outputDir() })],
  ["nuclear_reset", "c64_debug", () => ({ op: "nuclear_reset" })],
];

for (const [name, tool, makeArgs] of metaCases) {
  test(`labels of an earlier program are cleared by ${name}`, async () => {
    const ctx = makeContext();
    const programPath = withProgramRunners(ctx);
    if (tool === "c64_debug") {
      const vice = { id: "vice", features: [], limitedFeatures: [] };
      ctx.platform = vice;
      ctx.setPlatform = () => vice;
    }
    await registerLabels(ctx);
    const result = await toolRegistry.invoke(tool, makeArgs(programPath), ctx);
    assert.ok(!result.isError, JSON.stringify(result.content));
    assert.equal(getSymbolAddress("score"), undefined);
  });
}

test("a failed find_and_run start keeps the labels", async () => {
  const ctx = makeContext();
  withProgramRunners(ctx);
  ctx.client.runPrgFile = async () => ({ success: false, details: { reason: "refused" } });
  await registerLabels(ctx);
  const result = await toolRegistry.invoke("c64_disk", { op: "find_and_run", root: "/Usb0", nameContains: "game" }, ctx);
  assert.equal(result.isError, true);
  assert.equal(getSymbolAddress("score"), 0xc002);
});
