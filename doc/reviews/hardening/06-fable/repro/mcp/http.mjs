import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const { startMockC64Server } = await import("/home/claude/c64bridge/scripts/mockC64Server.mjs");
const mock = await startMockC64Server(); const u = new URL(mock.baseUrl);
const dir = mkdtempSync(join(tmpdir(), "h6http-")); const cfg = join(dir, "c.json");
writeFileSync(cfg, JSON.stringify({ c64u: { host: u.hostname, port: Number(u.port) } }));
const port = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, ["/home/claude/c64bridge/dist/index.js", "--http", String(port)], { env: { ...process.env, C64BRIDGE_CONFIG: cfg, C64BRIDGE_STATE_DIR: join(dir, "s"), HOME: dir, C64BRIDGE_HTTP_TOKEN: "tok-0123456789" }, stdio: ["ignore", "pipe", "pipe"] });
let err = ""; child.stderr.on("data", (d) => err += d);
await new Promise((r) => { const t = setInterval(() => { if (err.includes("running on HTTP")) { clearInterval(t); r(); } }, 20); });
const H = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer tok-0123456789" };
async function post(body) { const s = performance.now(); const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: H, body: JSON.stringify(body) }); const t = await r.text(); return { status: r.status, ms: performance.now() - s, t }; }
let r = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
console.log("init", r.status, r.ms.toFixed(1), r.t.slice(0, 120));
r = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "c64_memory", arguments: { op: "read", address: "$0400", length: 1 } } });
console.log("call", r.status, r.ms.toFixed(1), r.t.slice(0, 160));
let s = performance.now(); for (let i = 0; i < 30; i++) await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "c64_memory", arguments: { op: "read", address: "$0400", length: 1 } } });
console.log("avg http call", ((performance.now() - s) / 30).toFixed(2));
const ac = new AbortController(); setTimeout(() => ac.abort(), 3000); try { const g = await fetch(`http://127.0.0.1:${port}/mcp`, { headers: H, signal: ac.signal }); console.log("GET status", g.status, g.headers.get("content-type")); const rd = g.body.getReader(); const c = await Promise.race([rd.read(), new Promise(r => setTimeout(() => r("no data after 2s"), 2000))]); console.log("GET first chunk:", typeof c === "string" ? c : new TextDecoder().decode(c.value)); } catch (e) { console.log("GET aborted", e.name); }
child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r)); await mock.close();
console.log(err.split("\n").filter(l=>/token|WARN|warn/i.test(l)).slice(0,3).join("\n"));
