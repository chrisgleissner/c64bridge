import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toolRegistry } from "../src/tools/registry/index.js";
import { ToolUnsupportedPlatformError } from "../src/tools/errors.js";
import { C64Client } from "../src/c64Client.js";
import { ViceBackend } from "../src/device.js";
import { ViceClient } from "../src/vice/viceClient.js";
import { startViceMockServer } from "../src/vice/mockServer.js";
import { createLogger } from "./meta/helpers.mjs";

const platforms = ["c64u", "u2", "vice"];
const score = `song: { title: Capability Test, mode: PAL, tempo: 120 }
voices:
  - id: 1
    waveform: triangle
    patterns:
      main: { notes: [C4, E4, G4] }
timeline:
  - bars: 1
    layers: { v1: main }
`;
const analysis = { analysis: { source: "microphone", durationSeconds: 1, voices: [], global_metrics: { average_rms: 0.05, max_rms: 0.08 } } };
function context(platform, client) {
  return { client, platform: { id: platform, features: [], limitedFeatures: [] }, rag: {}, logger: createLogger(), setPlatform() {} };
}
async function withDirectory(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "c64bridge-capabilities-"));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

// This matrix states device constraints independently of implementation metadata.
// Exercise every rejected operation through the public registry with no client I/O.
const restrictions = {
  c64_program: { load_prg: ["c64u", "u2"], run_crt: ["c64u", "u2"] },
  c64_sound: { capture_samples: ["c64u"], play_sid_file: ["c64u", "u2"], play_mod_file: ["c64u", "u2"] },
  c64_system: { pause: ["c64u", "u2"], resume: ["c64u", "u2"], menu: ["c64u", "u2"], read_menu_screen: ["c64u", "u2"], poweroff: ["c64u", "vice"] },
  c64_graphics: { capture_frame: ["c64u", "vice"] },
  c64_drive: { load_rom: ["c64u", "u2"] },
  c64_disk: { file_info: ["c64u", "u2"], create_image: ["c64u", "u2"], find_and_run: ["c64u", "u2"] },
  c64_config: { load_flash: ["c64u", "u2"], save_flash: ["c64u", "u2"], reset_defaults: ["c64u", "u2"], read_debugreg: ["c64u"], write_debugreg: ["c64u"], shuffle: ["c64u", "u2"] },
  c64_extract: { fs_stats: ["c64u", "u2"] },
  c64_input: { keyboard: ["c64u"], release_all: ["c64u"], state: ["c64u"], joystick: ["c64u", "vice"] },
};
for (const [name, operations] of Object.entries(restrictions)) {
  for (const [op, supported] of Object.entries(operations)) {
    for (const platform of platforms.filter((platform) => !supported.includes(platform))) {
      test(`${name}.${op} rejects ${platform} before device I/O and declares the constraint`, async () => {
        const descriptor = toolRegistry.list().find((tool) => tool.name === name);
        assert.deepEqual([...descriptor.metadata.operationPlatforms[op]].sort(), [...supported].sort());
        let accesses = 0;
        const client = new Proxy({}, { get() { accesses++; throw new Error("unexpected client access"); } });
        await assert.rejects(() => toolRegistry.invoke(name, { op }, context(platform, client)), (error) => error instanceof ToolUnsupportedPlatformError);
        assert.equal(accesses, 0);
      });
    }
  }
}

for (const platform of platforms) {
  test(`artifact bundles on ${platform} preserve screen/memory and select a supported debug capture default`, async () => withDirectory(async (dir) => {
    let debugReads = 0;
    const result = await toolRegistry.invoke("c64_program", { op: "bundle_run", runId: "sample", outputPath: dir, memoryRanges: [{ address: "$0400", length: 2 }] }, context(platform, {
      async readScreen() { return "HELLO C64"; },
      async readMemory() { return { success: true, data: "$AABB" }; },
      async debugregRead() { debugReads++; assert.equal(platform, "c64u"); return { success: true, value: "1234" }; },
    }));
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const { artifacts } = result.structuredContent.data;
    assert.equal(await fs.readFile(artifacts.screen, "utf8"), "HELLO C64");
    assert.equal(await fs.readFile(artifacts.memory_range_0, "utf8"), "$AABB");
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "sample", "manifest.json"), "utf8"));
    assert.deepEqual(manifest.artifacts, artifacts);
    assert.equal(debugReads, platform === "c64u" ? 1 : 0);
    assert.equal(Boolean(artifacts.debugreg), platform === "c64u");
  }));

  test(`preset routing on ${platform} analyzes actual audio and restores the active backend`, async () => {
    const switches = [];
    const recordings = [];
    const result = await toolRegistry.invoke("c64_sound", { op: "play_preset", platforms: [platform], waitBeforeCaptureMs: 0, analysisDurationSeconds: 1 }, context(platform, {
      async getActiveBackendType() { return platform; }, getAvailableBackends() { return [platform]; },
      switchBackend(backend) { switches.push(backend); }, async sidSilenceAll() { return { success: true }; },
      async runPrg(prg) { assert.ok(prg.length > 100); return { success: true }; },
      async recordAndAnalyzeAudio(options) { recordings.push(options); return analysis; },
    }));
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(switches, [platform, platform]);
    assert.equal(recordings.length, 1);
    assert.equal(recordings[0].durationSeconds, 1);
    assert.ok(recordings[0].expectedSidwave.includes("voices:"));
    assert.equal(result.structuredContent.data.results[0].verification.mode, "audio-analysis");
    assert.equal(result.structuredContent.data.results[0].verification.maxRms, 0.08);
  });

  test(`PRG analysis pipeline dispatches and verifies on ${platform}`, async () => {
    const events = [];
    const result = await toolRegistry.invoke("c64_sound", { op: "pipeline", sidwave: score, verifySilenceBefore: false, verifySilenceAfter: false, waitBeforeCaptureMs: 0, analysisDurationSeconds: 1 }, context(platform, {
      async runPrg(prg) { events.push("play"); assert.ok(prg.length > 100); return { success: true }; },
      async recordAndAnalyzeAudio() { events.push("analyze"); return analysis; },
      async sidSilenceAll() { return { success: true }; },
    }));
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(events, ["play", "analyze"]);
  });

  test(`memory extraction on ${platform} writes exact bytes and skips unsupported VICE pause`, async () => withDirectory(async (dir) => {
    const events = [];
    const result = await toolRegistry.invoke("c64_extract", { op: "memory_dump", address: "$2000", length: 4, outputPath: path.join(dir, "dump.bin"), format: "binary" }, context(platform, {
      async pause() { events.push("pause"); assert.notEqual(platform, "vice"); return { success: true }; },
      async resume() { events.push("resume"); return { success: true }; },
      async readMemory(address, length) { events.push("read"); assert.equal(address, "$2000"); assert.equal(length, "4"); return { success: true, data: "$00117FFF" }; },
    }));
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual([...await fs.readFile(path.join(dir, "dump.bin"))], [0, 17, 127, 255]);
    assert.deepEqual(events, platform === "vice" ? ["read"] : ["pause", "read", "resume"]);
  }));
}

for (const platform of ["u2", "vice"]) {
  test(`explicit debug register bundling on ${platform} fails before creating files or reading the device`, async () => withDirectory(async (dir) => {
    const outputPath = path.join(dir, "must-not-exist");
    let reads = 0;
    const result = await toolRegistry.invoke("c64_program", { op: "bundle_run", runId: "sample", outputPath, captureDebugReg: true }, context(platform, {
      async readScreen() { reads++; }, async debugregRead() { reads++; },
    }));
    assert.equal(result.metadata.error.code, "unsupported_platform");
    assert.equal(reads, 0);
    await assert.rejects(() => fs.access(outputPath));
  }));

  test(`preset verify:false on ${platform} launches without requiring audio dependencies`, async () => {
    let recordings = 0;
    const result = await toolRegistry.invoke("c64_sound", { op: "play_preset", verify: false }, context(platform, {
      async getActiveBackendType() { return platform; }, getAvailableBackends() { return [platform]; }, switchBackend() {},
      async sidSilenceAll() { return { success: true }; }, async runPrg() { return { success: true }; },
      async recordAndAnalyzeAudio() { recordings++; throw new Error("no audio input"); },
    }));
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(recordings, 0);
    assert.equal(result.structuredContent.data.results[0].verification, null);
  });
}

test("U2 frame capture fails before allocating a stream session", async () => {
  const client = Object.create(C64Client.prototype);
  client.facadePromise = Promise.resolve({ type: "u2" });
  let captures = 0;
  client.captureC64uVideoFrames = async () => { captures++; };
  await assert.rejects(() => client.captureFrames(), /U2 has no video stream/);
  assert.equal(captures, 0);
});

test("U2-only greeting defaults to configured backends and verifies text without capturing video", async () => {
  let text = "";
  let captures = 0;
  const result = await toolRegistry.invoke("c64_program", { op: "cross_platform_greeting" }, context("u2", {
    getAvailableBackends() { return ["u2"]; }, async getActiveBackendType() { return "u2"; }, switchBackend() {},
    async renderGreetingScreen({ message }) { text = message; return { success: true }; }, async readScreen() { return text; },
    async captureFrames() { captures++; throw new Error("U2 has no stream"); },
  }));
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(result.metadata.backends, ["u2"]);
  assert.equal(result.structuredContent.data.results[0].verification.screenContainsExpectedText, true);
  assert.equal(result.structuredContent.data.results[0].verification.screenshotCaptured, undefined);
  assert.equal(captures, 0);
});

test("explicit U2 screenshot requests reject before switching or rendering any backend", async () => {
  let effects = 0;
  const result = await toolRegistry.invoke("c64_program", { op: "cross_platform_greeting", platforms: ["vice", "u2"], captureScreenshot: true }, context("vice", {
    getAvailableBackends() { return ["vice", "u2"]; }, switchBackend() { effects++; }, async renderGreetingScreen() { effects++; },
  }));
  assert.equal(result.metadata.error.code, "unsupported_platform");
  assert.equal(effects, 0);
});

for (const op of ["pipeline", "compile_play"]) {
  test(`VICE ${op} SID playback rejects before silencing, recording, or launching`, async () => {
    let effects = 0;
    const result = await toolRegistry.invoke("c64_sound", { op, sidwave: score, output: "sid" }, context("vice", {
      async sidSilenceAll() { effects++; }, async recordAndAnalyzeAudio() { effects++; }, async sidplayAttachment() { effects++; },
    }));
    assert.equal(result.metadata.error.code, "unsupported_platform");
    assert.equal(effects, 0);
  });
}

test("VICE can export SID files without playback", async () => {
  const result = await toolRegistry.invoke("c64_sound", { op: "compile_play", sidwave: score, output: "sid", dryRun: true }, context("vice", {}));
  assert.equal(result.isError, undefined, JSON.stringify(result));
});

test("VICE flash restore rejects before filesystem access or configuration mutation", async () => withDirectory(async (dir) => {
  let effects = 0;
  const parent = path.join(dir, "must-not-exist");
  const result = await toolRegistry.invoke("c64_config", { op: "restore", path: path.join(parent, "missing.json"), applyToFlash: true }, context("vice", {
    async configBatchUpdate() { effects++; }, async configSaveToFlash() { effects++; },
  }));
  assert.equal(result.metadata.error.code, "unsupported_platform");
  assert.equal(effects, 0);
  await assert.rejects(() => fs.access(parent));
}));

test("unmanaged VICE power cycle never quits an emulator that it cannot restart", async () => {
  const backend = Object.create(ViceBackend.prototype);
  backend.manageProcess = false;
  let effects = 0;
  backend.poweroff = async () => { effects++; return { success: true }; };
  backend.ensureProcess = async () => { effects++; };
  const result = await backend.powerCycle();
  assert.equal(result.success, false);
  assert.equal(result.details.code, "UNSUPPORTED");
  assert.equal(effects, 0);
});

test("managed VICE power cycle shuts down then starts and propagates shutdown errors", async () => {
  const backend = Object.create(ViceBackend.prototype);
  backend.manageProcess = true;
  const events = [];
  backend.poweroff = async () => { events.push("stop"); return { success: true }; };
  backend.ensureProcess = async () => { events.push("start"); };
  assert.equal((await backend.powerCycle()).success, true);
  assert.deepEqual(events, ["stop", "start"]);
  backend.poweroff = async () => ({ success: false, details: { message: "stop failed" } });
  assert.equal((await backend.powerCycle()).success, false);
  assert.deepEqual(events, ["stop", "start"]);
});

for (const options of [{ type: "d64" }, { mode: "readonly" }, { mode: "unlinked" }]) {
  test(`VICE disk mount refuses unsupported ${JSON.stringify(options)} before modifying resources`, async () => {
    const backend = Object.create(ViceBackend.prototype);
    let effects = 0;
    backend.withClient = async () => { effects++; };
    await assert.rejects(() => backend.driveMount("drive8", "demo.d64", options), /omit these options on VICE/);
    assert.equal(effects, 0);
  });
}

test("VICE configuration snapshot/diff/restore round-trips integers and numeric-looking strings over Binary Monitor", async () => withDirectory(async (dir) => {
  const server = await startViceMockServer();
  const backend = Object.create(ViceBackend.prototype);
  backend.withClient = async (fn) => {
    const client = new ViceClient();
    try { await client.connect(server.port, "127.0.0.1"); return await fn(client); } finally { client.close(); }
  };
  backend.info = async () => ({ emulator: "vice" });
  try {
    const inventory = await backend.configsList();
    const client = new ViceClient();
    try {
      await client.connect(server.port, "127.0.0.1");
      for (const item of inventory.categories[0].items) await client.resourceSet(item, item.includes("Image") ? "1541" : 1);
    } finally { client.close(); }
    const ctx = context("vice", backend);
    const file = path.join(dir, "config.json");
    assert.equal((await toolRegistry.invoke("c64_config", { op: "snapshot", path: file }, ctx)).isError, undefined);
    const snapshot = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(snapshot.categories.VICE.WarpMode, 1);
    assert.equal(snapshot.categories.VICE.Drive8Image, "1541");
    const category = await toolRegistry.invoke("c64_config", { op: "get", category: "VICE" }, ctx);
    assert.equal(category.isError, undefined);
    assert.deepEqual(await backend.configGet("VICE"), snapshot.categories.VICE);
    await backend.configSet("VICE", "WarpMode", "0");
    await backend.configSet("VICE", "Drive8Image", "changed.d64");
    assert.equal((await toolRegistry.invoke("c64_config", { op: "diff", path: file }, ctx)).metadata.changed, 1);
    assert.equal((await toolRegistry.invoke("c64_config", { op: "restore", path: file }, ctx)).isError, undefined);
    assert.deepEqual(await backend.configGet("VICE"), snapshot.categories.VICE);
    assert.equal((await toolRegistry.invoke("c64_config", { op: "diff", path: file }, ctx)).metadata.changed, 0);
  } finally { await server.stop(); }
}));

for (const platform of platforms) {
  test(`failed program launches on ${platform} count as batch errors, never passes`, async () => withDirectory(async (dir) => {
    let runs = 0;
    const result = await toolRegistry.invoke("c64_program", { op: "batch_run", programs: [{ path: "first.prg" }, { path: "second.prg" }], durationMs: 1, resetDelayMs: 0, outputPath: dir }, context(platform, {
      async runPrgFile() { runs++; return { success: false, details: { reason: "launch failure" } }; },
      async reset() { return { success: true }; },
    }));
    assert.equal(result.metadata.success, false);
    assert.equal(result.structuredContent.data.summary.passed, 0);
    assert.equal(result.structuredContent.data.summary.errors, 1);
    assert.equal(runs, 1);
    const report = JSON.parse(await fs.readFile(result.structuredContent.data.reportPath, "utf8"));
    assert.equal(report.results[0].status, "error");
    assert.match(report.results[0].error, /PRG playback failed/);
  }));

  test(`c64_batch respects failed result metadata on ${platform} and stops before the next command`, async () => {
    let reads = 0;
    const result = await toolRegistry.invoke("c64_batch", { commands: [
      { tool: "c64_extract", args: { op: "firmware_health" } },
      { tool: "c64_memory", args: { op: "read", address: "$0400", length: 1 } },
    ] }, context(platform, {
      async getActiveBackendType() { return platform; }, async version() { return {}; }, async info() { throw new Error("unreachable"); },
      async readMemory() { reads++; return { success: true, data: "$00" }; },
    }));
    assert.equal(result.metadata.success, false);
    assert.equal(result.structuredContent.data.failed, 1);
    assert.equal(result.structuredContent.data.executed, 1);
    assert.equal(reads, 1);
  });
}

test("VICE batch CRT request is rejected before any preceding PRG launch or output creation", async () => withDirectory(async (dir) => {
  const outputPath = path.join(dir, "must-not-exist");
  let effects = 0;
  const result = await toolRegistry.invoke("c64_program", { op: "batch_run", programs: [{ path: "first.prg" }, { path: "second.CRT" }], outputPath }, context("vice", {
    async runPrgFile() { effects++; }, async runCrtFile() { effects++; }, async reset() { effects++; },
  }));
  assert.equal(result.metadata.error.code, "unsupported_platform");
  assert.equal(effects, 0);
  await assert.rejects(() => fs.access(outputPath));
}));

test("c64_batch uses its client's active backend even when another context last changed the global platform", async () => {
  let effects = 0;
  const result = await toolRegistry.invoke("c64_batch", { commands: [{ tool: "c64_system", args: { op: "poweroff" } }] }, context("c64u", {
    async getActiveBackendType() { return "u2"; }, async poweroff() { effects++; return { success: true }; },
  }));
  assert.equal(result.structuredContent.data.failed, 1);
  assert.equal(effects, 0);
});

test("VICE resource writes honor booleans, preserve numeric strings, and reject fractional/out-of-range integers", async () => {
  const backend = Object.create(ViceBackend.prototype);
  const writes = [];
  backend.withClient = async (fn) => fn({
    async resourceGet(item) { return { type: item === "Label" ? "string" : "int", value: item === "Label" ? "1541" : 1 }; },
    async resourceSet(item, value) { writes.push([item, value]); },
  });
  await backend.configSet("VICE", "WarpMode", "true");
  await backend.configBatchUpdate({ VICE: { WarpMode: false, Label: "1541" } });
  assert.deepEqual(writes, [["WarpMode", 1], ["WarpMode", 0], ["Label", "1541"]]);
  for (const value of ["0.5", "NaN", "Infinity", "2147483648", "-2147483649"]) {
    await assert.rejects(() => backend.configSet("VICE", "WarpMode", value), /32-bit integer/);
  }
  const invalidBatch = await backend.configBatchUpdate({ VICE: { WarpMode: 0.5 } });
  assert.equal(invalidBatch.success, false);
  assert.equal(writes.length, 3);
});

test("flash save failure after restore is reported honestly", async () => withDirectory(async (dir) => {
  const file = path.join(dir, "snapshot.json");
  await fs.writeFile(file, JSON.stringify({ categories: { Audio: { Volume: 80 } } }));
  const result = await toolRegistry.invoke("c64_config", { op: "restore", path: file, applyToFlash: true }, context("c64u", {
    async configBatchUpdate() { return { success: true }; }, async configSaveToFlash() { return { success: false, details: { reason: "flash failed" } }; },
  }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /saving to flash failed/);
}));

for (const op of ["print_text", "print_bitmap", "define_chars"]) {
  test(`c64_printer.${op} rejects vice before device I/O`, async () => {
    let accesses = 0;
    const client = new Proxy({}, { get() { accesses++; throw new Error("unexpected client access"); } });
    await assert.rejects(() => toolRegistry.invoke("c64_printer", { op }, context("vice", client)), (error) => error instanceof ToolUnsupportedPlatformError);
    assert.equal(accesses, 0);
  });
}

for (const action of ["restore", "diff"]) {
  test(`config ${action} from a missing path does not create directories`, async () => withDirectory(async (dir) => {
    const parent = path.join(dir, "must-not-exist");
    const result = await toolRegistry.invoke("c64_config", { op: action, path: path.join(parent, "missing.json") }, context("c64u", {
      async configBatchUpdate() { throw new Error("must not update"); },
      async configsList() { return { categories: [] }; },
    }));
    assert.equal(result.isError, true);
    await assert.rejects(() => fs.access(parent));
  }));
}

test("verified disk mount rejects type and attachmentMode instead of dropping them", async () => {
  let effects = 0;
  const client = new Proxy({}, { get() { effects++; throw new Error("unexpected client access"); } });
  for (const extra of [{ type: "d64" }, { attachmentMode: "readonly" }]) {
    await assert.rejects(() => toolRegistry.invoke("c64_disk", { op: "mount", drive: "drive8", image: "/tmp/a.d64", verify: true, ...extra }, context("c64u", client)), /verified mount workflow/);
  }
  assert.equal(effects, 0);
});
