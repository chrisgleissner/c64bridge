import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { metaModule } from "../src/tools/meta/index.js";
import { toolRegistry } from "../src/tools/registry/index.js";
import { programRunnersModule } from "../src/tools/programRunners.js";
import { ViceBackend } from "../src/device.js";

// Locations outside the default roots (working directory, ~/.c64bridge, temp directory).
// Each case must be rejected before anything is created, so the directory must not exist afterwards.
function outsideTarget(name) {
  const dir = path.join("/dev/shm", `c64bridge-h2-outside-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return { dir, file: path.join(dir, name) };
}

function createLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function assertRejectedWithRoots(res, outside) {
  assert.equal(res.isError, true, JSON.stringify(res.content));
  const text = res.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /outside the allowed directories/);
  assert.ok(text.includes(outside.file) || text.includes(outside.dir), text);
  assert.ok(text.includes(process.cwd()), "message lists the working directory root");
  assert.ok(text.includes("C64BRIDGE_ALLOWED_DIRS"));
  assert.equal(fs.existsSync(outside.dir), false, "nothing was created outside the roots");
}

const hex = (bytes) => `$${Buffer.from(bytes).toString("hex").toUpperCase()}`;

test("save_memory rejects a file path outside the roots", async () => {
  const outside = outsideTarget("dump.bin");
  const ctx = { client: { async readMemoryRaw() { return Uint8Array.of(1, 2, 3); } }, logger: createLogger() };
  const res = await toolRegistry.invoke("c64_memory", { op: "save_memory", startAddress: "$2000", endAddress: "$2002", filePath: outside.file, asPrg: false }, ctx);
  assertRejectedWithRoots(res, outside);
});

test("memory_dump_to_file rejects an output path outside the roots", async () => {
  const outside = outsideTarget("dump.hex");
  let reads = 0;
  const ctx = { platform: { id: "c64u" }, client: { async readMemory() { reads += 1; return { success: true, data: "$AABB" }; } }, logger: createLogger() };
  const res = await metaModule.invoke("memory_dump_to_file", { address: "$C000", length: 2, outputPath: outside.file, pauseDuringRead: false }, ctx);
  assertRejectedWithRoots(res, outside);
  assert.equal(reads, 0);
});

test("config_snapshot_and_restore rejects paths outside the roots for snapshot, restore and diff", async () => {
  for (const action of ["snapshot", "restore", "diff"]) {
    const outside = outsideTarget("snapshot.json");
    let touched = false;
    const ctx = {
      platform: { id: "c64u" },
      client: {
        async version() { touched = true; return {}; },
        async info() { return {}; },
        async configsList() { return { categories: [] }; },
        async configGet() { return {}; },
        async configBatchUpdate() { touched = true; return { success: true }; },
      },
      logger: createLogger(),
    };
    const res = await metaModule.invoke("config_snapshot_and_restore", { action, path: outside.file }, ctx);
    assertRejectedWithRoots(res, outside);
    assert.equal(touched, false, action);
  }
});

test("config restore reads a readable file outside the roots only after rejection (existing file stays unread)", async () => {
  const dir = fs.mkdtempSync(path.join("/dev/shm", "c64bridge-h2-cfg-"));
  const file = path.join(dir, "snapshot.json");
  fs.writeFileSync(file, JSON.stringify({ categories: { Audio: { Volume: "1" } } }));
  try {
    let updated = false;
    const ctx = { platform: { id: "c64u" }, client: { async configBatchUpdate() { updated = true; return { success: true }; } }, logger: createLogger() };
    const res = await metaModule.invoke("config_snapshot_and_restore", { action: "restore", path: file }, ctx);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /outside the allowed directories/);
    assert.equal(updated, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function spriteHex() {
  const bytes = new Uint8Array(64);
  for (let y = 0; y < 21; y += 1) {
    for (let x = 0; x < 24; x += 1) {
      if (x === y) bytes[(y * 3) + Math.floor(x / 8)] |= (1 << (7 - (x % 8)));
    }
  }
  return hex(bytes);
}

test("graphics exports reject output paths outside the roots", async () => {
  const sprites = outsideTarget("sprites");
  const spriteCtx = {
    platform: { id: "c64u" },
    client: {
      async pause() { return { success: true }; },
      async resume() { return { success: true }; },
      async readMemory() { return { success: true, data: spriteHex() }; },
    },
    logger: createLogger(),
  };
  const spriteRes = await metaModule.invoke("extract_sprites_from_ram", { address: "$2000", length: 64, stride: 64, maxSprites: 1, outputDir: sprites.dir }, spriteCtx);
  assertRejectedWithRoots(spriteRes, sprites);

  const charset = outsideTarget("charset.bin");
  const data = new Uint8Array(2048);
  for (let i = 0; i < 128; i += 1) {
    const o = i * 8;
    data.set([i % 256, (i * 2) % 256, (i * 3) % 256, 0xFF, (i * 4) % 256, (i * 5) % 256, (i * 6) % 256, 0], o);
  }
  const charCtx = {
    platform: { id: "c64u" },
    client: {
      async pause() { return { success: true }; },
      async resume() { return { success: true }; },
      async readMemory() { return { success: true, data: hex(data) }; },
    },
    logger: createLogger(),
  };
  const charRes = await metaModule.invoke("rip_charset_from_ram", { address: "$3000", outputPath: charset.file }, charCtx);
  assertRejectedWithRoots(charRes, charset);
});

test("bundle_run_artifacts rejects an output path outside the roots", async () => {
  const outside = outsideTarget("bundle");
  const ctx = { platform: { id: "c64u" }, client: { async readScreen() { return "X"; } }, logger: createLogger() };
  const res = await metaModule.invoke("bundle_run_artifacts", { runId: "r1", outputPath: outside.dir, captureDebugReg: false }, ctx);
  assertRejectedWithRoots(res, outside);
});

test("program and compilation workflows reject output paths outside the roots", async () => {
  const client = {
    async filesInfo() { return ["/USB0/a.prg"]; },
    async runPrgFile() { return { success: true }; },
    async readScreen() { return "READY."; },
    async reset() { return { success: true }; },
    async uploadAndRunBasic() { return { success: true }; },
    getAvailableBackends() { return ["c64u"]; },
  };
  const ctx = { platform: { id: "c64u" }, client, logger: createLogger() };

  const shuffle = outsideTarget("shuffle");
  assertRejectedWithRoots(await metaModule.invoke("program_shuffle", { root: "/USB0", durationMs: 1, resetDelayMs: 0, outputPath: shuffle.dir }, ctx), shuffle);

  const batch = outsideTarget("batch");
  assertRejectedWithRoots(await metaModule.invoke("batch_run_with_assertions", { programs: [{ path: "/USB0/a.prg" }], durationMs: 1, resetDelayMs: 0, outputPath: batch.dir }, ctx), batch);

  const greeting = outsideTarget("greeting");
  assertRejectedWithRoots(await metaModule.invoke("cross_platform_greeting", { platforms: ["c64u"], outputPath: greeting.dir }, ctx), greeting);

  const cycle = outsideTarget("cycle");
  assertRejectedWithRoots(await metaModule.invoke("compile_run_verify_cycle", { sourceType: "basic", source: "10 PRINT 1", durationMs: 1, outputPath: cycle.dir }, ctx), cycle);
});

test("run_prg symbolsFile outside the roots is rejected before it is read", async () => {
  const dir = fs.mkdtempSync(path.join("/dev/shm", "c64bridge-h2-sym-"));
  const symbols = path.join(dir, "sym.vs");
  fs.writeFileSync(symbols, "al C:1000 .start\n");
  let ran = false;
  try {
    const ctx = { platform: { id: "vice" }, client: { async runPrgFile() { ran = true; return { success: true }; } }, logger: createLogger() };
    const res = await programRunnersModule.invoke("run_prg", { path: "/tmp/x.prg", symbolsFile: symbols }, ctx);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /outside the allowed directories/);
    assert.ok(res.content[0].text.includes("C64BRIDGE_ALLOWED_DIRS"));
    assert.equal(ran, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("VICE runPrgFile and driveMount reject host files outside the roots", async () => {
  const dir = fs.mkdtempSync(path.join("/dev/shm", "c64bridge-h2-vice-"));
  try {
    const prg = path.join(dir, "demo.prg");
    const d64 = path.join(dir, "disk.d64");
    fs.writeFileSync(prg, Buffer.from([0x01, 0x08, 0x00, 0x00]));
    fs.writeFileSync(d64, Buffer.alloc(174848));
    const backend = new ViceBackend({ host: "127.0.0.1", port: 1 });
    await assert.rejects(() => backend.runPrgFile(prg), /outside the allowed directories/);
    await assert.rejects(() => backend.driveMount("8", d64), /outside the allowed directories/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("paths inside the temp directory are still accepted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h2-inside-"));
  try {
    const file = path.join(dir, "nested", "dump.bin");
    const ctx = { client: { async readMemoryRaw() { return Uint8Array.of(1, 2, 3); } }, logger: createLogger() };
    const res = await toolRegistry.invoke("c64_memory", { op: "save_memory", startAddress: "$2000", endAddress: "$2002", filePath: file, asPrg: false }, ctx);
    assert.equal(res.isError, undefined);
    assert.deepEqual(Array.from(fs.readFileSync(file)), [1, 2, 3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
