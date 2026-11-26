import test from "#test/runner";
import assert from "#test/assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODERN = "2026-07-28";
const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "modern-test", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const modernParams = (params = {}) => ({ ...params, _meta: { ...(params._meta ?? {}), ...META } });
const legacyInit = {
  jsonrpc: "2.0",
  id: 100,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy-test", version: "0.0.0" } },
};

async function waitFor(predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met before timeout");
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5_000).unref();
  });
}

async function spawnServer(t, args) {
  const mock = await startMockC64Server();
  t.after(async () => { await mock.close(); });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-modern-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const configPath = path.join(tempRoot, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ c64u: { baseUrl: mock.baseUrl } }), "utf8");
  const homeDir = path.join(tempRoot, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", path.join(repoRoot, "src", "mcp-server.ts"), ...args],
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
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => stopChild(child));
  return { child, getStderr: () => stderr };
}

/** Line-delimited JSON-RPC over the child's stdio. */
function stdioRpc(child) {
  const pending = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  return (body) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no response to ${body.method}`)), 30_000);
    pending.set(body.id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify(body)}\n`);
  });
}

function assertDiscover(message) {
  assert.ok(message.result, `server/discover failed: ${JSON.stringify(message)}`);
  assert.ok(message.result.supportedVersions.includes(MODERN), JSON.stringify(message.result));
  assert.ok(message.result.capabilities.tools, "tools capability advertised");
  assert.ok(message.result.capabilities.resources, "resources capability advertised");
  assert.ok(message.result.capabilities.prompts, "prompts capability advertised");
  const serverInfo = message.result._meta?.["io.modelcontextprotocol/serverInfo"] ?? message.result.serverInfo;
  assert.ok(serverInfo?.name, JSON.stringify(message.result));
}

function assertTools(message) {
  assert.ok(message.result, `tools/list failed: ${JSON.stringify(message)}`);
  assert.ok(message.result.tools.some((tool) => tool.name === "c64_system"));
}

function assertCall(message) {
  assert.ok(message.result, `tools/call failed: ${JSON.stringify(message)}`);
  assert.ok(Array.isArray(message.result.content));
}

const callBody = (id) => ({
  jsonrpc: "2.0", id, method: "tools/call",
  params: modernParams({ name: "c64_system", arguments: { op: "list_tasks" } }),
});

test("modern era over stdio: server/discover, tools/list, tools/call", async (t) => {
  const { child, getStderr } = await spawnServer(t, []);
  await waitFor(() => getStderr().includes("running on stdio"));
  const rpc = stdioRpc(child);
  assertDiscover(await rpc({ jsonrpc: "2.0", id: 1, method: "server/discover", params: modernParams() }));
  assertTools(await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: modernParams() }));
  assertCall(await rpc(callBody(3)));
});

test("pre-2026 initialize still works over stdio", async (t) => {
  const { child, getStderr } = await spawnServer(t, []);
  await waitFor(() => getStderr().includes("running on stdio"));
  const rpc = stdioRpc(child);
  const init = await rpc(legacyInit);
  assert.ok(init.result?.serverInfo, JSON.stringify(init));
  assert.ok(init.result.capabilities.tools);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  assertTools(await rpc({ jsonrpc: "2.0", id: 101, method: "tools/list", params: {} }));
});

async function startHttp(t) {
  const port = await reservePort();
  const server = await spawnServer(t, ["--http", String(port)]);
  server.child.stdout.resume();
  await waitFor(() => server.getStderr().includes("running on HTTP"));
  return port;
}

async function httpRpc(port, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
  let message;
  try { message = JSON.parse(dataLine ? dataLine.slice(5) : text); } catch { message = undefined; }
  return { status: response.status, message, text };
}

function modernHeaders(body) {
  const headers = { "mcp-protocol-version": MODERN, "mcp-method": body.method };
  if (body.method === "tools/call") headers["mcp-name"] = body.params.name;
  return headers;
}

test("modern era over stateless HTTP: server/discover, tools/list, tools/call", async (t) => {
  const port = await startHttp(t);
  const send = async (body) => {
    const reply = await httpRpc(port, body, modernHeaders(body));
    assert.equal(reply.status, 200, reply.text);
    return reply.message;
  };
  assertDiscover(await send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: modernParams() }));
  assertTools(await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: modernParams() }));
  assertCall(await send(callBody(3)));
});

test("pre-2026 initialize still works over stateless HTTP", async (t) => {
  const port = await startHttp(t);
  const init = await httpRpc(port, legacyInit);
  assert.equal(init.status, 200, init.text);
  assert.ok(init.message?.result?.serverInfo, init.text);
  const list = await httpRpc(port, { jsonrpc: "2.0", id: 101, method: "tools/list", params: {} });
  assert.equal(list.status, 200, list.text);
  assertTools(list.message);
});
