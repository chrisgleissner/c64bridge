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
const lt = await timed("tools/list", "tools/list", {});
await timed("resources/list", "resources/list", {});
await timed("prompts/list", "prompts/list", {});
await timed("resources/templates/list", "resources/templates/list", {});
await timed("logging/setLevel", "logging/setLevel", { level: "debug" });
await timed("ping", "ping", {});
// typical results
await call("read 256", "c64_memory", { op: "read", address: "$0400", length: 256 });
await call("read 4096", "c64_memory", { op: "read", address: "$0400", length: 4096 });
await call("read_screen", "c64_memory", { op: "read_screen" });
await call("disassemble 20", "c64_memory", { op: "disassemble", address: "$E000", instructionCount: 20 });
await call("config get Audio", "c64_config", { op: "get", category: "Audio" });
await call("rag basic", "c64_rag", { op: "basic", q: "print to screen" });
await call("unknown tool", "c64_nope", {});
await call("bad op", "c64_memory", { op: "nope" });
writeFileSync("/tmp/h6/mcp/results.json", JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.msg])), null, 1));
// per-call overhead: 50 sequential reads of 1 byte
let s = performance.now();
for (let i = 0; i < 50; i++) await rpc("tools/call", { name: "c64_memory", arguments: { op: "read", address: "$0400", length: 1 } });
console.log(`50 x read 1 byte: avg ${((performance.now() - s) / 50).toFixed(2)} ms`);
s = performance.now();
for (let i = 0; i < 50; i++) await rpc("tools/call", { name: "c64_memory", arguments: { op: "nope" } });
console.log(`50 x validation error (no device I/O): avg ${((performance.now() - s) / 50).toFixed(2)} ms`);
// diagnostics file growth
const ddir = join(state, "diagnostics");
for (const f of readdirSync(ddir)) {
  const p = join(ddir, f); const lines = readFileSync(p, "utf8").trim().split("\n");
  console.log(`diagnostics ${f}: ${statSync(p).size} bytes, ${lines.length} records`);
  const counts = {}; for (const l of lines) { const e = JSON.parse(l).event; counts[e] = (counts[e] ?? 0) + 1; }
  console.log(JSON.stringify(counts));
}
// shutdown
s = performance.now();
const exited = new Promise((r) => child.once("exit", (code, sig) => r({ code, sig })));
child.stdin.end();
const ex = await exited;
console.log(`exit after stdin end: ${(performance.now() - s).toFixed(0)} ms, ${JSON.stringify(ex)}`);
console.log("stderr tail:\n" + stderr.split("\n").slice(-4).join("\n"));
await mock?.close();
