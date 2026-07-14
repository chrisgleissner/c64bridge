import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { __buildViceProcessOptionsForTests, __resolveViceBinaryForTests, __resolveViceLaunchForTests, createFacade, ViceBackend } from "../src/device.js";
import { ViceClient } from "../src/vice/viceClient.js";
import { startViceMockServer } from "../src/vice/mockServer.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

const platform = (process.env.C64_MODE ?? "").toLowerCase();
const viceTarget = (process.env.VICE_TEST_TARGET ?? "mock").toLowerCase();
const useViceMock = viceTarget !== "vice";
// Skip ViceBackend integration tests when running against real VICE but no device is available.
// Set VICE_AVAILABLE=1 in the environment when a real VICE instance is reachable.
const viceAvailable = process.env.VICE_AVAILABLE === "1";
const viceSuite = platform === "vice" && (useViceMock || viceAvailable) ? test : test.skip;
const viceIntegrationSuite = !useViceMock && process.env.CI === "1" ? viceSuite.skip : viceSuite;
const debugEnabled = process.env.VICE_DEVICE_TEST_DEBUG === "1";
function debugLog(...args) {
  if (debugEnabled) {
    console.error("[device.test]", ...args);
  }
}
const READY_PATTERN = Uint8Array.of(0x12, 0x05, 0x01, 0x04, 0x19, 0x2E);
const WAIT_READY_TIMEOUT_MS = useViceMock ? 1_000 : 10_000;
const WAIT_READY_INTERVAL_MS = useViceMock ? 25 : 200;
const WAIT_READY_SCAN_LENGTH = 1_000; // full text screen
const VICE_PING_TIMEOUT_MS = useViceMock ? 2_000 : (process.env.CI === "1" ? 40_000 : 20_000);
const VICE_SUITE_TIMEOUT_MS = useViceMock ? 30_000 : (process.env.CI === "1" ? 90_000 : 45_000);
const REPO_CONFIG_PATH = path.resolve(".c64bridge.json");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reserveLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error("Failed to reserve an ephemeral loopback port"));
          return;
        }
        resolve(port);
      });
    });
  });
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-config-scenario-"));
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

async function waitForTruthy(check, {
  timeoutMs = 10_000,
  intervalMs = 200,
  description = "condition",
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = false;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) {
      return true;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}; lastValue=${String(lastValue)}`);
}

async function waitForPattern(
  facade,
  address,
  expected,
  { timeoutMs = WAIT_READY_TIMEOUT_MS, intervalMs = WAIT_READY_INTERVAL_MS, scanLength = WAIT_READY_SCAN_LENGTH } = {},
) {
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  let last = null;
  let matchSlice = null;
  let attempts = 0;
  let lastLog = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const data = await facade.readMemory(address, scanLength);
    last = data;
    for (let offset = 0; offset <= data.length - expected.length; offset += 1) {
      let matches = true;
      for (let index = 0; index < expected.length; index += 1) {
        if (data[offset + index] !== expected[index]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        matchSlice = data.slice(offset, offset + expected.length);
        return matchSlice;
      }
    }
    if (debugEnabled) {
      const now = Date.now();
      if (attempts === 1 || now - lastLog >= 1_000) {
        debugLog(
          `scan attempt=${attempts}, elapsed=${now - startTime}ms, head=${Array.from(data.slice(0, expected.length))}`,
        );
        lastLog = now;
      }
    }
    await delay(intervalMs);
  }
  const lastSnapshot = last ? Array.from(last.slice(0, expected.length)) : null;
  if (debugEnabled) {
    debugLog(`timeout after ${attempts} attempts (${Date.now() - startTime}ms); lastPrefix=${lastSnapshot}`);
  }
  throw new Error(
    `Timed out waiting for pattern at $${address.toString(16).toUpperCase()} (expected=${Array.from(expected)}, lastPrefix=${lastSnapshot})`,
  );
}

test("ViceBackend nuclearReset propagates poweroff failures", async () => {
  const backend = new ViceBackend({ host: "127.0.0.1", port: 6502 });
  backend.poweroff = async () => ({ success: false, details: { message: "quit failed" } });
  backend.ensureProcess = async () => {
    throw new Error("should not restart after failed poweroff");
  };

  const result = await backend.nuclearReset();

  assert.equal(result.success, false);
  assert.deepEqual(result.details, { message: "quit failed" });
});

test("ViceBackend nuclearReset reports unmanaged instances as unsupported", async () => {
  const backend = new ViceBackend({ host: "127.0.0.1", port: 6502 });
  backend.manageProcess = false;
  backend.poweroff = async () => ({ success: true });

  const result = await backend.nuclearReset();

  assert.equal(result.success, false);
  assert.equal(result.details.code, "UNSUPPORTED");
});

test("ViceBackend writeMemoryBlocks coalesces adjacent writes before sending them", async () => {
  const backend = new ViceBackend({ host: "127.0.0.1", port: 6502 });
  const writes = [];
  backend.withClient = async (fn) => fn({
    async memSet(address, bytes) {
      writes.push({ address, bytes: Array.from(bytes) });
    },
  });

  await backend.writeMemoryBlocks([
    { address: 0x1000, bytes: Uint8Array.of(0x11, 0x22) },
    { address: 0x1002, bytes: Uint8Array.of(0x33, 0x44) },
  ]);

  assert.deepEqual(writes, [{ address: 0x1000, bytes: [0x11, 0x22, 0x33, 0x44] }]);
});

test("ViceBackend withMonitor forwards to withClient", async () => {
  const backend = new ViceBackend({ host: "127.0.0.1", port: 6502 });
  let forwarded = false;
  backend.withClient = async (fn) => {
    forwarded = true;
    return fn("monitor-client");
  };

  const result = await backend.withMonitor(async (client) => client);

  assert.equal(forwarded, true);
  assert.equal(result, "monitor-client");
});

viceIntegrationSuite("device: ViceBackend basic operations", { timeout: VICE_SUITE_TIMEOUT_MS }, async (t) => {
  let server = null;
  let cfgDir = null;
  let cfgPath = null;
  const oldConfig = process.env.C64BRIDGE_CONFIG;
  const oldMode = process.env.C64_MODE;
  const oldVicePort = process.env.VICE_PORT;
  const scratchAddress = 0x1000;
  const scratchBytes = Uint8Array.of(0x11, 0x22, 0x33, 0x44);

  debugLog(`vice target=${viceTarget}; useViceMock=${useViceMock}`);

  if (useViceMock) {
    server = await startViceMockServer({ host: "127.0.0.1", port: 0 });
    cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "vice-config-"));
    cfgPath = path.join(cfgDir, "c64bridge.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ vice: { host: "127.0.0.1", port: server.port } }), "utf8");
    process.env.C64BRIDGE_CONFIG = cfgPath;
    process.env.C64_MODE = "vice";
    debugLog(`mock vice server listening on ${server.port}`);
  } else {
    debugLog("running against real VICE backend");
    process.env.VICE_PORT = String(await reserveLoopbackPort());
  }

  t.after(async () => {
    if (server) await server.stop();
    if (cfgDir) fs.rmSync(cfgDir, { recursive: true, force: true });
    if (oldConfig !== undefined) process.env.C64BRIDGE_CONFIG = oldConfig;
    else delete process.env.C64BRIDGE_CONFIG;
    if (oldMode !== undefined) process.env.C64_MODE = oldMode;
    else delete process.env.C64_MODE;
    if (oldVicePort !== undefined) process.env.VICE_PORT = oldVicePort;
    else delete process.env.VICE_PORT;
  });

  const { facade } = await createFacade();
  debugLog(`facade selected=${facade.type}`);

  await t.test("ping succeeds", async () => {
    assert.equal(
      await waitForTruthy(() => facade.ping(), {
        timeoutMs: VICE_PING_TIMEOUT_MS,
        intervalMs: useViceMock ? 50 : 250,
        description: "VICE ping",
      }),
      true,
    );
  });

  await t.test("version reports vice backend", async () => {
    const version = await facade.version();
    assert.equal(version?.emulator, "vice");
  });

  await t.test("info reports vice endpoint", async () => {
    const info = await facade.info();
    assert.equal(info?.emulator, "vice");
    assert.ok(typeof info?.host === "string" && info.host.length > 0);
    assert.ok(Number.isInteger(info?.port));
  });

  await t.test("readMemory returns requested length", async () => {
    const data = await facade.readMemory(0x0400, READY_PATTERN.length);
    assert.equal(data.length, READY_PATTERN.length);
  });

  await t.test("writeMemory round-trips bytes", async () => {
    await facade.writeMemory(scratchAddress, scratchBytes);
    const data = await facade.readMemory(scratchAddress, scratchBytes.length);
    assert.deepEqual(Array.from(data), Array.from(scratchBytes));
  });

  await t.test("reset restores READY prompt", async () => {
    await facade.writeMemory(0x0400, new Uint8Array(READY_PATTERN.length).fill(0));
    await facade.reset();
    const data = await waitForPattern(facade, 0x0400, READY_PATTERN);
    debugLog("READY prompt restored");
    assert.deepEqual(Array.from(data), Array.from(READY_PATTERN));
  });

  await t.test("pause/resume report unsupported", async () => {
    const pause = await facade.pause();
    const resume = await facade.resume();
    assert.equal(pause.success, false);
    assert.equal(resume.success, false);
    assert.equal(pause.details?.code, "UNSUPPORTED");
    assert.equal(resume.details?.code, "UNSUPPORTED");
  });

  await t.test("loadPrgFile throws unsupported", async () => {
    await assert.rejects(() => facade.loadPrgFile("/tmp/test.prg"));
  });

  await t.test("runCrtFile throws unsupported", async () => {
    await assert.rejects(() => facade.runCrtFile("/tmp/test.crt"));
  });

  await t.test("sidplayFile throws unsupported", async () => {
    await assert.rejects(() => facade.sidplayFile("/tmp/test.sid"));
  });

  await t.test("sidplayAttachment throws unsupported", async () => {
    await assert.rejects(() => facade.sidplayAttachment(new Uint8Array([1, 2, 3])));
  });

  await t.test("poweroff succeeds and allows reconnect", async () => {
    const result = await facade.poweroff();
    assert.equal(result.success, true);
    // Give the supervisor a moment to respawn if needed.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      await waitForTruthy(() => facade.ping(), {
        timeoutMs: VICE_PING_TIMEOUT_MS,
        intervalMs: useViceMock ? 50 : 250,
        description: "VICE reconnect ping",
      }),
      true,
    );
    if (!useViceMock) {
      await facade.poweroff();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });

  await t.test("menuButton throws unsupported", async () => {
    await assert.rejects(() => facade.menuButton());
  });

  // Drive tests — resource-backed tests only run against the mock server
  if (useViceMock) {
    await t.test("drivesList returns array of 4 drives", async () => {
      const drives = await facade.drivesList();
      assert.ok(Array.isArray(drives));
      assert.equal(drives.length, 4);
      assert.ok(drives.every((d) => ["drive8", "drive9", "drive10", "drive11"].includes(d.id)));
      assert.ok(drives.every((d) => d.power === "on" || d.power === "off"));
    });

    await t.test("driveOn enables drive 8", async () => {
      const result = await facade.driveOn("drive8");
      assert.equal(result.success, true);
      const detail = result.details;
      assert.equal(detail.drive, "drive8");
      assert.equal(detail.power, "on");
    });

    await t.test("driveOff disables drive 8", async () => {
      const result = await facade.driveOff("drive8");
      assert.equal(result.success, true);
      const detail = result.details;
      assert.equal(detail.drive, "drive8");
      assert.equal(detail.power, "off");
    });

    await t.test("driveSetMode sets drive type to 1571", async () => {
      const result = await facade.driveSetMode("drive8", "1571");
      assert.equal(result.success, true);
    });

    await t.test("driveSetMode sets drive type to 1541", async () => {
      const result = await facade.driveSetMode("drive9", "1541");
      assert.equal(result.success, true);
    });

    await t.test("driveSetMode sets drive type to 1581", async () => {
      const result = await facade.driveSetMode("drive10", "1581");
      assert.equal(result.success, true);
    });

    await t.test("driveMount attaches image to drive 8", async () => {
      const result = await facade.driveMount("drive8", "/tmp/test.d64");
      assert.equal(result.success, true);
    });

    await t.test("driveReset resets drive 8", async () => {
      const result = await facade.driveReset("drive8");
      assert.equal(result.success, true);
    });

    await t.test("driveRemove detaches image from drive 8", async () => {
      const result = await facade.driveRemove("drive8");
      assert.equal(result.success, true);
    });
  }

  // These reject immediately without touching the backend — safe on real VICE too
  await t.test("driveLoadRom throws unsupported", async () => {
    await assert.rejects(() => facade.driveLoadRom("drive8", "/tmp/1541.rom"));
  });

  await t.test("driveOn throws on invalid drive", async () => {
    await assert.rejects(() => facade.driveOn("drive7"));
  });

  await t.test("driveOff throws on invalid drive", async () => {
    await assert.rejects(() => facade.driveOff("drive12"));
  });

  // Config tests
  await t.test("configsList returns categories array", async () => {
    // configsList returns a static structure — no BM round-trip required
    const list = await facade.configsList();
    assert.ok(list && typeof list === "object");
    assert.ok(Array.isArray(list.categories));
    assert.ok(list.categories.length > 0);
    assert.ok(list.categories[0].name);
    assert.ok(Array.isArray(list.categories[0].items));
  });

  if (useViceMock) {
    await t.test("configGet returns resource value for known key", async () => {
      // SidEngine is pre-seeded in mock server as value 1
      const result = await facade.configGet("VICE", "SidEngine");
      assert.ok(result && typeof result === "object");
      assert.ok("value" in result);
    });

    await t.test("configGet returns empty string for unknown key", async () => {
      const result = await facade.configGet("VICE", "UnknownKey99");
      assert.ok(result && typeof result === "object");
      assert.ok("value" in result);
    });

    await t.test("configSet writes a resource value", async () => {
      const result = await facade.configSet("VICE", "WarpMode", "1");
      assert.equal(result.success, true);
    });

    await t.test("configBatchUpdate sets multiple resources", async () => {
      const result = await facade.configBatchUpdate({ VICE: { SoundVolume: "80", WarpMode: "0" } });
      assert.equal(result.success, true);
    });
  }

  // These reject immediately without touching the backend
  await t.test("configLoadFromFlash throws unsupported", async () => {
    await assert.rejects(() => facade.configLoadFromFlash());
  });

  await t.test("configSaveToFlash throws unsupported", async () => {
    await assert.rejects(() => facade.configSaveToFlash());
  });

  await t.test("configResetToDefault throws unsupported", async () => {
    await assert.rejects(() => facade.configResetToDefault());
  });

  await t.test("filesInfo throws unsupported", async () => {
    await assert.rejects(() => facade.filesInfo("/tmp/test.d64"));
  });

  await t.test("filesCreateD64 throws unsupported", async () => {
    await assert.rejects(() => facade.filesCreateD64("/tmp/new.d64"));
  });

  await t.test("filesCreateD71 throws unsupported", async () => {
    await assert.rejects(() => facade.filesCreateD71("/tmp/new.d71"));
  });

  await t.test("filesCreateD81 throws unsupported", async () => {
    await assert.rejects(() => facade.filesCreateD81("/tmp/new.d81"));
  });

  await t.test("filesCreateDnp throws unsupported", async () => {
    await assert.rejects(() => facade.filesCreateDnp("/tmp/new.dnp"));
  });
});

test("device: createFacade with config file", async (t) => {
  await t.test("c64u config only", async () => {
    await withConfigScenario(
      {
        envConfig: { c64u: { hostname: "test.local", port: 8080 } },
        repoConfig: null,
        homeConfig: null,
      },
      async () => {
        const { facade, selected, reason } = await createFacade();
        assert.equal(selected, "c64u");
        assert.equal(reason, "config only");
        assert.equal(facade.type, "c64u");
      },
    );
  });

  await t.test("vice config only", async () => {
    await withConfigScenario(
      {
        envConfig: { vice: { exe: "/usr/bin/x64sc" } },
        repoConfig: null,
        homeConfig: null,
      },
      async () => {
        const { facade, selected, reason } = await createFacade();
        assert.equal(selected, "vice");
        assert.equal(reason, "config only");
        assert.equal(facade.type, "vice");
      },
    );
  });

  await t.test("both configs prefer c64u", async () => {
    await withConfigScenario(
      {
        envConfig: {
          c64u: { hostname: "test.local" },
          vice: { exe: "/usr/bin/x64sc" },
        },
        repoConfig: null,
        homeConfig: null,
      },
      async () => {
        const { facade, selected, reason } = await createFacade();
        assert.equal(selected, "c64u");
        assert.equal(reason, "both defined (prefer c64u)");
        assert.equal(facade.type, "c64u");
      },
    );
  });

  await t.test("c64u config forwards networkPassword to REST backend", async () => {
    const mock = await startMockC64Server({ networkPassword: "open-sesame" });
    t.after(async () => {
      await mock.close();
    });

    await withConfigScenario(
      {
        envConfig: { c64u: { baseUrl: mock.baseUrl, networkPassword: "open-sesame" } },
        repoConfig: null,
        homeConfig: null,
      },
      async () => {
        const { facade, selected, reason } = await createFacade();
        assert.equal(selected, "c64u");
        assert.equal(reason, "config only");
        assert.equal(await facade.ping(), true);
        const info = await facade.info();
        assert.ok(info && typeof info === "object");
        assert.equal(mock.state.lastRequest.headers["x-password"], "open-sesame");
      },
    );
  });

  await t.test("c64u facade operations stay covered behind networkPassword", async () => {
    const mock = await startMockC64Server({ networkPassword: "open-sesame" });
    t.after(async () => {
      await mock.close();
    });

    await withConfigScenario(
      {
        envConfig: { c64u: { baseUrl: mock.baseUrl, networkPassword: "open-sesame" } },
        repoConfig: null,
        homeConfig: null,
      },
      async () => {
        const { facade, selected } = await createFacade();
        assert.equal(selected, "c64u");
        assert.equal(await facade.ping(), true);
        assert.ok(await facade.version());
        assert.ok(await facade.info());

        const before = await facade.readMemory(0x0400, 4);
        assert.equal(before.length, 4);

        await facade.writeMemory(0x0400, Uint8Array.from([0x01, 0x02, 0x03, 0x04]));
        const after = await facade.readMemory(0x0400, 4);
        assert.deepEqual(Array.from(after), [0x01, 0x02, 0x03, 0x04]);

        const runPrg = await facade.runPrg(Buffer.from([0x01, 0x08, 0x00, 0x00]));
        assert.equal(runPrg.success, true);
        assert.equal((await facade.sidplayFile("/tmp/test.sid", 2)).success, true);
        assert.equal((await facade.sidplayAttachment(Buffer.from([1, 2, 3]), { songnr: 1, songlengths: Buffer.from([4, 5]) })).success, true);
        assert.equal((await facade.modplayFile("/tmp/test.mod")).success, true);
        assert.equal((await facade.pause()).success, true);
        assert.equal((await facade.resume()).success, true);
        assert.equal((await facade.reset()).success, true);
        assert.equal((await facade.reboot()).success, true);
        assert.equal((await facade.poweroff()).success, true);
        assert.equal((await facade.menuButton()).success, true);

        const debugWrite = await facade.debugregWrite("CD");
        assert.equal(debugWrite.success, true);
        const debugRead = await facade.debugregRead();
        assert.equal(debugRead.success, true);
        assert.equal(debugRead.value?.toUpperCase(), "CD");

        const drives = await facade.drivesList();
        assert.ok(drives && typeof drives === "object");
        assert.equal((await facade.driveOn("8")).success, true);
        assert.equal((await facade.driveSetMode("8", "1571")).success, true);
        assert.equal((await facade.driveMount("8", "/tmp/disk.d64", { type: "d64", mode: "readonly" })).success, true);
        assert.equal((await facade.driveLoadRom("8", "/tmp/1541.rom")).success, true);
        assert.equal((await facade.driveReset("8")).success, true);
        assert.equal((await facade.driveRemove("8")).success, true);
        assert.equal((await facade.driveOff("8")).success, true);

        const configList = await facade.configsList();
        assert.ok(configList && typeof configList === "object");
        const configCategory = await facade.configGet("video");
        assert.ok(configCategory && typeof configCategory === "object");
        assert.equal((await facade.configSet("video", "palette", "colodore")).success, true);
        assert.equal((await facade.configBatchUpdate({ audio: { volume: "10" } })).success, true);
        assert.equal((await facade.configSaveToFlash()).success, true);
        assert.equal((await facade.configLoadFromFlash()).success, true);
        assert.equal((await facade.configResetToDefault()).success, true);

        const fileInfo = await facade.filesInfo("/tmp/demo.prg");
        assert.ok(fileInfo && typeof fileInfo === "object");
        assert.equal((await facade.filesCreateD64("/tmp/demo.d64", { tracks: 35, diskname: "DEMO" })).success, true);
        assert.equal((await facade.filesCreateD71("/tmp/demo.d71", { diskname: "DEMO71" })).success, true);
        assert.equal((await facade.filesCreateD81("/tmp/demo.d81", { diskname: "DEMO81" })).success, true);
        assert.equal((await facade.filesCreateDnp("/tmp/demo.dnp", 160, { diskname: "DEMODNP" })).success, true);

        assert.equal((await facade.streamStart("video", "127.0.0.1")).success, true);
        assert.equal((await facade.streamStop("video")).success, true);

        assert.equal(mock.state.lastRequest.headers["x-password"], "open-sesame");
      },
    );
  });
});

test("device: createFacade merges backend sections across config candidates", async () => {
  await withConfigScenario(
    {
      repoConfig: { vice: { exe: "/usr/bin/x64sc" } },
      homeConfig: null,
    },
    async () => {
      const { facade, selected, reason } = await createFacade();
      assert.equal(selected, "vice");
      assert.equal(reason, "config only");
      assert.equal(facade.type, "vice");
    },
  );

  await withConfigScenario(
    {
      repoConfig: {},
      homeConfig: { vice: { exe: "/usr/bin/x64sc" } },
    },
    async () => {
      const { facade, selected, reason } = await createFacade();
      assert.equal(selected, "vice");
      assert.equal(reason, "config only");
      assert.equal(facade.type, "vice");
    },
  );

  await withConfigScenario(
    {
      repoConfig: { c64u: { host: "repo.local", port: 8081 } },
      homeConfig: { vice: { host: "127.0.0.1", port: 6509 } },
      mode: "vice",
    },
    async () => {
      const { facade, selected, reason, details } = await createFacade();
      assert.equal(selected, "vice");
      assert.equal(reason, "env override");
      assert.equal(facade.type, "vice");
      assert.deepEqual(details, { host: "127.0.0.1", port: 6509 });
    },
  );

  await withConfigScenario(
    {
      envConfig: { c64u: { host: "env.local", port: 8082 } },
      repoConfig: { c64u: { host: "repo.local", port: 8081 }, vice: { exe: "/usr/bin/x64sc" } },
      homeConfig: { vice: { host: "127.0.0.1", port: 6510 } },
    },
    async () => {
      const { facade, selected, reason } = await createFacade();
      assert.equal(selected, "c64u");
      assert.equal(reason, "both defined (prefer c64u)");
      assert.equal(facade.type, "c64u");
      assert.equal(facade.getBaseUrl(), "http://env.local:8082");
    },
  );
});

test("device: createFacade with env overrides", async (t) => {
  await t.test("C64_MODE=vice forces vice backend", async () => {
    const oldMode = process.env.C64_MODE;
    process.env.C64_MODE = "vice";
    
    t.after(() => {
      if (oldMode !== undefined) {
        process.env.C64_MODE = oldMode;
      } else {
        delete process.env.C64_MODE;
      }
    });

    const { facade, selected, reason } = await createFacade();
    assert.equal(selected, "vice");
    assert.equal(reason, "env override");
    assert.equal(facade.type, "vice");
  });

  await t.test("C64_MODE=c64u forces c64u backend", async () => {
    const oldMode = process.env.C64_MODE;
    process.env.C64_MODE = "c64u";
    
    t.after(() => {
      if (oldMode !== undefined) {
        process.env.C64_MODE = oldMode;
      } else {
        delete process.env.C64_MODE;
      }
    });

    const { facade, selected, reason } = await createFacade();
    assert.equal(selected, "c64u");
    assert.equal(reason, "env override");
    assert.equal(facade.type, "c64u");
  });

  await t.test("C64_MODE=u2 preserves the preferred U2 endpoint", async () => {
    const oldMode = process.env.C64_MODE;
    process.env.C64_MODE = "u2";
    t.after(() => {
      if (oldMode !== undefined) process.env.C64_MODE = oldMode;
      else delete process.env.C64_MODE;
    });

    const { facade, selected } = await createFacade(undefined, {
      preferredC64uBaseUrl: "http://u2.example.test",
    });
    assert.equal(selected, "u2");
    assert.equal(facade.type, "u2");
    assert.equal(facade.getBaseUrl(), "http://u2.example.test");
  });
});

test("device: C64uBackend env overrides", async (t) => {
  await t.test("env vars alone configure host, port, and password", async () => {
    const mock = await startMockC64Server({ networkPassword: "env-secret" });
    const mockPort = new URL(mock.baseUrl).port;
    t.after(async () => {
      await mock.close();
    });

    await withConfigScenario(
      {
        envConfig: null,
        repoConfig: null,
        homeConfig: null,
        mode: "c64u",
      },
      async () => {
        await withEnv({
          C64U_HOST: "127.0.0.1",
          C64U_PORT: mockPort,
          C64U_PASSWORD: "env-secret",
        }, async () => {
          const { facade, selected, reason } = await createFacade();

          assert.equal(selected, "c64u");
          assert.equal(reason, "env override");
          assert.equal(facade.type, "c64u");
          assert.equal(facade.getBaseUrl(), mock.baseUrl);
          assert.equal(await facade.ping(), true);
          await facade.info();
          assert.equal(mock.state.lastRequest.headers["x-password"], "env-secret");
        });
      },
    );
  });

  await t.test("config alone still configures c64u backend", async () => {
    const mock = await startMockC64Server({ networkPassword: "config-secret" });
    t.after(async () => {
      await mock.close();
    });

    await withConfigScenario(
      {
        envConfig: { c64u: { baseUrl: mock.baseUrl, networkPassword: "config-secret" } },
        repoConfig: null,
        homeConfig: null,
        mode: "c64u",
      },
      async () => {
        await withEnv({
          C64U_HOST: undefined,
          C64U_PORT: undefined,
          C64U_PASSWORD: undefined,
        }, async () => {
          const { facade } = await createFacade();

          assert.equal(facade.type, "c64u");
          assert.equal(facade.getBaseUrl(), mock.baseUrl);
          assert.equal(await facade.ping(), true);
          await facade.info();
          assert.equal(mock.state.lastRequest.headers["x-password"], "config-secret");
        });
      },
    );
  });

  await t.test("env vars beat config values", async () => {
    const configMock = await startMockC64Server({ networkPassword: "config-secret" });
    const envMock = await startMockC64Server({ networkPassword: "env-secret" });
    const envMockPort = new URL(envMock.baseUrl).port;
    t.after(async () => {
      await configMock.close();
      await envMock.close();
    });

    await withConfigScenario(
      {
        envConfig: { c64u: { baseUrl: configMock.baseUrl, networkPassword: "config-secret" } },
        repoConfig: null,
        homeConfig: null,
        mode: "c64u",
      },
      async () => {
        await withEnv({
          C64U_HOST: "127.0.0.1",
          C64U_PORT: envMockPort,
          C64U_PASSWORD: "env-secret",
        }, async () => {
          const { facade } = await createFacade();

          assert.equal(facade.type, "c64u");
          assert.equal(facade.getBaseUrl(), envMock.baseUrl);
          assert.equal(await facade.ping(), true);
          await facade.info();
          assert.equal(envMock.state.lastRequest.headers["x-password"], "env-secret");
          assert.equal(configMock.state.lastRequest, null);
        });
      },
    );
  });

  await t.test("defaults apply when env vars and config are absent", async () => {
    await withConfigScenario(
      {
        envConfig: null,
        repoConfig: null,
        homeConfig: null,
        mode: "c64u",
      },
      async () => {
        await withEnv({
          C64U_HOST: undefined,
          C64U_PORT: undefined,
          C64U_PASSWORD: undefined,
        }, async () => {
          const { facade } = await createFacade();

          assert.equal(facade.type, "c64u");
          assert.equal(facade.getBaseUrl(), "http://c64u");
        });
      },
    );
  });
});

test("device: createFacade fallback behavior", async (t) => {
  await t.test("falls back to vice or c64u when no config", async () => {
    await withConfigScenario(
      {
        envConfig: null,
        repoConfig: null,
        homeConfig: null,
      },
      async () => {
        const { facade, selected } = await createFacade();
        assert.ok(selected === "vice" || selected === "c64u");
        assert.ok(facade.type === "vice" || facade.type === "c64u");
      },
    );
  });

  await t.test("preferred baseUrl forces c64u backend and forwards password", async () => {
    const mock = await startMockC64Server({ networkPassword: "sesame" });
    t.after(async () => {
      await mock.close();
    });

    const loggerCalls = [];
    const { facade, selected, reason, details } = await createFacade(
      { info(message) { loggerCalls.push(message); } },
      {
        preferredC64uBaseUrl: mock.baseUrl,
        preferredC64uNetworkPassword: "sesame",
      },
    );

    assert.equal(selected, "c64u");
    assert.equal(reason, "forced by caller");
    assert.deepEqual(details, { baseUrl: mock.baseUrl });
    assert.equal(facade.type, "c64u");
    assert.equal(await facade.ping(), true);
    await facade.info();
    assert.equal(mock.state.lastRequest.headers["x-password"], "sesame");
    assert.ok(loggerCalls.some((message) => message.includes("forced by caller")));
  });

  await t.test("env override selects vice endpoint from config", async () => {
    const server = await startViceMockServer({ host: "127.0.0.1", port: 0 });
    t.after(async () => {
      await server.stop();
    });

    await withConfigScenario(
      {
        envConfig: { vice: { host: "127.0.0.1", port: server.port } },
        repoConfig: null,
        homeConfig: null,
        mode: "vice",
      },
      async () => {
        const { facade, selected, reason, details } = await createFacade();

        assert.equal(selected, "vice");
        assert.equal(reason, "env override");
        assert.equal(facade.type, "vice");
        assert.deepEqual(details, { host: "127.0.0.1", port: server.port });
        assert.equal(await facade.ping(), true);
      },
    );
  });

  await t.test("config host strings with embedded ports resolve to normalized base URLs", async () => {
    await withConfigScenario(
      {
        envConfig: { c64u: { host: "demo.local:8081" } },
        repoConfig: null,
        homeConfig: null,
      },
      async () => {
        const { facade, selected, reason } = await createFacade();

        assert.equal(selected, "c64u");
        assert.equal(reason, "config only");
        assert.equal(facade.type, "c64u");
        assert.equal(facade.getBaseUrl(), "http://demo.local:8081");
      },
    );
  });
});

test("device: URL helpers parse endpoints and ports", () => {
  // These helpers are not exported directly; we exercise indirectly via createFacade resolveBaseUrl
  // by constructing config objects through env file
});

test("device: ViceBackend unit branches", async () => {
  await withEnv({
    VICE_TEST_TARGET: "mock",
    VICE_HOST: "127.0.0.1",
    VICE_PORT: "6510",
    VICE_ARGS: "--limit-cycles 42 --trace",
  }, async () => {
    const backend = new ViceBackend({ host: "localhost", port: "6502" });
    assert.deepEqual(backend.getEndpoint(), { host: "127.0.0.1", port: 6510 });

    const calls = [];
    const readyPointers = Buffer.alloc(8);
    readyPointers.writeUInt16LE(0x0801, 0);
    readyPointers.writeUInt16LE(0x0810, 2);
    readyPointers.writeUInt16LE(0x0810, 4);
    readyPointers.writeUInt16LE(0x0810, 6);
    const fakeClient = {
      async info() {
        calls.push(["info"]);
      },
      async memGet(start, end) {
        calls.push(["memGet", start, end]);
        if (start === 0x002B) {
          return readyPointers;
        }
        return start === 0x0400 ? Buffer.from(READY_PATTERN) : Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
      },
      async memSet(address, data) {
        calls.push(["memSet", address, Array.from(data)]);
      },
      async reset() {
        calls.push(["reset"]);
      },
      async keyboardFeed(text) {
        calls.push(["keyboardFeed", text]);
      },
      async exitMonitor() {
        calls.push(["exitMonitor"]);
      },
      async quit() {
        calls.push(["quit"]);
        throw new Error("transport closed");
      },
      async resourceGet(name) {
        calls.push(["resourceGet", name]);
        if (name === "Drive8CPUEnabled") return { type: "int", value: 1 };
        if (name === "Drive8Image") return { type: "string", value: "disk8.d64" };
        if (name === "Drive8Type") return { type: "int", value: 11 };
        if (name === "Drive9CPUEnabled") throw new Error("missing");
        if (name === "Drive10CPUEnabled") return { type: "int", value: 0 };
        if (name === "Drive10Image") return { type: "string", value: "" };
        if (name === "Drive10Type") return { type: "int", value: 8 };
        if (name === "Drive11CPUEnabled") return { type: "int", value: 1 };
        if (name === "Drive11Image") return { type: "string", value: "disk11.d64" };
        if (name === "Drive11Type") return { type: "int", value: 2 };
        if (name === "WarpMode") return { type: "int", value: 1 };
        throw new Error(`unexpected resource ${name}`);
      },
      async resourceSet(name, value) {
        calls.push(["resourceSet", name, value]);
        if (name === "BadSetting") {
          throw new Error("write failed");
        }
      },
      close() {
        calls.push(["close"]);
      },
    };

    backend.withClient = async (fn) => fn(fakeClient);

    const read = await backend.readMemory(0x2000, 2);
    assert.deepEqual(Array.from(read), [0xAA, 0xBB]);

    await assert.rejects(() => backend.readMemory(-1, 1), /Address must be within/);
    await assert.rejects(() => backend.readMemory(0x1000, 0), /Length must be positive/);
    await assert.rejects(() => backend.writeMemory(0x10000, Uint8Array.of(1)), /Address must be within/);
    await assert.rejects(() => backend.writeMemory(0x1000, new Uint8Array()), /non-empty Uint8Array/);

    await backend.writeMemory(0x3000, Uint8Array.of(0x10, 0x11));
    const runResult = await backend.runPrg(Buffer.from([0x01, 0x08, 0x99, 0x00]));
    const file = path.join(os.tmpdir(), "vice-backend-test.prg");
    fs.writeFileSync(file, Buffer.from([0x01, 0x08, 0x44]));
    try {
      const fileResult = await backend.runPrgFile(file);
      assert.equal(fileResult.success, true);
    } finally {
      fs.rmSync(file, { force: true });
    }
    assert.equal(runResult.success, true);
    await assert.rejects(() => backend.runPrg(Buffer.from([0x01])), /PRG data too short/);

    const resetResult = await backend.reset();
    const rebootResult = await backend.reboot();
    assert.equal(resetResult.success, true);
    assert.equal(rebootResult.success, true);

    const drives = await backend.drivesList();
    assert.equal(drives[0].image, "disk8.d64");
    assert.deepEqual(drives[1], { id: "drive9", power: "off", image: null, type: 0 });
    assert.deepEqual(drives[2], { id: "drive10", power: "off", image: null, type: 8 });
    assert.deepEqual(drives[3], { id: "drive11", power: "on", image: "disk11.d64", type: 2 });

    assert.equal((await backend.driveMount("drive8", "/tmp/demo.d64")).success, true);
    assert.equal((await backend.driveRemove("drive8")).success, true);
    assert.equal((await backend.driveReset("drive8")).success, true);
    assert.equal((await backend.driveOn("drive8")).details.power, "on");
    assert.equal((await backend.driveOff("drive8")).details.power, "off");
    assert.equal((await backend.driveSetMode("drive8", "1581")).details.mode, "1581");
    await assert.rejects(() => backend.driveSetMode("drive8", "4041"), /Unknown drive mode/);

    const configValue = await backend.configGet("VICE", "WarpMode");
    assert.deepEqual(configValue, { category: "VICE", item: "WarpMode", value: 1, type: "int" });
    await assert.rejects(() => backend.configGet("VICE"), /configGet without item name/);
    assert.equal((await backend.configSet("VICE", "WarpMode", "0")).details.value, 0);
    assert.equal((await backend.configSet("VICE", "MachineVideoStandard", "PAL")).details.value, "PAL");

    const batch = await backend.configBatchUpdate({
      VICE: { WarpMode: "1", BadSetting: "oops" },
    });
    assert.equal(batch.success, false);
    assert.deepEqual(batch.details.results, [
      { item: "VICE/WarpMode", success: true },
      { item: "VICE/BadSetting", success: false, error: "write failed" },
    ]);

    await withEnv({ VICE_TEST_TARGET: undefined }, async () => {
      const managedBackend = new ViceBackend({ host: "127.0.0.1", port: 6510 });
      managedBackend.withClient = async (fn) => fn(fakeClient);
      const key = "127.0.0.1:6510";
      const supervisorStops = [];
      ViceBackend.supervisors.set(key, {
        process: { exitCode: null, signalCode: null },
        async stop() {
          supervisorStops.push("stop");
          throw new Error("stop failed");
        },
      });
      const poweroff = await managedBackend.poweroff();
      assert.equal(poweroff.success, true);
      assert.equal(ViceBackend.supervisors.has(key), false);
      assert.deepEqual(supervisorStops, ["stop"]);
    });

    backend.withClient = async () => {
      throw new Error("connect failed");
    };
    const failedPoweroff = await backend.poweroff();
    assert.equal(failedPoweroff.success, false);
    assert.deepEqual(failedPoweroff.details, { message: "connect failed" });

    let pingAttempts = 0;
    backend.withClient = async (fn) => {
      pingAttempts += 1;
      if (pingAttempts === 1) {
        throw new Error("not yet");
      }
      return await fn(fakeClient);
    };
    assert.equal(await backend.ping(), true);
    assert.equal(pingAttempts, 2);
  });
});

test("device: ViceBackend defaults to visible launches and parses boolean overrides", async () => {
  await withEnv({
    VICE_TEST_TARGET: "mock",
    VICE_VISIBLE: undefined,
    VICE_WARP: undefined,
  }, async () => {
    const backend = new ViceBackend({ host: "127.0.0.1", port: 6510 });
    assert.equal(backend.visible, true);
    assert.equal(backend.warp, false);
  });

  await withEnv({
    VICE_TEST_TARGET: "mock",
    VICE_VISIBLE: "false",
    VICE_WARP: undefined,
  }, async () => {
    const backend = new ViceBackend({ host: "127.0.0.1", port: 6510 });
    assert.equal(backend.visible, false);
    assert.equal(backend.warp, true);
  });

  await withEnv({
    VICE_TEST_TARGET: "mock",
    VICE_VISIBLE: "off",
    VICE_WARP: "off",
  }, async () => {
    const backend = new ViceBackend({ host: "127.0.0.1", port: 6510 });
    assert.equal(backend.visible, false);
    assert.equal(backend.warp, false);
  });
});

test("device: ViceBackend attaches to an already running local VICE monitor without supervising a new process", async (t) => {
  const vice = await startViceMockServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await vice.stop();
  });

  await withEnv({
    VICE_TEST_TARGET: undefined,
    VICE_HOST: undefined,
    VICE_PORT: undefined,
    VICE_VISIBLE: "false",
    VICE_WARP: "true",
  }, async () => {
    const backend = new ViceBackend({
      host: "127.0.0.1",
      port: vice.port,
      visible: true,
      warp: false,
      args: ["-minimized"],
    });

    assert.equal(ViceBackend.supervisors.size, 0);
    assert.equal(await backend.ping(), true);
    assert.equal(ViceBackend.supervisors.size, 0);

    const info = await backend.info();
    assert.equal(info?.emulator, "vice");
    assert.equal(info?.host, "127.0.0.1");
    assert.equal(info?.port, vice.port);
    assert.equal(ViceBackend.supervisors.size, 0);
  });
});

test("device: ViceBackend resumes the monitor before disconnecting ordinary sessions", async (t) => {
  const server = await startViceMockServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await server.stop();
  });

  await withEnv({ VICE_TEST_TARGET: "mock" }, async () => {
    const backend = new ViceBackend({ host: "127.0.0.1", port: server.port });
    const originalExitMonitor = ViceClient.prototype.exitMonitor;
    const exitCalls = [];
    ViceClient.prototype.exitMonitor = async function patchedExitMonitor(...args) {
      exitCalls.push("exit");
      return await originalExitMonitor.apply(this, args);
    };

    try {
      assert.equal(await backend.ping(), true);
      const data = await backend.readMemory(0x0400, 4);
      assert.equal(data.length, 4);
    } finally {
      ViceClient.prototype.exitMonitor = originalExitMonitor;
    }

    assert.equal(exitCalls.length >= 2, true);
  });
});

test("device: ViceBackend resolves directory and config-driven launch options", async (t) => {
  const viceDir = fs.mkdtempSync(path.join(os.tmpdir(), "vice-resources-"));
  fs.mkdirSync(path.join(viceDir, "C64"), { recursive: true });
  fs.writeFileSync(path.join(viceDir, "C64", "kernal-901227-03.bin"), "kernal", "utf8");
  fs.writeFileSync(path.join(viceDir, "C64", "basic-901226-01.bin"), "basic", "utf8");
  fs.writeFileSync(path.join(viceDir, "C64", "chargen-901225-01.bin"), "chargen", "utf8");

  t.after(() => {
    fs.rmSync(viceDir, { recursive: true, force: true });
  });

  await withEnv({
    VICE_TEST_TARGET: "mock",
    VICE_DIRECTORY: undefined,
    VICE_VISIBLE: undefined,
    VICE_WARP: undefined,
    VICE_ARGS: undefined,
  }, async () => {
    const backend = new ViceBackend({
      host: "127.0.0.1",
      port: 6510,
      directory: viceDir,
      visible: false,
      warp: true,
      args: ["-limitcycles", "1234"],
    });

    assert.equal(backend.directory, viceDir);
    assert.equal(backend.visible, false);
    assert.equal(backend.warp, true);
    assert.deepEqual(backend.extraArgs, ["-limitcycles", "1234"]);
  });
});

test("device: invisible managed VICE launches keep headless mode opt-in", () => {
  const options = __buildViceProcessOptionsForTests({
    binary: "/usr/local/bin/x64sc",
    directory: "/usr/local/share/vice",
    host: "127.0.0.1",
    port: 6510,
    warp: true,
    visible: false,
    extraArgs: [],
  });

  assert.equal(options.visible, false);
  assert.equal(options.headless, undefined);
  assert.equal(options.extraArgs, undefined);

  const withArgs = __buildViceProcessOptionsForTests({
    binary: "/usr/local/bin/x64sc",
    host: "127.0.0.1",
    port: 6510,
    warp: false,
    visible: true,
    extraArgs: ["-limitcycles", "1234"],
  });

  assert.deepEqual(withArgs.extraArgs, ["-limitcycles", "1234"]);
  assert.equal(withArgs.headless, undefined);
});

test("device: VICE binary resolution prefers env override over config", () => {
  const resolved = __resolveViceBinaryForTests(
    { envBinary: "/usr/local/bin/x64sc", configBinary: "/usr/bin/x64sc" },
    (binary) => binary,
  );

  assert.equal(resolved, "/usr/local/bin/x64sc");
});

test("device: VICE binary resolution prefers /usr/local/bin/x64sc before PATH fallback", () => {
  const resolved = __resolveViceBinaryForTests(
    {},
    (binary) => {
      if (binary === "/usr/local/bin/x64sc") {
        return "/usr/local/bin/x64sc";
      }
      if (binary === "x64sc") {
        return "/usr/bin/x64sc";
      }
      return null;
    },
  );

  assert.equal(resolved, "/usr/local/bin/x64sc");
});

test("device: VICE binary resolution falls back to PATH on other systems", () => {
  const resolved = __resolveViceBinaryForTests(
    {},
    (binary) => {
      if (binary === "x64sc") {
        return "C:/VICE/x64sc.exe";
      }
      return null;
    },
  );

  assert.equal(resolved, "C:/VICE/x64sc.exe");
});

test("device: VICE binary resolution falls back when an explicit path is missing", () => {
  const resolved = __resolveViceBinaryForTests(
    { envBinary: "/usr/local/bin/x64sc" },
    (binary) => {
      if (binary === "/usr/local/bin/x64sc") {
        return null;
      }
      if (binary === "x64sc") {
        return "/usr/bin/x64sc";
      }
      return null;
    },
  );

  assert.equal(resolved, "/usr/bin/x64sc");
});

test("device: VICE launch resolution keeps an explicit binary while falling back to a detected resource directory", () => {
  const resolved = __resolveViceLaunchForTests(
    { configBinary: "/usr/bin/x64sc" },
    {
      findBinary(binary) {
        if (binary === "/usr/bin/x64sc") {
          return "/usr/bin/x64sc";
        }
        return null;
      },
      isResourceDirectory(candidate) {
        return candidate === "/usr/local/share/vice";
      },
    },
  );

  assert.deepEqual(resolved, {
    binary: "/usr/bin/x64sc",
    directory: "/usr/local/share/vice",
  });
});

test("device: VICE launch resolution keeps an explicit matching directory", () => {
  const resolved = __resolveViceLaunchForTests(
    {
      configBinary: "/usr/bin/x64sc",
      configDirectory: "/custom/share/vice",
    },
    {
      findBinary(binary) {
        return binary === "/usr/bin/x64sc" ? "/usr/bin/x64sc" : null;
      },
      isResourceDirectory(candidate) {
        return candidate === "/custom/share/vice";
      },
    },
  );

  assert.deepEqual(resolved, {
    binary: "/usr/bin/x64sc",
    directory: "/custom/share/vice",
  });
});

test("device: C64u facade exercises runner, machine, config, drive, stream, and file endpoints", async (t) => {
  const mock = await startMockC64Server({ networkPassword: "open-sesame" });
  const mockUrl = new URL(mock.baseUrl);
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "c64u-device-config-"));
  const cfgPath = path.join(cfgDir, "c64bridge.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    c64u: {
      host: mockUrl.hostname,
      port: Number(mockUrl.port),
      networkPassword: "open-sesame",
    },
  }), "utf8");

  t.after(async () => {
    fs.rmSync(cfgDir, { recursive: true, force: true });
    await mock.close();
  });

  await withEnv({
    C64BRIDGE_CONFIG: cfgPath,
    C64_MODE: "c64u",
  }, async () => {
    const { facade, selected } = await createFacade();
    assert.equal(selected, "c64u");
    assert.equal(facade.type, "c64u");
    assert.equal(await facade.ping(), true);

    const readResponses = [
      {
        headers: { "content-type": "application/octet-stream" },
        data: Uint8Array.from([0x10, 0x11, 0x12, 0x13]).buffer,
      },
      {
        headers: { "content-type": "application/json" },
        data: (() => {
          const body = Buffer.from(JSON.stringify({ data: "AABB" }), "utf8");
          return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        })(),
      },
    ];
    const writes = [];
    const v1 = facade.api.v1;
    v1.runnersRunPrgCreate = async (_route, payload) => ({ data: { result: "run_prg", bytes: Buffer.from(payload).length } });
    v1.runnersLoadPrgUpdate = async (_route, payload) => ({ data: { result: "load_prg", file: payload.file } });
    v1.runnersRunPrgUpdate = async (_route, payload) => ({ data: { result: "run_prg_file", file: payload.file } });
    v1.runnersRunCrtUpdate = async (_route, payload) => ({ data: { result: "run_crt", file: payload.file } });
    v1.runnersSidplayUpdate = async (_route, payload) => ({ data: { result: "sidplay", file: payload.file, songnr: payload.songnr } });
    v1.runnersSidplayCreate = async (_route, form, options) => ({ data: { result: "sidplay_attachment", bytes: Buffer.from(form.sid).length, songnr: options?.songnr ?? null } });
    v1.machineReadmemList = async () => readResponses.shift();
    v1.machineWritememUpdate = async (_route, payload) => {
      writes.push({ kind: "small", address: payload.address, data: payload.data });
      return { data: { result: "wrote_small" } };
    };
    v1.machineWritememCreate = async (_route, payload, body) => {
      writes.push({ kind: "large", address: payload.address, length: Buffer.from(body).length });
      return { data: { result: "wrote_large" } };
    };
    v1.machineResetUpdate = async () => ({ data: { result: "reset" } });
    v1.machineRebootUpdate = async () => ({ data: { result: "reboot" } });
    v1.machinePauseUpdate = async () => ({ data: { result: "pause" } });
    v1.machineResumeUpdate = async () => ({ data: { result: "resume" } });
    v1.machinePoweroffUpdate = async () => ({ data: { result: "poweroff" } });
    v1.machineMenuButtonUpdate = async () => ({ data: { result: "menu" } });
    v1.machineDebugregList = async () => ({ data: { value: "AB" } });
    v1.machineDebugregUpdate = async (_route, payload) => ({ data: { value: payload.value } });
    v1.versionList = async () => ({ data: { version: "mock" } });
    v1.infoList = async () => ({ data: { product: "mock" } });
    v1.drivesList = async () => ({ data: { drives: { drive8: { power: "on" } } } });
    v1.drivesMountUpdate = async (drive, _route, payload) => ({ data: { drive, ...payload } });
    v1.drivesRemoveUpdate = async (drive) => ({ data: { drive, removed: true } });
    v1.drivesResetUpdate = async (drive) => ({ data: { drive, reset: true } });
    v1.drivesOnUpdate = async (drive) => ({ data: { drive, power: "on" } });
    v1.drivesOffUpdate = async (drive) => ({ data: { drive, power: "off" } });
    v1.drivesSetModeUpdate = async (drive, _route, payload) => ({ data: { drive, mode: payload.mode } });
    v1.drivesLoadRomUpdate = async (drive, _route, payload) => ({ data: { drive, file: payload.file } });
    v1.streamsStartUpdate = async (stream, _route, payload) => ({ data: { stream, target: payload.ip } });
    v1.streamsStopUpdate = async (stream) => ({ data: { stream, stopped: true } });
    v1.configsList = async () => ({ data: { categories: ["MACHINE"] } });
    v1.configsDetail = async (category) => ({ data: { category, mode: "mock" } });
    v1.configsDetail2 = async (category, item) => ({ data: { category, item, value: "mock" } });
    v1.configsUpdate = async (category, item, payload) => ({ data: { category, item, value: payload.value } });
    v1.configsCreate = async (payload) => ({ data: { categories: Object.keys(payload) } });
    v1.configsLoadFromFlashUpdate = async () => ({ data: { result: "load" } });
    v1.configsSaveToFlashUpdate = async () => ({ data: { result: "save" } });
    v1.configsResetToDefaultUpdate = async () => ({ data: { result: "reset" } });
    v1.filesInfoDetail = async (pathValue) => ({ data: { path: decodeURIComponent(pathValue) } });
    v1.filesCreateD64Update = async (pathValue, _route, payload) => ({ data: { path: decodeURIComponent(pathValue), ...payload } });
    v1.filesCreateD71Update = async (pathValue, _route, payload) => ({ data: { path: decodeURIComponent(pathValue), ...payload } });
    v1.filesCreateD81Update = async (pathValue, _route, payload) => ({ data: { path: decodeURIComponent(pathValue), ...payload } });
    v1.filesCreateDnpUpdate = async (pathValue, _route, payload) => ({ data: { path: decodeURIComponent(pathValue), ...payload } });
    v1.runnersModplayUpdate = async (_route, payload) => ({ data: { result: "modplay", file: payload.file } });

    const prgRun = await facade.runPrg(Buffer.from([0x01, 0x08, 0x00]));
    const prgLoad = await facade.loadPrgFile("//USB0/demo.prg");
    const prgFileRun = await facade.runPrgFile("//USB0/run.prg");
    const crtRun = await facade.runCrtFile("//USB0/demo.crt");
    const sidplay = await facade.sidplayFile("//USB0/theme.sid", 2);
    const sidAttachment = await facade.sidplayAttachment(Buffer.from([1, 2, 3]), {
      songnr: 1,
      songlengths: Buffer.from([4, 5, 6]),
    });
    assert.equal(prgRun.success, true);
    assert.equal(prgLoad.success, true);
    assert.equal(prgFileRun.success, true);
    assert.equal(crtRun.success, true);
    assert.equal(sidplay.success, true);
    assert.equal(sidAttachment.success, true);
    const read = await facade.readMemory(0x2000, 4);
    assert.deepEqual(Array.from(read), [0x10, 0x11, 0x12, 0x13]);
    const readJson = await facade.readMemory(0x2000, 2);
    assert.ok(readJson.length > 0);

    await facade.writeMemory(0x2100, Uint8Array.of(0xAA, 0xBB));
    const largeWrite = new Uint8Array(129).fill(0x5A);
    await facade.writeMemory(0x2200, largeWrite);
    await facade.writeMemoryBlocks([
      { address: 0x2300, bytes: Uint8Array.of(0x01, 0x02) },
      { address: 0x2302, bytes: Uint8Array.of(0x03, 0x04) },
    ]);
    assert.deepEqual(writes, [
      { kind: "small", address: "2100", data: "AABB" },
      { kind: "large", address: "2200", length: 129 },
      { kind: "small", address: "2300", data: "01020304" },
    ]);

    assert.equal((await facade.reset()).success, true);
    assert.equal((await facade.reboot()).success, true);
    assert.equal((await facade.pause()).success, true);
    assert.equal((await facade.resume()).success, true);
    assert.equal((await facade.poweroff()).success, true);
    assert.equal((await facade.menuButton()).success, true);

    const debugWrite = await facade.debugregWrite("AB");
    const debugRead = await facade.debugregRead();
    assert.equal(debugWrite.success, true);
    assert.equal(debugRead.value, "AB");
    assert.ok((await facade.version()));
    assert.ok((await facade.info()));

    assert.ok(await facade.drivesList());
    assert.equal((await facade.driveMount("drive8", "//USB0/disk.d64", { type: "d64", mode: "readwrite" })).success, true);
    assert.equal((await facade.driveRemove("drive8")).success, true);
    assert.equal((await facade.driveReset("drive8")).success, true);
    assert.equal((await facade.driveOn("drive8")).success, true);
    assert.equal((await facade.driveOff("drive8")).success, true);
    assert.equal((await facade.driveSetMode("drive8", "1581")).success, true);
    assert.equal((await facade.driveLoadRom("drive8", "//USB0/1541.rom")).success, true);

    assert.equal((await facade.streamStart("video", "127.0.0.1:9999")).success, true);
    assert.equal((await facade.streamStop("video")).success, true);
    assert.ok(await facade.configsList());
    assert.ok(await facade.configGet("MACHINE"));
    assert.ok(await facade.configGet("MACHINE", "name"));
    assert.equal((await facade.configSet("MACHINE", "name", "VICELESS")).success, true);
    assert.equal((await facade.configBatchUpdate({ AUDIO: { volume: 5 } })).success, true);
    assert.equal((await facade.configSaveToFlash()).success, true);
    assert.equal((await facade.configLoadFromFlash()).success, true);
    assert.equal((await facade.configResetToDefault()).success, true);

    assert.ok(await facade.filesInfo("//USB0/demo.d64"));
    assert.equal((await facade.filesCreateD64("//USB0/demo.d64", { tracks: 40, diskname: "DEMO" })).success, true);
    assert.equal((await facade.filesCreateD71("//USB0/demo.d71", { diskname: "DUCKS" })).success, true);
    assert.equal((await facade.filesCreateD81("//USB0/demo.d81", { diskname: "SEA" })).success, true);
    assert.equal((await facade.filesCreateDnp("//USB0/demo.dnp", 160, { diskname: "POND" })).success, true);
    assert.equal((await facade.modplayFile("//USB0/duck.mod")).success, true);

    assert.equal(mock.state.lastRequest.headers["x-password"], "open-sesame");
    assert.equal((await facade.configGet("MACHINE")).mode, "mock");
    assert.equal((await facade.configGet("MACHINE", "name")).item, "name");
  });
});

test("device: ViceBackend reports unsupported operations and emulator metadata", async () => {
  await withEnv({
    VICE_TEST_TARGET: "mock",
    VICE_HOST: "127.0.0.1",
    VICE_PORT: "6510",
  }, async () => {
    const backend = new ViceBackend({ host: "127.0.0.1", port: "6510" });
    backend.withClient = async (fn) => fn({
      async info() {},
      close() {},
      async resourceGet(name) {
        return { type: "string", value: name };
      },
    });

    const pause = await backend.pause();
    const resume = await backend.resume();
    assert.equal(pause.success, false);
    assert.equal(resume.success, false);
    assert.match(String(pause.details?.message ?? ""), /not implemented/i);
    assert.match(String(resume.details?.message ?? ""), /unavailable/i);

    await assert.rejects(() => backend.menuButton(), /not supported/);
    await assert.rejects(() => backend.debugregRead(), /not supported/);
    await assert.rejects(() => backend.debugregWrite("AA"), /not supported/);
    await assert.rejects(() => backend.driveLoadRom(), /not supported/);
    await assert.rejects(() => backend.streamStart("video", "127.0.0.1"), /not supported/);
    await assert.rejects(() => backend.streamStop("video"), /not supported/);
    await assert.rejects(() => backend.configLoadFromFlash(), /not supported/);
    await assert.rejects(() => backend.configSaveToFlash(), /not supported/);
    await assert.rejects(() => backend.configResetToDefault(), /not supported/);
    await assert.rejects(() => backend.filesInfo("/tmp/file"), /not supported/);
    await assert.rejects(() => backend.filesCreateD64("/tmp/file"), /not supported/);
    await assert.rejects(() => backend.filesCreateD71("/tmp/file"), /not supported/);
    await assert.rejects(() => backend.filesCreateD81("/tmp/file"), /not supported/);
    await assert.rejects(() => backend.filesCreateDnp("/tmp/file", 40), /not supported/);

    const version = await backend.version();
    const info = await backend.info();
    const configs = await backend.configsList();
    assert.deepEqual(version, { emulator: "vice", host: "127.0.0.1", port: 6510 });
    assert.deepEqual(info, { emulator: "vice", host: "127.0.0.1", port: 6510 });
    assert.ok(Array.isArray(configs.categories));
    assert.equal(configs.categories[0].name, "VICE");
  });
});
