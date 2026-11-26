// Deterministic raw JSON-RPC test client for both protocol eras, on stdio and stateless HTTP.
//
// Chosen over the SDK v2 client: the tests must control the per-request envelope exactly (declared
// extensions, malformed capability metadata, missing protocol version) and see the raw result, including
// `resultType`, which a typed client would hide or reject. The envelope shapes follow
// test/modernProtocol.test.mjs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockC64Server } from "../../scripts/mockC64Server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const MODERN = "2026-07-28";
export const TASKS_EXT = "io.modelcontextprotocol/tasks";
export const SKILLS_EXT = "io.modelcontextprotocol/skills";
const KEY_VERSION = "io.modelcontextprotocol/protocolVersion";
const KEY_INFO = "io.modelcontextprotocol/clientInfo";
const KEY_CAPS = "io.modelcontextprotocol/clientCapabilities";

export async function waitFor(predicate, { timeoutMs = 30_000, intervalMs = 20, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`${label} not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
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
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 5_000).unref();
  });
}

/**
 * Starts a mock C64 and a c64bridge server on stdio or HTTP.
 * `env` entries are added to the server environment (access mode, inline window, ttl, page size, token ...).
 */
export async function startServer(t, { transport = "stdio", env = {}, mockOptions, execPath = process.execPath } = {}) {
  const mock = await startMockC64Server(mockOptions);
  t.after(async () => { await mock.close(); });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-native-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const configPath = path.join(tempRoot, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ c64u: { baseUrl: mock.baseUrl } }), "utf8");
  const homeDir = path.join(tempRoot, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const port = transport === "http" ? await reservePort() : undefined;
  const child = spawn(
    execPath,
    ["--import", "tsx/esm", path.join(repoRoot, "src", "mcp-server.ts"), ...(port ? ["--http", String(port)] : [])],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        C64BRIDGE_SKIP_AUTO_START: "0",
        C64BRIDGE_CONFIG: configPath,
        C64_TASK_STATE_FILE: path.join(homeDir, "tasks.json"),
        HOME: homeDir,
        C64_TEST_TARGET: "mock",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => stopChild(child));
  const marker = port ? "running on HTTP" : "running on stdio";
  await waitFor(() => stderr.includes(marker), { timeoutMs: 60_000, label: `server start (${marker})` });
  if (port) child.stdout.resume();
  return { transport, mock, child, port, token: env.C64BRIDGE_HTTP_TOKEN, getStderr: () => stderr };
}

/** One JSON-RPC exchange over the child's stdio. Notifications from the server are collected, never matched. */
function stdioChannel(child) {
  const pending = new Map();
  const notifications = [];
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
      } else if (message.method) {
        notifications.push(message);
      }
    }
  });
  return {
    notifications,
    send(body, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(body.id); reject(new Error(`no response to ${body.method}`)); }, timeoutMs);
        pending.set(body.id, (message) => { clearTimeout(timer); resolve({ message }); });
        child.stdin.write(`${JSON.stringify(body)}\n`);
      });
    },
    notify(body) { child.stdin.write(`${JSON.stringify(body)}\n`); },
  };
}

function httpChannel(server) {
  return {
    notifications: [],
    async send(body, timeoutMs, headers = {}) {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(server.token ? { authorization: `Bearer ${server.token}` } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      // An event stream carries progress notifications before the response; the response is the message with the id.
      const messages = text.split("\n").filter((line) => line.startsWith("data:")).map((line) => { try { return JSON.parse(line.slice(5)); } catch { return undefined; } }).filter(Boolean);
      let message = messages.find((entry) => entry.id === body.id);
      if (!message) { try { message = JSON.parse(text); } catch { message = undefined; } }
      return { message, status: response.status, text };
    },
    notify(body) { return this.send(body, 5_000).catch(() => {}); },
  };
}

const NAME_SOURCE = { "tools/call": "name", "prompts/get": "name", "resources/read": "uri", "tasks/get": "taskId", "tasks/update": "taskId", "tasks/cancel": "taskId" };

/**
 * Connects a client. `era: "legacy"` performs the 2025 handshake; `era: "modern"` sends a per-request envelope
 * with `extensions` (object of declared extensions) or, for malformed metadata tests, `capabilities` verbatim
 * and `omit` (list of envelope keys to leave out).
 */
export async function connect(server, { era = "modern", extensions, capabilities, omit = [], protocolVersion = MODERN, timeoutMs = 30_000 } = {}) {
  const channel = server.transport === "http" ? httpChannel(server) : stdioChannel(server.child);
  let nextId = 1;
  const envelope = () => {
    const meta = {
      [KEY_VERSION]: protocolVersion,
      [KEY_INFO]: { name: "native-test", version: "0.0.0" },
      [KEY_CAPS]: capabilities !== undefined ? capabilities : (extensions ? { extensions } : {}),
    };
    for (const key of omit) delete meta[key];
    return meta;
  };
  const client = {
    era,
    channel,
    /** Sends a request; resolves to `{ result }` or `{ error }` (plus HTTP `status`). */
    async request(method, params = {}, { headers = {}, timeout = timeoutMs } = {}) {
      const body = {
        jsonrpc: "2.0",
        id: nextId++,
        method,
        params: era === "modern" ? { ...params, _meta: { ...(params._meta ?? {}), ...envelope() } } : params,
      };
      let reply;
      if (server.transport === "http") {
        const extra = era === "modern" ? { "mcp-protocol-version": protocolVersion, "mcp-method": method } : {};
        const field = NAME_SOURCE[method];
        if (era === "modern" && field && typeof params[field] === "string") extra["mcp-name"] = params[field];
        reply = await channel.send(body, timeout, { ...extra, ...headers });
      } else {
        reply = await channel.send(body, timeout);
      }
      const { message, status } = reply;
      if (!message) return { status, error: { code: undefined, message: reply.text ?? "no message" } };
      return message.error ? { error: message.error, status } : { result: message.result, status };
    },
    callTool(name, args = {}, params = {}) {
      return this.request("tools/call", { name, arguments: args, ...params });
    },
    /** Like request, but throws on a JSON-RPC error. */
    async ok(method, params) {
      const reply = await this.request(method, params);
      if (reply.error) throw new Error(`${method} failed: ${JSON.stringify(reply.error)}`);
      return reply.result;
    },
  };
  if (era === "legacy") {
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "legacy-test", version: "0.0.0" },
    });
    if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
    client.initializeResult = init.result;
    if (server.transport === "stdio") channel.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  return client;
}

/** Text of the first text block of a tool result. */
export function resultText(result) {
  return (result?.content ?? []).find((block) => block.type === "text")?.text ?? "";
}

/** The structured data of a tool result (`structuredContent.data`). */
export function resultData(result) {
  return result?.structuredContent?.data;
}
