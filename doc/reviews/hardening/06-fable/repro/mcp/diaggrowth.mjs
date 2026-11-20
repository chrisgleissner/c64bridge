// Usage: node /tmp/h6/mcp/harness.mjs <entry: dist|src> [mode]
// Starts the loopback mock, then the real server over stdio, and measures.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, readdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const repo = "/home/claude/c64bridge";
const entry = process.argv[2] ?? "dist";
const mode = process.argv[3] ?? "mock"; // mock | refused | blackhole | hang
const { startMockC64Server } = await import(`${repo}/scripts/mockC64Server.mjs`);

let baseHost, port, mock, hang;
if (mode === "mock") {
  mock = await startMockC64Server();
  const u = new URL(mock.baseUrl); baseHost = u.hostname; port = Number(u.port);
} else if (mode === "refused") {
  baseHost = "127.0.0.1"; port = 1; // nothing listens
} else if (mode === "hang") {
  // accepts the connection and never answers
  hang = createServer(() => {}); await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  baseHost = "127.0.0.1"; port = hang.address().port;
}
const dir = mkdtempSync(join(tmpdir(), "h6mcp-"));
const cfg = join(dir, "cfg.json");
writeFileSync(cfg, JSON.stringify({ c64u: { host: baseHost, port } }));
const state = join(dir, "state");
const env = { ...process.env, C64BRIDGE_CONFIG: cfg, C64BRIDGE_STATE_DIR: state, HOME: dir, C64_MODE: "c64u" };
delete env.NODE_ENV;
for (const [k, v] of Object.entries(JSON.parse(process.env.EXTRA_ENV ?? "{}"))) env[k] = v;
const args = entry === "dist" ? [`${repo}/dist/index.js`] : ["--import", "tsx/esm", `${repo}/src/index.ts`];
const t0 = performance.now();
const child = spawn(process.execPath, args, { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => { stderr += d; });
let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)({ msg, bytes: Buffer.byteLength(line) }); pending.delete(msg.id); }
    else if (process.env.SHOW_NOTIF) console.log("notif", line.slice(0, 200));
  }
});
let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  const p = new Promise((r) => pending.set(id, r));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}
function notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "h6", version: "0" } });
const tInit = performance.now() - t0;
notify("notifications/initialized", {});
console.log(`initialize response after ${tInit.toFixed(0)} ms; protocol=${init.msg.result.protocolVersion}; capabilities=${JSON.stringify(init.msg.result.capabilities)}`);
const results = {};
async function timed(label, method, params) {
  const s = performance.now();
  const r = await rpc(method, params);
  const ms = performance.now() - s;
  results[label] = r;
  console.log(`${label}: ${ms.toFixed(1)} ms, ${r.bytes} bytes${r.msg.error ? " ERROR " + JSON.stringify(r.msg.error).slice(0, 300) : ""}`);
  return r;
}
const call = (label, name, a) => timed(label, "tools/call", { name, arguments: a });
await timed("first tools/call (read 1 byte)", "tools/call", { name: "c64_memory", arguments: { op: "read", address: "$0400", length: 1 } });
if (mode !== "mock") {
  console.log("stderr:\n" + stderr.split("\n").slice(-6).join("\n"));
  child.kill("SIGTERM"); hang?.close(); process.exit(0);
}

const ddir = join(state, "diagnostics"); const f = join(ddir, readdirSync(ddir)[0]);
const before = statSync(f).size;
const s0 = performance.now();
await call("wait 3s @20ms", "c64_memory", { op: "wait_for_text", pattern: "NEVER", timeoutMs: 3000, intervalMs: 20 });
const grown = statSync(f).size - before;
const recs = readFileSync(f, "utf8").trim().split("\n").length;
console.log(`diagnostics grew ${grown} bytes during one 3 s wait_for_text (${recs} records total) => ${(grown/3/1024).toFixed(1)} KiB/s`);
child.kill("SIGTERM"); await mock?.close();
