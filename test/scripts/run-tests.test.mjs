import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBunTestBatches, buildMatrixEnv, buildNodeFallbackBatches, parseRunTestsArgs, resolveDefaultMatrixTestFiles, shouldUseNodeFallback, splitPassthroughByRuntime } from "../../scripts/run-tests.ts";
import { buildNodeTestArgs } from "../../scripts/run-tests.mjs";

test("run-tests parses CLI args for matrix selection and passthrough", () => {
  const parsed = parseRunTestsArgs([
    "--platform=vice",
    "--target",
    "device",
    "--base-url=http://example.test",
    "--coverage",
    "test/logger.test.mjs",
    "--timeout",
    "5000",
  ]);

  assert.deepEqual(parsed, {
    target: "device",
    platform: "vice",
    explicitBaseUrl: "http://example.test",
    runCoverage: true,
    passthrough: ["test/logger.test.mjs", "--timeout", "5000"],
  });
});

test("run-tests ignores blank passthrough args from shell wrappers", () => {
  const parsed = parseRunTestsArgs(["", "   ", "--platform=c64u"]);
  assert.deepEqual(parsed.passthrough, []);
  assert.equal(parsed.platform, "c64u");
});

test("run-tests prefers Node for broad default Bun suites", () => {
  assert.equal(shouldUseNodeFallback(false, []), true);
});

test("run-tests keeps Bun for coverage and small targeted slices", () => {
  assert.equal(shouldUseNodeFallback(true, []), false);
  assert.equal(shouldUseNodeFallback(false, ["test/logger.test.mjs"]), false);
  assert.equal(shouldUseNodeFallback(false, ["test/logger.test.mjs", "test/petscii.test.mjs", "--timeout", "5000"]), false);
});

test("run-tests prefers Node when explicit Bun file set is too large unless overridden", () => {
  const manyFiles = [
    "test/a.test.mjs",
    "test/b.test.mjs",
    "test/c.test.mjs",
    "test/d.test.mjs",
    "test/e.test.mjs",
  ];

  assert.equal(shouldUseNodeFallback(false, manyFiles), true);
  assert.equal(shouldUseNodeFallback(false, manyFiles, { C64BRIDGE_TEST_RUNNER: "bun" }), false);
  assert.equal(shouldUseNodeFallback(false, manyFiles, { C64BRIDGE_BUN_FILE_LIMIT: "8" }), false);
  assert.equal(shouldUseNodeFallback(false, manyFiles, { C64BRIDGE_TEST_RUNNER: "node" }), true);
});

test("run-tests shards default Bun suites instead of sending the full matrix through Node", () => {
  const batches = buildBunTestBatches([], { C64BRIDGE_BUN_BATCH_SIZE: "20" });

  assert.equal(Array.isArray(batches), true);
  assert.equal(batches.length > 1, true);
  assert.equal(batches[0]?.length <= 20, true);
  assert.equal(batches.flat().includes("test/scripts/run-tests.test.mjs"), true);
  const isolatedBatch = batches.find((batch) => batch.length === 1 && batch[0] === "test/audioRuntime.test.mjs");
  assert.ok(isolatedBatch);
});

test("run-tests shards explicit Bun file lists and preserves shared args", () => {
  const batches = buildBunTestBatches(
    [
      "test/a.test.mjs",
      "test/b.test.mjs",
      "test/c.test.mjs",
      "--timeout",
      "5000",
    ],
    { C64BRIDGE_BUN_BATCH_SIZE: "2" },
  );

  assert.deepEqual(batches, [
    ["test/a.test.mjs", "test/b.test.mjs", "--timeout", "5000"],
    ["test/c.test.mjs", "--timeout", "5000"],
  ]);
});

test("run-tests isolates mock-heavy explicit Bun files", () => {
  const batches = buildBunTestBatches(
    [
      "test/audioRuntime.test.mjs",
      "test/a.test.mjs",
      "--timeout",
      "5000",
    ],
    { C64BRIDGE_BUN_BATCH_SIZE: "4" },
  );

  assert.deepEqual(batches, [
    ["test/a.test.mjs", "--timeout", "5000"],
    ["test/audioRuntime.test.mjs", "--timeout", "5000"],
  ]);
});

test("run-tests routes bun:test files to Bun when Node fallback is selected", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-runtime-split-"));
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "test", "node.test.mjs"), "import test from '#test/runner';\n", "utf8");
  fs.writeFileSync(path.join(root, "test", "bun.test.mjs"), "import { test } from 'bun:test';\n", "utf8");

  try {
    const split = splitPassthroughByRuntime([
      "test/node.test.mjs",
      "test/bun.test.mjs",
      "--timeout",
      "5000",
    ], root);

    assert.deepEqual(split, {
      nodePassthrough: ["test/node.test.mjs", "--timeout", "5000"],
      bunPassthrough: ["test/bun.test.mjs", "--timeout", "5000"],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run-tests routes Bun-runtime-dependent tests to Bun even without bun:test imports", () => {
  const split = splitPassthroughByRuntime([
    "test/scripts/start.test.mjs",
    "test/generateMcpInterface.test.mjs",
    "test/logger.test.mjs",
  ]);

  assert.deepEqual(split, {
    nodePassthrough: ["test/logger.test.mjs"],
    bunPassthrough: ["test/scripts/start.test.mjs", "test/generateMcpInterface.test.mjs"],
  });
});

test("run-tests isolates env-sensitive polling files in Node fallback batches", () => {
  const batches = buildNodeFallbackBatches([
    "test/logger.test.mjs",
    "test/pollIntegration.test.mjs",
    "test/programRunnersModule.test.mjs",
    "--timeout",
    "5000",
  ]);

  assert.deepEqual(batches, [
    ["test/logger.test.mjs", "--timeout", "5000"],
    ["test/pollIntegration.test.mjs", "--timeout", "5000"],
    ["test/programRunnersModule.test.mjs", "--timeout", "5000"],
  ]);
});

test("run-tests builds explicit vice mock and device environments", () => {
  const mockEnv = buildMatrixEnv("vice", "mock", null, {});
  assert.equal(mockEnv.C64_MODE, "vice");
  assert.equal(mockEnv.C64_TEST_TARGET, "mock");
  assert.equal(mockEnv.VICE_TEST_TARGET, "mock");
  assert.equal(mockEnv.C64_TEST_ENABLE_VICE_MOCK, "1");
  assert.equal("VICE_AVAILABLE" in mockEnv, false);

  const deviceEnv = buildMatrixEnv("vice", "device", null, {});
  assert.equal(deviceEnv.C64_MODE, "vice");
  assert.equal(deviceEnv.C64_TEST_TARGET, "real");
  assert.equal(deviceEnv.VICE_TEST_TARGET, "vice");
  assert.equal(deviceEnv.C64_TEST_ENABLE_VICE_MOCK, "0");
  assert.equal(deviceEnv.VICE_AVAILABLE, "1");
});

test("run-tests curates default VICE matrix files around supported suites", () => {
  assert.deepEqual(resolveDefaultMatrixTestFiles("vice", "mock"), [
    "test/device.test.mjs",
    "test/viceIntegration.test.mjs",
    "test/viceModule.test.mjs",
    "test/groupedToolsShims.test.mjs",
    "test/toolsTypes.test.mjs",
    "test/platformRegistry.test.mjs",
    "test/meta/program.test.mjs",
    "test/mcpServerIntegration.test.mjs",
    "test/c64Client.test.mjs",
    "test/vice/viceSmokeTest.ts",
  ]);
  assert.deepEqual(resolveDefaultMatrixTestFiles("vice", "device"), [
    "test/device.test.mjs",
    "test/vice/viceSmokeTest.ts",
  ]);
});

test("run-tests prefers Node for real VICE runs", () => {
  assert.equal(
    shouldUseNodeFallback(false, ["test/device.test.mjs"], {
      C64_MODE: "vice",
      VICE_TEST_TARGET: "vice",
    }),
    true,
  );
});

test("run-tests.mjs scopes bare Node fallback runs to the repo test tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-node-fallback-"));
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "test", "alpha.test.mjs"), "export {};\n", "utf8");
  fs.mkdirSync(path.join(root, "ignored"), { recursive: true });
  fs.writeFileSync(path.join(root, "ignored", "beta.test.mjs"), "export {};\n", "utf8");

  try {
    const parsed = buildNodeTestArgs([], root);
    assert.equal(parsed.target, "mock");
    assert.equal(parsed.explicitBaseUrl, null);
    assert.deepEqual(parsed.nodeArgs, [
      parsed.nodeArgs[0],
      parsed.nodeArgs[1],
      parsed.nodeArgs[2],
      "test/alpha.test.mjs",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run-tests.mjs preserves explicit files instead of appending defaults", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-node-explicit-"));
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "test", "alpha.test.mjs"), "export {};\n", "utf8");

  try {
    const parsed = buildNodeTestArgs([
      "--target=device",
      "--base-url=http://example.test",
      "test/custom.test.mjs",
    ], root);
    assert.equal(parsed.target, "device");
    assert.equal(parsed.explicitBaseUrl, "http://example.test");
    assert.equal(parsed.nodeArgs.includes("test/alpha.test.mjs"), false);
    assert.equal(parsed.nodeArgs.includes("test/custom.test.mjs"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
