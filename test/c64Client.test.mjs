import test from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { C64Client } from "../src/c64Client.js";
import {
  buildPrinterBasicProgram,
  buildCommodoreBitmapBasicProgram,
  buildEpsonBitmapBasicProgram,
  buildCommodoreDllBasicProgram,
} from "../src/c64Client.js";
import { basicToPrg } from "../src/tools/translation/basicTokenizer.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";
import { startViceMockServer } from "../src/vice/mockServer.js";

const SCREEN_BASE = "$0400";
const SAFE_RAM_BASE = "$C000";
const REPO_CONFIG_PATH = path.resolve(".c64bridge.json");

function asciiToHexBytes(text) {
  return Buffer.from(text, "ascii").toString("hex").toUpperCase();
}

async function writeMessageAt(client, baseAddress, message) {
  const hex = asciiToHexBytes(message);
  const write = await client.writeMemory(baseAddress, `$${hex}`);
  return { write, hex: `$${hex}` };
}

async function withEnv(overrides, fn) {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || value === null) {
        delete process.env[key];
      } else {
        process.env[key] = String(value);
      }
    }
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withConfigScenario({
  envConfig,
  repoConfig,
  homeConfig,
  mode,
}, fn) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-client-config-"));
  const envConfigPath = path.join(tempRoot, "env.json");
  const homeDir = path.join(tempRoot, "home");
  const homeConfigPath = path.join(homeDir, ".c64bridge.json");
  const hadRepoConfig = fs.existsSync(REPO_CONFIG_PATH);
  const originalRepoConfig = hadRepoConfig ? fs.readFileSync(REPO_CONFIG_PATH, "utf8") : null;

  fs.mkdirSync(homeDir, { recursive: true });

  try {
    if (repoConfig === null) {
      fs.rmSync(REPO_CONFIG_PATH, { force: true });
    } else if (repoConfig !== undefined) {
      fs.writeFileSync(REPO_CONFIG_PATH, JSON.stringify(repoConfig), "utf8");
    }

    if (homeConfig !== undefined) {
      if (homeConfig === null) {
        fs.rmSync(homeConfigPath, { force: true });
      } else {
        fs.writeFileSync(homeConfigPath, JSON.stringify(homeConfig), "utf8");
      }
    }

    if (envConfig !== undefined && envConfig !== null) {
      fs.writeFileSync(envConfigPath, JSON.stringify(envConfig), "utf8");
    }

    return await withEnv({
      HOME: homeDir,
      C64BRIDGE_CONFIG: envConfig !== undefined ? envConfigPath : undefined,
      C64_MODE: mode ?? undefined,
    }, fn);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (hadRepoConfig) {
      fs.writeFileSync(REPO_CONFIG_PATH, originalRepoConfig, "utf8");
    } else {
      fs.rmSync(REPO_CONFIG_PATH, { force: true });
    }
  }
}

const target = (process.env.C64_TEST_TARGET ?? "mock").toLowerCase();
const platform = (process.env.C64_MODE ?? "c64u").toLowerCase();
const injectedBaseUrl = process.env.C64_TEST_BASE_URL;

test("C64Client against mock server", async (t) => {
  if (target !== "mock") {
    t.skip("mock target disabled");
    return;
  }
  if (platform !== "c64u") {
    t.skip("C64Client mock integration is only exercised on c64u");
    return;
  }

  const mock = await startMockC64Server();
  t.after(async () => {
    await mock.close();
  });

  const client = new C64Client(mock.baseUrl);

  await t.test("uploadAndRunBasic sends PRG payload", async () => {
    const program = '10 PRINT "HELLO"';
    const result = await client.uploadAndRunBasic(program);
    assert.equal(result.success, true);
    assert.ok(mock.state.lastPrg instanceof Buffer);
    assert.equal(mock.state.runCount, 1);
    const prg = mock.state.lastPrg;
    assert.equal(prg.readUInt16LE(0), 0x0801);
    const firstLinePointer = prg.readUInt16LE(2);
    const firstLineNumber = prg.readUInt16LE(4);
    assert.equal(firstLineNumber, 10);
    assert.ok(firstLinePointer > 0x0801);
    assert.equal(prg[6], 0x99);
    const finalMarker = prg.subarray(-2);
    assert.deepEqual(Array.from(finalMarker), [0x00, 0x00]);
  });

  await t.test("captureFrames reconstructs a complete streamed video frame", async () => {
    const result = await client.captureFrames({ count: 1 });

    assert.equal(result.backend, "c64u");
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].width, 384);
    assert.equal(result.frames[0].height, 272);
    assert.equal(result.frames[0].bitsPerPixel, 4);
    assert.equal(result.frames[0].complete, true);
    assert.equal(result.frames[0].pixels.length, 384 * 272);
    assert.equal(mock.state.streams.video.active, false);
    assert.ok(mock.state.streams.video.packetsSent >= 68);
  });

  await t.test("prepareVideoCapture reuses a single C64U video stream across captures", async () => {
    const startsBefore = mock.state.streamActionLog.filter((entry) => entry.action === "start" && entry.stream === "video").length;
    const stopsBefore = mock.state.streamActionLog.filter((entry) => entry.action === "stop" && entry.stream === "video").length;

    await client.prepareVideoCapture({ keepAliveMs: 5_000 });
    assert.equal(mock.state.streams.video.active, true);
    assert.equal(mock.state.streamActionLog.filter((entry) => entry.action === "start" && entry.stream === "video").length - startsBefore, 1);

    const first = await client.captureFrames({ count: 1, reuseSession: true, keepAliveMs: 5_000 });
    const second = await client.captureFrames({ count: 1, reuseSession: true, keepAliveMs: 5_000 });

    assert.equal(first.backend, "c64u");
    assert.equal(first.frames.length, 1);
    assert.equal(second.backend, "c64u");
    assert.equal(second.frames.length, 1);
    assert.equal(mock.state.streams.video.active, true);
    assert.equal(mock.state.streamActionLog.filter((entry) => entry.action === "start" && entry.stream === "video").length - startsBefore, 1);
    assert.equal(mock.state.streamActionLog.filter((entry) => entry.action === "stop" && entry.stream === "video").length - stopsBefore, 0);

    await client.releaseVideoCapture();

    assert.equal(mock.state.streams.video.active, false);
    assert.equal(mock.state.streamActionLog.filter((entry) => entry.action === "stop" && entry.stream === "video").length - stopsBefore, 1);
  });

  await t.test("captureSamples collects stereo PCM pairs from streamed audio", async () => {
    const result = await client.captureSamples({ count: 256 });

    assert.equal(result.backend, "c64u");
    assert.equal(result.channels, 2);
    assert.equal(result.samplePairs, 256);
    assert.equal(result.samples.length, 512);
    assert.equal(result.sampleRateHz, 47982.8869047619);
    assert.equal(mock.state.streams.audio.active, false);
    assert.ok(mock.state.streams.audio.packetsSent >= 2);
  });

  await t.test("printTextOnPrinterAndRun generates Commodore BASIC and runs it", async () => {
    const opts = { text: "HELLO\nWORLD", formFeed: true };
    const prevRuns = mock.state.runCount;
    const result = await client.printTextOnPrinterAndRun(opts);
    assert.equal(result.success, true);
    assert.equal(mock.state.runCount, prevRuns + 1);
    assert.ok(mock.state.lastPrg instanceof Buffer);
    const expectedSource = buildPrinterBasicProgram(opts);
    const expectedPrg = basicToPrg(expectedSource);
    assert.deepEqual(Array.from(mock.state.lastPrg), Array.from(expectedPrg));
  });

  await t.test("buildPrinterBasicProgram splits long lines and escapes quotes", () => {
    const src = buildPrinterBasicProgram({ text: 'A"B' });
    assert.ok(src.includes('PRINT#1,"A""B"'));
  });

  await t.test("Commodore BIM builder sets bit7 and emits DATA lines", () => {
    const src = buildCommodoreBitmapBasicProgram({ columns: [0, 1, 2, 127], repeats: 2, secondaryAddress: 7 });
    // Expect bit7 set => 128,129,130,255 in DATA
    assert.ok(src.includes("DATA 128,129,130,255"));
    assert.ok(src.includes("OPEN1,4,7"));
    assert.ok(src.includes("PRINT#1,CHR$(8);A$"));
  });

  await t.test("Epson bitmap builder encodes length in n,m", () => {
    const src = buildEpsonBitmapBasicProgram({ columns: Array.from({ length: 16 }).map((_, i) => i), mode: "K", repeats: 3, timesPerLine: 2 });
    // n=16, m=0
    assert.ok(src.includes("CHR$(27)+CHR$(75)+CHR$(16)+CHR$(0)"), src);
    assert.ok(src.includes("PRINT#1,A$;A$;CHR$(10);CHR$(13)"));
  });

  await t.test("Commodore DLL builder computes m,n and prints p1..p11", () => {
    const src = buildCommodoreDllBasicProgram({ firstChar: 65, chars: [{ a: 0, columns: [1,2,3,4,5,6,7,8,9,10,11] }] });
    // t = (1*13)+2 = 15 => n=0, m=15
    assert.ok(src.includes('CHR$(27);"=";CHR$(15);CHR$(0);CHR$(65);CHR$(32);CHR$(0)'));
    assert.ok(src.includes('PRINT#1,CHR$(1),CHR$(2),CHR$(3),CHR$(4),CHR$(5),CHR$(6),CHR$(7),CHR$(8),CHR$(9),CHR$(10),CHR$(11)'));
  });

  await t.test("printBitmapOnCommodoreAndRun sends expected PRG", async () => {
    const opts = { columns: [0, 1, 2, 3, 4, 5, 6, 7], repeats: 2, secondaryAddress: 7 };
    const before = mock.state.runCount;
    const result = await client.printBitmapOnCommodoreAndRun(opts);
    assert.equal(result.success, true);
    assert.equal(mock.state.runCount, before + 1);
    const expected = basicToPrg(buildCommodoreBitmapBasicProgram(opts));
    assert.deepEqual(Array.from(mock.state.lastPrg), Array.from(expected));
  });

  await t.test("printBitmapOnEpsonAndRun sends expected PRG", async () => {
    const opts = { columns: Array.from({ length: 16 }).map((_, i) => i), mode: "L", repeats: 1, timesPerLine: 1 };
    const before = mock.state.runCount;
    const result = await client.printBitmapOnEpsonAndRun(opts);
    assert.equal(result.success, true);
    assert.equal(mock.state.runCount, before + 1);
    const expected = basicToPrg(buildEpsonBitmapBasicProgram(opts));
    assert.deepEqual(Array.from(mock.state.lastPrg), Array.from(expected));
  });

  await t.test("defineCustomCharsOnCommodoreAndRun sends expected PRG", async () => {
    const opts = { firstChar: 65, chars: [{ a: 1, columns: [1,2,3,4,5,6,7,8,9,10,11] }], secondaryAddress: 0 };
    const before = mock.state.runCount;
    const result = await client.defineCustomCharsOnCommodoreAndRun(opts);
    assert.equal(result.success, true);
    assert.equal(mock.state.runCount, before + 1);
    const expected = basicToPrg(buildCommodoreDllBasicProgram(opts));
    assert.deepEqual(Array.from(mock.state.lastPrg), Array.from(expected));
  });

  await t.test("printTextOnPrinterAndRun honors explicit Epson target (same BASIC by default)", async () => {
    const opts = { text: "EPSON TEXT", target: "epson", formFeed: false };
    const before = mock.state.runCount;
    const result = await client.printTextOnPrinterAndRun(opts);
    assert.equal(result.success, true);
    assert.equal(mock.state.runCount, before + 1);
    const expected = basicToPrg(buildPrinterBasicProgram(opts));
    assert.deepEqual(Array.from(mock.state.lastPrg), Array.from(expected));
  });

  await t.test("version and info endpoints respond", async () => {
    const v = await client.version();
    assert.ok(v && typeof v === "object");
    const info = await client.info();
    assert.ok(info && typeof info === "object");
  });

  await t.test("networkPassword is sent as X-Password header when configured", async () => {
    const passwordClient = new C64Client(mock.baseUrl, { networkPassword: "open-sesame" });
    await passwordClient.info();
    assert.equal(mock.state.lastRequest.headers["x-password"], "open-sesame");
  });

  await t.test("networkPassword-protected mock rejects missing or wrong passwords", async () => {
    const protectedMock = await startMockC64Server({ networkPassword: "open-sesame" });
    t.after(async () => {
      await protectedMock.close();
    });

    const missingPasswordClient = new C64Client(protectedMock.baseUrl);
    await assert.rejects(() => missingPasswordClient.info(), (error) => {
      assert.equal(error?.response?.status, 403);
      return true;
    });

    const wrongPasswordClient = new C64Client(protectedMock.baseUrl, { networkPassword: "wrong-pass" });
    await assert.rejects(() => wrongPasswordClient.info(), (error) => {
      assert.equal(error?.response?.status, 403);
      return true;
    });

    const correctPasswordClient = new C64Client(protectedMock.baseUrl, { networkPassword: "open-sesame" });
    const info = await correctPasswordClient.info();
    assert.ok(info && typeof info === "object");
    assert.equal(protectedMock.state.lastRequest.headers["x-password"], "open-sesame");
  });

  await t.test("pause/resume and debugreg read/write work", async () => {
    let r = await client.pause();
    assert.equal(r.success, true);
    r = await client.resume();
    assert.equal(r.success, true);

    const write = await client.debugregWrite("AB");
    assert.equal(write.success, true);
    const read = await client.debugregRead();
    assert.equal(read.success, true);
    assert.equal(read.value?.toUpperCase(), "AB");
  });

  await t.test("symbol address 'screen' resolves for readMemory", async () => {
    const result = await client.readMemory("screen", "1");
    assert.equal(result.success, true);
    assert.equal(typeof result.data, "string");
    assert.ok(result.data?.startsWith("$"));
  });

  await t.test("readScreen returns translated ASCII text", async () => {
    const screen = await client.readScreen();
    assert.ok(screen.includes("READY."));
  });

  await t.test("SID: set volume, note on/off, and silence all", async () => {
    // Volume write should produce a write to $D418
    const vol = await client.sidSetVolume(12);
    assert.equal(vol.success, true);
    assert.equal(mock.state.lastWrite.address, 0xd418);
    assert.equal(mock.state.lastWrite.bytes.length, 1);

    // Note on voice 1 writes FREQ..SR block starting at $D400
    const noteOn = await client.sidNoteOn({ voice: 1, note: "A4", waveform: "pulse", pulseWidth: 0x0800, attack: 1, decay: 2, sustain: 8, release: 3 });
    assert.equal(noteOn.success, true);
    assert.equal(mock.state.lastWrite.address, 0xd400);
    assert.equal(mock.state.lastWrite.bytes.length, 7);

    const noteOff = await client.sidNoteOff(1);
    assert.equal(noteOff.success, true);
    assert.equal(mock.state.lastWrite.address, 0xd404);
    assert.equal(mock.state.lastWrite.bytes[0], 0x00);

    const silence = await client.sidSilenceAll();
    assert.equal(silence.success, true);
    assert.equal(mock.state.lastWrite.address, 0xd418);
    assert.equal(mock.state.lastWrite.bytes[0], 0x00);
  });

  await t.test("SID frequency bytes are correct for PAL vs NTSC", async () => {
    const client = new C64Client(mock.baseUrl);
    function expectFreqBytes(hz, system) {
      const phi2 = system === "PAL" ? 985_248 : 1_022_727;
      const value = Math.round((hz * 65536) / phi2) & 0xffff;
      const lo = value & 0xff;
      const hi = (value >> 8) & 0xff;
      return { lo, hi };
    }

    // Use A4 = 440Hz via note name
    await client.sidNoteOn({ voice: 1, note: "A4", waveform: "tri", attack: 1, decay: 7, sustain: 15, release: 0, system: "PAL" });
    assert.equal(mock.state.lastWrite.address, 0xd400);
    const palLo = mock.state.lastWrite.bytes[0];
    const palHi = mock.state.lastWrite.bytes[1];
    const expectedPal = expectFreqBytes(440, "PAL");
    assert.equal(palLo, expectedPal.lo);
    assert.equal(palHi, expectedPal.hi);

    await client.sidNoteOn({ voice: 1, note: "A4", waveform: "tri", attack: 1, decay: 7, sustain: 15, release: 0, system: "NTSC" });
    assert.equal(mock.state.lastWrite.address, 0xd400);
    const ntscLo = mock.state.lastWrite.bytes[0];
    const ntscHi = mock.state.lastWrite.bytes[1];
    const expectedNtsc = expectFreqBytes(440, "NTSC");
    assert.equal(ntscLo, expectedNtsc.lo);
    assert.equal(ntscHi, expectedNtsc.hi);
  });

  await t.test("write message to high RAM and read back", async () => {
    const message = "HELLO FROM MCP";
    const length = message.length.toString(10);

    const before = await client.readMemory(SAFE_RAM_BASE, length);
    assert.equal(before.success, true);
    const previousHex = before.data ?? null;

    try {
      const { write, hex } = await writeMessageAt(client, SAFE_RAM_BASE, message);
      assert.equal(write.success, true, `Write failed: ${JSON.stringify(write.details)}`);

      const readBack = await client.readMemory(SAFE_RAM_BASE, length);
      assert.equal(readBack.success, true);
      assert.equal(readBack.data, hex);
    } finally {
      if (previousHex) {
        await client.writeMemory(SAFE_RAM_BASE, previousHex);
      }
    }
  });

  await t.test("runPrg uploads a raw PRG payload", async () => {
    const prg = basicToPrg('10 PRINT "RAW"');
    const before = mock.state.runCount;
    const result = await client.runPrg(prg);
    assert.equal(result.success, true);
    assert.equal(mock.state.runCount, before + 1);
  });

  await t.test("reset returns success", async () => {
    const result = await client.reset();
    assert.equal(result.success, true);
    assert.equal(mock.state.resets, 1);
  });

  await t.test("reboot triggers firmware endpoint", async () => {
    const result = await client.reboot();
    assert.equal(result.success, true);
    assert.equal(mock.state.reboots, 1);
  });

  await t.test("writeMemory writes bytes to mock memory", async () => {
    const result = await client.writeMemory("$0400", "$AA55");
    assert.equal(result.success, true);
    assert.deepEqual(Array.from(mock.state.lastWrite.bytes), [0xaa, 0x55]);
  });

  await t.test("readMemory returns hex string with prefix", async () => {
    const result = await client.readMemory("%0000010000000000", "2");
    assert.equal(result.success, true);
    assert.equal(result.data, "$AA55");
  });

  await t.test("readMemory requests binary and falls back to JSON", async () => {
    const r = await client.readMemory("$0400", "4");
    assert.equal(r.success, true);
    assert.equal(typeof r.data, "string");
    // Ensure the mock recorded Accept header with octet-stream
    const accept = String(mock.state.lastRequest.headers["accept"] || "");
    assert.ok(accept.includes("application/octet-stream"));
  });

  await t.test("writeMemory uses POST for >128 bytes", async () => {
    const big = Buffer.alloc(200, 0x42); // 'B'
    const hex = `$${big.toString("hex").toUpperCase()}`;
    const res = await client.writeMemory("$C100", hex);
    assert.equal(res.success, true);
    assert.equal(mock.state.lastWrite.address, 0xC100);
    assert.equal(mock.state.lastWrite.bytes.length, 200);
  });
});

test("renderGreetingScreen uses batched writes when the facade supports them", async () => {
  const client = new C64Client("http://127.0.0.1:65535");
  const writeMemoryCalls = [];
  const writeMemoryBlocksCalls = [];
  let readMemoryCalls = 0;

  client.facadePromise = Promise.resolve({
    type: "c64u",
    async readMemory() {
      readMemoryCalls += 1;
      return Uint8Array.of(0);
    },
    async writeMemory(address, bytes) {
      writeMemoryCalls.push({ address, length: bytes.length });
    },
    async writeMemoryBlocks(blocks) {
      writeMemoryBlocksCalls.push(blocks.map(({ address, bytes }) => ({ address, length: bytes.length })));
    },
  });

  const result = await client.renderGreetingScreen({ message: "HELLO TEST" });

  assert.equal(result.success, true);
  assert.equal(writeMemoryCalls.length, 0);
  assert.equal(writeMemoryBlocksCalls.length, 1);
  assert.equal(writeMemoryBlocksCalls[0].length, 8);
  assert.equal(readMemoryCalls, 1);
});

test("renderGreetingScreen reuses the cached DD00 value across repeated renders", async () => {
  const client = new C64Client("http://127.0.0.1:65535");
  let readMemoryCalls = 0;

  client.facadePromise = Promise.resolve({
    type: "c64u",
    async readMemory() {
      readMemoryCalls += 1;
      return Uint8Array.of(0);
    },
    async writeMemory() {},
    async writeMemoryBlocks() {},
  });

  const first = await client.renderGreetingScreen({ message: "HELLO ONCE" });
  const second = await client.renderGreetingScreen({ message: "HELLO TWICE" });

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(readMemoryCalls, 1);
});

test("renderGreetingScreen coalesces contiguous C64U register writes", async () => {
  const mock = await startMockC64Server();

  try {
    const client = new C64Client(mock.baseUrl);
    const result = await client.renderGreetingScreen({ message: "HELLO MOCK" });

    assert.equal(result.success, true);
    assert.equal(mock.state.writeLog.length, 7);
    const mergedRegisters = mock.state.writeLog.find((entry) => entry.address === 0xD020);
    assert.ok(mergedRegisters);
    assert.equal(mergedRegisters.bytes.length, 2);
  } finally {
    await mock.close();
  }
});

test("C64Client against real C64", async (t) => {
  if (target !== "real") {
    t.skip("real target disabled");
    return;
  }
  if (platform !== "c64u") {
    t.skip("C64Client real-hardware integration is only exercised on c64u");
    return;
  }

  const baseUrl = injectedBaseUrl ?? "http://c64u";
  const client = new C64Client(baseUrl);

  await t.test("reset real C64", async () => {
    const response = await client.reset();
    assert.equal(response.success, true, `Reset failed: ${JSON.stringify(response.details)}`);
  });

  await t.test("upload program to real C64", async () => {
    const program = '10 PRINT "MCP!"\n20 END';
    const response = await client.uploadAndRunBasic(program);
    assert.equal(response.success, true, `Upload failed: ${JSON.stringify(response.details)}`);
  });

  await t.test("read screen from real C64", async () => {
    const screen = await client.readScreen();
    assert.equal(typeof screen, "string");
    assert.ok(screen.length > 0, "Screen buffer empty");
  });

  // TODO(chris): Re-enable once the real hardware exposes consistent RAM reads at $C000
  // await t.test("write message to real high RAM and read back", async () => {
  //   const message = "MCP SCREEN TEST";
  //   const length = message.length.toString(10);

  //   const before = await client.readMemory(SAFE_RAM_BASE, length);
  //   assert.equal(before.success, true, `Pre-read failed: ${JSON.stringify(before.details)}`);
  //   const previousHex = before.data ?? null;

  //   try {
  //     const { write, hex } = await writeMessageAt(client, SAFE_RAM_BASE, message);
  //     assert.equal(write.success, true, `Write failed: ${JSON.stringify(write.details)}`);

  //     const readBack = await client.readMemory(SAFE_RAM_BASE, length);
  //     assert.equal(readBack.success, true, `Read-back failed: ${JSON.stringify(readBack.details)}`);
  //     assert.equal(readBack.data, hex);
  //   } finally {
  //     if (previousHex) {
  //       await client.writeMemory(SAFE_RAM_BASE, previousHex);
  //     }
  //   }
  // });

  await t.test("reboot real C64", async () => {
    const response = await client.reboot();
    assert.equal(response.success, true, `Reboot failed: ${JSON.stringify(response.details)}`);
  });
});

test("C64Client backend selection and switching", async (t) => {
  await t.test("single c64u config exposes only c64u", async () => {
    const mock = await startMockC64Server();
    t.after(async () => {
      await mock.close();
    });

    await withConfigScenario(
      {
        envConfig: { c64u: { baseUrl: mock.baseUrl } },
        repoConfig: null,
        homeConfig: null,
      },
      async () => {
        const client = new C64Client("http://unused.local", { forceC64uFacade: false });

        assert.equal(await client.getActiveBackendType(), "c64u");
        assert.equal(await client.getBackendType(), "c64u");
        assert.deepEqual(client.getAvailableBackends(), ["c64u"]);

        const info = await client.info();
        assert.ok(info && typeof info === "object");
        await assert.rejects(() => client.viceCheckpointList(), /VICE-specific operation requested/);
      },
    );
  });

  await t.test("single vice config exposes only vice", async () => {
    const vice = await startViceMockServer({ host: "127.0.0.1", port: 0 });
    t.after(async () => {
      await vice.stop();
    });

    await withConfigScenario(
      {
        envConfig: { vice: { host: "127.0.0.1", port: vice.port } },
        repoConfig: null,
        homeConfig: null,
      },
      async () => {
        const client = new C64Client("http://unused.local", { forceC64uFacade: false });

        assert.equal(await client.getActiveBackendType(), "vice");
        assert.equal(await client.getBackendType(), "vice");
        assert.deepEqual(client.getAvailableBackends().sort(), ["c64u", "vice"]);

        const info = await client.info();
        assert.equal(info?.emulator, "vice");
        assert.equal(info?.port, vice.port);

        client.switchBackend("c64u");
        assert.equal(await client.getActiveBackendType(), "c64u");

        client.switchBackend("vice");
        assert.equal(await client.getActiveBackendType(), "vice");
      },
    );
  });

  await t.test("both configured initialises both facades and switchBackend swaps the active facade", async () => {
    const c64u = await startMockC64Server();
    const vice = await startViceMockServer({ host: "127.0.0.1", port: 0 });
    t.after(async () => {
      await Promise.all([c64u.close(), vice.stop()]);
    });

    await withConfigScenario(
      {
        repoConfig: { c64u: { baseUrl: c64u.baseUrl } },
        homeConfig: { vice: { host: "127.0.0.1", port: vice.port } },
        mode: "vice",
      },
      async () => {
        const client = new C64Client("http://unused.local", { forceC64uFacade: false });

        assert.equal(await client.getActiveBackendType(), "vice");
        assert.deepEqual(client.getAvailableBackends().sort(), ["c64u", "vice"]);

        const warmResults = await client.prewarmBackends();
        assert.equal(warmResults.c64u, true);
        assert.equal(warmResults.vice, true);

        const viceFrames = await client.captureFrames({ count: 1 });
        assert.equal(viceFrames.backend, "vice");
        assert.equal(viceFrames.frames.length, 1);

        const viceInfo = await client.info();
        assert.equal(viceInfo?.emulator, "vice");
        assert.equal((await client.version())?.emulator, "vice");
        assert.equal(await client.getBackendType(), "vice");

        client.switchBackend("c64u");
        assert.equal(await client.getActiveBackendType(), "c64u");
        assert.equal(await client.getBackendType(), "c64u");

        const c64uInfo = await client.info();
        assert.ok(c64uInfo && typeof c64uInfo === "object");
        assert.equal(c64u.state.lastRequest?.method, "GET");
        assert.match(c64u.state.lastRequest?.url ?? "", /\/v1\/info$/);

        client.switchBackend("vice");
        assert.equal(await client.getActiveBackendType(), "vice");
        assert.equal(await client.getBackendType(), "vice");
        assert.equal((await client.info())?.emulator, "vice");
      },
    );
  });

  await t.test("switchBackend throws for an unconfigured backend", async () => {
    const mock = await startMockC64Server();
    t.after(async () => {
      await mock.close();
    });

    await withConfigScenario(
      {
        envConfig: { c64u: { baseUrl: mock.baseUrl } },
        repoConfig: null,
        homeConfig: null,
      },
      async () => {
        const client = new C64Client("http://unused.local", { forceC64uFacade: false });
        await client.getActiveBackendType();

        assert.throws(() => client.switchBackend("vice"), /not configured/);
      },
    );
  });
});
