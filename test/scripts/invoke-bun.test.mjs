import test from "#test/runner";
import assert from "#test/assert";
import { buildBunArgs } from "../../scripts/invoke-bun.mjs";

test("invoke-bun prefixes script paths with bun run", () => {
  assert.deepEqual(
    buildBunArgs(["scripts/run-tests.ts", "--platform=c64u"]),
    ["run", "scripts/run-tests.ts", "--platform=c64u"],
  );
  assert.deepEqual(
    buildBunArgs(["src/mcp-server.ts"]),
    ["run", "src/mcp-server.ts"],
  );
});

test("invoke-bun preserves explicit bun subcommands", () => {
  assert.deepEqual(
    buildBunArgs(["test", "test/device.test.mjs"]),
    ["test", "test/device.test.mjs"],
  );
  assert.deepEqual(
    buildBunArgs(["run", "scripts/run-tests.ts"]),
    ["run", "scripts/run-tests.ts"],
  );
});

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(`invoke-bun forwards ${signal} and reaps its child`, async (t) => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { spawn } = await import("node:child_process");
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-invoke-"));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const pidFile = path.join(fixture, "child.pid");
    const stub = path.join(fixture, "bun.sh");
    fs.writeFileSync(stub, '#!/bin/sh\necho $$ > "$INVOKE_PID_FILE"\nexec sleep 60\n', { mode: 0o755 });
    const wrapper = spawn(process.env.C64BRIDGE_TEST_NODE_BIN || "node", [fileURLToPath(new URL("../../scripts/invoke-bun.mjs", import.meta.url)), "fake-server.ts"], {
      cwd: fixture,
      env: { ...process.env, BUN_BIN: stub, INVOKE_PID_FILE: pidFile },
      stdio: "ignore",
    });
    const exited = new Promise((resolve, reject) => {
      wrapper.once("error", reject);
      wrapper.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    t.after(() => {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
    });
    assert.ok(await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== ""), "child never started");
    const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    t.after(() => {
      if (pidAlive(childPid)) process.kill(childPid, "SIGKILL");
    });
    // SIGHUP is the last installed handler; /proc avoids signalling in the
    // small interval between spawn() and registering the forwarders.
    const statusPath = `/proc/${wrapper.pid}/status`;
    if (fs.existsSync(statusPath)) {
      assert.ok(await waitUntil(() => {
        try {
          const line = fs.readFileSync(statusPath, "utf8").split("\n").find((entry) => entry.startsWith("SigCgt:"));
          return line !== undefined && (BigInt(`0x${line.split(/\s+/)[1]}`) & 1n) === 1n;
        } catch {
          return false;
        }
      }), "wrapper never registered its signal handlers");
    } else {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    wrapper.kill(signal);
    const outcome = await exited;
    assert.equal(outcome.signal, signal);
    assert.ok(await waitUntil(() => !pidAlive(childPid)), "server child survived termination of invoke-bun");
  });
}


test("invoke-bun reports a failed Bun spawn without an unhandled event", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-invoke-error-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const stub = path.join(fixture, "bun.sh");
  // An executable with a missing interpreter passes access(X_OK), but spawn fails.
  fs.writeFileSync(stub, "#!/nonexistent/c64bridge-test-interpreter\n", { mode: 0o755 });
  const result = spawnSync(process.env.C64BRIDGE_TEST_NODE_BIN || "node", [fileURLToPath(new URL("../../scripts/invoke-bun.mjs", import.meta.url)), "fake-server.ts"], {
    cwd: fixture,
    env: { ...process.env, BUN_BIN: stub },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[invoke-bun\] Unable to start Bun:.*ENOENT/);
  assert.equal(result.stderr.includes("Unhandled 'error' event"), false);
});
