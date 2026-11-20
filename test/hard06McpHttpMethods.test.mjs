import test from "#test/runner";
import assert from "#test/assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("MCP-15 the stateless HTTP endpoint answers GET and DELETE with 405 instead of an endless stream", async () => {
  const mock = await startMockC64Server();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h6-http-"));
  const configPath = path.join(tempRoot, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ c64u: { baseUrl: mock.baseUrl } }), "utf8");
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx/esm", path.join(repoRoot, "src", "mcp-server.ts"), "--http", String(port)], {
    cwd: repoRoot,
    env: { ...process.env, C64BRIDGE_SKIP_AUTO_START: "0", C64BRIDGE_CONFIG: configPath, HOME: tempRoot, C64_TASK_STATE_FILE: path.join(tempRoot, "tasks.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.resume();
    const deadline = Date.now() + 60_000;
    while (!stderr.includes("running on HTTP") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    const headers = { accept: "application/json, text/event-stream" };
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method, headers, signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get("allow"), "POST");
      await response.text();
    }
    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    assert.equal(init.status, 200);
    await init.text();
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(tempRoot, { recursive: true, force: true });
    await mock.close();
  }
});

const HTTP_TRANSPORT_MARKER = "c64bridge-test: streamableHttp loaded";

function nodeExecutable() {
  if (typeof globalThis.Bun === "undefined") return process.execPath;
  return globalThis.Bun.which?.("node") ?? "node";
}

// Starts the server under Node with a resolve hook that writes a marker to stderr when the
// streamable HTTP transport module is resolved, and returns the stderr once the server has started.
async function startupStderr(serverArgs, readyText) {
  const mock = await startMockC64Server();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-h6-lazy-"));
  const configPath = path.join(tempRoot, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ c64u: { baseUrl: mock.baseUrl } }), "utf8");
  const hookPath = path.join(tempRoot, "hook.mjs");
  fs.writeFileSync(hookPath, [
    'import { registerHooks } from "node:module";',
    "registerHooks({ resolve(specifier, context, next) {",
    "  const resolved = next(specifier, context);",
    `  if (/server\\/streamableHttp\\.js$/.test(resolved.url)) process.stderr.write(${JSON.stringify(HTTP_TRANSPORT_MARKER + "\n")});`,
    "  return resolved;",
    "} });",
  ].join("\n"), "utf8");
  const child = spawn(nodeExecutable(), ["--import", pathToFileURL(hookPath).href, "--import", "tsx/esm", path.join(repoRoot, "src", "mcp-server.ts"), ...serverArgs], {
    cwd: repoRoot,
    env: { ...process.env, C64BRIDGE_SKIP_AUTO_START: "0", C64BRIDGE_CONFIG: configPath, HOME: tempRoot, C64_TASK_STATE_FILE: path.join(tempRoot, "tasks.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.resume();
    const deadline = Date.now() + 60_000;
    while (!stderr.includes(readyText) && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(stderr.includes(readyText), `server did not start: ${stderr.slice(-2000)}`);
    return stderr;
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(tempRoot, { recursive: true, force: true });
    await mock.close();
  }
}

test("PACKAGE-8 stdio startup does not load the HTTP transport; --http does", async () => {
  const stdio = await startupStderr([], "running on stdio");
  assert.equal(stdio.includes(HTTP_TRANSPORT_MARKER), false, "stdio mode loaded the HTTP transport");
  const port = await freePort();
  const http = await startupStderr(["--http", String(port)], "running on HTTP");
  assert.ok(http.includes(HTTP_TRANSPORT_MARKER), "the hook did not observe the HTTP transport in --http mode");
});
