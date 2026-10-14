import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import path from "node:path";
import { metaModule } from "../../src/tools/meta/index.js";
import { createLogger, tmpPath } from "./helpers.mjs";

test("find_paths_by_name filters by substring and extension", async () => {
  const ctx = {
    client: {
      async filesInfo() { return ["/games/demo.prg", "/games/other.crt", "/music/demo.sid"]; },
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("find_paths_by_name", { root: "/", nameContains: "demo", extensions: ["prg", "sid"] }, ctx);
  assert.equal(res.metadata?.success, true);
  const results = res.structuredContent?.data?.results ?? [];
  assert.deepEqual(results.sort(), ["/games/demo.prg", "/music/demo.sid"].sort());
});

test("find_paths_by_name supports object payload shape from firmware", async () => {
  const ctx = {
    client: {
      async filesInfo() { return { paths: ["/USB0/Demo1.PRG", "/USB0/Readme.TXT"] }; },
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("find_paths_by_name", { root: "/USB0", nameContains: "demo", caseInsensitive: true }, ctx);
  assert.equal(res.metadata?.success, true);
  const results = res.structuredContent?.data?.results ?? [];
  assert.ok(results.includes("/USB0/Demo1.PRG"));
});

test("find_paths_by_name limits by maxResults and honors case sensitive flag", async () => {
  const paths = ["/a/demo.prg", "/b/DEMO.prg", "/c/demo.sid", "/d/other.txt"];
  const ctx = { client: { async filesInfo() { return paths; } }, logger: createLogger() };
  const res1 = await metaModule.invoke("find_paths_by_name", { root: "/", nameContains: "demo", maxResults: 2 }, ctx);
  assert.equal((res1.metadata?.count ?? 0) <= 2, true);
  const res2 = await metaModule.invoke("find_paths_by_name", { root: "/", nameContains: "DEMO", caseInsensitive: false }, ctx);
  const results2 = res2.structuredContent?.data?.results ?? [];
  assert.deepEqual(results2, ["/b/DEMO.prg"]);
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
        async filesInfo(pattern) {
          if (pattern.toLowerCase().includes(".prg")) {
            return ["/games/Alpha.PRG", "/games/Beta.PRG"];
          }
          return [];
        },
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
        async filesInfo(pattern) {
          if (pattern.toLowerCase().includes(".crt")) {
            return ["/games/ZZZ.CRT", "/games/Alpha.CRT", "/games/omega.crt"];
          }
          if (pattern.toLowerCase().includes(".prg")) {
            return ["/games/Zeta.PRG"];
          }
          return [];
        },
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
    client: { async filesInfo() { return []; } },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("find_and_run_program_by_name", { root: "/games", nameContains: "missing" }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
});

test("filesystem_stats_by_extension aggregates counts and bytes", async () => {
  const ctx = {
    client: {
      async filesInfo(pattern) {
        assert.equal(pattern, "/games/**/*");
        return [
          { path: "/games/Alpha.PRG", size: 4096 },
          { path: "/games/Beta.sid", size: 2048 },
          {
            path: "/games/Collection.d64",
            size: 174848,
            entries: [
              { path: "/games/Collection.d64#DRAGON.PRG", size: 8192 },
              { path: "/games/Collection.d64#README.TXT", size: 512 },
            ],
          },
        ];
      },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("filesystem_stats_by_extension", { root: "/games" }, ctx);
  assert.equal(res.metadata?.success, true);
  const data = res.structuredContent?.data ?? {};
  assert.equal(data.totals.files, 5);
  assert.equal(data.insideContainerEntries, 2);

  const prgStats = (data.extensions ?? []).find((entry) => entry.extension === "prg");
  assert.ok(prgStats, "expected prg stats");
  assert.equal(prgStats.count, 2);
  assert.equal(prgStats.totalBytes, 4096 + 8192);

  const d64Stats = (data.extensions ?? []).find((entry) => entry.extension === "d64");
  assert.ok(d64Stats, "expected d64 stats");
  assert.equal(d64Stats.count, 1);
  assert.equal(d64Stats.totalBytes, 174848);

  const containerStats = (data.containers ?? []).find((entry) => entry.container === "/games/Collection.d64");
  assert.ok(containerStats, "expected container stats");
  assert.equal(containerStats.totalBytes, 8192 + 512);
});

test("filesystem_stats_by_extension filters extensions and skips containers when requested", async () => {
  const patterns = [];
  const ctx = {
    client: {
      async filesInfo(pattern) {
        patterns.push(pattern);
        return [
          { path: "/games/ALPHA.PRG", size: 4096 },
          { path: "/games/collection.d64", size: 174848, entries: [{ path: "/games/collection.d64#BETA.PRG", size: 2048 }] },
          { path: "/games/readme.txt", size: 128 },
        ];
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
  assert.equal(data.totals.files, 2);
  assert.equal(data.insideContainerEntries, 1);

  const prgStats = (data.extensions ?? []).find((entry) => entry.extension === "prg");
  assert.ok(prgStats, "expected prg stats");
  assert.equal(prgStats.count, 2);
  assert.equal(prgStats.totalBytes, 4096 + 2048);

  const hasD64 = (data.extensions ?? []).some((entry) => entry.extension === "d64");
  assert.equal(hasD64, false, "containers should be skipped when includeContainers is false");

  assert.deepEqual([...new Set(patterns)], ["/games/**/*.prg"]);
});

test("filesystem_stats_by_extension handles entries without size", async () => {
  const ctx = {
    client: {
      async filesInfo() {
        return ["/games/UNKNOWN"];
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

test("filesystem_stats_by_extension parses nested collections, deduplicates entries, and warns on failed patterns", async () => {
  const warnings = [];
  const ctx = {
    client: {
      async filesInfo(pattern) {
        if (pattern === "/**/*.txt") {
          throw new Error("txt lookup failed");
        }
        return {
          entries: [
            { path: "/games/demo.prg", size: "1024" },
            { fullPath: "/games/demo.prg", bytes: "1024" },
            { path: "/games/second.prg", length: "512" },
            { fullPath: "/games/folder/", type: "directory" },
            {
              path: "/games/archive.d64",
              format: "D64",
              size: "174848",
              contents: [
                { fullPath: "/games/archive.d64#INNER.PRG", byteLength: "2048" },
                { path: "/games/archive.d64#docs/readme.txt", bytes: "256" },
                { path: "/games/archive.d64#skip/", kind: "folder" },
              ],
            },
          ],
        };
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
  assert.equal(data.totals.files, 4);
  assert.equal(data.insideContainerEntries, 2);

  const prgStats = (data.extensions ?? []).find((entry) => entry.extension === "prg");
  assert.ok(prgStats, "expected prg stats");
  assert.equal(prgStats.count, 3);
  assert.equal(prgStats.totalBytes, 1024 + 512 + 2048);
  assert.equal(prgStats.samples.length, 1);

  const txtStats = (data.extensions ?? []).find((entry) => entry.extension === "txt");
  assert.ok(txtStats, "expected txt stats");
  assert.equal(txtStats.totalBytes, 256);

  const folderStats = (data.folders ?? []).find((entry) => entry.folder === "/games");
  assert.ok(folderStats, "expected /games folder stats");
  assert.equal(folderStats.count, 4);

  const containerStats = (data.containers ?? []).find((entry) => entry.container === "/games/archive.d64");
  assert.ok(containerStats, "expected container stats");
  assert.equal(containerStats.totalBytes, 2048 + 256);
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
          return {
            paths: ["/games/ignore.prg"],
            entries: [
              { path: "/games/Demo.PRG" },
              { paths: ["/games/demo.prg", "/games/Demo.PRG"] },
            ],
          };
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
    client: {
      async filesInfo() {
        return ["/games/demo.tap"];
      },
    },
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
      async filesInfo() {
        return ["/games/demo.prg"];
      },
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
