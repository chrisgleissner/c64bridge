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

async function reserveLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(predicate, { timeoutMs = 60_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("condition not met before timeout");
}

async function stopChild(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    child.once("exit", done);
    child.kill("SIGTERM");
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      setTimeout(done, 200);
    }, timeoutMs);
  });
}

async function startHttpServer(t, extraEnv = {}) {
  const mock = await startMockC64Server();
  t.after(async () => { await mock.close(); });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-http-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const configPath = path.join(tempRoot, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ c64u: { baseUrl: mock.baseUrl } }), "utf8");
  const homeDir = path.join(tempRoot, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const port = await reserveLoopbackPort();
  const child = spawn(
    process.execPath,
    ["--import", tsLoader, path.join(repoRoot, "src", "mcp-server.ts"), "--http", String(port)],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        C64BRIDGE_SKIP_AUTO_START: "0",
        C64BRIDGE_CONFIG: configPath,
        C64_TASK_STATE_FILE: path.join(homeDir, "tasks.json"),
        HOME: homeDir,
        C64_TEST_TARGET: "mock",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.resume();
  t.after(() => stopChild(child));
  await waitFor(() => stderr.includes("running on HTTP"));
  return { port, getStderr: () => stderr };
}

async function rpc(port, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let message;
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  try {
    message = JSON.parse(dataLine ? dataLine.slice(5) : text);
  } catch {
    message = undefined;
  }
  return { status: response.status, text, message };
}

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "http-test", version: "0.0.0" } },
};

test("R-01 HTTP mode serves initialize, tools/list and tools/call in sequence", async (t) => {
  const { port } = await startHttpServer(t);

  const init = await rpc(port, initializeBody);
  assert.equal(init.status, 200);
  assert.ok(init.message?.result?.serverInfo);

  const list = await rpc(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.message?.result?.tools));
  assert.ok(list.message.result.tools.some((tool) => tool.name === "c64_system"));

  const call = await rpc(port, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "c64_system", arguments: { op: "list_tasks" } },
  });
  assert.equal(call.status, 200);
  assert.ok(call.message?.result, `unexpected tools/call response: ${call.text}`);

  // A further request after the tool call still succeeds.
  const again = await rpc(port, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
  assert.equal(again.status, 200);
});
