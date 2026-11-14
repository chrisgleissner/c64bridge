import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "#test/runner";
import assert from "#test/assert";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const sourceStartScript = path.join(repoRoot, "scripts", "start.mjs");

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-start-"));
  return { dir };
}

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  if (mode !== undefined) {
    fs.chmodSync(filePath, mode);
  }
}

function withTempEnv(pairs) {
  const previous = new Map();
  for (const [key, value] of Object.entries(pairs)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function importFixtureStart(fixtureDir) {
  const restoreEnv = withTempEnv({
    C64BRIDGE_START_SKIP_AUTO_LAUNCH: "1",
    C64BRIDGE_PROJECT_ROOT: fixtureDir,
  });
  try {
    const href = `${pathToFileURL(sourceStartScript).href}?t=${Date.now()}-${Math.random()}`;
    return await import(href);
  } finally {
    restoreEnv();
  }
}

test("start script helper functions handle project root and file checks", async (t) => {
  const fixture = createFixture();
  writeFile(path.join(fixture.dir, "plain-file.txt"), "hello\n");

  t.after(() => {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  const startModule = await importFixtureStart(fixture.dir);

  const restoreProjectRoot = withTempEnv({
    C64BRIDGE_PROJECT_ROOT: fixture.dir,
  });
  try {
    assert.equal(startModule.resolveProjectRoot(), fixture.dir);
  } finally {
    restoreProjectRoot();
  }

  const restoreDefaultProjectRoot = withTempEnv({
    C64BRIDGE_PROJECT_ROOT: undefined,
  });
  try {
    assert.equal(startModule.resolveProjectRoot(), repoRoot);
  } finally {
    restoreDefaultProjectRoot();
  }

  const restoreForceNode = withTempEnv({
    C64BRIDGE_START_FORCE_NODE_RUNTIME: "1",
  });
  try {
    assert.equal(startModule.shouldImportTypeScriptDirectly(), false);
  } finally {
    restoreForceNode();
  }

  assert.equal(await startModule.fileExists(path.join(fixture.dir, "plain-file.txt")), true);
  assert.equal(await startModule.fileExists(path.join(fixture.dir, "missing.txt")), false);
  assert.equal(await startModule.fileExists(path.join(fixture.dir, "plain-file.txt", "child.txt")), false);
});

test("start script resolves configured Bun executables and default fallback", async (t) => {
  const fixture = createFixture();
  const configuredBun = path.join(fixture.dir, "configured-bun.sh");
  const installBun = path.join(fixture.dir, "bun-home", "bin", "bun");
  writeFile(configuredBun, "#!/bin/sh\nexit 0\n", 0o755);
  writeFile(installBun, "#!/bin/sh\nexit 0\n", 0o755);

  t.after(() => {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  const startModule = await importFixtureStart(fixture.dir);

  const restoreConfigured = withTempEnv({
    BUN_BIN: "",
    C64BRIDGE_TEST_BUN_BIN: path.join(fixture.dir, "missing-bun.sh"),
    C64BRIDGE_BUN_BIN: configuredBun,
    BUN_INSTALL: undefined,
    HOME: fixture.dir,
  });
  try {
    assert.equal(startModule.resolveBunExecutable(), configuredBun);
  } finally {
    restoreConfigured();
  }

  const restoreInstall = withTempEnv({
    BUN_BIN: undefined,
    C64BRIDGE_TEST_BUN_BIN: undefined,
    C64BRIDGE_BUN_BIN: undefined,
    BUN_INSTALL: path.join(fixture.dir, "bun-home"),
    HOME: fixture.dir,
  });
  try {
    assert.equal(startModule.resolveBunExecutable(), installBun);
  } finally {
    restoreInstall();
  }

  const restoreFallback = withTempEnv({
    BUN_BIN: undefined,
    C64BRIDGE_TEST_BUN_BIN: undefined,
    C64BRIDGE_BUN_BIN: undefined,
    BUN_INSTALL: undefined,
    HOME: fixture.dir,
  });
  try {
    assert.equal(startModule.resolveBunExecutable(), "bun");
  } finally {
    restoreFallback();
  }
});

test("start script handles Bun child process signals", async (t) => {
  const fixture = createFixture();
  const stubPath = path.join(fixture.dir, "bun-signal.sh");
  writeFile(
    stubPath,
    "#!/bin/sh\nkill -TERM $$\n",
    0o755,
  );

  const signals = [];
  const oldKill = process.kill;
  t.after(() => {
    process.kill = oldKill;
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  process.kill = (pid, signal) => {
    signals.push([pid, signal]);
    return true;
  };

  const startModule = await importFixtureStart(fixture.dir);
  const restoreEnv = withTempEnv({
    BUN_BIN: stubPath,
    HOME: fixture.dir,
  });
  try {
    assert.equal(await startModule.runWithBun(path.join(fixture.dir, "entry.ts")), true);
  } finally {
    restoreEnv();
  }

  assert.deepEqual(signals, [[process.pid, "SIGTERM"]]);
});

test("start script falls back to dist when Bun cannot be launched", async (t) => {
  const fixture = createFixture();
  const markerKey = `__startFixtureDistFallback_${Date.now()}`;
  writeFile(path.join(fixture.dir, "src", "index.ts"), "export {};\n");
  writeFile(
    path.join(fixture.dir, "dist", "index.js"),
    `globalThis.${markerKey} = "dist-fallback";\n`,
  );

  t.after(() => {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
    delete globalThis[markerKey];
  });

  const startModule = await importFixtureStart(fixture.dir);
  const restoreEnv = withTempEnv({
    C64BRIDGE_PROJECT_ROOT: fixture.dir,
    C64BRIDGE_START_FORCE_NODE_RUNTIME: "1",
    BUN_BIN: path.join(fixture.dir, "missing-bun.sh"),
    C64BRIDGE_TEST_BUN_BIN: undefined,
    C64BRIDGE_BUN_BIN: undefined,
    BUN_INSTALL: undefined,
    HOME: fixture.dir,
    PATH: fixture.dir,
  });
  try {
    await startModule.launch();
  } finally {
    restoreEnv();
  }

  assert.equal(globalThis[markerKey], "dist-fallback");
});
test("start script imports src entry directly when running under Bun", async (t) => {
  const fixture = createFixture();
  const markerKey = `__startFixtureSrc_${Date.now()}`;
  writeFile(
    path.join(fixture.dir, "src", "index.ts"),
    `globalThis.${markerKey} = "src";\n`,
  );

  t.after(() => {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
    delete globalThis[markerKey];
  });

  const startModule = await importFixtureStart(fixture.dir);
  const restoreEnv = withTempEnv({
    C64BRIDGE_PROJECT_ROOT: fixture.dir,
  });
  try {
    await startModule.launch();
  } finally {
    restoreEnv();
  }
  assert.equal(globalThis[markerKey], "src");
});

test("start script runs src via configured Bun executable when Bun global is unavailable", async (t) => {
  const fixture = createFixture();
  const captureFile = path.join(fixture.dir, "captured-args.txt");
  const stubPath = path.join(fixture.dir, "bun-stub.sh");
  writeFile(path.join(fixture.dir, "src", "index.ts"), "export {};\n");
  writeFile(
    stubPath,
    "#!/bin/sh\nprintf '%s\n%s\n' \"$PWD\" \"$1\" > \"$START_CAPTURE_FILE\"\n",
    0o755,
  );

  t.after(() => {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  const startModule = await importFixtureStart(fixture.dir);
  const previousExitCode = process.exitCode;
  const restoreEnv = withTempEnv({
    C64BRIDGE_PROJECT_ROOT: fixture.dir,
    C64BRIDGE_START_FORCE_NODE_RUNTIME: "1",
    BUN_BIN: stubPath,
    HOME: fixture.dir,
    START_CAPTURE_FILE: captureFile,
  });
  try {
    await startModule.launch();
  } finally {
    restoreEnv();
    process.exitCode = previousExitCode;
  }

  const [capturedCwd, capturedEntry] = fs.readFileSync(captureFile, "utf8").trim().split("\n");
  assert.equal(capturedCwd, fixture.dir);
  assert.equal(capturedEntry, path.join(fixture.dir, "src", "index.ts"));
});

test("start script falls back to dist entry when src is unavailable", async (t) => {
  const fixture = createFixture();
  const markerKey = `__startFixtureDist_${Date.now()}`;
  writeFile(
    path.join(fixture.dir, "dist", "index.js"),
    `globalThis.${markerKey} = "dist";\n`,
  );

  t.after(() => {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
    delete globalThis[markerKey];
  });

  const startModule = await importFixtureStart(fixture.dir);
  const restoreEnv = withTempEnv({
    C64BRIDGE_PROJECT_ROOT: fixture.dir,
  });
  try {
    await startModule.launch();
  } finally {
    restoreEnv();
  }
  assert.equal(globalThis[markerKey], "dist");
});

test("start script reports missing entry points", async (t) => {
  const fixture = createFixture();
  const errors = [];
  const oldError = console.error;
  const previousExitCode = process.exitCode;
  console.error = (...args) => {
    errors.push(args.join(" "));
  };

  t.after(() => {
    console.error = oldError;
    process.exitCode = previousExitCode;
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });

  const startModule = await importFixtureStart(fixture.dir);
  const restoreEnv = withTempEnv({
    C64BRIDGE_PROJECT_ROOT: fixture.dir,
  });
  try {
    await startModule.launch();
  } finally {
    restoreEnv();
  }
  assert.equal(process.exitCode, 1);
  assert.ok(errors.some((line) => line.includes("Unable to locate server entry point")));
});
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

// The pid file only proves that the child started. The launcher registers its signal forwarders
// in the statements after spawn(), and until then Node's own default SIGTERM handler terminates the
// launcher without touching the child. SIGHUP is the last forwarder registered and Node does not catch it
// by default, so a caught SIGHUP means all forwarders are in place. /proc is only available on Linux;
// elsewhere a short fixed delay is used.
async function waitForSignalForwarders(pid) {
  const statusPath = `/proc/${pid}/status`;
  if (!fs.existsSync(statusPath)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return true;
  }
  return await waitUntil(() => {
    try {
      const line = fs.readFileSync(statusPath, "utf8").split("\n").find((entry) => entry.startsWith("SigCgt:"));
      return line !== undefined && (BigInt(`0x${line.split(/\s+/)[1]}`) & 1n) === 1n;
    } catch {
      return false;
    }
  });
}

test("start script forwards SIGTERM to the Bun child and the child exits", async (t) => {
  const fixture = createFixture();
  t.after(() => {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  });
  const pidFile = path.join(fixture.dir, "child.pid");
  const stubPath = path.join(fixture.dir, "bun-stub.sh");
  // The stub stands in for Bun: it records its pid, then becomes a long sleep.
  writeFile(stubPath, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`, 0o755);
  writeFile(path.join(fixture.dir, "src", "index.ts"), "// fake entry\n");

  const { spawn } = await import("node:child_process");
  const launcher = spawn(process.env.C64BRIDGE_TEST_NODE_BIN || "node", [sourceStartScript], {
    cwd: fixture.dir,
    env: {
      ...process.env,
      C64BRIDGE_PROJECT_ROOT: fixture.dir,
      C64BRIDGE_START_SKIP_AUTO_LAUNCH: "0",
      BUN_BIN: stubPath,
    },
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => launcher.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
  });

  assert.ok(await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== ""), "child never started");
  const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(pidAlive(childPid));

  t.after(() => {
    if (pidAlive(childPid)) process.kill(childPid, "SIGKILL");
  });
  assert.ok(await waitForSignalForwarders(launcher.pid), "launcher never registered its signal forwarders");
  launcher.kill("SIGTERM");
  await exited;
  assert.ok(await waitUntil(() => !pidAlive(childPid)), "child process survived SIGTERM to the launcher");
});
