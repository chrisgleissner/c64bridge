import test from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import { C64Client } from "../src/c64Client.js";

process.env.C64_TEST_TARGET = "stub";

const writes = [];
let lastPrg = null;
let lastLoadedPrg = null;

const stubFacade = {
  type: "c64u",
  async ping() { return true; },
  async runPrg(prg) { lastPrg = prg; return { success: true, details: { prgLength: prg?.length ?? 0 } }; },
  async loadPrg(prg) { lastLoadedPrg = prg; return { success: true, details: { prgLength: prg?.length ?? 0 } }; },
  async loadPrgFile() { return { success: true }; },
  async runPrgFile() { return { success: true }; },
  async runCrtFile() { return { success: true }; },
  async sidplayFile() { return { success: true }; },
  async sidplayAttachment() { return { success: true }; },
  async readMemory(_address, length) { return new Uint8Array(Array.from({ length }, (_, i) => i & 0xff)); },
  async writeMemory(address, bytes) {
    const copy = bytes instanceof Uint8Array ? Uint8Array.from(bytes) : Uint8Array.from(Buffer.from(bytes));
    writes.push({ address, bytes: copy });
  },
  async reset() { return { success: true }; },
  async reboot() { return { success: true }; },
  async pause() { return { success: true }; },
  async resume() { return { success: true }; },
  async poweroff() { return { success: true }; },
  async menuButton() { return { success: true }; },
  async debugregRead() { return { success: true, value: "AB" }; },
  async debugregWrite() { return { success: true, value: "AB" }; },
  async version() { return { version: "stub" }; },
  async info() { return { product: "stub" }; },
  async drivesList() { return { drives: [{ a: { enabled: true } }] }; },
  async driveMount() { return { success: true }; },
  async driveRemove() { return { success: true }; },
  async driveReset() { return { success: true }; },
  async driveOn() { return { success: true }; },
  async driveOff() { return { success: true }; },
  async driveSetMode() { return { success: true }; },
  async driveLoadRom() { return { success: true }; },
  async streamStart() { return { success: true }; },
  async streamStop() { return { success: true }; },
  async configsList() { return { categories: ["Audio"] }; },
  async configGet() { return { audio: "stub" }; },
  async configSet() { return { success: true }; },
  async configBatchUpdate() { return { success: true }; },
  async configLoadFromFlash() { return { success: true }; },
  async configSaveToFlash() { return { success: true }; },
  async configResetToDefault() { return { success: true }; },
  async filesInfo() { return { info: { size: 1024 } }; },
  async filesCreateD64() { return { success: true }; },
  async filesCreateD71() { return { success: true }; },
  async filesCreateD81() { return { success: true }; },
  async filesCreateDnp() { return { success: true }; },
  async modplayFile() { return { success: true }; },
};

function createViceFacade(monitor) {
  return {
    type: "vice",
    async withMonitor(fn) {
      return fn(monitor);
    },
  };
}

function expectSuccess(result, message) {
  assert.ok(result && typeof result === "object", message ?? "expected object result");
  assert.equal(result.success, true, message ?? "expected success true");
}

test("C64Client MCP tool coverage", async (t) => {
  const client = new C64Client("http://stub.local");
  Reflect.set(client, "facadePromise", Promise.resolve(stubFacade));

  await t.test("program runners", async () => {
    const basicResult = await client.uploadAndRunBasic('10 PRINT "HELLO"\n20 END');
    expectSuccess(basicResult, "upload_run_basic");
    assert.ok(lastPrg instanceof Uint8Array, "PRG bytes captured");

    const asm = await client.uploadAndRunAsm("*=$0801\nBRK");
    expectSuccess(asm, "upload_run_asm");
    // HARD01-018: the assembled code must be loaded (not LOAD+RUN, which
    // would misinterpret the opcodes as BASIC text) and entered via a typed
    // SYS to the entry point rather than a bare RUN.
    assert.ok(lastLoadedPrg instanceof Uint8Array, "PRG bytes loaded without running");
    assert.equal(asm.details.entryAddress, 0x0801);
    const sysBytes = writes.find((w) => w.address === 0x0277)?.bytes;
    assert.ok(sysBytes, "SYS command written to the KERNAL keyboard buffer");
    assert.equal(Buffer.from(sysBytes).toString("ascii"), "SYS2049\r");

    expectSuccess(await client.loadPrgFile("//disk/demo.prg"), "load_prg");
    expectSuccess(await client.runPrgFile("//disk/demo.prg"), "run_prg");
    expectSuccess(await client.runCrtFile("//cart/game.crt"), "run_crt");
    expectSuccess(await client.sidplayFile("//music/song.sid", 1), "sidplay_file");
    expectSuccess(await client.modplayFile("//music/song.mod"), "modplay_file");
  });

  await t.test("printer helpers", async () => {
    expectSuccess(await client.printTextOnPrinterAndRun({ text: "HELLO" }), "print_text");
    expectSuccess(await client.printBitmapOnCommodoreAndRun({ columns: [0, 1, 2], repeats: 1, secondaryAddress: 7 }), "print_bitmap_commodore");
    expectSuccess(await client.printBitmapOnEpsonAndRun({ columns: [0, 1, 2, 3], mode: "L", repeats: 1, timesPerLine: 1 }), "print_bitmap_epson");
    expectSuccess(await client.defineCustomCharsOnCommodoreAndRun({ firstChar: 65, chars: [{ a: 1, columns: Array.from({ length: 11 }, () => 0) }], secondaryAddress: 0 }), "printer_dll");
  });

  await t.test("graphics helpers", async () => {
    const writeStart = writes.length;
    const spriteBytes = new Uint8Array(63).fill(0x11);
    expectSuccess(await client.generateAndRunSpritePrg({ spriteBytes, spriteIndex: 0, x: 100, y: 50, color: 2, multicolour: false }), "render_sprite");
    expectSuccess(await client.renderPetsciiScreenAndRun({ text: "PETSCII" }), "render_petscii_text");

    const display = await client.displayBitmap({
      mode: "hires",
      bitmapData: new Uint8Array(8000).fill(0xAA),
      screenRam: new Uint8Array(1000).fill(0x62),
      colorRam: new Uint8Array(1000).fill(0),
      sourceWidth: 320,
      sourceHeight: 200,
      logicalWidth: 320,
      logicalHeight: 200,
      displayWidth: 320,
      displayHeight: 200,
      backgroundColor: 0,
      borderColor: 6,
    }, {
      bitmapAddress: 0x2000,
      screenAddress: 0x0400,
    });
    expectSuccess(display, "render_bitmap");
    assert.equal(display.details.bank, 0);

    const displayWrites = writes.slice(writeStart);
    assert.ok(displayWrites.some((entry) => entry.address === 0x2000 && entry.bytes.length === 8000));
    assert.ok(displayWrites.some((entry) => entry.address === 0x0400 && entry.bytes.length === 1000));
    assert.ok(displayWrites.some((entry) => entry.address === 0xD800 && entry.bytes.length === 1000));
    assert.ok(displayWrites.some((entry) => entry.address === 0xDD00 && entry.bytes.length === 1));
    assert.ok(displayWrites.some((entry) => entry.address === 0xD011 && entry.bytes.length === 1));
    assert.ok(displayWrites.some((entry) => entry.address === 0xD016 && entry.bytes.length === 1));
    assert.ok(displayWrites.some((entry) => entry.address === 0xD018 && entry.bytes.length === 1));
    assert.ok(displayWrites.some((entry) => entry.address === 0xD020 && entry.bytes.length === 1));
    assert.ok(displayWrites.some((entry) => entry.address === 0xD021 && entry.bytes.length === 1));

    const viceWrites = [];
    const viceBitmapClient = new C64Client("http://stub.local");
    Reflect.set(viceBitmapClient, "facadePromise", Promise.resolve({
      type: "vice",
      async readMemory() {
        return new Uint8Array([0xFF]);
      },
      async writeMemory(address, bytes) {
        viceWrites.push({ address, bytes: Uint8Array.from(bytes) });
      },
    }));

    const viceDisplay = await viceBitmapClient.displayBitmap({
      mode: "multicolor",
      bitmapData: new Uint8Array(8000).fill(0x55),
      screenRam: new Uint8Array(1000).fill(0x12),
      colorRam: new Uint8Array(1000).fill(0x06),
      sourceWidth: 160,
      sourceHeight: 200,
      logicalWidth: 160,
      logicalHeight: 200,
      displayWidth: 320,
      displayHeight: 200,
      backgroundColor: 0,
      borderColor: 3,
    }, {
      bitmapAddress: 0x2000,
      screenAddress: 0x0400,
    });
    expectSuccess(viceDisplay, "render_bitmap_vice");
    assert.equal(viceDisplay.details.registers.d016, 0x18);
    assert.ok(viceWrites.some((entry) => entry.address === 0x2000 && entry.bytes.length === 8000));
  });

  await t.test("memory access", async () => {
    const read = await client.readMemory("$0400", "4");
      expectSuccess(read, "read");
    assert.equal(read.data, "$00010203");

    const write = await client.writeMemory("$0400", "$AA55");
      expectSuccess(write, "write");
    const lastWrite = writes[writes.length - 1];
    assert.equal(lastWrite.address, 0x0400);
    assert.deepEqual(Array.from(lastWrite.bytes), [0xaa, 0x55]);
  });

  await t.test("machine controls", async () => {
    expectSuccess(await client.reset(), "reset_c64");
    expectSuccess(await client.reboot(), "reboot_c64");
    expectSuccess(await client.pause(), "pause");
    expectSuccess(await client.resume(), "resume");
    expectSuccess(await client.poweroff(), "poweroff");
    expectSuccess(await client.menuButton(), "menu_button");

    const debugRead = await client.debugregRead();
    assert.equal(debugRead.success, true);
    assert.equal(debugRead.value, "AB");

    const debugWrite = await client.debugregWrite("CD");
    assert.equal(debugWrite.success, true);
  });

  await t.test("sid helpers", async () => {
    expectSuccess(await client.sidSetVolume(12), "sid_volume");
    expectSuccess(await client.sidReset(false), "sid_reset_soft");
    expectSuccess(await client.sidReset(true), "sid_reset_hard");
    expectSuccess(await client.sidNoteOn({ voice: 1, note: "A4", waveform: "pulse" }), "sid_note_on");
    expectSuccess(await client.sidNoteOff(1), "sid_note_off");
    expectSuccess(await client.sidSilenceAll(), "sid_silence_all");
  });

  await t.test("drive + stream", async () => {
    const drives = await client.drivesList();
    assert.ok(drives);
    expectSuccess(await client.driveMount("a", "/tmp/demo.d64", { type: "d64", mode: "readwrite" }), "drive_mount");
    expectSuccess(await client.driveRemove("a"), "drive_remove");
    expectSuccess(await client.driveReset("a"), "drive_reset");
    expectSuccess(await client.driveOn("a"), "drive_on");
    expectSuccess(await client.driveOff("a"), "drive_off");
    expectSuccess(await client.driveLoadRom("a", "/roms/drive.rom"), "drive_load_rom");
    expectSuccess(await client.driveSetMode("a", "1541"), "drive_mode");
    expectSuccess(await client.streamStart("video", "127.0.0.1:11000"), "stream_start");
    expectSuccess(await client.streamStop("video"), "stream_stop");
  });

  await t.test("config endpoints", async () => {
    const categories = await client.configsList();
    assert.deepEqual(categories, { categories: ["Audio"] });
    const cat = await client.configGet("Audio", "Volume");
    assert.ok(cat);
    expectSuccess(await client.configSet("Audio", "Volume", "10"), "config_set");
    expectSuccess(await client.configBatchUpdate({ Audio: { Volume: "10" } }), "config_batch_update");
    expectSuccess(await client.configLoadFromFlash(), "config_load_from_flash");
    expectSuccess(await client.configSaveToFlash(), "config_save_to_flash");
    expectSuccess(await client.configResetToDefault(), "config_reset_to_default");
  });

  await t.test("file helpers", async () => {
    const info = await client.filesInfo("/tmp/file" );
    assert.deepEqual(info, { info: { size: 1024 } });
    expectSuccess(await client.filesCreateD64("/tmp/disk.d64", { tracks: 35, diskname: "DEMO" }), "create_d64");
    expectSuccess(await client.filesCreateD71("/tmp/disk.d71", { diskname: "DEMO" }), "create_d71");
    expectSuccess(await client.filesCreateD81("/tmp/disk.d81", { diskname: "DEMO" }), "create_d81");
    expectSuccess(await client.filesCreateDnp("/tmp/disk.dnp", 10, { diskname: "DEMO" }), "create_dnp");
  });

  await t.test("vice monitor wrappers", async () => {
    const monitorCalls = [];
    const monitor = {
      async checkpointList() { monitorCalls.push("list"); return [{ id: 1 }]; },
      async checkpointGet(id) { monitorCalls.push(["get", id]); return { id }; },
      async checkpointCreate(payload) { monitorCalls.push(["create", payload]); return { id: 7, ...payload }; },
      async checkpointDelete(id) { monitorCalls.push(["delete", id]); },
      async checkpointToggle(id, enabled) { monitorCalls.push(["toggle", id, enabled]); },
      async checkpointSetCondition(id, expression) { monitorCalls.push(["condition", id, expression]); },
      async registersAvailable(memspace) { monitorCalls.push(["registersAvailable", memspace]); return [{ id: 0, name: "PC", bits: 16, size: 2 }]; },
      async registersGet(memspace) { monitorCalls.push(["registersGet", memspace]); return [{ id: 0, size: 2, value: 0x0801 }]; },
      async registersSet(writesArg, optionsArg) { monitorCalls.push(["registersSet", writesArg, optionsArg]); return [{ id: 0, size: 2, value: 0x0802 }]; },
      async stepInstructions(count, optionsArg) { monitorCalls.push(["stepInstructions", count, optionsArg]); },
      async stepReturn() { monitorCalls.push("stepReturn"); },
      async displayGet(optionsArg) {
        monitorCalls.push(["displayGet", optionsArg]);
        const debugWidth = 6;
        const debugHeight = 4;
        const pixels = Uint8Array.from([
          0, 0, 14, 14, 14, 0,
          0, 14, 11, 12, 13, 14,
          0, 14, 21, 22, 23, 14,
          0, 0, 14, 14, 14, 0,
        ]);
        return {
          debugWidth,
          debugHeight,
          offsetX: 1,
          offsetY: 1,
          innerWidth: 3,
          innerHeight: 2,
          bitsPerPixel: 8,
          pixels,
        };
      },
      async resourceGet(name) { monitorCalls.push(["resourceGet", name]); return { type: "string", value: "demo" }; },
      async resourceSet(name, value) { monitorCalls.push(["resourceSet", name, value]); },
    };

    const viceClient = new C64Client("http://stub.local");
    Reflect.set(viceClient, "facadePromise", Promise.resolve(createViceFacade(monitor)));

    assert.deepEqual(await viceClient.viceCheckpointList(), [{ id: 1 }]);
    assert.deepEqual(await viceClient.viceCheckpointGet(3), { id: 3 });
    assert.equal((await viceClient.viceCheckpointCreate({ start: 0x1000, end: 0x1001, memspace: 9 })).id, 7);
    await viceClient.viceCheckpointDelete(7);
    await viceClient.viceCheckpointToggle(7, false);
    await viceClient.viceCheckpointSetCondition(7, "A == 1");
    assert.equal((await viceClient.viceRegistersAvailable(9))[0].name, "PC");
    assert.equal((await viceClient.viceRegistersGet(4))[0].value, 0x0801);
    assert.equal((await viceClient.viceRegistersSet([{ id: 0, value: 0x0802 }], { memspace: 9, metadata: [{ id: 0, name: "PC", bits: 16, size: 2 }] }))[0].value, 0x0802);
    await viceClient.viceStepInstructions(2, { stepOver: true });
    await viceClient.viceStepReturn();
    const capture = await viceClient.captureFrames({ count: 2 });
    assert.equal(capture.frames.length, 2);
    assert.equal(capture.frames[0].width, 5);
    assert.equal(capture.frames[0].height, 4);
    assert.deepEqual(Array.from(capture.frames[0].pixels), [
      0, 14, 14, 14, 0,
      14, 11, 12, 13, 14,
      14, 21, 22, 23, 14,
      0, 14, 14, 14, 0,
    ]);
    assert.deepEqual(await viceClient.viceResourceGet("Drive8Image"), { type: "string", value: "demo" });
    await viceClient.viceResourceSet("Drive8Image", "demo.d64");

    assert.ok(monitorCalls.some((entry) => Array.isArray(entry) && entry[0] === "registersAvailable" && entry[1] === 0));
    assert.ok(monitorCalls.some((entry) => Array.isArray(entry) && entry[0] === "registersSet" && entry[2].memspace === 0));
  });

  await t.test("vice wrappers reject on c64u facade", async () => {
    await assert.rejects(() => client.viceCheckpointList(), /VICE-specific operation requested/);
  });

  await t.test("mock REST fallback helpers and metadata endpoints", async () => {
    const previousTarget = process.env.C64_TEST_TARGET;
    process.env.C64_TEST_TARGET = "mock";
    try {
      const mockClient = new C64Client("http://stub.local");
      Reflect.set(mockClient, "facadePromise", Promise.resolve({
        ...stubFacade,
        async readMemory() {
          const error = new Error("unsupported");
          error.code = "UNSUPPORTED";
          throw error;
        },
        async writeMemory() {
          const error = new Error("unsupported");
          error.code = "UNSUPPORTED";
          throw error;
        },
      }));
      Reflect.set(mockClient, "api", {
        v1: {
          machineReadmemList: async (_op, _query, options) => {
            if (String(options.headers.Accept).includes("application/json")) {
              return {
                headers: { "content-type": "application/json" },
                data: Buffer.from(JSON.stringify({ data: Buffer.from([0xaa, 0xbb]).toString("base64") })),
              };
            }
            return { headers: { "content-type": "application/octet-stream" }, data: Uint8Array.from([1, 2, 3, 4]).buffer };
          },
          machineWritememUpdate: async () => ({ data: { updated: true } }),
          machineWritememCreate: async () => ({ data: { created: true } }),
          versionList: async () => ({ data: { version: "1.2.3" } }),
          infoList: async () => ({ data: { product: "ultimate" } }),
          machinePauseUpdate: async () => ({ data: { paused: true } }),
          machineResumeUpdate: async () => ({ data: { resumed: true } }),
          machineMenuButtonUpdate: async () => ({ data: { toggled: true } }),
          machineDebugregList: async () => ({ data: { value: "EF" } }),
          machineDebugregUpdate: async () => ({ data: { value: "CD" } }),
          runnersRunPrgCreate: async () => ({ data: { uploaded: true } }),
        },
      });

      const raw = await mockClient.readMemoryRaw(0x0400, 2);
      assert.deepEqual(Array.from(raw), [170, 187]);

      const smallWrite = await mockClient.writeMemory("$0400", "$AABB");
      expectSuccess(smallWrite, "mock write small");
      const largeWrite = await mockClient.writeMemory("$0400", `$${"AA".repeat(129)}`);
      expectSuccess(largeWrite, "mock write large");

      assert.deepEqual(await mockClient.version(), { version: "stub" });
      assert.deepEqual(await mockClient.info(), { product: "stub" });
      assert.equal((await mockClient.pause()).success, true);
      assert.equal((await mockClient.resume()).success, true);
      assert.equal((await mockClient.menuButton()).success, true);
      assert.equal((await mockClient.debugregRead()).value, "EF");
      assert.equal((await mockClient.debugregWrite("CD")).value, "CD");
      assert.equal((await mockClient.runPrg(Uint8Array.from([1, 2, 3]))).success, true);
    } finally {
      process.env.C64_TEST_TARGET = previousTarget;
    }
  });

  await t.test("client helper validation and error normalization", async () => {
    assert.equal((await client.modplayFile("//music/song.mod")).success, true);
    assert.equal((await client.sidNoteOn({ voice: 4, frequencyHz: 440 })).success, false);
    assert.equal((await client.sidNoteOff(4)).success, false);
    assert.equal((await client.readMemory("$0400", "0")).success, false);
    assert.equal((await client.writeMemory("$0400", "   ")).success, false);
  });
});
