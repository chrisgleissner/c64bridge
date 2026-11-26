import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stateRootDir } from "../src/hostPaths.ts";
import { getTasksHomeDir } from "../src/tools/meta/background.ts";

// The directory a developer's real ~/.c64bridge would be. The test setup
// (test/setup/hermetic-state.mjs) records the real home before it redirects HOME.
const realHome = process.env.C64BRIDGE_TEST_REAL_HOME || os.homedir();
const realStateDir = path.join(realHome, ".c64bridge");

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function withoutStateEnv(fn) {
  const keys = ["C64BRIDGE_STATE_DIR", "C64_TASK_STATE_FILE", "C64BRIDGE_DIAGNOSTICS_DIR"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

test("a test process resolves its state directory outside the real home", () => {
  assert.equal(isInside(stateRootDir(), realStateDir), false, `state dir ${stateRootDir()} is inside ${realStateDir}`);
  assert.equal(isInside(getTasksHomeDir(), realStateDir), false);
  assert.ok(process.env.C64BRIDGE_TEST_REAL_HOME, "the test setup did not run");
});

test("a test that clears the state variables still cannot reach the real home", () => {
  // Several tests delete C64_TASK_STATE_FILE and C64BRIDGE_STATE_DIR in a finally block while a
  // background task still has a pending write. That write then resolves the default location.
  withoutStateEnv(() => {
    assert.equal(isInside(stateRootDir(), realStateDir), false, `default state dir ${stateRootDir()} is inside ${realStateDir}`);
    assert.equal(isInside(getTasksHomeDir(), realStateDir), false);
  });
});

test("the setup relocates state variables that point into the real home", async () => {
  const { installHermeticState } = await import("./setup/hermetic-state.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-home-"));
  const env = {
    HOME: home,
    C64BRIDGE_STATE_DIR: path.join(home, ".c64bridge"),
    C64_TASK_STATE_FILE: path.join(home, ".c64bridge", "tasks.json"),
  };
  const guard = installHermeticState(env);
  try {
    assert.equal(env.C64BRIDGE_TEST_REAL_HOME, home);
    assert.equal(isInside(env.C64BRIDGE_STATE_DIR, home), false);
    assert.equal(isInside(env.C64_TASK_STATE_FILE, home), false);
    assert.equal(isInside(env.HOME, home), false);
    assert.equal(isInside(env.C64BRIDGE_DIAGNOSTICS_DIR, home), false);
  } finally {
    guard.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the setup keeps a state directory the caller already placed outside the real home", async () => {
  const { installHermeticState } = await import("./setup/hermetic-state.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-home-"));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-state-"));
  const env = { HOME: home, C64BRIDGE_STATE_DIR: stateDir };
  const guard = installHermeticState(env);
  try {
    assert.equal(env.C64BRIDGE_STATE_DIR, stateDir);
    assert.equal(env.C64_TASK_STATE_FILE, path.join(stateDir, "tasks.json"));
  } finally {
    guard.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a background task that outlives its state override does not write under the home directory", () => {
  // Reproduces the leak in a child process: the override is restored (deleted) while a persist
  // is still pending, as the background tests do. HOME is a scratch directory we inspect afterwards.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-leak-home-"));
  const script = `
    import { tools, stopAllBackgroundTasks } from ${JSON.stringify(path.resolve("src/tools/meta/background.ts"))};
    delete process.env.C64_TASK_STATE_FILE;
    delete process.env.C64BRIDGE_STATE_DIR;
    const ctx = { client: { readMemory: async () => ({ success: true, data: "$00" }) } };
    await tools.find((t) => t.name === "start_background_task").execute({ name: "leak-probe", operation: "read", intervalMs: 5000 }, ctx);
    await stopAllBackgroundTasks();
  `;
  const env = { ...process.env, HOME: home };
  delete env.C64BRIDGE_STATE_DIR;
  delete env.C64_TASK_STATE_FILE;
  delete env.C64BRIDGE_DIAGNOSTICS_DIR;
  delete env.C64BRIDGE_TEST_REAL_HOME;
  const result = spawnSync("node", ["--import", "tsx", "--import", path.resolve("test/setup/hermetic-state.mjs"), "--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 60000 });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(home, ".c64bridge")), false, "a child process wrote under its HOME/.c64bridge");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
