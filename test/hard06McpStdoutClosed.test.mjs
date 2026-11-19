import test from "#test/runner";
import assert from "#test/assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function waitFor(predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met before timeout");
}

test("MCP-8 a closed stdout pipe ends the server through the shutdown path, not an uncaught EPIPE", async () => {
  const mock = await startMockC64Server();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h6-stdout-"));
  const configPath = path.join(tempRoot, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ c64u: { baseUrl: mock.baseUrl } }), "utf8");
  const child = spawn(process.execPath, ["--import", "tsx/esm", path.join(repoRoot, "src", "mcp-server.ts")], {
    cwd: repoRoot,
    env: { ...process.env, C64BRIDGE_SKIP_AUTO_START: "0", C64BRIDGE_CONFIG: configPath, HOME: tempRoot, C64_TASK_STATE_FILE: path.join(tempRoot, "tasks.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    await waitFor(() => stderr.includes("running on stdio"));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })}\n`);
    await waitFor(() => stdout.includes("\"id\":1"));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "c64_memory", arguments: { op: "wait_for_text", pattern: "NEVER", timeoutMs: 600, intervalMs: 100 } } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.stdout.destroy();
    const result = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 15_000))]);
    assert.notEqual(result, "timeout");
    assert.equal(result.code, 0, stderr.slice(-800));
    assert.match(stderr, /shutting down \(stdout closed\)/);
    assert.equal(/Unhandled 'error' event/.test(stderr), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(tempRoot, { recursive: true, force: true });
    await mock.close();
  }
});
