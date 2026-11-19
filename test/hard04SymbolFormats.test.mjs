import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { programRunnersModule } from "../src/tools/programRunners.js";
import { toolRegistry } from "../src/tools/registry/index.js";
import { clearViceSymbols, getViceSymbol, parseSymbolFile, parseViceSymbolFile } from "../src/tools/translation/symbolRegistry.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = (id) => ({ id, features: [], limitedFeatures: [] });

test.afterEach(() => clearViceSymbols());

test("HARD04-002 parser accepts VICE, 64tass, ACME and KickAssembler label files", () => {
  const parsed = parseSymbolFile([
    "al C:0810 .vice_main",
    "tass_main = $0820",
    "acme_main = 2096 ; decimal",
    ".namespace game {",
    ".label kick_main=$0840",
    "}",
    "garbage line",
  ].join("\n"));
  assert.equal(parsed.get("vice_main"), 0x0810);
  assert.equal(parsed.get("tass_main"), 0x0820);
  assert.equal(parsed.get("acme_main"), 2096);
  assert.equal(parsed.get("kick_main"), 0x0840);
  assert.equal(parsed.size, 4);
  assert.equal(parseViceSymbolFile("al 0810 .x").get("x"), 0x0810);
});

function withSymbolsFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h4-sym-"));
  const file = path.join(dir, "labels.sym");
  fs.writeFileSync(file, content, "utf8");
  return fn(file).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const ctxFor = (id) => ({
  client: {
    async runPrgFile() { return { success: true }; },
    async loadPrgFile() { return { success: true }; },
    async readMemoryRaw(_a, length) { return Uint8Array.from({ length }, (_v, i) => (i === 0 ? 0xea : 0xea)); },
  },
  logger,
  platform: platform(id),
  setPlatform: () => platform(id),
});

test("HARD04-002 run_prg then disassemble shows the label on c64u", async () => {
  await withSymbolsFile("start = $C000\n", async (file) => {
    const ctx = ctxFor("c64u");
    const run = await programRunnersModule.invoke("run_prg", { path: "//USB0/a.prg", symbolsFile: file }, ctx);
    assert.equal(run.isError, undefined);
    assert.equal(run.metadata.symbolsLoaded, 1);
    assert.equal(getViceSymbol(0xc000), "start");
    const dis = await toolRegistry.invoke("c64_memory", { op: "disassemble", address: "$C000", instructionCount: 2 }, ctx);
    assert.equal(dis.isError, undefined, JSON.stringify(dis.content));
    assert.ok(dis.content.map((c) => c.text ?? "").join("\n").includes("start"));
  });
});

test("HARD04-002 load_prg honours symbolsFile", async () => {
  await withSymbolsFile(".label loader=$0900\n", async (file) => {
    const res = await programRunnersModule.invoke("load_prg", { path: "//USB0/a.prg", symbolsFile: file }, ctxFor("c64u"));
    assert.equal(res.isError, undefined);
    assert.equal(res.metadata.symbolsLoaded, 1);
    assert.equal(getViceSymbol(0x0900), "loader");
  });
});

test("HARD04-002 a symbols file without labels reports symbolsLoaded 0 and a warning", async () => {
  await withSymbolsFile("nothing useful here\n", async (file) => {
    const res = await programRunnersModule.invoke("run_prg", { path: "//USB0/a.prg", symbolsFile: file }, ctxFor("c64u"));
    assert.equal(res.isError, undefined);
    assert.equal(res.metadata.symbolsLoaded, 0);
    assert.equal(res.structuredContent.data.symbolsLoaded, 0);
    assert.match(res.structuredContent.data.warnings[0], /64tass/);
  });
});
