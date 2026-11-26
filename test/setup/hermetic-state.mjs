// Test-process guard: no test may read or write the developer's real ~/.c64bridge.
//
// Loaded for every test process by `bunfig.toml` ([test] preload) and by
// `node --import` in scripts/run-tests.mjs. It points the state variables and HOME at a
// scratch directory, so that a code path that falls back to the default location (for
// example a background task persisting after a test removed its C64_TASK_STATE_FILE
// override) still lands in the scratch directory. The real home is kept in
// C64BRIDGE_TEST_REAL_HOME so that tests can assert against it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function installHermeticState(env = process.env) {
  const realHome = env.C64BRIDGE_TEST_REAL_HOME || env.HOME || os.homedir();
  const realStateDir = path.join(realHome, ".c64bridge");
  const outsideReal = (value) => Boolean(value?.trim()) && !isInside(value, realStateDir);
  env.C64BRIDGE_TEST_REAL_HOME = realHome;

  let created = null;
  if (!outsideReal(env.C64BRIDGE_STATE_DIR)) {
    created = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-test-state-"));
    env.C64BRIDGE_STATE_DIR = created;
  }
  const stateDir = path.resolve(env.C64BRIDGE_STATE_DIR);
  if (!outsideReal(env.C64_TASK_STATE_FILE)) env.C64_TASK_STATE_FILE = path.join(stateDir, "tasks.json");
  if (!outsideReal(env.C64BRIDGE_DIAGNOSTICS_DIR)) env.C64BRIDGE_DIAGNOSTICS_DIR = path.join(stateDir, "diagnostics");

  // Fallback for code that resolves the default location after the overrides were removed.
  if (!env.HOME || env.HOME === realHome) {
    const scratchHome = path.join(stateDir, "home");
    fs.mkdirSync(scratchHome, { recursive: true });
    env.HOME = scratchHome;
  }

  return {
    stateDir,
    cleanup() {
      if (created) fs.rmSync(created, { recursive: true, force: true });
    },
  };
}

const guard = installHermeticState(process.env);
process.on("exit", () => guard.cleanup());
