import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    assert.ok(!fs.existsSync(env.C64BRIDGE_STATE_DIR));

    const polluted = { HOME: home, C64BRIDGE_TEST_ASSERT_HERMETIC: "1" };
    const second = prepareTestStateDir(polluted);
    fs.mkdirSync(path.join(home, ".c64bridge", "batch_1"));
    assert.equal(second.finish(0), 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
