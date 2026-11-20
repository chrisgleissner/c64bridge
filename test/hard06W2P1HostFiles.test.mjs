import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { C64Client } from "../src/c64Client.js";
import { assemblyToPrgDetailed } from "../src/tools/translation/assembler.js";
import { programRunnersModule, assemblerHostResolvers } from "../src/tools/programRunners.js";
import { storageModule, diskImageTypeFromPath } from "../src/tools/storage.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

// Wave 2 P1: host files for run_crt and disk mount (DEVICE-6), .include/.incbin through the allowed
// host roots, assembler warnings and replaced BASIC lines in results, SID cancel in run_prg/load_prg.

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = (id) => ({ id, features: [], limitedFeatures: [] });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "h6w2p1-"));

test("DEVICE-6 run_crt with location host uploads the file to the Ultimate", async () => {
  const mock = await startMockC64Server();
  const dir = tmp();
  try {
    const crt = Buffer.concat([Buffer.from("C64 CARTRIDGE   ", "latin1"), Buffer.from([0, 1, 2, 3, 0xff])]);
    const file = path.join(dir, "game.crt");
    fs.writeFileSync(file, crt);
    const client = new C64Client(mock.baseUrl);
    const result = await programRunnersModule.invoke("run_crt", { path: file, location: "host" }, { client, logger, platform: platform("c64u") });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(result.structuredContent.data.location, "host");
    assert.match(result.content[0].text, /^CRT .* \(21 bytes uploaded from the host\) started\./);
    assert.equal(mock.state.lastCrt.name, "upload.crt");
    assert.deepEqual([...mock.state.lastCrt.crt], [...crt]);
    // Without location the path is sent to the device as before.
    const device = await programRunnersModule.invoke("run_crt", { path: "//USB0/game.crt" }, { client, logger, platform: platform("c64u") });
    assert.equal(device.structuredContent.data.location, "device");
    assert.equal(mock.state.lastCrtFile, "//USB0/game.crt");
    // A host path outside the allowed roots is rejected before anything is sent.
    const before = mock.state.crtCount;
    const denied = await programRunnersModule.invoke("run_crt", { path: "/etc/hostname", location: "host" }, { client, logger, platform: platform("c64u") });
    assert.equal(denied.isError, true);
    assert.equal(mock.state.crtCount, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("DEVICE-6 drive mount with location host uploads the image and takes the type from the extension", async () => {
  const mock = await startMockC64Server();
  const dir = tmp();
  try {
    const image = Buffer.alloc(174848, 0x01);
    const file = path.join(dir, "Demo.D64");
    fs.writeFileSync(file, image);
    const client = new C64Client(mock.baseUrl);
    const result = await storageModule.invoke("drive_mount", { drive: "a", image: file, location: "host", mode: "readonly" }, { client, logger, platform: platform("c64u") });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(mock.state.lastMountUpload.name, "upload.d64");
    assert.equal(mock.state.lastMountUpload.type, "d64");
    assert.equal(mock.state.lastMountUpload.mode, "readonly");
    assert.equal(mock.state.lastMountUpload.bytes, 174848);
    assert.match(result.content[0].text, /174848 bytes uploaded from the host/);

    const unknown = path.join(dir, "disk.img");
    fs.writeFileSync(unknown, image);
    const bad = await storageModule.invoke("drive_mount", { drive: "a", image: unknown, location: "host" }, { client, logger, platform: platform("c64u") });
    assert.equal(bad.isError, true);
    const typed = await storageModule.invoke("drive_mount", { drive: "a", image: unknown, location: "host", type: "d81" }, { client, logger, platform: platform("c64u") });
    assert.equal(typed.isError, undefined, JSON.stringify(typed.content));
    assert.equal(mock.state.lastMountUpload.name, "upload.d81");
    assert.equal(diskImageTypeFromPath("x.G71"), "g71");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

function asmClient(source) {
  const prg = assemblyToPrgDetailed(source, assemblerHostResolvers).prg;
  const load = prg.readUInt16LE(0);
  return {
    async uploadAndRunAsm() { return { success: true }; },
    async readScreen() { return "READY.\n"; },
    async readMemoryRaw(address, length) {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) out[i] = prg[2 + address + i - load] ?? 0;
      return out;
    },
  };
}

test("assembler .include and .incbin read files inside the allowed host directories", async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, "inc.asm"), "lda #$05\n");
    fs.writeFileSync(path.join(dir, "data.bin"), Buffer.from([1, 2, 3]));
    const source = `*=$C000\n.include "${path.join(dir, "inc.asm")}"\n.incbin "${path.join(dir, "data.bin")}"\nrts\n`;
    let assembled;
    const client = { ...asmClient(source), async uploadAndRunAsm(_program, result) { assembled = result; return { success: true }; } };
    const result = await programRunnersModule.invoke("upload_run_asm", { program: source }, { client, logger, platform: platform("c64u") });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.deepEqual([...assembled.prg.subarray(2)], [0xa9, 0x05, 1, 2, 3, 0x60]);

    const outside = await programRunnersModule.invoke("upload_run_asm", { program: '*=$C000\n.incbin "/etc/hostname"\n' }, { client, logger, platform: platform("c64u") });
    assert.equal(outside.isError, true);
    assert.match(JSON.stringify(outside.content), /outside the allowed directories/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("upload_run_asm reports assembler warnings in the text block and the data", async () => {
  const program = '*=$C000\n.text "abc"\nrts\n';
  const result = await programRunnersModule.invoke("upload_run_asm", { program }, { client: asmClient(program), logger, platform: platform("c64u") });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.ok(result.structuredContent.data.warnings.length > 0);
  assert.match(result.content[0].text, /Assembler warnings: /);
});

test("upload_run_basic names line numbers whose text was replaced by a later line", async () => {
  const client = { async uploadAndRunBasic() { return { success: true }; }, async readScreen() { return "READY.\n"; } };
  const result = await programRunnersModule.invoke("upload_run_basic", { program: '10 PRINT "A"\n20 END\n10 PRINT "B"\n' }, { client, logger, platform: platform("c64u") });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(result.structuredContent.data.replacedLines, [10]);
  assert.match(result.content[0].text, /Line number\(s\) 10 appear more than once/);
  const clean = await programRunnersModule.invoke("upload_run_basic", { program: '10 PRINT "A"\n' }, { client, logger, platform: platform("c64u") });
  assert.equal(clean.structuredContent.data.replacedLines, undefined);
});

for (const tool of ["run_prg", "load_prg"]) {
  test(`${tool} stops a running music_generate sequence`, async () => {
    const { audioModule, cancelGeneratedSidPlayback } = await import("../src/tools/audio.js");
    const state = { noteOns: 0 };
    const client = {
      sidSetVolume: async () => ({ success: true }),
      sidNoteOn: async () => { state.noteOns += 1; return { success: true }; },
      sidNoteOff: async () => ({ success: true }),
      runPrgFile: async () => ({ success: true }),
      loadPrgFile: async () => ({ success: true }),
    };
    try {
      await audioModule.invoke("music_generate", { steps: 128, tempoMs: 20 }, { client, logger });
      const deadline = Date.now() + 2000;
      while (state.noteOns === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
      assert.ok(state.noteOns > 0);
      const result = await programRunnersModule.invoke(tool, { path: "//USB0/a.prg" }, { client, logger, platform: platform("c64u") });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      await new Promise((r) => setTimeout(r, 30));
      const settled = state.noteOns;
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(state.noteOns, settled);
    } finally {
      cancelGeneratedSidPlayback();
    }
  });
}