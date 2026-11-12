import test from "#test/runner";
import assert from "#test/assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tsLoader = "tsx/esm";

async function waitFor(predicate, { timeoutMs = 60_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("condition not met before timeout");
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Starts the stdio server against the REST mock, initialises it and starts a
// short-interval background read task. Returns once the task is running.
async function startServerWithTask(t) {
  const mock = await startMockC64Server();
  t.after(async () => { await mock.close(); });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-lifecycle-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const configPath = path.join(tempRoot, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ c64u: { baseUrl: mock.baseUrl } }), "utf8");
  const homeDir = path.join(tempRoot, "home");
  fs.mkdirSync(homeDir, { recursive: true });

  const child = spawn(
    process.execPath,
    ["--import", tsLoader, path.join(repoRoot, "src", "mcp-server.ts")],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        C64BRIDGE_SKIP_AUTO_START: "0",
        C64BRIDGE_CONFIG: configPath,
        C64_TASK_STATE_FILE: path.join(homeDir, "tasks.json"),
        HOME: homeDir,
        C64_TEST_TARGET: "mock",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const responses = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) responses.set(message.id, message);
      } catch {
        // ignore non-JSON output
      }
    }
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = async (id, method, params) => {
    send({ jsonrpc: "2.0", id, method, params });
    await waitFor(() => responses.has(id));
    return responses.get(id);
  };

  await waitFor(() => stderr.includes("running on stdio"));
  await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "0.0.0" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const started = await request(2, "tools/call", {
    name: "c64_system",
    arguments: { op: "start_task", name: "lifecycle", operation: "read", arguments: { address: "$0400", length: 1 }, intervalMs: 100 },
  });
  assert.ok(!started.result?.isError, JSON.stringify(started));
  return { child, exited, getStderr: () => stderr, request };
}

test("R-02 the server exits within 3 s when stdin closes while a background task runs", async (t) => {
  const { child, exited, getStderr } = await startServerWithTask(t);
  const startedAt = Date.now();
  child.stdin.end();
  const result = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 3_000)),
  ]);
  assert.notEqual(result, "timeout", `server still running 3 s after stdin close; stderr: ${getStderr().slice(-500)}`);
  assert.ok(Date.now() - startedAt < 3_500);
  assert.equal(result.code, 0);
});

test("R-02 SIGTERM stops background tasks and exits with the signal exit code", async (t) => {
  const { child, exited } = await startServerWithTask(t);
  const pid = child.pid;
  child.kill("SIGTERM");
  const result = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 3_000)),
  ]);
  assert.notEqual(result, "timeout", "server did not exit within 3 s of SIGTERM");
  assert.equal(result.code, 143);
  assert.equal(pidAlive(pid), false);
});
