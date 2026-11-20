import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Keeps test runs out of the developer's real state directory (~/.c64bridge).
 * Sets C64BRIDGE_STATE_DIR to a fresh temporary directory unless the caller set one,
 * and removes that directory afterwards. Legacy state overrides are redirected
 * inside that root for the run; the caller's environment is restored afterwards.
 * With C64BRIDGE_TEST_ASSERT_HERMETIC=1 the
 * run fails when the modification time or entry count of ~/.c64bridge changed.
 */
export function realStateDir(env = process.env) {
  return path.join(env.HOME || os.homedir(), ".c64bridge");
}

export function snapshotStateDir(dir) {
  try {
    const stat = fs.statSync(dir);
    return { exists: true, mtimeMs: stat.mtimeMs, entries: fs.readdirSync(dir).length };
  } catch {
    return { exists: false };
  }
}

export function sameStateSnapshot(a, b) {
  return a.exists === b.exists && a.mtimeMs === b.mtimeMs && a.entries === b.entries;
}

export function prepareTestStateDir(env) {
  const realDir = realStateDir(env);
  const before = env.C64BRIDGE_TEST_ASSERT_HERMETIC === "1" ? snapshotStateDir(realDir) : null;
  const stateKeys = ["C64BRIDGE_STATE_DIR", "C64_TASK_STATE_FILE", "C64BRIDGE_DIAGNOSTICS_DIR"];
  const previous = Object.fromEntries(stateKeys.map((key) => [key, env[key]]));
  let created = null;
  if (!env.C64BRIDGE_STATE_DIR?.trim()) {
    created = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-test-state-"));
    env.C64BRIDGE_STATE_DIR = created;
  }
  const stateDir = path.resolve(env.C64BRIDGE_STATE_DIR);
  // These overrides take precedence over STATE_DIR in production. Never let a
  // test subprocess inherit an operator's registry or diagnostics directory.
  env.C64_TASK_STATE_FILE = path.join(stateDir, "tasks.json");
  env.C64BRIDGE_DIAGNOSTICS_DIR = path.join(stateDir, "diagnostics");
  return {
    stateDir,
    finish(code) {
      try {
        if (created) {
          fs.rmSync(created, { recursive: true, force: true });
        }
        if (before) {
          const after = snapshotStateDir(realDir);
          if (!sameStateSnapshot(before, after)) {
            console.error(`[run-tests] hermetic check failed: ${realDir} changed during the test run (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`);
            return code === 0 ? 1 : code;
          }
        }
        return code;
      } finally {
        for (const key of stateKeys) {
          if (previous[key] === undefined) delete env[key]; else env[key] = previous[key];
        }
      }
    },
  };
}
