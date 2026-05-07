import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Jimp } from "jimp";
import { toolRegistry } from "../src/tools/registry/index.js";
import { metaModule } from "../src/tools/meta/index.js";
import { ToolUnsupportedPlatformError, ToolValidationError } from "../src/tools/errors.js";
import { getPlatformStatus, setPlatform } from "../src/platform.js";
import { installProcessDiagnostics, writeDiagnosticEvent } from "../src/diagnostics.js";
import { createLogger, tmpPath } from "./meta/helpers.mjs";

const originalPlatform = getPlatformStatus().id;
const isVice = (process.env.C64_MODE ?? "").toLowerCase() === "vice";
const testC64uOnly = isVice ? test.skip : test;

test.after(() => {
  setPlatform(originalPlatform);
});

test("grouped tools appear in registry list", () => {
  const toolNames = toolRegistry.list().map((descriptor) => descriptor.name);
  assert.ok(toolNames.includes("c64_program"), "c64_program should be registered");
  assert.ok(toolNames.includes("c64_memory"), "c64_memory should be registered");
  assert.ok(toolNames.includes("c64_sound"), "c64_sound should be registered");
  assert.ok(toolNames.includes("c64_system"), "c64_system should be registered");
  assert.ok(toolNames.includes("c64_select_backend"), "c64_select_backend should be registered");
  assert.ok(toolNames.includes("c64_debug"), "c64_debug should be registered");
  assert.ok(toolNames.includes("c64_graphics"), "c64_graphics should be registered");
  assert.ok(toolNames.includes("c64_rag"), "c64_rag should be registered");
  assert.ok(toolNames.includes("c64_disk"), "c64_disk should be registered");
  assert.ok(toolNames.includes("c64_drive"), "c64_drive should be registered");
  assert.ok(toolNames.includes("c64_printer"), "c64_printer should be registered");
  assert.ok(toolNames.includes("c64_config"), "c64_config should be registered");
  assert.ok(toolNames.includes("c64_extract"), "c64_extract should be registered");
  assert.ok(toolNames.includes("c64_stream"), "c64_stream should be registered");
  assert.ok(toolNames.includes("c64_vice"), "c64_vice should be registered");
});

test("registry only exposes grouped tool names", () => {
  const toolNames = toolRegistry.list().map((descriptor) => descriptor.name);
  for (const name of toolNames) {
    assert.ok(name.startsWith("c64_"), `unexpected legacy tool visible in registry: ${name}`);
  }
});

test("c64_program run_prg delegates to legacy handler", async () => {
  const calls = [];
  const stubClient = {
    async runPrgFile(path) {
      calls.push({ method: "runPrgFile", path });
      return { success: true, details: {} };
    },
    async uploadAndRunBasic() {
      throw new Error("not used");
    },
    async uploadAndRunAsm() {
      throw new Error("not used");
    },
    async loadPrgFile() {
      throw new Error("not used");
    },
    async runCrtFile() {
      throw new Error("not used");
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke("c64_program", { op: "run_prg", path: "//USB0/demo.prg" }, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "runPrgFile");
  assert.equal(calls[0].path, "//USB0/demo.prg");
});

test("c64_config list is available on vice", async () => {
  const stubClient = {
    async configsList() {
      return { categories: [{ name: "VICE", items: ["WarpMode"] }] };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: { id: "vice", features: [], limitedFeatures: [] },
    setPlatform,
  };

  const result = await toolRegistry.invoke("c64_config", { op: "list" }, ctx);
  assert.equal(result.isError, undefined);
  const data = result.structuredContent?.data;
  assert.ok(Array.isArray(data?.categories));
  assert.equal(data.categories[0]?.name, "VICE");
});

test("c64_system pause is rejected on vice", async () => {
  const ctx = {
    client: {
      async pause() {
        throw new Error("should not execute on unsupported platform");
      },
    },
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: { id: "vice", features: [], limitedFeatures: [] },
    setPlatform,
  };

  await assert.rejects(
    () => toolRegistry.invoke("c64_system", { op: "pause" }, ctx),
    /Tool pause is not available on platform vice/,
  );
});

test("c64_program c64u-only grouped operations reject on vice", async () => {
  const ctx = {
    client: {},
    rag: {},
    logger: createLogger(),
    platform: { id: "vice", features: [], limitedFeatures: [] },
    setPlatform,
  };

  for (const [args, expectedTool] of [
    [{ op: "load_prg", path: "//USB0/demo.prg" }, "load_prg"],
    [{ op: "run_crt", path: "//USB0/demo.crt" }, "run_crt"],
    [{ op: "bundle_run", runId: "demo", outputPath: "/tmp/demo" }, "bundle_run_artifacts"],
  ]) {
    await assert.rejects(
      () => toolRegistry.invoke("c64_program", args, ctx),
      (error) => {
        assert.ok(error instanceof ToolUnsupportedPlatformError);
        assert.equal(error.tool, expectedTool);
        assert.equal(error.platform, "vice");
        return true;
      },
    );
  }
});

test("c64_program upload_run_basic uses shared BASIC handler", async () => {
  const uploads = [];
  let screenReads = 0;
  const stubClient = {
    async runPrgFile() {
      throw new Error("not used");
    },
    async uploadAndRunBasic(program) {
      uploads.push(program);
      return { success: true };
    },
    async uploadAndRunAsm() {
      throw new Error("not used");
    },
    async loadPrgFile() {
      throw new Error("not used");
    },
    async runCrtFile() {
      throw new Error("not used");
    },
    async readScreen() {
      screenReads += 1;
      return "READY.\n";
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_program",
    { op: "upload_run_basic", program: '10 PRINT "HI"\n20 END' },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(uploads.length, 1);
  assert.ok(screenReads >= 1);
});

test("c64_program cross_platform_greeting delegates to the orchestration workflow", async () => {
  const switches = [];
  let activeBackend = "vice";
  const { dir } = tmpPath("grouped-program", "cross-platform-greeting");
  await fs.promises.rm(dir, { recursive: true, force: true });

  const stubClient = {
    getAvailableBackends() {
      return ["vice", "c64u"];
    },
    async getActiveBackendType() {
      return activeBackend;
    },
    switchBackend(backend) {
      switches.push(backend);
      activeBackend = backend;
    },
    async uploadAndRunBasic() {
      return { success: true };
    },
    async readScreen() {
      return activeBackend === "vice"
        ? "READY.\nHAVE A GREAT DAY, VICE!"
        : "READY.\nHAVE A GREAT DAY, C64U!";
    },
    async captureFrames() {
      return {
        backend: activeBackend,
        frames: [
          {
            frameNumber: null,
            width: 2,
            height: 2,
            bitsPerPixel: 4,
            pixels: Uint8Array.from([0, 1, 2, 3]),
            complete: true,
          },
        ],
      };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: createLogger(),
    platform: { id: "c64u", features: [], limitedFeatures: [] },
    setPlatform(target) {
      return { id: target, features: [], limitedFeatures: [] };
    },
  };

  const result = await toolRegistry.invoke(
    "c64_program",
    { op: "cross_platform_greeting", outputPath: dir, timeoutMs: 100, pollIntervalMs: 50 },
    ctx,
  );

  assert.equal(result.isError, undefined);
  const data = result.structuredContent?.data;
  assert.equal(data.results.length, 2);
  assert.equal(data.results[0].backend, "vice");
  assert.equal(data.results[1].backend, "c64u");
  assert.equal(switches.join(","), "vice,c64u,vice");
});

test("c64_memory read delegates to legacy handler", async () => {
  const calls = [];
  const stubClient = {
    async readMemory(address, length) {
      calls.push({ method: "readMemory", address, length });
      return { success: true, data: "$AA", details: { address: "0400", length: 1 } };
    },
    async writeMemory() {
      throw new Error("not used");
    },
    async readScreen() {
      return "READY.";
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke("c64_memory", { op: "read", address: "$0400", length: 1 }, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "readMemory");
  assert.equal(calls[0].address, "$0400");
  assert.equal(calls[0].length, "1");
});

test("c64_memory wait_for_text polls screen", async () => {
  let readCount = 0;
  const stubClient = {
    async readMemory() {
      throw new Error("not used");
    },
    async writeMemory() {
      throw new Error("not used");
    },
    async readScreen() {
      readCount += 1;
      return "READY.";
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke("c64_memory", { op: "wait_for_text", pattern: "READY." }, ctx);
  assert.equal(result.isError, undefined);
  assert.ok(readCount >= 1, "readScreen should be called at least once");
});

testC64uOnly("c64_memory write with verify pauses, writes, and resumes", async () => {
  const callLog = [];
  let readInvocation = 0;

  const stubClient = {
    async pause() {
      callLog.push("pause");
      return { success: true };
    },
    async resume() {
      callLog.push("resume");
      return { success: true };
    },
    async readMemory(address, length) {
      callLog.push({ method: "readMemory", address, length });
      readInvocation += 1;
      if (readInvocation === 1) {
        return { success: true, data: "$0000" };
      }
      return { success: true, data: "$ABCD" };
    },
    async writeMemory(address, bytes) {
      callLog.push({ method: "writeMemory", address, bytes });
      return { success: true, details: { address: "$0400", length: 2 } };
    },
    async readScreen() {
      throw new Error("not used");
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_memory",
    { op: "write", address: "$0400", bytes: "$ABCD", verify: true },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.metadata?.verified, true);

  const callNames = callLog.map((entry) => (typeof entry === "string" ? entry : entry.method));
  assert.deepEqual(callNames.filter((name) => name === "pause"), ["pause"]);
  assert.deepEqual(callNames.filter((name) => name === "writeMemory"), ["writeMemory"]);
  assert.deepEqual(callNames.filter((name) => name === "resume"), ["resume"]);

  const readCalls = callLog.filter((entry) => typeof entry === "object" && entry.method === "readMemory");
  assert.equal(readCalls.length, 2, "should read before and after write when verify is true");
  assert.equal(readCalls[0].address, "$0400");
  assert.equal(readCalls[1].address, "$0400");
});

test("c64_sound note_on delegates to legacy handler", async () => {
  const calls = [];
  const stubClient = {
    async sidNoteOn(payload) {
      calls.push({ method: "sidNoteOn", payload });
      return { success: true };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_sound",
    { op: "note_on", voice: 2, note: "G4", waveform: "tri" },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sidNoteOn");
  assert.equal(calls[0].payload.voice, 2);
  assert.equal(calls[0].payload.note, "G4");
});

test("c64_sound silence_all verify runs audio analyzer", async () => {
  const stubClient = {
    async sidSilenceAll() {
      return { success: true };
    },
    async recordAndAnalyzeAudio({ durationSeconds }) {
      return {
        analysis: {
          durationSeconds,
          global_metrics: {
            average_rms: 0.01,
            max_rms: 0.015,
          },
        },
      };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_sound",
    { op: "silence_all", verify: true },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.metadata?.verify, true);
  assert.equal(result.metadata?.verification?.silent, true);
  assert.ok(result.metadata?.verification?.maxRms <= 0.02);
});

test("c64_sound play_preset delegates to the preset workflow", async () => {
  const previousPlatform = getPlatformStatus().id;
  const calls = [];
  let activeBackend = "vice";
  const legacyAlias = String.fromCharCode(103, 101, 114, 109, 97, 110, 95, 97, 110, 116, 104, 101, 109);
  const stubClient = {
    getAvailableBackends() {
      return ["vice", "c64u"];
    },
    async getActiveBackendType() {
      return activeBackend;
    },
    switchBackend(backend) {
      activeBackend = backend;
      calls.push({ method: "switchBackend", backend });
    },
    async sidSilenceAll() {
      calls.push({ method: "sidSilenceAll" });
      return { success: true };
    },
    async runPrg(prg) {
      calls.push({ method: "runPrg", bytes: prg.length });
      return { success: true, details: { started: true } };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: createLogger(),
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_sound",
    { op: "play_preset", preset: legacyAlias, verify: false },
    ctx,
  );

  setPlatform(previousPlatform);

  assert.equal(result.isError, undefined);
  assert.equal(result.metadata?.success, true);
  assert.equal(result.metadata?.preset, "fuer_elise");
  assert.equal(result.metadata?.legacyAliasUsed, true);
  assert.ok(calls.some((entry) => entry.method === "runPrg"));
});

testC64uOnly("c64_sound capture_samples returns encoded PCM payload", async () => {
  const stubClient = {
    async captureSamples({ count }) {
      assert.equal(count, 256);
      return {
        backend: "c64u",
        channels: 2,
        sampleRateHz: 47982.8869047619,
        samplePairs: 256,
        samples: new Int16Array([0x0102, -2, 0x0304, -4]),
      };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: createLogger(),
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke("c64_sound", { op: "capture_samples" }, ctx);

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.type, "json");
  assert.equal(result.metadata?.samplePairs, 256);
  const data = result.structuredContent?.data;
  assert.equal(data.backend, "c64u");
  assert.equal(data.channels, 2);
  assert.equal(data.sampleRateHz, 47982.8869047619);
  assert.equal(data.samples.encoding, "base64");
});

test("c64_system reset delegates to machine control", async () => {
  const calls = [];
  const stubClient = {
    async reset() {
      calls.push("reset");
      return { success: true, details: {} };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke("c64_system", { op: "reset" }, ctx);

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ["reset"]);
  assert.equal(result.metadata?.success, true);
});

test("c64_system background task lifecycle proxies to meta tools", async () => {
  const { file, dir } = tmpPath("grouped-system", "tasks.json");
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify({ tasks: [] }, null, 2));
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;

  try {
    const stubClient = {
      async readMemory() {
        return { success: true, data: "$00" };
      },
    };

    const ctx = {
      client: stubClient,
      rag: {},
      logger: createLogger(),
      platform: getPlatformStatus(),
      setPlatform,
    };

    const start = await toolRegistry.invoke(
      "c64_system",
  { op: "start_task", name: "grouped-task", operation: "read", intervalMs: 10, maxIterations: 1 },
      ctx,
    );
    assert.equal(start.metadata?.success, true);

  await new Promise((resolve) => setTimeout(resolve, 50));

    const list = await toolRegistry.invoke("c64_system", { op: "list_tasks" }, ctx);
    assert.equal(list.metadata?.success, true);
    const tasks = list.structuredContent?.data?.tasks ?? [];
    const match = tasks.find((task) => task.name === "grouped-task");
    assert.ok(match, "background task should be present");

    const stop = await toolRegistry.invoke("c64_system", { op: "stop_all_tasks" }, ctx);
    assert.equal(stop.metadata?.success, true);
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("c64_disk list_drives delegates to storage module", async () => {
  const calls = [];
  const stubClient = {
    async drivesList() {
      calls.push("drivesList");
      return { success: true, details: { drives: [] } };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke("c64_disk", { op: "list_drives" }, ctx);

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ["drivesList"]);
});

test("c64_system performance_report delegates to diagnostics summary tool", async () => {
  const previousDir = process.env.C64BRIDGE_DIAGNOSTICS_DIR;
  const previousEnable = process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-grouped-performance-"));

  try {
    process.env.C64BRIDGE_DIAGNOSTICS_DIR = tempDir;
    process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS = "1";

    installProcessDiagnostics("grouped-performance");
    writeDiagnosticEvent("mcp_call_tool_ok", { name: "c64_program", latencyMs: 7.5, isError: false });

    const ctx = {
      client: {},
      rag: {},
      logger: createLogger(),
      platform: getPlatformStatus(),
      setPlatform,
    };

    const result = await toolRegistry.invoke("c64_system", { op: "performance_report", scope: "current" }, ctx);

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.data?.toolCalls[0]?.name, "c64_program");
  } finally {
    if (previousDir === undefined) delete process.env.C64BRIDGE_DIAGNOSTICS_DIR;
    else process.env.C64BRIDGE_DIAGNOSTICS_DIR = previousDir;
    if (previousEnable === undefined) delete process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS;
    else process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS = previousEnable;
  }
});

test("c64_disk mount without verify calls driveMount", async () => {
  const calls = [];
  const stubClient = {
    async driveMount(drive, image, options) {
      calls.push({ drive, image, options });
      return { success: true, details: {} };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_disk",
    {
      op: "mount",
      drive: "drive8",
      image: "//USB0/demo.g64",
      type: "g64",
      attachmentMode: "readonly",
    },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].drive, "drive8");
  assert.equal(calls[0].image, "//USB0/demo.g64");
  assert.equal(calls[0].options?.type, "g64");
  assert.equal(calls[0].options?.mode, "readonly");
});

test("c64_disk mount with verify delegates to meta workflow", async () => {
  const calls = [];
  const stubClient = {
    async driveMount() {
      throw new Error("driveMount should not be called when verify=true");
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const originalInvoke = metaModule.invoke;
  metaModule.invoke = async (name, payload) => {
    calls.push({ name, payload });
    return {
      content: [{ type: "text", text: "verified" }],
      metadata: { verifyMount: true },
    };
  };

  try {
    const result = await toolRegistry.invoke(
      "c64_disk",
      {
        op: "mount",
        drive: "drive9",
        image: "//USB0/demo.d64",
        verify: true,
        powerOnIfNeeded: true,
        resetAfterMount: true,
      },
      ctx,
    );

    assert.equal(result.metadata?.verifyMount, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "drive_mount_and_verify");
    assert.equal(calls[0].payload.drive, "drive9");
    assert.equal(calls[0].payload.imagePath, "//USB0/demo.d64");
    assert.equal(calls[0].payload.verifyMount, true);
  } finally {
    metaModule.invoke = originalInvoke;
  }
});

testC64uOnly("c64_disk create_image validates D64 tracks", async () => {
  const ctx = {
    client: {},
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  await assert.rejects(
    () => toolRegistry.invoke(
      "c64_disk",
      { op: "create_image", format: "d64", path: "//USB0/bad.d64", tracks: 36 },
      ctx,
    ),
    ToolValidationError,
  );
});

test("c64_disk c64u-only grouped operations reject on vice", async () => {
  const ctx = {
    client: {},
    rag: {},
    logger: createLogger(),
    platform: { id: "vice", features: [], limitedFeatures: [] },
    setPlatform,
  };

  for (const [args, expectedTool] of [
    [{ op: "file_info", path: "/tmp/demo.d64" }, "file_info"],
    [{ op: "create_image", format: "d81", path: "/tmp/demo.d81" }, "create_image"],
    [{ op: "find_and_run", nameContains: "demo" }, "find_and_run_program_by_name"],
  ]) {
    await assert.rejects(
      () => toolRegistry.invoke("c64_disk", args, ctx),
      (error) => {
        assert.ok(error instanceof ToolUnsupportedPlatformError);
        assert.equal(error.tool, expectedTool);
        assert.equal(error.platform, "vice");
        return true;
      },
    );
  }
});

test("c64_drive set_mode delegates to storage module", async () => {
  const calls = [];
  const stubClient = {
    async driveSetMode(drive, mode) {
      calls.push({ drive, mode });
      return { success: true, details: {} };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_drive",
    { op: "set_mode", drive: "drive8", mode: "1581" },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ drive: "drive8", mode: "1581" }]);
});

test("c64_drive load_rom rejects on vice", async () => {
  const ctx = {
    client: {},
    rag: {},
    logger: createLogger(),
    platform: { id: "vice", features: [], limitedFeatures: [] },
    setPlatform,
  };

  await assert.rejects(
    () => toolRegistry.invoke("c64_drive", { op: "load_rom", drive: "drive8", path: "/roms/custom.rom" }, ctx),
    (error) => {
      assert.ok(error instanceof ToolUnsupportedPlatformError);
      assert.equal(error.tool, "drive_load_rom");
      assert.equal(error.platform, "vice");
      return true;
    },
  );
});

test("c64_sound c64u-only grouped operations reject on vice", async () => {
  const ctx = {
    client: {},
    rag: {},
    logger: createLogger(),
    platform: { id: "vice", features: [], limitedFeatures: [] },
    setPlatform,
  };

  for (const [args, expectedTool] of [
    [{ op: "capture_samples" }, "capture_samples"],
    [{ op: "play_sid_file", path: "//USB0/demo.sid" }, "sidplay_file"],
    [{ op: "play_mod_file", path: "//USB0/demo.mod" }, "modplay_file"],
    [{ op: "pipeline", source: "A4 q" }, "music_compile_play_analyze"],
    [{ op: "analyze", request: { durationSeconds: 1 } }, "analyze_audio"],
    [{ op: "record_analyze", durationSeconds: 1 }, "record_and_analyze_audio"],
  ]) {
    await assert.rejects(
      () => toolRegistry.invoke("c64_sound", args, ctx),
      (error) => {
        assert.ok(error instanceof ToolUnsupportedPlatformError);
        assert.equal(error.tool, expectedTool);
        assert.equal(error.platform, "vice");
        return true;
      },
    );
  }
});

testC64uOnly("c64_printer print_text delegates to printer module", async () => {
  const calls = [];
  const stubClient = {
    async printTextOnPrinterAndRun(payload) {
      calls.push(payload);
      return { success: true, details: {} };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_printer",
    { op: "print_text", text: "HELLO", formFeed: true },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "HELLO");
  assert.equal(calls[0].formFeed, true);
});

testC64uOnly("c64_printer print_bitmap routes to Commodore workflow", async () => {
  const calls = [];
  const stubClient = {
    async printBitmapOnCommodoreAndRun(payload) {
      calls.push(payload);
      return { success: true, details: {} };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_printer",
    {
      op: "print_bitmap",
      printer: "commodore",
      columns: [0, 255],
      secondaryAddress: 7,
    },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].columns, [0, 255]);
  assert.equal(calls[0].secondaryAddress, 7);
  assert.equal(calls[0].ensureMsb, true);
});

testC64uOnly("c64_extract sprites delegates to sprite extractor", async () => {
  const ctx = {
    client: {},
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const calls = [];
  const originalInvoke = metaModule.invoke;
  metaModule.invoke = async (name, payload) => {
    calls.push({ name, payload });
    return {
      content: [{ type: "text", text: "sprites extracted" }],
      metadata: { success: true },
    };
  };

  try {
    const result = await toolRegistry.invoke(
      "c64_extract",
      { op: "sprites", address: "$2000", length: 2048, stride: 64 },
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "extract_sprites_from_ram");
    assert.equal(calls[0].payload.address, "$2000");
    assert.equal(calls[0].payload.length, 2048);
    assert.equal(calls[0].payload.stride, 64);
  } finally {
    metaModule.invoke = originalInvoke;
  }
});

testC64uOnly("c64_extract memory_dump forwards to meta dump tool", async () => {
  const ctx = {
    client: {},
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const calls = [];
  const originalInvoke = metaModule.invoke;
  metaModule.invoke = async (name, payload) => {
    calls.push({ name, payload });
    return {
      content: [{ type: "text", text: "dumped" }],
      metadata: { success: true },
    };
  };

  try {
    const result = await toolRegistry.invoke(
      "c64_extract",
      {
        op: "memory_dump",
        address: "$0400",
        length: 256,
        outputPath: "./dumps/screen.hex",
        format: "hex",
      },
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "memory_dump_to_file");
    assert.equal(calls[0].payload.address, "$0400");
    assert.equal(calls[0].payload.length, 256);
    assert.equal(calls[0].payload.outputPath, "./dumps/screen.hex");
    assert.equal(calls[0].payload.format, "hex");
    assert.equal("op" in calls[0].payload, false);
  } finally {
    metaModule.invoke = originalInvoke;
  }
});

testC64uOnly("c64_stream start delegates to streaming start handler", async () => {
  const calls = [];
  const stubClient = {
    async streamStart(stream, target) {
      calls.push({ stream, target });
      return { success: true, details: { ack: true } };
    },
    async streamStop() {
      throw new Error("not used");
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_stream",
    { op: "start", stream: "audio", target: "127.0.0.1:9000" },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { stream: "audio", target: "127.0.0.1:9000" });
  assert.equal(result.metadata?.success, true);
  assert.equal(result.metadata?.stream, "audio");
  assert.equal(result.metadata?.target, "127.0.0.1:9000");
});

testC64uOnly("c64_stream stop delegates to streaming stop handler", async () => {
  const calls = [];
  const stubClient = {
    async streamStart() {
      throw new Error("not used");
    },
    async streamStop(stream) {
      calls.push(stream);
      return { success: true, details: { stopped: true } };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_stream",
    { op: "stop", stream: "audio" },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ["audio"]);
  assert.equal(result.metadata?.success, true);
  assert.equal(result.metadata?.stream, "audio");
});

testC64uOnly("c64_printer print_bitmap routes to Epson workflow", async () => {
  const calls = [];
  const stubClient = {
    async printBitmapOnEpsonAndRun(payload) {
      calls.push(payload);
      return { success: true, details: {} };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_printer",
    {
      op: "print_bitmap",
      printer: "epson",
      columns: [255, 0, 255],
      mode: "*",
      density: 3,
      repeats: 2,
    },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].columns, [255, 0, 255]);
  assert.equal(calls[0].mode, "*");
  assert.equal(calls[0].density, 3);
  assert.equal(calls[0].repeats, 2);
});

testC64uOnly("c64_printer print_bitmap rejects invalid secondary address", async () => {
  const ctx = {
    client: {},
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  await assert.rejects(
    () => toolRegistry.invoke(
      "c64_printer",
      {
        op: "print_bitmap",
        printer: "commodore",
        columns: [0],
        secondaryAddress: 5,
      },
      ctx,
    ),
    ToolValidationError,
  );
});

test("c64_config list delegates to configsList", async () => {
  const calls = [];
  const stubClient = {
    async configsList() {
      calls.push("configsList");
      return { categories: [] };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke("c64_config", { op: "list" }, ctx);

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ["configsList"]);
});

test("c64_config set delegates to configSet", async () => {
  const calls = [];
  const stubClient = {
    async configSet(category, item, value) {
      calls.push({ category, item, value });
      return { success: true, details: {} };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_config",
    { op: "set", category: "Audio", item: "Volume", value: 70 },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].category, "Audio");
  assert.equal(calls[0].item, "Volume");
  assert.equal(calls[0].value, "70");
});

testC64uOnly("c64_config write_debugreg uppercases payload", async () => {
  const calls = [];
  const stubClient = {
    async debugregWrite(value) {
      calls.push(value);
      return { success: true, details: {} };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_config",
    { op: "write_debugreg", value: "2a" },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ["2A"]);
});

test("c64_config snapshot delegates to meta workflow", async () => {
  const ctx = {
    client: {},
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const originalInvoke = metaModule.invoke;
  const calls = [];
  metaModule.invoke = async (name, payload) => {
    calls.push({ name, payload });
    return {
      content: [{ type: "text", text: "snapshot" }],
      metadata: { success: true },
    };
  };

  try {
    const result = await toolRegistry.invoke(
      "c64_config",
      { op: "snapshot", path: "/tmp/config.json" },
      ctx,
    );

    assert.equal(result.metadata?.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "config_snapshot_and_restore");
    assert.equal(calls[0].payload.action, "snapshot");
    assert.equal(calls[0].payload.path, "/tmp/config.json");
  } finally {
    metaModule.invoke = originalInvoke;
  }
});

test("c64_config restore forwards applyToFlash flag", async () => {
  const ctx = {
    client: {},
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const originalInvoke = metaModule.invoke;
  const calls = [];
  metaModule.invoke = async (name, payload) => {
    calls.push({ name, payload });
    return {
      content: [{ type: "text", text: "restore" }],
      metadata: { success: true },
    };
  };

  try {
    const result = await toolRegistry.invoke(
      "c64_config",
      { op: "restore", path: "./snap.json", applyToFlash: true },
      ctx,
    );

    assert.equal(result.metadata?.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.action, "restore");
    assert.equal(calls[0].payload.path, "./snap.json");
    assert.equal(calls[0].payload.applyToFlash, true);
  } finally {
    metaModule.invoke = originalInvoke;
  }
});

test("c64_config diff delegates to config snapshot meta tool", async () => {
  const ctx = {
    client: {},
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const originalInvoke = metaModule.invoke;
  const calls = [];
  metaModule.invoke = async (name, payload) => {
    calls.push({ name, payload });
    return {
      content: [{ type: "text", text: "diff" }],
      metadata: { success: true },
    };
  };

  try {
    const result = await toolRegistry.invoke(
      "c64_config",
      { op: "diff", path: "./snap.json" },
      ctx,
    );

    assert.equal(result.metadata?.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.action, "diff");
    assert.equal(calls[0].payload.path, "./snap.json");
  } finally {
    metaModule.invoke = originalInvoke;
  }
});

testC64uOnly("c64_config shuffle delegates to program shuffle workflow", async () => {
  const ctx = {
    client: {},
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const originalInvoke = metaModule.invoke;
  const calls = [];
  metaModule.invoke = async (name, payload) => {
    calls.push({ name, payload });
    return {
      content: [{ type: "text", text: "shuffle" }],
      metadata: { success: true },
    };
  };

  try {
    const result = await toolRegistry.invoke(
      "c64_config",
      { op: "shuffle", root: "/games" },
      ctx,
    );

    assert.equal(result.metadata?.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "program_shuffle");
    assert.equal(calls[0].payload.root, "/games");
  } finally {
    metaModule.invoke = originalInvoke;
  }
});

test("c64_graphics render_petscii_text delegates to shared handler", async () => {
  const calls = [];
  const stubClient = {
    async renderPetsciiScreenAndRun(payload) {
      calls.push(payload);
      return { success: true, details: {} };
    },
    async generateAndRunSpritePrg() {
      throw new Error("not used");
    },
    async uploadAndRunBasic() {
      throw new Error("not used");
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_graphics",
    { op: "render_petscii_text", text: "HELLO", borderColor: 6 },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "HELLO");
  assert.equal(calls[0].borderColor, 6);
});

test("c64_graphics capture_frame returns normalized frame payload", async () => {
  const stubClient = {
    async captureFrames({ count }) {
      assert.equal(count, 2);
      return {
        backend: "vice",
        frames: [
          {
            frameNumber: null,
            width: 320,
            height: 200,
            bitsPerPixel: 8,
            pixels: Uint8Array.from([0, 1, 2, 3]),
            complete: true,
          },
          {
            frameNumber: null,
            width: 320,
            height: 200,
            bitsPerPixel: 8,
            pixels: Uint8Array.from([4, 5, 6, 7]),
            complete: true,
          },
        ],
      };
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: createLogger(),
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_graphics",
    { op: "capture_frame", count: 2 },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.type, "json");
  assert.equal(result.metadata?.backend, "vice");
  assert.equal(result.metadata?.count, 2);
  const data = result.structuredContent?.data;
  assert.equal(data.frames.length, 2);
  assert.equal(data.frames[0].byteLength, 4);
  assert.equal(data.frames[0].pixels.encoding, "base64");
});

test("c64_graphics render_sprite proxies to sprite helper", async () => {
  const calls = [];
  const stubClient = {
    async generateAndRunSpritePrg(payload) {
      calls.push(payload);
      return { success: true, details: {} };
    },
    async renderPetsciiScreenAndRun() {
      throw new Error("not used");
    },
    async uploadAndRunBasic() {
      throw new Error("not used");
    },
  };

  const ctx = {
    client: stubClient,
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const sprite = Array.from({ length: 63 }, () => 0);
  const result = await toolRegistry.invoke(
    "c64_graphics",
    { op: "render_sprite", sprite, index: 1, x: 140, y: 120, color: 5 },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].spriteBytes.length, 63);
  assert.equal(calls[0].spriteIndex, 1);
  assert.equal(calls[0].x, 140);
  assert.equal(calls[0].y, 120);
  assert.equal(calls[0].color, 5);
});

test("c64_graphics render_bitmap imports images and delegates to displayBitmap", async () => {
  const { dir, file } = tmpPath("graphics", "grouped-bitmap.png");
  await fs.promises.mkdir(dir, { recursive: true });
  const image = new Jimp({ width: 8, height: 8, color: 0x813338FF });
  await image.write(file);

  const calls = [];
  const ctx = {
    client: {
      async displayBitmap(prepared, options) {
        calls.push({ prepared, options });
        return {
          success: true,
          details: {
            bitmapAddress: 0x2000,
            screenAddress: 0x0400,
            colorRamAddress: 0xD800,
            bank: 0,
            registerValues: {
              dd00: 0xFF,
              d011: 0x3B,
              d016: 0x08,
              d018: 0x18,
              d020: 2,
              d021: 0,
            },
          },
        };
      },
    },
    rag: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_graphics",
    { op: "render_bitmap", imagePath: file, format: "hires", borderColor: 2 },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.metadata?.success, true);
  assert.equal(result.metadata?.mode, "hires");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prepared.mode, "hires");
  assert.equal(calls[0].prepared.sourceWidth, 8);
  assert.equal(calls[0].prepared.sourceHeight, 8);
});

test("c64_rag basic retrieval delegates to RAG layer", async () => {
  const queries = [];
  const stubRag = {
    async retrieve(q, k, language) {
      queries.push({ q, k, language });
      return [
        {
          snippet: "10 PRINT \"HELLO\"",
          score: 0.9,
          origin: "basic.md#hello",
        },
      ];
    },
  };

  const ctx = {
    client: {},
    rag: stubRag,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_rag",
    { op: "basic", q: "print border" },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].language, "basic");
  assert.equal(queries[0].q, "print border");
  assert.equal(queries[0].k, 3);
  assert.ok(result.structuredContent?.data?.refs?.length);
});

test("c64_rag asm retrieval delegates to RAG layer", async () => {
  const queries = [];
  const stubRag = {
    async retrieve(q, k, language) {
      queries.push({ q, k, language });
      return [];
    },
  };

  const ctx = {
    client: {},
    rag: stubRag,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    platform: getPlatformStatus(),
    setPlatform,
  };

  const result = await toolRegistry.invoke(
    "c64_rag",
    { op: "asm", q: "stable raster irq" },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].language, "asm");
  assert.equal(queries[0].q, "stable raster irq");
  assert.equal(queries[0].k, 3);
});

test("c64_debug list_checkpoints proxies to VICE client", async () => {
  const restore = getPlatformStatus().id;
  setPlatform("vice");
  try {
    let calls = 0;
    const stubClient = {
      async viceCheckpointList() {
        calls += 1;
        return [
          {
            id: 1,
            hit: false,
            start: 0x0801,
            end: 0x0801,
            stopOnHit: true,
            enabled: true,
            temporary: false,
            operations: { execute: true, load: false, store: false },
            hitCount: 0,
            ignoreCount: 0,
            hasCondition: false,
            memspace: 0,
          },
        ];
      },
    };

    const ctx = {
      client: stubClient,
      rag: {},
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      platform: getPlatformStatus(),
      setPlatform,
    };

    const result = await toolRegistry.invoke("c64_debug", { op: "list_checkpoints" }, ctx);

    assert.equal(result.isError, undefined);
    assert.equal(calls, 1);
  assert.equal(result.structuredContent?.type, "json");
  const data = result.structuredContent?.data;
  assert.ok(data && Array.isArray(data.checkpoints));
  assert.equal(data.checkpoints[0].id, 1);
  assert.equal(data.checkpoints[0].start, "$0801");
  } finally {
    setPlatform(restore);
  }
});

test("c64_debug set_registers resolves metadata and writes values", async () => {
  const restore = getPlatformStatus().id;
  setPlatform("vice");
  try {
    let metadataCalls = 0;
    const setCalls = [];
    const stubClient = {
      async viceRegistersAvailable(memspace) {
        metadataCalls += 1;
        return [
          { id: 0, name: "PC", bits: 16, size: 2 },
          { id: 1, name: "A", bits: 8, size: 1 },
        ];
      },
      async viceRegistersSet(writes, options) {
        setCalls.push({ writes, options });
        return writes.map((write) => ({
          id: write.id ?? (write.name?.toUpperCase() === "PC" ? 0 : 1),
          size: write.value > 0xff ? 2 : 1,
          value: write.value,
        }));
      },
    };

    const ctx = {
      client: stubClient,
      rag: {},
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      platform: getPlatformStatus(),
      setPlatform,
    };

    const result = await toolRegistry.invoke(
      "c64_debug",
      {
        op: "set_registers",
        writes: [
          { name: "pc", value: 0x1234 },
          { id: 1, value: 0x20 },
        ],
      },
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.equal(metadataCalls, 1);
    assert.equal(setCalls.length, 1);
    assert.deepEqual(setCalls[0].writes, [
      { name: "pc", value: 0x1234 },
      { id: 1, value: 0x20 },
    ]);
    assert.equal(setCalls[0].options.memspace, 0);
    assert.ok(Array.isArray(setCalls[0].options.metadata));
  assert.equal(result.structuredContent?.type, "json");
  const data = result.structuredContent?.data;
  assert.ok(data && Array.isArray(data.registers));
  assert.equal(data.registers.length, 2);
  } finally {
    setPlatform(restore);
  }
});

test("c64_debug step over delegates to VICE stepping", async () => {
  const restore = getPlatformStatus().id;
  setPlatform("vice");
  try {
    const stepCalls = [];
    const stubClient = {
      async viceStepInstructions(count, options) {
        stepCalls.push({ count, options });
      },
    };

    const ctx = {
      client: stubClient,
      rag: {},
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      platform: getPlatformStatus(),
      setPlatform,
    };

    const result = await toolRegistry.invoke(
      "c64_debug",
      { op: "step", count: 2, mode: "over" },
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.equal(stepCalls.length, 1);
    assert.equal(stepCalls[0].count, 2);
    assert.equal(stepCalls[0].options.stepOver, true);
  } finally {
    setPlatform(restore);
  }
});

test("c64_debug create_checkpoint persists labels for list and get operations", async () => {
  const restore = getPlatformStatus().id;
  setPlatform("vice");
  try {
    const checkpoint = {
      id: 91,
      hit: false,
      start: 0x0810,
      end: 0x0810,
      stopOnHit: true,
      enabled: true,
      temporary: false,
      operations: { execute: true, load: false, store: false },
      hitCount: 0,
      ignoreCount: 0,
      hasCondition: false,
      memspace: 0,
    };
    const stubClient = {
      async viceCheckpointCreate() {
        return checkpoint;
      },
      async viceCheckpointGet(id) {
        assert.equal(id, checkpoint.id);
        return checkpoint;
      },
      async viceCheckpointList() {
        return [checkpoint];
      },
      async viceCheckpointDelete(id) {
        assert.equal(id, checkpoint.id);
      },
    };

    const ctx = {
      client: stubClient,
      rag: {},
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      platform: getPlatformStatus(),
      setPlatform,
    };

    const created = await toolRegistry.invoke(
      "c64_debug",
      { op: "create_checkpoint", address: "$0810", label: "entry_point" },
      ctx,
    );
    const listed = await toolRegistry.invoke("c64_debug", { op: "list_checkpoints" }, ctx);
    const fetched = await toolRegistry.invoke("c64_debug", { op: "get_checkpoint", id: checkpoint.id }, ctx);
    const deleted = await toolRegistry.invoke("c64_debug", { op: "delete_checkpoint", id: checkpoint.id }, ctx);

    assert.equal(created.isError, undefined);
    assert.equal(created.structuredContent?.data?.checkpoint?.label, "entry_point");
    assert.equal(listed.structuredContent?.data?.checkpoints[0]?.label, "entry_point");
    assert.equal(fetched.structuredContent?.data?.checkpoint?.label, "entry_point");
    assert.equal(deleted.isError, undefined);
  } finally {
    setPlatform(restore);
  }
});

test("c64_debug get_monitor_state formats the current PC from register values", async () => {
  const restore = getPlatformStatus().id;
  setPlatform("vice");
  try {
    const stubClient = {
      async viceRegistersAvailable(memspace) {
        assert.equal(memspace, 1);
        return [
          { id: 0, name: "PC", bits: 16, size: 2 },
          { id: 1, name: "A", bits: 8, size: 1 },
        ];
      },
      async viceRegistersGet(memspace) {
        assert.equal(memspace, 1);
        return [
          { id: 0, size: 2, value: 0x1234 },
          { id: 1, size: 1, value: 0x20 },
        ];
      },
    };

    const ctx = {
      client: stubClient,
      rag: {},
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      platform: getPlatformStatus(),
      setPlatform,
    };

    const result = await toolRegistry.invoke("c64_debug", { op: "get_monitor_state", memspace: 1 }, ctx);

    assert.equal(result.isError, undefined);
    assert.equal(result.metadata?.memspace, 1);
    assert.equal(result.structuredContent?.data?.pc, "$1234");
    assert.equal(result.structuredContent?.data?.registers.length, 2);
  } finally {
    setPlatform(restore);
  }
});

test("c64_debug wait_for_state reports matched and timed out outcomes", async () => {
  const restore = getPlatformStatus().id;
  setPlatform("vice");
  try {
    let reads = 0;
    const matchedClient = {
      async viceRegistersAvailable(memspace) {
        assert.equal(memspace, 0);
        return [{ id: 0, name: "PC", bits: 16, size: 2 }];
      },
      async viceRegistersGet(memspace) {
        assert.equal(memspace, 0);
        reads += 1;
        return [{ id: 0, size: 2, value: reads === 1 ? 0x1000 : 0x1004 }];
      },
    };
    const timedOutClient = {
      async viceRegistersAvailable() {
        return [{ id: 0, name: "PC", bits: 16, size: 2 }];
      },
      async viceRegistersGet() {
        return [{ id: 0, size: 2, value: 0x2000 }];
      },
    };

    const logger = {
      debug() {},
      info() {},
      warn() {},
      error() {},
    };

    const matched = await toolRegistry.invoke(
      "c64_debug",
      { op: "wait_for_state", expectedPC: "$1004", timeoutMs: 50, pollMs: 10 },
      { client: matchedClient, rag: {}, logger, platform: getPlatformStatus(), setPlatform },
    );
    const timedOut = await toolRegistry.invoke(
      "c64_debug",
      { op: "wait_for_state", expectedPC: "$2001", timeoutMs: 20, pollMs: 10 },
      { client: timedOutClient, rag: {}, logger, platform: getPlatformStatus(), setPlatform },
    );

    assert.equal(matched.isError, undefined);
    assert.equal(matched.structuredContent?.data?.matched, true);
    assert.equal(matched.structuredContent?.data?.pc, "$1004");
    assert.equal(timedOut.isError, undefined);
    assert.equal(timedOut.structuredContent?.data?.matched, false);
    assert.equal(timedOut.structuredContent?.data?.timedOut, true);
    assert.equal(timedOut.structuredContent?.data?.pc, "$2000");
  } finally {
    setPlatform(restore);
  }
});

test("c64_debug continue_execution and nuclear_reset delegate to VICE control paths", async () => {
  const restore = getPlatformStatus().id;
  setPlatform("vice");
  try {
    const checkpoint = {
      id: 92,
      hit: false,
      start: 0x0900,
      end: 0x0900,
      stopOnHit: true,
      enabled: true,
      temporary: false,
      operations: { execute: true, load: false, store: false },
      hitCount: 0,
      ignoreCount: 0,
      hasCondition: false,
      memspace: 0,
    };
    let exitMonitorCalls = 0;
    let nuclearResetCalls = 0;
    const stubClient = {
      async viceCheckpointCreate() {
        return checkpoint;
      },
      async viceCheckpointList() {
        return [checkpoint];
      },
      async viceExitMonitor() {
        exitMonitorCalls += 1;
      },
      async viceNuclearReset() {
        nuclearResetCalls += 1;
      },
    };

    const ctx = {
      client: stubClient,
      rag: {},
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      platform: getPlatformStatus(),
      setPlatform,
    };

    await toolRegistry.invoke("c64_debug", { op: "create_checkpoint", address: "$0900", label: "to_clear" }, ctx);
    const beforeReset = await toolRegistry.invoke("c64_debug", { op: "list_checkpoints" }, ctx);
    const resumed = await toolRegistry.invoke("c64_debug", { op: "continue_execution" }, ctx);
    const reset = await toolRegistry.invoke("c64_debug", { op: "nuclear_reset" }, ctx);
    const afterReset = await toolRegistry.invoke("c64_debug", { op: "list_checkpoints" }, ctx);

    assert.equal(beforeReset.structuredContent?.data?.checkpoints[0]?.label, "to_clear");
    assert.equal(resumed.isError, undefined);
    assert.equal(reset.isError, undefined);
    assert.equal(exitMonitorCalls, 1);
    assert.equal(nuclearResetCalls, 1);
    assert.equal(afterReset.structuredContent?.data?.checkpoints[0]?.label, undefined);
  } finally {
    setPlatform(restore);
  }
});

test("c64_debug new monitor control operations surface client failures", async () => {
  const restore = getPlatformStatus().id;
  setPlatform("vice");
  try {
    const failingCtx = {
      client: {
        viceRegistersAvailable() {
          throw new Error("register metadata failed");
        },
        viceRegistersGet() {
          throw new Error("register read failed");
        },
        viceNuclearReset() {
          throw new Error("nuclear reset failed");
        },
        viceExitMonitor() {
          throw new Error("exit monitor failed");
        },
      },
      rag: {},
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      platform: getPlatformStatus(),
      setPlatform,
    };

    for (const args of [
      { op: "get_monitor_state" },
      { op: "wait_for_state", expectedPC: "$0810", timeoutMs: 10, pollMs: 10 },
      { op: "nuclear_reset" },
      { op: "continue_execution" },
    ]) {
      const result = await toolRegistry.invoke("c64_debug", args, failingCtx);
      assert.equal(result.isError, true);
      assert.equal(result.metadata?.error?.kind, "unknown");
    }
  } finally {
    setPlatform(restore);
  }
});

test("c64_vice resource_set writes allowed resources", async () => {
  const restore = getPlatformStatus().id;
  setPlatform("vice");
  try {
    const calls = [];
    const stubClient = {
      async viceResourceSet(name, value) {
        calls.push({ name, value });
      },
    };

    const ctx = {
      client: stubClient,
      rag: {},
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      platform: getPlatformStatus(),
      setPlatform,
    };

    const result = await toolRegistry.invoke(
      "c64_vice",
      { op: "resource_set", name: "SidEngine", value: 2 },
      ctx,
    );

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "SidEngine");
    assert.equal(calls[0].value, 2);
  } finally {
    setPlatform(restore);
  }
});

test("c64_vice resource_set rejects unsafe prefixes", async () => {
  const restore = getPlatformStatus().id;
  setPlatform("vice");
  try {
    const stubClient = {
      async viceResourceSet() {
        throw new Error("should not be called");
      },
    };

    const ctx = {
      client: stubClient,
      rag: {},
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      platform: getPlatformStatus(),
      setPlatform,
    };

    const result = await toolRegistry.invoke(
      "c64_vice",
      { op: "resource_set", name: "Drive8Type", value: "1541" },
      ctx,
    );

    assert.equal(result.isError, true);
    assert.equal(result.metadata?.error?.kind, "validation");
    assert.equal(result.metadata?.error?.path, "$.name");
  } finally {
    setPlatform(restore);
  }
});
