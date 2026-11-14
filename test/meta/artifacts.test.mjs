import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import path from "node:path";
import { metaModule } from "../../src/tools/meta/index.js";
import { createLogger, tmpPath } from "./helpers.mjs";

test("bundle_run_artifacts captures screen and memory", async () => {
  const { dir } = tmpPath("artifacts", "bundle");
  const ctx = {
    platform: { id: "c64u" },
    client: {
      async readScreen() { return "CAPTURED SCREEN"; },
      async readMemory() { return { success: true, data: "$AABBCC" }; },
      async debugregRead() { return { value: "0000" }; },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("bundle_run_artifacts", {
    runId: "test_001",
    outputPath: dir,
    captureScreen: true,
    memoryRanges: [{ address: "$0400", length: 16 }],
    captureDebugReg: true,
  }, ctx);

  assert.equal(res.metadata?.success, true);
  const data = res.structuredContent?.data ?? {};
  assert.equal(data.runId, "test_001");
  assert.ok(data.artifacts?.screen);
  assert.ok(data.artifacts?.memory_range_0);
  assert.ok(data.artifacts?.debugreg);
});

test("bundle_run_artifacts works with minimal options", async () => {
  const { dir } = tmpPath("artifacts", "minimal");
  const ctx = {
    platform: { id: "c64u" },
    client: {
      async readScreen() { return "SCREEN"; },
      async debugregRead() { return { value: "0000" }; },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("bundle_run_artifacts", {
    runId: "test_002",
    outputPath: dir,
  }, ctx);

  assert.equal(res.metadata?.success, true);
  const data = res.structuredContent?.data ?? {};
  assert.equal(data.runId, "test_002");
});

test("bundle_run_artifacts handles errors gracefully", async () => {
  const { dir } = tmpPath("artifacts", "error");
  const ctx = {
    platform: { id: "c64u" },
    client: {
      async readScreen() { throw new Error("screen read failed"); },
    },
    logger: createLogger(),
  };

  const res = await metaModule.invoke("bundle_run_artifacts", {
    runId: "test_error",
    outputPath: dir,
    captureScreen: true,
  }, ctx);

  assert.equal(res.isError, true);
});

test("HARD01-029 bundle_run_artifacts rejects a traversal runId and creates nothing outside outputPath", async () => {
  const { dir } = tmpPath("artifacts", "traversal");
  const ctx = {
    platform: { id: "c64u" },
    client: {
      async readScreen() { return "SCREEN"; },
      async debugregRead() { return { value: "0000" }; },
    },
    logger: createLogger(),
  };
  const escapeTarget = path.resolve(dir, "..", "escape");
  await fs.rm(escapeTarget, { recursive: true, force: true });

  const res = await metaModule.invoke("bundle_run_artifacts", {
    runId: "../escape",
    outputPath: dir,
    captureScreen: true,
  }, ctx);

  assert.equal(res.isError, true);
  const escapeExists = await fs.access(escapeTarget).then(() => true, () => false);
  assert.equal(escapeExists, false, "runId traversal must not create a directory outside outputPath");
});

test("HARD01-029 bundle_run_artifacts rejects an absolute-path and sibling-prefix-escaping runId", async () => {
  const { dir } = tmpPath("artifacts", "traversal-abs");
  const ctx = {
    platform: { id: "c64u" },
    client: {
      async readScreen() { return "SCREEN"; },
    },
    logger: createLogger(),
  };

  const absoluteResult = await metaModule.invoke("bundle_run_artifacts", {
    runId: "/etc/passwd",
    outputPath: dir,
  }, ctx);
  assert.equal(absoluteResult.isError, true);

  // outputPath "dir" has a sibling "dir-evil" that a naive string-prefix
  // check on the resolved path would incorrectly treat as contained.
  const siblingDir = `${dir}-evil`;
  await fs.rm(siblingDir, { recursive: true, force: true });
  const siblingResult = await metaModule.invoke("bundle_run_artifacts", {
    runId: "..",
    outputPath: dir,
  }, ctx);
  assert.equal(siblingResult.isError, true);
  const siblingExists = await fs.access(siblingDir).then(() => true, () => false);
  assert.equal(siblingExists, false);
});

test("HARD03-022 bundle_run_artifacts fails and writes no range file when a memory read fails", async () => {
  const { dir } = tmpPath(`artifacts-${Date.now()}-a`, "x");
  const ctx = {
    platform: { id: "c64u" },
    client: {
      async readScreen() { return "S"; },
      async readMemory() { return { success: false, error: "device busy" }; },
    },
    logger: createLogger(),
  };
  const res = await metaModule.invoke("bundle_run_artifacts", {
    runId: "fail_001", outputPath: dir, captureScreen: false, captureDebugReg: false,
    memoryRanges: [{ address: "$0400", length: 16 }],
  }, ctx);
  assert.equal(res.isError, true);
  assert.equal(res.metadata?.error?.kind, "execution");
  const files = await fs.readdir(path.join(dir, "fail_001", "memory")).catch(() => []);
  assert.deepEqual(files, []);
});

test("HARD03-022 bundle_run_artifacts validates addresses and lengths before creating anything", async () => {
  for (const memoryRange of [{ address: "C000", length: 4 }, { address: "0400", length: 4 }, { address: "$FFF0", length: 64 }, { address: "$0400", length: 70000 }]) {
    const { dir } = tmpPath(`artifacts-${Date.now()}-${Math.random().toString(36).slice(2)}`, "x");
    let reads = 0;
    const ctx = {
      platform: { id: "c64u" },
      client: { async readMemory() { reads += 1; return { success: true, data: "$00" }; } },
      logger: createLogger(),
    };
    const res = await metaModule.invoke("bundle_run_artifacts", {
      runId: "bad_001", outputPath: dir, captureScreen: false, captureDebugReg: false, memoryRanges: [memoryRange],
    }, ctx);
    assert.equal(res.isError, true, JSON.stringify(memoryRange));
    assert.equal(res.metadata?.error?.kind, "validation", JSON.stringify(memoryRange));
    assert.equal(reads, 0);
    assert.equal(await fs.stat(path.join(dir, "bad_001")).catch(() => null), null);
  }
});

test("artifact memory budgets reject excessive aggregate data or range counts before reads and files", async () => {
  const cases = [
    Array.from({ length: 33 }, () => ({ address: "$0000", length: 65536 })),
    Array.from({ length: 257 }, () => ({ address: "$0400", length: 1 })),
  ];
  for (const memoryRanges of cases) {
    const { dir } = tmpPath(`artifact-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`, "x");
    let reads = 0;
    const result = await metaModule.invoke("bundle_run_artifacts", {
      runId: "over_budget", outputPath: dir, captureScreen: false, captureDebugReg: false, memoryRanges,
    }, {
      platform: { id: "c64u" },
      client: { async readMemory() { reads += 1; return { success: true, data: "$00" }; } },
      logger: createLogger(),
    });
    assert.equal(result.isError, true);
    assert.equal(result.metadata?.error?.kind, "validation");
    assert.equal(reads, 0);
    assert.equal(await fs.stat(dir).catch(() => null), null);
  }
});

test("artifact memory snapshots accept the 2 MiB aggregate boundary", async () => {
  const { dir } = tmpPath(`artifact-boundary-${Date.now()}`, "x");
  const data = `$${"AB".repeat(65536)}`;
  let reads = 0;
  try {
    const result = await metaModule.invoke("bundle_run_artifacts", {
      runId: "at_budget", outputPath: dir, captureScreen: false, captureDebugReg: false,
      memoryRanges: Array.from({ length: 32 }, () => ({ address: "$0000", length: 65536 })),
    }, {
      platform: { id: "c64u" },
      client: { async readMemory() { reads += 1; return { success: true, data }; } },
      logger: createLogger(),
    });
    assert.equal(result.metadata?.success, true);
    assert.equal(reads, 32);
    const files = await fs.readdir(path.join(dir, "at_budget", "memory"));
    assert.equal(files.length, 32);
    assert.equal(await fs.readFile(path.join(dir, "at_budget", "memory", "range_31.hex"), "utf8"), data);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a later artifact memory read failure leaves no earlier range files", async () => {
  const { dir } = tmpPath(`artifact-late-failure-${Date.now()}`, "x");
  let reads = 0;
  const result = await metaModule.invoke("bundle_run_artifacts", {
    runId: "late_failure", outputPath: dir, captureScreen: false, captureDebugReg: false,
    memoryRanges: [{ address: "$0400", length: 16 }, { address: "$0800", length: 16 }],
  }, {
    platform: { id: "c64u" },
    client: { async readMemory() {
      reads += 1;
      return reads === 1 ? { success: true, data: "$AABB" } : { success: false, error: "device busy" };
    } },
    logger: createLogger(),
  });
  assert.equal(result.isError, true);
  assert.equal(reads, 2);
  assert.deepEqual(await fs.readdir(path.join(dir, "late_failure", "memory")), []);
});
