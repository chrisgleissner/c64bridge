import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import path from "node:path";
import { toolRegistry } from "../../src/tools/registry/index.js";
import { C64Client } from "../../src/c64Client.js";
import { startMockC64Server } from "../../scripts/mockC64Server.mjs";
import { metaModule } from "../../src/tools/meta/index.js";
import { createLogger, tmpPath } from "./helpers.mjs";

// Answers GET /v1/files/<pattern>:info like the firmware: the first file in the pattern's directory whose
// name matches the pattern's `*` wildcards, as {files: {...}}, and a 404 when nothing matches.
function firmwareInfo(files, sizes = {}) {
  return async (pattern) => {
    const slash = pattern.lastIndexOf("/");
    const dir = pattern.slice(0, slash);
    const leaf = new RegExp(`^${pattern.slice(slash + 1).split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
    const hit = files.find((file) => file.slice(0, file.lastIndexOf("/")) === dir && leaf.test(file.slice(file.lastIndexOf("/") + 1)));
    if (!hit) throw Object.assign(new Error("Request failed with status code 404"), { response: { status: 404 } });
    const filename = hit.slice(hit.lastIndexOf("/") + 1);
    return { files: { path: hit, filename, size: sizes[hit] ?? 1024, extension: filename.split(".").pop().toLowerCase() }, errors: [] };
  };
}

test("find_paths_by_name filters by substring and extension", async () => {
  const ctx = {
    client: {
      filesInfo: firmwareInfo(["/games/demo.prg", "/games/other.crt", "/music/demo.sid"]),
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("find_paths_by_name", { root: "/games", nameContains: "demo", extensions: ["prg", "sid"] }, ctx);
  assert.equal(res.metadata?.success, true);
  assert.deepEqual(res.structuredContent?.data?.results, ["/games/demo.prg"]);
});

test("find_paths_by_name reports the single firmware match and rejects an array answer", async () => {
  const ctx = {
    client: { filesInfo: firmwareInfo(["/USB0/Demo1.PRG", "/USB0/Readme.TXT"]) },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("find_paths_by_name", { root: "/USB0", nameContains: "demo", caseInsensitive: true }, ctx);
  assert.equal(res.metadata?.success, true);
  assert.deepEqual(res.structuredContent?.data?.results, ["/USB0/Demo1.PRG"]);

  const unknown = {
    client: { async filesInfo() { return ["/USB0/Demo1.PRG"]; } },
    logger: createLogger(),
  };
  const bad = await metaModule.invoke("find_paths_by_name", { root: "/USB0", nameContains: "demo" }, unknown);
  assert.equal(bad.isError, true);
  assert.equal(bad.metadata?.error?.kind, "execution");
});

test("find_paths_by_name limits by maxResults and honors case sensitive flag", async () => {
  const ctx = { client: { filesInfo: firmwareInfo(["/b/DEMO.prg"]) }, logger: createLogger() };
  const exact = await metaModule.invoke("find_paths_by_name", { root: "/b", nameContains: "DEMO", caseInsensitive: false }, ctx);
  assert.deepEqual(exact.structuredContent?.data?.results, ["/b/DEMO.prg"]);

  const lower = { client: { filesInfo: firmwareInfo(["/b/demo.prg"]) }, logger: createLogger() };
  const res = await metaModule.invoke("find_paths_by_name", { root: "/b", nameContains: "DEMO", caseInsensitive: false }, lower);
  assert.deepEqual(res.structuredContent?.data?.results, []);
});

test("find_and_run_program_by_name runs first matching PRG and records state", async () => {
  const { file, dir } = tmpPath("findrun", "state.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    let runPath = null;
    const ctx = {
      client: {
        filesInfo: firmwareInfo(["/games/Alpha.PRG", "/games/Beta.PRG"]),
        async runPrgFile(p) { runPath = p; return { success: true }; },
      },
      logger: createLogger(),
    };

    const res = await metaModule.invoke("find_and_run_program_by_name", { root: "/games", nameContains: "alpha" }, ctx);
    assert.equal(res.metadata?.success, true);
    assert.equal(runPath, "/games/Alpha.PRG");

    const stateFile = path.join(dir, "meta", "find_and_run_program_by_name.json");
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    assert.equal(state.lastRunPath, "/games/Alpha.PRG");
    assert.equal(Array.isArray(state.recentSearches), true);
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("find_and_run_program_by_name honors alphabetical sort and CRT extension", async () => {
  const { file, dir } = tmpPath("findrun2", "state.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    let crtPath = null;
    let prgCalls = 0;
    const ctx = {
      client: {
        filesInfo: firmwareInfo(["/games/ZZZ.CRT", "/games/Alpha.CRT", "/games/omega.crt"]),
        async runCrtFile(p) { crtPath = p; return { success: true }; },
        async runPrgFile() { prgCalls += 1; return { success: true }; },
      },
      logger: createLogger(),
    };

    const res = await metaModule.invoke("find_and_run_program_by_name", {
      root: "/games",
      nameContains: "a",
      extensions: ["crt"],
      sort: "alphabetical",
    }, ctx);

    assert.equal(res.metadata?.success, true);
    assert.equal(crtPath, "/games/Alpha.CRT");
    assert.equal(prgCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("find_and_run_program_by_name reports error when no program matches", async () => {
  const ctx = {
    client: { filesInfo: firmwareInfo([]) },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("find_and_run_program_by_name", { root: "/games", nameContains: "missing" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("filesystem_stats_by_extension aggregates counts and bytes", async () => {
  const ctx = {
    client: {
      filesInfo: firmwareInfo(
        ["/games/Alpha.PRG", "/games/Beta.sid", "/games/Collection.d64"],
        { "/games/Alpha.PRG": 4096, "/games/Beta.sid": 2048, "/games/Collection.d64": 174848 },
      ),
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("filesystem_stats_by_extension", { root: "/games", extensions: ["prg", "sid", "d64"] }, ctx);
  assert.equal(res.metadata?.success, true);
  const data = res.structuredContent?.data ?? {};
  assert.equal(data.totals.files, 3);
  assert.equal(data.totals.totalBytes, 4096 + 2048 + 174848);

  const prgStats = (data.extensions ?? []).find((entry) => entry.extension === "prg");
  assert.ok(prgStats, "expected prg stats");
  assert.equal(prgStats.count, 1);
  assert.equal(prgStats.totalBytes, 4096);

  const d64Stats = (data.extensions ?? []).find((entry) => entry.extension === "d64");
  assert.ok(d64Stats, "expected d64 stats");
  assert.equal(d64Stats.count, 1);
  assert.equal(d64Stats.totalBytes, 174848);
});

test("filesystem_stats_by_extension filters extensions and skips containers when requested", async () => {
  const patterns = [];
  const info = firmwareInfo(["/games/ALPHA.PRG", "/games/collection.d64"], { "/games/ALPHA.PRG": 4096, "/games/collection.d64": 174848 });
  const ctx = {
    client: {
      async filesInfo(pattern) {
        patterns.push(pattern);
        return info(pattern);
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("filesystem_stats_by_extension", {
    root: "/games/",
    extensions: ["prg", ".PRG"],
    includeContainers: false,
  }, ctx);

  assert.equal(res.metadata?.success, true);
  const data = res.structuredContent?.data ?? {};
  assert.equal(data.totals.files, 1);

  const prgStats = (data.extensions ?? []).find((entry) => entry.extension === "prg");
  assert.ok(prgStats, "expected prg stats");
  assert.equal(prgStats.count, 1);
  assert.equal(prgStats.totalBytes, 4096);

  const hasD64 = (data.extensions ?? []).some((entry) => entry.extension === "d64");
  assert.equal(hasD64, false, "d64 is not requested by the extension filter");

  assert.deepEqual([...new Set(patterns)], ["/games/*.prg"]);
});

test("filesystem_stats_by_extension handles entries without size", async () => {
  const ctx = {
    client: {
      async filesInfo() {
        return { files: { path: "/games/UNKNOWN", filename: "UNKNOWN", extension: "" }, errors: [] };
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("filesystem_stats_by_extension", { root: "/games" }, ctx);
  assert.equal(res.metadata?.success, true);
  const data = res.structuredContent?.data ?? {};
  assert.equal(data.totals.files, 1);
  const noneStats = (data.extensions ?? []).find((entry) => entry.extension === "(none)");
  assert.ok(noneStats, "expected (none) extension stats");
  assert.equal(noneStats.knownSizes, 0);
  assert.equal(noneStats.unknownSizes, 1);
});

test("filesystem_stats_by_extension warns on a failed pattern and keeps the other matches", async () => {
  const warnings = [];
  const info = firmwareInfo(["/Demo.PRG"], { "/Demo.PRG": 1024 });
  const ctx = {
    client: {
      async filesInfo(pattern) {
        if (pattern === "/*.txt") {
          throw new Error("txt lookup failed");
        }
        return info(pattern);
      },
    },
    logger: {
      ...createLogger(),
      warn(message, details) {
        warnings.push({ message, details });
      },
    },
  };

  const res = await metaModule.invoke("filesystem_stats_by_extension", {
    root: "/",
    extensions: ["prg", "txt"],
    maxSamplesPerExtension: 1,
  }, ctx);

  assert.equal(res.metadata?.success, true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, "filesInfo pattern failed");

  const data = res.structuredContent?.data ?? {};
  assert.equal(data.totals.files, 1);

  const prgStats = (data.extensions ?? []).find((entry) => entry.extension === "prg");
  assert.ok(prgStats, "expected prg stats");
  assert.equal(prgStats.count, 1);
  assert.equal(prgStats.totalBytes, 1024);
  assert.equal(prgStats.samples.length, 1);
});

test("find_and_run_program_by_name rewrites malformed state and tolerates one failing extension scan", async () => {
  const { file, dir } = tmpPath("findrun-bad-state", "tasks.json");
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;

  try {
    await fs.mkdir(path.join(dir, "meta"), { recursive: true });
    await fs.writeFile(path.join(dir, "meta", "find_and_run_program_by_name.json"), "{broken", "utf8");

    const warnings = [];
    const runs = [];
    const ctx = {
      client: {
        async filesInfo(pattern) {
          if (pattern.endsWith(".crt")) {
            throw new Error("crt scan failed");
          }
          return firmwareInfo(["/games/Demo.PRG"])(pattern);
        },
        async runPrgFile(programPath) {
          runs.push(programPath);
          return { success: true };
        },
      },
      logger: {
        ...createLogger(),
        warn(message, details) {
          warnings.push({ message, details });
        },
      },
    };

    const res = await metaModule.invoke("find_and_run_program_by_name", {
      root: "/games",
      nameContains: "Demo",
      caseInsensitive: false,
      waitMs: 1,
      captureCandidates: 1,
    }, ctx);

    assert.equal(res.metadata?.success, true);
    assert.deepEqual(runs, ["/games/Demo.PRG"]);
    assert.equal(warnings.some((entry) => entry.message === "filesInfo pattern failed"), true);
    assert.deepEqual(res.structuredContent?.data?.candidates, ["/games/Demo.PRG"]);

    const statePath = path.join(dir, "meta", "find_and_run_program_by_name.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(state.lastRunPath, "/games/Demo.PRG");
    assert.equal(state.recentSearches[0].matched, "/games/Demo.PRG");
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("drive_mount_and_verify mounts image successfully with defaults", async () => {
  let powerOnCalled = false;
  let mountCalled = false;
  let resetCalled = false;
  let driveListCalls = 0;

  const ctx = {
    client: {
      async drivesList() {
        driveListCalls += 1;
        if (driveListCalls === 1) {
          // Initial check - drive is off
          return [{ id: "drive8", power: "off", image: null }];
        } else {
          // Verification check - drive is on with image
          return [{ id: "drive8", power: "on", image: "/media/test.d64" }];
        }
      },
      async driveOn(drive) {
        powerOnCalled = true;
        assert.equal(drive, "drive8");
        return { success: true, details: { drive, power: "on" } };
      },
      async driveMount(drive, image, opts) {
        mountCalled = true;
        assert.equal(drive, "drive8");
        assert.equal(image, "/media/test.d64");
        return { success: true, details: { drive, image } };
      },
      async driveReset(drive) {
        resetCalled = true;
        assert.equal(drive, "drive8");
        return { success: true, details: { drive } };
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("drive_mount_and_verify", {
    drive: "drive8",
    imagePath: "/media/test.d64",
  }, ctx);

  assert.equal(res.metadata?.success, true);
  assert.equal(powerOnCalled, true);
  assert.equal(mountCalled, true);
  assert.equal(resetCalled, true);
  assert.equal(driveListCalls, 2);

  const data = res.structuredContent?.data;
  assert.equal(data?.mounted, true);
  assert.equal(data?.drive, "drive8");
  assert.equal(data?.imagePath, "/media/test.d64");
  assert.equal(data?.attempts, 1);
  assert.ok(data?.verification);
  assert.equal(data?.verification.imageMatches, true);
});

test("drive_mount_and_verify sets the drive mode instead of passing it as the mount mode", async () => {
  const calls = [];
  const ctx = {
    client: {
      async drivesList() {
        return [{ id: "drive8", power: "on", image: "/media/work.d81" }];
      },
      async driveSetMode(drive, mode) {
        calls.push({ op: "set_mode", drive, mode });
        return { success: true, details: { drive, mode } };
      },
      async driveMount(drive, image, opts) {
        calls.push({ op: "mount", drive, image, opts });
        return { success: true, details: { drive, image } };
      },
      async driveReset(drive) {
        calls.push({ op: "reset", drive });
        return { success: true, details: { drive } };
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("drive_mount_and_verify", {
    drive: "drive8",
    imagePath: "/media/work.d81",
    mode: "1581",
  }, ctx);

  assert.equal(res.metadata?.success, true);
  assert.deepEqual(calls.map((call) => call.op), ["set_mode", "mount", "reset"]);
  assert.deepEqual(calls[0], { op: "set_mode", drive: "drive8", mode: "1581" });
  assert.equal(calls[1].opts?.mode, undefined);
});

test("drive_mount_and_verify finds drive8 in an Ultimate listing that names drives a and b", async () => {
  const calls = [];
  // drivesList() shape on the Ultimate 64: firmware ids with the bus number in raw.bus_id.
  // A disabled drive x on bus 8 first in the list must not be picked over the enabled drive a.
  const listing = (image) => [
    { id: "x", power: "off", image: null, type: "1541", raw: { enabled: false, bus_id: 8 } },
    { id: "a", power: "on", image, type: "1541", raw: { enabled: true, bus_id: 8 } },
    { id: "b", power: "on", image: null, type: "1571", raw: { enabled: true, bus_id: 9 } },
  ];
  let listCalls = 0;
  const ctx = {
    client: {
      async drivesList() {
        listCalls += 1;
        return listing(listCalls === 1 ? null : "/Usb0/games/test.d64");
      },
      async driveMount(drive, image) {
        calls.push({ op: "mount", drive, image });
        return { success: true, details: {} };
      },
      async driveReset(drive) {
        calls.push({ op: "reset", drive });
        return { success: true, details: {} };
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("drive_mount_and_verify", {
    drive: "drive8",
    imagePath: "/Usb0/games/test.d64",
  }, ctx);

  assert.equal(res.metadata?.success, true, JSON.stringify(res.content));
  assert.equal(res.structuredContent?.data?.verification?.drive, "a");
  assert.equal(res.structuredContent?.data?.verification?.imageMatches, true);
});

test("drive_mount_and_verify retries on mount failure", async () => {
  let mountAttempts = 0;

  const ctx = {
    client: {
      async drivesList() {
        return [{ id: "drive8", power: "on", image: "/media/test.d64" }];
      },
      async driveOn() {
        return { success: true };
      },
      async driveMount() {
        mountAttempts += 1;
        if (mountAttempts < 3) {
          return { success: false, details: { error: "busy" } };
        }
        return { success: true, details: { drive: "drive8" } };
      },
      async driveReset() {
        return { success: true };
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("drive_mount_and_verify", {
    drive: "drive8",
    imagePath: "/media/test.d64",
    maxRetries: 2,
    retryDelayMs: 10,
  }, ctx);

  assert.equal(res.metadata?.success, true);
  assert.equal(mountAttempts, 3);
  const data = res.structuredContent?.data;
  assert.equal(data?.attempts, 3);
});

test("drive_mount_and_verify fails after max retries", async () => {
  const ctx = {
    client: {
      async drivesList() {
        return [{ id: "drive8", power: "on", image: null }];
      },
      async driveOn() {
        return { success: true };
      },
      async driveMount() {
        return { success: false, details: { error: "device error" } };
      },
      async driveReset() {
        return { success: true };
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("drive_mount_and_verify", {
    drive: "drive8",
    imagePath: "/media/test.d64",
    maxRetries: 1,
    retryDelayMs: 10,
  }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("drive_mount_and_verify fails when drive not found", async () => {
  const ctx = {
    client: {
      async drivesList() {
        return [{ id: "drive9", power: "on", image: null }];
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("drive_mount_and_verify", {
    drive: "drive8",
    imagePath: "/media/test.d64",
  }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("drive_mount_and_verify skips power on when already on", async () => {
  let powerOnCalled = false;

  const ctx = {
    client: {
      async drivesList() {
        return [{ id: "drive8", power: "on", image: "/media/test.d64" }];
      },
      async driveOn() {
        powerOnCalled = true;
        return { success: true };
      },
      async driveMount() {
        return { success: true };
      },
      async driveReset() {
        return { success: true };
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("drive_mount_and_verify", {
    drive: "drive8",
    imagePath: "/media/test.d64",
  }, ctx);

  assert.equal(res.metadata?.success, true);
  assert.equal(powerOnCalled, false);
});

test("drive_mount_and_verify respects powerOnIfNeeded=false", async () => {
  let driveListCalled = false;

  const ctx = {
    client: {
      async drivesList() {
        driveListCalled = true;
        return [];
      },
      async driveMount() {
        return { success: true };
      },
      async driveReset() {
        return { success: true };
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("drive_mount_and_verify", {
    drive: "drive8",
    imagePath: "/media/test.d64",
    powerOnIfNeeded: false,
    verifyMount: false,
  }, ctx);

  assert.equal(res.metadata?.success, true);
  assert.equal(driveListCalled, false);
});

test("find_and_run_program_by_name rejects unsupported extensions after discovery", async () => {
  const ctx = {
    client: { filesInfo: firmwareInfo(["/games/demo.tap"]) },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("find_and_run_program_by_name", {
    root: "/games",
    nameContains: "demo",
    extensions: ["tap"],
  }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
  assert.ok(String(res.content?.[0]?.text ?? "").length > 0);
});

test("find_and_run_program_by_name surfaces firmware failures", async () => {
  const ctx = {
    client: {
      filesInfo: firmwareInfo(["/games/demo.prg"]),
      async runPrgFile() {
        return { success: false, details: { code: "DENIED" } };
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("find_and_run_program_by_name", {
    root: "/games",
    nameContains: "demo",
  }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
  assert.deepEqual(res.metadata?.error?.details?.response, { code: "DENIED" });
});

test("drive_mount_and_verify can skip verification and tolerate reset failures", async () => {
  let resetCalls = 0;
  const ctx = {
    client: {
      async drivesList() {
        return [{ id: "drive8", power: "on", image: null }];
      },
      async driveMount() {
        return { success: true, details: { mounted: true } };
      },
      async driveReset() {
        resetCalls += 1;
        throw new Error("reset boom");
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("drive_mount_and_verify", {
    drive: "drive8",
    imagePath: "/media/skipverify.d64",
    verifyMount: false,
    resetAfterMount: true,
  }, ctx);

  assert.equal(res.metadata?.success, true);
  assert.equal(resetCalls, 1);
  assert.equal(res.structuredContent?.data?.verification, null);
  assert.ok(Array.isArray(res.structuredContent?.data?.log));
});

test("drive_mount_and_verify fails when post-mount verification lookup breaks", async () => {
  let listCalls = 0;
  const ctx = {
    client: {
      async drivesList() {
        listCalls += 1;
        if (listCalls === 1) {
          return [{ id: "drive8", power: "on", image: null }];
        }
        throw new Error("drive list unavailable");
      },
      async driveMount() {
        return { success: true, details: { mounted: true } };
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("drive_mount_and_verify", {
    drive: "drive8",
    imagePath: "/media/broken.d64",
    powerOnIfNeeded: true,
  }, ctx);

  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
  assert.ok(String(res.content?.[0]?.text ?? "").length > 0);
});

test("c64_disk find_paths searches without running and builds a root pattern without a doubled slash", async () => {
  const patterns = [];
  let ran = 0;
  const info = firmwareInfo(["/games/demo.prg"]);
  const ctx = {
    client: {
      async filesInfo(pattern) { patterns.push(pattern); return info(pattern); },
      async runPrgFile() { ran++; return { success: true }; },
      async runCrtFile() { ran++; return { success: true }; },
    },
    logger: createLogger(),
    platform: { id: "c64u", features: [], limitedFeatures: [] },
  };
  const res = await toolRegistry.invoke("c64_disk", { op: "find_paths", root: "/games/", nameContains: "demo", extensions: ["prg"] }, ctx);
  assert.equal(res.metadata?.success, true);
  assert.deepEqual(res.structuredContent.data.results, ["/games/demo.prg"]);
  assert.equal(res.structuredContent.data.truncated, false);
  assert.deepEqual(patterns, ["/games/*demo*.prg"]);
  assert.equal(ran, 0);

  patterns.length = 0;
  await metaModule.invoke("find_and_run_program_by_name", { root: "/games", nameContains: "demo" }, ctx).catch(() => {});
  assert.ok(patterns.length > 0 && patterns.every((p) => p.startsWith("/games/*demo*.")), `unexpected patterns ${patterns.join(",")}`);
});

test("find_paths caps results at maxResults and reports truncated", async () => {
  // One firmware match per extension pattern: three extensions give three candidates.
  const ctx = { client: { filesInfo: firmwareInfo(["/a/demo.prg", "/a/demo.sid", "/a/demo.crt"]) }, logger: createLogger() };
  const capped = await metaModule.invoke("find_paths_by_name", { root: "/a", nameContains: "demo", extensions: ["prg", "sid", "crt"], maxResults: 2 }, ctx);
  assert.equal(capped.structuredContent.data.results.length, 2);
  assert.equal(capped.structuredContent.data.truncated, true);
  const exact = await metaModule.invoke("find_paths_by_name", { root: "/a", nameContains: "demo", extensions: ["prg", "sid", "crt"], maxResults: 3 }, ctx);
  assert.equal(exact.structuredContent.data.results.length, 3);
  assert.equal(exact.structuredContent.data.truncated, false);
  const tooMany = await metaModule.invoke("find_paths_by_name", { nameContains: "demo", maxResults: 1001 }, ctx);
  assert.equal(tooMany.isError, true);
  assert.match(JSON.stringify(tooMany), /maxResults/);
});

test("find_paths sends the wildcard pattern to the mock /v1/files route", async () => {
  const mock = await startMockC64Server();
  try {
    const client = new C64Client(mock.baseUrl);
    const ctx = { client, logger: createLogger(), platform: { id: "c64u", features: [], limitedFeatures: [] } };
    const res = await toolRegistry.invoke("c64_disk", { op: "find_paths", root: "/games", nameContains: "demo", extensions: ["prg"] }, ctx);
    assert.equal(mock.state.lastFileInfo, "/games/*demo*.prg");
    assert.deepEqual(res.structuredContent.data.results, ["/games/demo.prg"]);
  } finally {
    await mock.close();
  }
});

test("find_paths and find_and_run reject glob metacharacters in nameContains and extensions", async () => {
  const patterns = [];
  const ctx = {
    client: { async filesInfo(pattern) { patterns.push(pattern); return []; } },
    logger: createLogger(),
  };
  for (const tool of ["find_paths_by_name", "find_and_run_program_by_name"]) {
    for (const bad of ["a*b", "a?b", "a[b", "a]b", "a/b", "a\\b"]) {
      const res = await metaModule.invoke(tool, { nameContains: bad }, ctx);
      assert.equal(res.isError, true, `${tool} nameContains ${bad}`);
      assert.match(JSON.stringify(res), /nameContains/);
      const ext = await metaModule.invoke(tool, { nameContains: "demo", extensions: [bad] }, ctx);
      assert.equal(ext.isError, true, `${tool} extension ${bad}`);
      assert.match(JSON.stringify(ext), /extensions/);
    }
  }
  assert.deepEqual(patterns, []);
});

test("find_paths and find_and_run match nameContains against the file name only", async () => {
  // The directory name contains "demo", the file name of alpha.prg does not: it must not match.
  const ctx = {
    client: { filesInfo: firmwareInfo(["/demo-games/alpha.prg", "/demo-games/demo2.prg"]) },
    logger: createLogger(),
  };
  const found = await metaModule.invoke("find_paths_by_name", { root: "/demo-games", nameContains: "demo" }, ctx);
  assert.deepEqual(found.structuredContent.data.results, ["/demo-games/demo2.prg"]);

  const ran = [];
  const runCtx = {
    client: {
      filesInfo: firmwareInfo(["/demo-games/alpha.prg"]),
      async runPrgFile(p) { ran.push(p); return { success: true }; },
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("find_and_run_program_by_name", { root: "/demo-games", nameContains: "demo" }, runCtx);
  assert.equal(res.isError, true);
  assert.deepEqual(ran, []);
});

test("find_paths and find_and_run send the device glob with the original nameContains case", async () => {
  for (const tool of ["find_paths_by_name", "find_and_run_program_by_name"]) {
    const patterns = [];
    const info = firmwareInfo(["/x/my game.prg"]);
    const ctx = {
      client: {
        async filesInfo(pattern) { patterns.push(pattern); return info(pattern); },
        async runPrgFile() { return { success: true }; },
      },
      logger: createLogger(),
    };
    await metaModule.invoke(tool, { root: "/x", nameContains: "Game", caseInsensitive: true, extensions: ["prg"] }, ctx).catch(() => {});
    assert.ok(patterns.length > 0, tool);
    assert.ok(patterns.every((p) => p.includes("*Game*")), `${tool}: ${patterns.join(",")}`);
  }
});

test("filesystem_stats_by_extension on c64u scans one directory with one firmware match per extension", async () => {
  const mock = await startMockC64Server();
  try {
    const client = new C64Client(mock.baseUrl);
    const ctx = { client, logger: createLogger(), platform: { id: "c64u", features: [], limitedFeatures: [] } };
    const res = await toolRegistry.invoke("c64_extract", { op: "fs_stats", root: "/games", extensions: ["prg", "crt"] }, ctx);
    assert.equal(res.metadata?.success, true, JSON.stringify(res.content));
    assert.equal(mock.state.lastFileInfo, "/games/*.crt");
    assert.equal(res.structuredContent.data.totals.files, 2);
    assert.deepEqual(res.structuredContent.data.patterns, ["/games/*.prg", "/games/*.crt"]);

    // A pattern with no match (404 from the firmware) adds nothing and is not an error.
    const none = await toolRegistry.invoke("c64_extract", { op: "fs_stats", root: "/music", extensions: ["crt"] }, ctx);
    assert.equal(none.metadata?.success, true, JSON.stringify(none.content));
    assert.equal(none.structuredContent.data.totals.files, 0);
  } finally {
    await mock.close();
  }
});

test("drive_mount_and_verify returns an error when the verified image is not the mounted one", async () => {
  let listCalls = 0;
  const ctx = {
    client: {
      async drivesList() {
        listCalls += 1;
        // The mount reports success, but the drive still lists the previous image afterwards.
        return [{ id: "a", power: "on", image: listCalls === 1 ? null : "/Usb0/old.d64" }];
      },
      async driveMount() {
        return { success: true, details: { mounted: true } };
      },
      async driveReset() {
        return { success: true, details: {} };
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("drive_mount_and_verify", {
    drive: "a",
    imagePath: "/Usb0/new.d64",
    powerOnIfNeeded: true,
  }, ctx);

  assert.equal(res.isError, true, JSON.stringify(res.content));
  assert.equal(res.metadata?.error?.kind, "execution");
  const text = String(res.content?.[0]?.text ?? "");
  assert.ok(text.includes("/Usb0/new.d64"), text);
  assert.ok(text.includes("/Usb0/old.d64"), text);
});

test("drive_mount_and_verify finds the soft IEC drive by its listing name", async () => {
  let listCalls = 0;
  const ctx = {
    client: {
      async drivesList() {
        listCalls += 1;
        // GET /v1/drives lists the soft IEC drive as "IEC Drive"; the drive routes call it softiec.
        return [{ id: "IEC Drive", power: "on", image: listCalls === 1 ? null : "/Temp/soft.d64" }];
      },
      async driveMount(drive) {
        assert.equal(drive, "softiec");
        return { success: true, details: {} };
      },
      async driveReset() {
        return { success: true, details: {} };
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("drive_mount_and_verify", {
    drive: "softiec",
    imagePath: "/Temp/soft.d64",
    powerOnIfNeeded: true,
  }, ctx);

  assert.equal(res.metadata?.success, true, JSON.stringify(res.content));
  assert.equal(res.structuredContent?.data?.verification?.drive, "IEC Drive");
  assert.equal(res.structuredContent?.data?.verification?.imageMatches, true);
});
