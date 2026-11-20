import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { allowedHostRoots, stateRootDir } from "../src/hostPaths.js";
import { getTasksHomeDir } from "../src/tools/meta/background.js";
import { prepareTestStateDir } from "../scripts/test-state-dir.mjs";

function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

test("C64BRIDGE_STATE_DIR moves the task state root and is an allowed host root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-state-root-"));
  try {
    withEnv({ C64BRIDGE_STATE_DIR: dir, C64_TASK_STATE_FILE: undefined }, () => {
      assert.equal(stateRootDir(), path.resolve(dir));
      assert.equal(getTasksHomeDir(), path.resolve(dir));
      assert.ok(allowedHostRoots().includes(fs.realpathSync(dir)));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("C64_TASK_STATE_FILE keeps precedence over C64BRIDGE_STATE_DIR", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-state-root-"));
  try {
    const stateFile = path.join(dir, "custom", "tasks.json");
    withEnv({ C64BRIDGE_STATE_DIR: path.join(dir, "root"), C64_TASK_STATE_FILE: stateFile }, () => {
      assert.equal(getTasksHomeDir(), path.dirname(stateFile));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the test runner state directory is temporary and the hermetic check detects changes to the real one", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-fake-home-"));
  try {
    fs.mkdirSync(path.join(home, ".c64bridge"));
    const env = { HOME: home, C64BRIDGE_TEST_ASSERT_HERMETIC: "1" };
    const run = prepareTestStateDir(env);
    assert.ok(env.C64BRIDGE_STATE_DIR);
    assert.ok(!env.C64BRIDGE_STATE_DIR.startsWith(path.join(home, ".c64bridge")));
    assert.ok(fs.existsSync(env.C64BRIDGE_STATE_DIR));
    assert.equal(run.finish(0), 0);
    assert.ok(!fs.existsSync(run.stateDir));
    assert.equal(env.C64BRIDGE_STATE_DIR, undefined);

    const polluted = { HOME: home, C64BRIDGE_TEST_ASSERT_HERMETIC: "1" };
    const second = prepareTestStateDir(polluted);
    fs.mkdirSync(path.join(home, ".c64bridge", "batch_1"));
    assert.equal(second.finish(0), 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("test state isolation redirects legacy overrides and restores the caller's environment", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-override-home-"));
  const root = path.join(home, "isolated");
  const env = {
    HOME: home,
    C64BRIDGE_STATE_DIR: root,
    C64_TASK_STATE_FILE: path.join(home, "operator-tasks.json"),
    C64BRIDGE_DIAGNOSTICS_DIR: path.join(home, "operator-diagnostics"),
  };
  const original = { ...env };
  try {
    const run = prepareTestStateDir(env);
    assert.equal(env.C64_TASK_STATE_FILE, path.join(root, "tasks.json"));
    assert.equal(env.C64BRIDGE_DIAGNOSTICS_DIR, path.join(root, "diagnostics"));
    assert.equal(run.finish(0), 0);
    assert.deepEqual(env, original);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the supported test runner leaves inherited operator task and diagnostics files untouched", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-runner-override-"));
  const operatorRoot = path.join(home, ".c64bridge", "custom");
  const registryPath = path.join(operatorRoot, "tasks.json");
  const diagnosticsDir = path.join(operatorRoot, "diagnostics");
  const diagnosticPath = path.join(diagnosticsDir, "operator.ndjson");
  const configPath = path.join(home, "empty-config.json");
  const registry = JSON.stringify({ tasks: [{
    id: "0001_operator", name: "operator", type: "background", operation: "read",
    args: { address: "$0400", length: 1 }, intervalMs: 1000, iterations: 5,
    status: "running", startedAt: "2026-11-14T00:00:00.000Z", updatedAt: "2026-11-14T00:00:05.000Z",
    folder: "tasks/background/0001_operator",
  }] });
  try {
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    fs.writeFileSync(registryPath, registry);
    fs.writeFileSync(diagnosticPath, "operator diagnostics\n");
    fs.writeFileSync(configPath, "{}");
    const env = {
      ...process.env, HOME: home, C64BRIDGE_CONFIG: configPath,
      C64_TASK_STATE_FILE: registryPath, C64BRIDGE_DIAGNOSTICS_DIR: diagnosticsDir,
      C64BRIDGE_TEST_ASSERT_HERMETIC: "1", VICE_VISIBLE: "false",
    };
    delete env.C64BRIDGE_STATE_DIR;
    const repoRoot = fileURLToPath(new URL("../", import.meta.url));
    const node = process.env.C64BRIDGE_TEST_NODE_BIN || (typeof globalThis.Bun === "undefined" ? process.execPath : "node");
    const result = await new Promise((resolve, reject) => {
      const child = spawn(node, ["scripts/run-tests.mjs", "test/accessMode.test.mjs"], { cwd: repoRoot, env });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(fs.readFileSync(registryPath, "utf8"), registry);
    assert.equal(fs.readFileSync(diagnosticPath, "utf8"), "operator diagnostics\n");
    assert.deepEqual(fs.readdirSync(diagnosticsDir), ["operator.ndjson"]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
