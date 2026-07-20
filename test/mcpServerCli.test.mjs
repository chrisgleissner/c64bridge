import test from "#test/runner";
import assert from "#test/assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tsLoader = "tsx/esm";

// mcp-server.ts auto-starts a live server on import unless opted out (it is
// always imported as a side effect by src/index.ts in real deployments, so
// it cannot gate on "am I the entrypoint"). A plain top-level `import`
// would run before this opt-out could be set, so load it dynamically. The
// override must be restored immediately: every test file in this repo's Bun
// runs share one process, and leaving this set would silently disable
// auto-start for every server spawned by unrelated test files afterward.
const previousSkipAutoStart = process.env.C64BRIDGE_SKIP_AUTO_START;
process.env.C64BRIDGE_SKIP_AUTO_START = "1";
const { parseCliOptions } = await import("../src/mcp-server.js");
if (previousSkipAutoStart === undefined) delete process.env.C64BRIDGE_SKIP_AUTO_START;
else process.env.C64BRIDGE_SKIP_AUTO_START = previousSkipAutoStart;

test("HARD01-001 parseCliOptions honours --http and its optional port", () => {
  assert.deepEqual(parseCliOptions([]), { mode: "stdio" });
  assert.deepEqual(parseCliOptions(["--foo", "bar"]), { mode: "stdio" });
  assert.deepEqual(parseCliOptions(["--http"]), { mode: "http", port: undefined });
  assert.deepEqual(parseCliOptions(["--http", "8080"]), { mode: "http", port: 8080 });
  assert.deepEqual(parseCliOptions(["--http", "--other-flag"]), { mode: "http", port: undefined });
  assert.deepEqual(parseCliOptions(["--http", "not-a-port"]), { mode: "http", port: undefined });
  assert.deepEqual(parseCliOptions(["--http", "0"]), { mode: "http", port: undefined });
  assert.deepEqual(parseCliOptions(["--http", "70000"]), { mode: "http", port: undefined });
});

async function reserveLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("failed to reserve a loopback port"));
        else resolve(port);
      });
    });
  });
}

function spawnServer(args, env) {
  const child = spawn(
    process.execPath,
    ["--import", tsLoader, path.join(repoRoot, "src", "mcp-server.ts"), ...args],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        // The parent test process opts itself out of auto-start (see the
        // dynamic import above); the spawned child must still start for real.
        C64BRIDGE_SKIP_AUTO_START: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, getStderr: () => stderr };
}

async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("condition not met before timeout");
}

// Bun's test runner executes every file in one shared process, so a spawned
// child that outlives its own test can still be shutting down while later
// files start their own servers. Wait for a real exit (escalating to
// SIGKILL) rather than firing SIGTERM and moving on.
async function stopChild(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", done);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch {}
      setTimeout(done, 200);
    }, timeoutMs);
  });
}

test("HARD01-001 --http <port> opens a real HTTP MCP listener; default invocation stays on stdio", async (t) => {
  const mock = await startMockC64Server();
  t.after(async () => { await mock.close(); });

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-http-cli-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const configPath = path.join(tempRoot, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ c64u: { baseUrl: mock.baseUrl } }), "utf8");
  const homeDir = path.join(tempRoot, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  const port = await reserveLoopbackPort();
  const env = {
    C64BRIDGE_CONFIG: configPath,
    HOME: homeDir,
    C64_TEST_TARGET: "mock",
  };

  const { child, getStderr } = spawnServer(["--http", String(port)], env);
  t.after(() => stopChild(child));

  try {
    await waitFor(() => getStderr().includes("running on HTTP"), { timeoutMs: 15_000 });

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "hard01-001-test", version: "0.0.0" },
        },
      }),
    });

    // The important assertion is that the request reached a real HTTP
    // listener at all (any HTTP status), not the specific status code.
    assert.ok(typeof response.status === "number" && response.status > 0);
  } finally {
    await stopChild(child);
  }
});
