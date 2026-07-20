import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import path from "node:path";
import { metaModule } from "../../src/tools/meta/index.js";
import { createLogger, tmpPath } from "./helpers.mjs";

test("bundle_run_artifacts captures screen and memory", async () => {
  const { dir } = tmpPath("artifacts", "bundle");
  const ctx = {
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
