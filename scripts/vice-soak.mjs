#!/usr/bin/env node
/**
 * Long-running soak test for the VICE backend, driven through the real MCP
 * server over stdio. Requires the built server (npm run build) and a VICE
 * binary (x64sc) plus Xvfb or a display. It is not part of `npm test`.
 *
 * Usage:
 *   node scripts/vice-soak.mjs [--duration 10m|90s|2] [--out DIR] [--keep-going]
 *   C64BRIDGE_SOAK_DURATION=10m npm run test:vice:soak
 *
 * The total duration is scaled across the scenarios:
 *   A steady load, B idle gaps, C held pause, D long keyboard feed,
 *   E VICE killed (idle and while a pause is held), F port in use,
 *   G debugger stress (checkpoints, stepping, overlapping calls).
 * The script exits non-zero on any unexpected tool error, failed check,
 * leaked checkpoint or resource growth above the thresholds below.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- options
function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|min)?$/i.exec(String(text).trim());
  if (!m) throw new Error(`Invalid duration '${text}' (use e.g. 10m, 90s or 2)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  return unit === "ms" ? n : unit === "s" ? n * 1000 : n * 60_000;
}
function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}
const TOTAL_MS = parseDuration(argValue("--duration") ?? process.env.C64BRIDGE_SOAK_DURATION ?? "2m");
const OUT_DIR = path.resolve(argValue("--out") ?? fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-soak-")));
fs.mkdirSync(OUT_DIR, { recursive: true });
const VICE_BINARY = process.env.VICE_BINARY || "x64sc";
const MAX_RSS_GROWTH_MB = Number(process.env.C64BRIDGE_SOAK_MAX_RSS_GROWTH_MB ?? 80);
const MAX_FD_GROWTH = Number(process.env.C64BRIDGE_SOAK_MAX_FD_GROWTH ?? 8);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const share = (f, lo, hi) => clamp(Math.round(TOTAL_MS * f), lo, hi);
const SHARE = {
  a: share(0.22, 8_000, 30 * 60_000),
  idleShort: share(0.03, 3_000, 60_000),
  idleLong: share(0.2, 8_000, 6 * 60_000),
  held: share(0.2, 8_000, 6 * 60_000),
  g: share(0.25, 10_000, 30 * 60_000),
  gIdle: share(0.05, 3_000, 3 * 60_000),
};

// ---------------------------------------------------------------- logging
const opsLog = fs.createWriteStream(path.join(OUT_DIR, "ops.jsonl"));
const startedAt = Date.now();
const stats = new Map(); // key scenario/op -> latencies
const errors = []; // unexpected errors
const failedChecks = [];
const notes = []; // informational observations (expected failures etc.)
const scenarioInfo = {};
let currentScenario = "setup";

function say(msg) {
  process.stdout.write(`[${((Date.now() - startedAt) / 1000).toFixed(1).padStart(7)}s] ${msg}\n`);
}
function record(entry) {
  opsLog.write(`${JSON.stringify(entry)}\n`);
}
function sc(name) {
  currentScenario = name;
  scenarioInfo[name] ??= { start: new Date().toISOString(), ops: 0, errors: 0, checks: 0, failedChecks: 0, firstError: null };
  say(`scenario ${name} start`);
  return scenarioInfo[name];
}
function check(cond, what) {
  const info = scenarioInfo[currentScenario];
  info.checks += 1;
  if (!cond) {
    info.failedChecks += 1;
    failedChecks.push(`${currentScenario}: ${what}`);
    info.firstError ??= `check failed: ${what}`;
    record({ t: new Date().toISOString(), scenario: currentScenario, check: what, ok: false });
    say(`CHECK FAILED ${currentScenario}: ${what}`);
  }
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// ---------------------------------------------------------------- processes
const ownedPids = new Set();
function listChildren(pid) {
  const out = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(rest[1]) === pid) out.push(Number(entry));
    } catch { /* process vanished */ }
  }
  return out;
}
function descendants(pid) {
  const all = [];
  const queue = [pid];
  while (queue.length) {
    for (const child of listChildren(queue.shift())) {
      all.push(child);
      queue.push(child);
    }
  }
  return all;
}
function cmdline(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return ""; }
}
function alive(pid) {
  try { process.kill(pid, 0); return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z"; } catch { return false; }
}
function rssMb(pid) {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch { return null; }
}
function fdCount(pid) {
  try { return fs.readdirSync(`/proc/${pid}/fd`).length; } catch { return null; }
}
function viceEmulatorPids(serverPid) {
  return descendants(serverPid).filter((p) => /x64sc/.test(cmdline(p)) && !/Xvfb/.test(cmdline(p)));
}
function trackDescendants(serverPid) {
  for (const p of descendants(serverPid)) ownedPids.add(p);
}
function killOwned(signal = "SIGKILL") {
  for (const pid of ownedPids) {
    // Only PIDs this script started or saw as descendants of its own server.
    if (alive(pid)) { try { process.kill(pid, signal); } catch { /* already gone */ } }
  }
}

async function freePort() {
  for (let i = 0; i < 50; i += 1) {
    const port = 6600 + Math.floor(Math.random() * 400);
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  throw new Error("no free port in 6600-6999");
}

// ---------------------------------------------------------------- MCP session
const sdkClient = path.join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/client");
const { Client } = await import(path.join(sdkClient, "index.js"));
const { StdioClientTransport } = await import(path.join(sdkClient, "stdio.js"));

async function startServer(port, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist/index.js")],
    cwd: root,
    stderr: "pipe",
    env: {
      ...process.env,
      C64_MODE: "vice",
      VICE_HOST: "127.0.0.1",
      VICE_PORT: String(port),
      VICE_BINARY,
      VICE_VISIBLE: "false",
      VICE_WARP: "false",
      FORCE_XVFB: "1",
      C64BRIDGE_ACCESS: "full",
    },
  });
  const errStream = fs.createWriteStream(path.join(OUT_DIR, `server-${label}.stderr.log`));
  transport.stderr?.pipe(errStream);
  const client = new Client({ name: "vice-soak", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, pid: transport.pid, port, label };
}

let session = null;

function dataOf(result) {
  const sc = result?.structuredContent?.data;
  if (sc !== undefined) return sc;
  const text = result?.content?.find((c) => c.type === "text")?.text;
  if (text) { try { return JSON.parse(text); } catch { return { text }; } }
  return {};
}
function textOf(result) {
  return (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

/**
 * Calls one MCP tool, logs it and returns { ok, text, data, ms }.
 * `expectError` marks calls whose failure is part of the scenario.
 */
async function call(tool, args, opts = {}) {
  const info = scenarioInfo[currentScenario];
  const t0 = Date.now();
  let ok = true;
  let text = "";
  let data = {};
  try {
    const timeout = opts.timeoutMs ?? 120_000;
    const result = await session.client.callTool({ name: tool, arguments: args }, undefined, { timeout });
    text = textOf(result);
    data = dataOf(result);
    ok = !result.isError;
  } catch (error) {
    ok = false;
    text = error instanceof Error ? error.message : String(error);
  }
  const ms = Date.now() - t0;
  const label = `${currentScenario}/${tool}.${args.op ?? ""}`;
  if (!stats.has(label)) stats.set(label, []);
  stats.get(label).push(ms);
  info.ops += 1;
  const unexpected = !ok && !opts.expectError;
  record({ t: new Date().toISOString(), scenario: currentScenario, tool, op: args.op, ms, ok, expected: !!opts.expectError, error: ok ? undefined : text.slice(0, 300) });
  if (unexpected) {
    info.errors += 1;
    const line = `${label}: ${text.split("\n")[0].slice(0, 300)}`;
    info.firstError ??= line;
    errors.push(line);
    say(`ERROR ${line}`);
  }
  if (!ok && opts.expectError) notes.push(`${label} (expected failure): ${text.split("\n")[0].slice(0, 200)}`);
  return { ok, text, data, ms };
}

const hexBytes = (hexData) => {
  const clean = String(hexData ?? "").replace(/[^0-9a-fA-F]/g, "");
  const out = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
};
async function readMem(address, length, opts) {
  const r = await call("c64_memory", { op: "read", address, length }, opts);
  return { ...r, bytes: hexBytes(r.data?.hexData) };
}
async function writeMem(address, bytes, opts) {
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return call("c64_memory", { op: "write", address, bytes: `$${hex}` }, opts);
}
const jiffyOf = (b) => (b[0] << 16) | (b[1] << 8) | b[2];
async function jiffy(opts) {
  const r = await readMem("$00A0", 3, opts);
  return r.bytes.length === 3 ? jiffyOf(r.bytes) : null;
}
const hex4 = (n) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;
async function screenText() {
  const r = await call("c64_memory", { op: "read_screen" });
  return r.text;
}
async function pcOf() {
  const r = await call("c64_debug", { op: "get_monitor_state" });
  const pc = r.data?.pc;
  return typeof pc === "string" ? parseInt(pc.replace("$", ""), 16) : null;
}
async function checkpointIds() {
  const r = await call("c64_debug", { op: "list_checkpoints" });
  return (r.data?.checkpoints ?? []).map((c) => c.id);
}

// ---------------------------------------------------------------- scenarios
// The program hooks the KERNAL IRQ vector: BASIC keeps running (keyboard input works) while
// the handler increments a 16-bit counter at $FB/$FC and the border colour 60 times a second.
//   $C000 sei / lda #<irq / sta $0314 / lda #>irq / sta $0315 / cli / rts
//   $C00D irq: inc $FB / bne skip / inc $FC / $C013 skip: inc $D020 / $C016 jmp $EA31
const LOOP_ASM = [
  "*=$C000",
  "  sei",
  "  lda #$0D",
  "  sta $0314",
  "  lda #$C0",
  "  sta $0315",
  "  cli",
  "  rts",
  "irq: inc $FB",
  "  bne skip",
  "  inc $FC",
  "skip: inc $D020",
  "  jmp $EA31",
].join("\n");
const HANDLER_BREAKPOINT = 0xC013;
const HANDLER_AFTER = 0xC016;

async function loadLoop() {
  const r = await call("c64_program", { op: "upload_run_asm", program: LOOP_ASM });
  return r.ok;
}
async function counterAdvances(what) {
  const a = await readMem("$00FB", 2);
  await sleep(300);
  const b = await readMem("$00FB", 2);
  return check(a.bytes.length === 2 && b.bytes.length === 2 && (a.bytes[0] !== b.bytes[0] || a.bytes[1] !== b.bytes[1]), `loop counter advances ${what} (${a.bytes} -> ${b.bytes})`);
}
async function jiffyAdvances(what) {
  const a = await jiffy();
  await sleep(1500);
  const b = await jiffy();
  return check(a !== null && b !== null && ((b - a + 0x1000000) % 0x1000000) > 0, `jiffy clock advances ${what} (${a} -> ${b})`);
}
async function jiffyFrozen(what) {
  const a = await jiffy();
  await sleep(700);
  const b = await jiffy();
  return check(a !== null && a === b, `jiffy clock frozen ${what} (${a} -> ${b})`);
}

/** Writes a signature table and reads slices of it with overlapping calls. */
async function overlapRound(extra = false) {
  const table = Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);
  await writeMem("$C100", table);
  const slices = Array.from({ length: extra ? 8 : 5 }, (_, i) => i * 8);
  const calls = slices.map((off) => readMem(hex4(0xC100 + off), 8));
  const aux = [];
  if (extra) {
    aux.push(call("c64_debug", { op: "list_checkpoints" }));
    aux.push(call("c64_memory", { op: "read_screen" }));
  }
  const results = await Promise.all([...calls, ...aux]);
  slices.forEach((off, i) => {
    const want = table.slice(off, off + 8);
    check(JSON.stringify(results[i].bytes) === JSON.stringify(want), `overlapping read #${i} at +${off} returned its own slice (${results[i].bytes} vs ${want})`);
  });
}

async function scenarioA() {
  sc("A");
  await call("c64_system", { op: "reset", waitForReady: true });
  const end = Date.now() + SHARE.a;
  let i = 0;
  while (Date.now() < end) {
    const t = Date.now();
    const kind = i % 6;
    if (kind === 0) {
      await readMem("$0400", 40);
    } else if (kind === 1) {
      const v = (i * 13) & 0xff;
      await writeMem("$C200", [v, v ^ 0xff, 0x5a]);
      const r = await readMem("$C200", 3);
      check(JSON.stringify(r.bytes) === JSON.stringify([v, v ^ 0xff, 0x5a]), `write+readback at $C200 (${r.bytes})`);
    } else if (kind === 2) {
      await screenText();
    } else if (kind === 3) {
      await call("c64_input", { op: "write_text", text: `PRINT ${i}\n` });
    } else if (kind === 4) {
      const n = i % 90;
      await call("c64_program", { op: "upload_run_basic", program: `10 PRINT "SOAK ${n}"\n20 END`, verify: true, autoFix: false });
      await jiffyAdvances("after upload_run_basic");
    } else {
      await overlapRound(false);
    }
    i += 1;
    if (i % 12 === 0) await jiffyAdvances("during steady load");
    await sleep(Math.max(0, 1200 - (Date.now() - t)));
  }
  await jiffyAdvances("at end of A");
}

async function scenarioB() {
  sc("B");
  for (const gap of [SHARE.idleShort, SHARE.idleLong]) {
    say(`B idle gap ${Math.round(gap / 1000)}s with no traffic`);
    await sleep(gap);
    const r = await readMem("$0400", 8);
    check(r.ok && r.ms < 8_000, `first operation after ${Math.round(gap / 1000)}s idle works (ok=${r.ok} ${r.ms}ms)`);
    await jiffyAdvances(`after ${Math.round(gap / 1000)}s idle`);
    await call("c64_input", { op: "write_text", text: "PRINT 1\n" });
  }
}

async function scenarioC() {
  sc("C");
  const p = await call("c64_system", { op: "pause" });
  check(p.ok, "pause succeeds");
  await jiffyFrozen("right after pause");
  say(`C held pause idle ${Math.round(SHARE.held / 1000)}s`);
  await sleep(SHARE.held);
  const r = await readMem("$00A0", 3);
  check(r.ok && r.ms < 8_000, `first memory read after held pause idle works (ok=${r.ok} ${r.ms}ms)`);
  await jiffyFrozen("after idle held pause");
  const w = await writeMem("$C300", [1, 2, 3]);
  const rb = await readMem("$C300", 3);
  check(w.ok && JSON.stringify(rb.bytes) === "[1,2,3]", "write+readback while paused");
  const res = await call("c64_system", { op: "resume" });
  check(res.ok, "resume succeeds");
  await jiffyAdvances("after resume");
}

async function scenarioD() {
  sc("D");
  await call("c64_system", { op: "reset", waitForReady: true });
  // Three batches of three PRINT lines (about 400 characters in total); each batch clears the screen first.
  let total = 0;
  for (let b = 0; b < 3; b += 1) {
    const lines = ["PRINT CHR$(147)"];
    for (let i = 1; i <= 3; i += 1) lines.push(`PRINT "D${b * 3 + i} ABCDEFGHIJKLMNOPQRSTUVWXYZ"`);
    const text = `${lines.join("\n")}\n`;
    total += text.length;
    const r = await call("c64_input", { op: "write_text", text });
    check(r.ok, `write_text of ${text.length} characters succeeds`);
    let screen = "";
    for (let i = 0; i < 15; i += 1) {
      screen = await screenText();
      if (screen.includes(`D${b * 3 + 3} ABCDEFGHIJKLMNOPQRSTUVWXYZ`)) break;
      await sleep(500);
    }
    for (let i = 1; i <= 3; i += 1) check(screen.includes(`D${b * 3 + i} ABCDEFGHIJKLMNOPQRSTUVWXYZ`), `screen shows output of keyboard feed line D${b * 3 + i}`);
  }
  scenarioInfo.D.charactersSent = total;
}

async function scenarioE() {
  sc("E");
  await call("c64_system", { op: "reset", waitForReady: true });
  // E1: VICE killed while idle.
  const pid1 = viceEmulatorPids(session.pid)[0];
  check(!!pid1, "VICE pid found under the server");
  trackDescendants(session.pid);
  if (pid1) process.kill(pid1, "SIGKILL");
  await sleep(1500);
  const t0 = Date.now();
  const first = await readMem("$0400", 4, { expectError: true, timeoutMs: 90_000 });
  let second = first;
  let attempts = 1;
  while (!second.ok && attempts < 4) { second = await readMem("$0400", 4, { expectError: true, timeoutMs: 90_000 }); attempts += 1; }
  scenarioInfo.E.killIdle = { firstOk: first.ok, firstError: first.ok ? null : first.text.split("\n")[0].slice(0, 200), attemptsToRecover: second.ok ? attempts : null, ms: Date.now() - t0 };
  check(second.ok, "backend recovers after VICE was killed while idle");
  check(first.ok || /VICE|monitor|connect|closed/i.test(first.text), "failure after kill, if any, is a clear error");
  trackDescendants(session.pid);
  const pid2 = viceEmulatorPids(session.pid)[0];
  check(!!pid2 && pid2 !== pid1, "a new VICE process serves the backend after the kill");
  await jiffyAdvances("after recovery from idle kill");

  // E2: VICE killed while a pause is held.
  const p = await call("c64_system", { op: "pause" });
  check(p.ok, "pause before kill succeeds");
  if (pid2) process.kill(pid2, "SIGKILL");
  await sleep(1500);
  const t1 = Date.now();
  const f2 = await readMem("$0400", 4, { expectError: true, timeoutMs: 90_000 });
  let s2 = f2;
  let n2 = 1;
  while (!s2.ok && n2 < 4) { s2 = await readMem("$0400", 4, { expectError: true, timeoutMs: 90_000 }); n2 += 1; }
  scenarioInfo.E.killPaused = { firstOk: f2.ok, firstError: f2.ok ? null : f2.text.split("\n")[0].slice(0, 200), attemptsToRecover: s2.ok ? n2 : null, ms: Date.now() - t1 };
  check(s2.ok, "backend recovers after VICE was killed while paused");
  trackDescendants(session.pid);
  const r = await call("c64_system", { op: "resume" });
  check(r.ok, "resume after VICE restart succeeds");
  await jiffyAdvances("after recovery from paused kill");
}

async function scenarioF() {
  sc("F");
  // F1: a second real VICE on the same monitor port cannot bind; the first is unaffected.
  const second = spawn(VICE_BINARY, ["-binarymonitor", "-binarymonitoraddress", `127.0.0.1:${session.port}`, "-sounddev", "dummy", "-config", "/dev/null"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DISPLAY: process.env.VICE_XVFB_DISPLAY || ":99" }, // the display the server uses for its own VICE
  });
  ownedPids.add(second.pid);
  let secondErr = "";
  second.stderr.on("data", (c) => { secondErr += c; });
  second.stdout.on("data", (c) => { secondErr += c; });
  await sleep(6_000);
  scenarioInfo.F.secondVice = { stillRunning: alive(second.pid), stderrTail: secondErr.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300) };
  if (alive(second.pid)) process.kill(second.pid, "SIGKILL");
  const r = await readMem("$0400", 4);
  check(r.ok, "first VICE instance still works while a second one tried the same port");
  await jiffyAdvances("with a second VICE attempting the same port");

  // F2: c64bridge refuses to start VICE when a foreign process owns the port.
  const foreign = net.createServer((s) => s.on("error", () => {}));
  const fport = await freePort();
  await new Promise((resolve) => foreign.listen(fport, "127.0.0.1", resolve));
  const probe = await startServer(fport, "port-in-use");
  try {
    const t = await probe.client.callTool({ name: "c64_memory", arguments: { op: "read", address: "$0400", length: 4 } }, undefined, { timeout: 60_000 });
    const msg = textOf(t);
    scenarioInfo.F.refusal = msg.split("\n")[0].slice(0, 300);
    check(!!t.isError && /already in use/i.test(msg), `c64bridge refuses a port held by another process (${scenarioInfo.F.refusal})`);
    record({ t: new Date().toISOString(), scenario: "F", tool: "c64_memory", op: "read", ok: !t.isError, expected: true, error: msg.slice(0, 300) });
  } finally {
    trackDescendants(probe.pid);
    await probe.client.close().catch(() => {});
    foreign.close();
  }
}

async function scenarioG() {
  const info = sc("G");
  await call("c64_system", { op: "reset", waitForReady: true });
  check(await loadLoop(), "assembly loop at $C000 loads");
  await counterAdvances("after loading the loop");
  const end = Date.now() + SHARE.g;
  let round = 0;
  let lastIdle = Date.now();
  const stopBudget = { exec: 2, watch: 2 }; // failures tolerated before the stopping variants are skipped
  let cycles = 0;
  while (Date.now() < end) {
    round += 1;
    // G1: pause, single-step, modify memory while stopped, resume.
    {
      const p = await call("c64_system", { op: "pause" });
      check(p.ok, "G1 pause");
      let pc = await pcOf();
      check(pc !== null, `G1 PC readable after pause (${pc === null ? "null" : hex4(pc)})`);
      const seen = new Set([pc]);
      for (let s2 = 0; s2 < 3 && pc !== null; s2 += 1) {
        const st = await call("c64_debug", { op: "step", count: 1 });
        const next = await pcOf();
        check(st.ok && next !== null && next !== pc, `G1 single step from ${hex4(pc)} advances PC (${next === null ? "null" : hex4(next)})`);
        seen.add(next);
        pc = next;
      }
      await jiffyFrozen("while stopped for stepping");
      const sig = [round & 0xff, 0xa5, 0x5a];
      await writeMem("$C400", sig);
      const rb = await readMem("$C400", 3);
      check(JSON.stringify(rb.bytes) === JSON.stringify(sig), "G1 write+readback while stopped");
      if (Date.now() - lastIdle > Math.max(SHARE.g / 4, 20_000)) {
        say(`G idle gap ${Math.round(SHARE.gIdle / 1000)}s while stopped`);
        await sleep(SHARE.gIdle);
        const after = await pcOf();
        check(after === pc, `G1 PC unchanged after the idle gap while stopped (${pc === null ? "null" : hex4(pc)} -> ${after === null ? "null" : hex4(after)})`);
        lastIdle = Date.now();
      }
      const res = await call("c64_system", { op: "resume" });
      check(res.ok, "G1 resume");
      await counterAdvances("after G1 resume");
      cycles += 1;
    }
    // G2: checkpoint that does not stop: the hit count rises, nothing is left behind.
    {
      const c = await call("c64_debug", { op: "create_checkpoint", address: "$C013", stopOnHit: false });
      const id = c.data?.checkpoint?.id;
      check(typeof id === "number", "G2 checkpoint created");
      await sleep(400);
      if (typeof id === "number") {
        const g = await call("c64_debug", { op: "get_checkpoint", id });
        check((g.data?.checkpoint?.hitCount ?? g.data?.hitCount ?? 0) > 0, `G2 non-stopping checkpoint counts hits (${g.data?.checkpoint?.hitCount})`);
        await call("c64_debug", { op: "delete_checkpoint", id });
      }
      await counterAdvances("with a non-stopping checkpoint");
      cycles += 1;
    }
    // G3: execution checkpoint that stops the CPU, then continue.
    if (stopBudget.exec > 0) {
      const ok = await stoppingCycle({ kind: "exec" });
      if (!ok) stopBudget.exec -= 1;
      cycles += 1;
    }
    // G4: memory-write watch checkpoint on the counter, temporary.
    if (stopBudget.watch > 0) {
      const ok = await stoppingCycle({ kind: "watch" });
      if (!ok) stopBudget.watch -= 1;
      cycles += 1;
    }
    // Interleaved ordinary tools and overlapping calls.
    await screenText();
    const wt = await call("c64_input", { op: "write_text", text: "X" });
    check(wt.ok, "G write_text while the IRQ handler runs");
    await overlapRound(true);
    const leaked = await checkpointIds();
    check(leaked.length === 0, `no leaked checkpoints after round ${round} (${leaked})`);
    await sleep(500);
  }
  info.rounds = round;
  info.cycles = cycles;
  info.stopBudgetLeft = stopBudget;
  if (stopBudget.exec <= 0) notes.push("G: stopping execution-checkpoint cycles abandoned after repeated failures");
  if (stopBudget.watch <= 0) notes.push("G: stopping watch-checkpoint cycles abandoned after repeated failures");
}

/** Restarts VICE and reloads the IRQ program after the debugger became unreachable. */
async function recoverMachine(why) {
  notes.push(`G: restarting VICE after ${why}`);
  say(`G recovery: restarting VICE (${why})`);
  await call("c64_debug", { op: "nuclear_reset" }, { expectError: true, timeoutMs: 120_000 });
  trackDescendants(session.pid);
  await call("c64_system", { op: "reset", waitForReady: true }, { expectError: true });
  await loadLoop();
}

/** One breakpoint round trip. Returns false when the machine could not be debugged and was restarted. */
async function stoppingCycle({ kind }) {
  const args = kind === "exec"
    ? { op: "create_checkpoint", address: hex4(HANDLER_BREAKPOINT) }
    : { op: "create_checkpoint", address: "$00FB", operations: { execute: false, store: true }, temporary: true };
  const c = await call("c64_debug", args);
  const id = c.data?.checkpoint?.id;
  if (!check(typeof id === "number", `G ${kind} checkpoint created`)) { await recoverMachine(`${kind} checkpoint creation failed`); return false; }
  const expectedPc = kind === "exec" ? hex4(HANDLER_BREAKPOINT) : undefined;
  const w = await call("c64_debug", { op: "wait_for_state", ...(expectedPc ? { expectedPC: expectedPc } : {}), timeoutMs: 5000 });
  const pc = w.ok ? await pcOf() : null;
  let good = w.ok && pc !== null;
  if (kind === "exec") good = good && pc === HANDLER_BREAKPOINT;
  if (!check(good, `G ${kind} CPU stops at the checkpoint (PC=${pc === null ? "unreadable" : hex4(pc)})`)) {
    await recoverMachine(`${kind} breakpoint not reachable`);
    return false;
  }
  if (kind === "exec") {
    const regs = await call("c64_debug", { op: "get_registers" });
    const pcReg = (regs.data?.registers ?? []).find((r) => String(r.name).toUpperCase() === "PC");
    check(pcReg?.value === HANDLER_BREAKPOINT, `G exec registers PC equals the breakpoint (${pcReg?.value})`);
    await call("c64_debug", { op: "step", count: 1 });
    const after = await pcOf();
    check(after === HANDLER_AFTER, `G exec single step from ${hex4(HANDLER_BREAKPOINT)} reaches ${hex4(HANDLER_AFTER)} (${after === null ? "null" : hex4(after)})`);
  }
  const wr = await writeMem("$C410", [0x11, 0x22]);
  const rb = await readMem("$C410", 2);
  check(wr.ok && JSON.stringify(rb.bytes) === "[17,34]", "G write+readback while stopped at a breakpoint");
  const del = await call("c64_debug", { op: "delete_checkpoint", id }, { expectError: kind === "watch", timeoutMs: 30_000 });
  const cont = await call("c64_debug", { op: "continue_execution" }, { timeoutMs: 30_000 });
  const health = await readMem("$00FB", 2, { timeoutMs: 30_000 });
  if (!del.ok && kind === "exec" || !cont.ok || !health.ok) {
    await recoverMachine(`${kind} breakpoint cycle left the monitor unreachable`);
    return false;
  }
  await counterAdvances(`after continuing from the ${kind} breakpoint`);
  return true;
}

// ---------------------------------------------------------------- main
function summarise(resources) {
  const perOp = {};
  for (const [label, values] of stats) {
    const sorted = [...values].sort((a, b) => a - b);
    perOp[label] = { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted[sorted.length - 1] };
  }
  const perScenario = {};
  for (const [label, values] of stats) {
    const name = label.split("/")[0];
    (perScenario[name] ??= []).push(...values);
  }
  for (const [name, values] of Object.entries(perScenario)) {
    const sorted = values.sort((a, b) => a - b);
    scenarioInfo[name].latencyMs = { p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted[sorted.length - 1] };
    scenarioInfo[name].end = scenarioInfo[name].end ?? new Date().toISOString();
  }
  return {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    wallClockSeconds: Math.round((Date.now() - startedAt) / 1000),
    requestedDurationMs: TOTAL_MS,
    shares: SHARE,
    scenarios: scenarioInfo,
    perOp,
    resources,
    errors,
    failedChecks,
    notes,
    outDir: OUT_DIR,
  };
}

let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  try { await session?.client.close(); } catch { /* ignore */ }
  await sleep(300);
  killOwned("SIGTERM");
  await sleep(500);
  killOwned("SIGKILL");
  opsLog.end();
  process.exit(code);
}
process.on("SIGINT", () => { say("SIGINT: cleaning up"); void finish(130); });
process.on("SIGTERM", () => { say("SIGTERM: cleaning up"); void finish(143); });

const resources = { start: null, end: null };
let exitCode = 0;
try {
  say(`vice soak: ${Math.round(TOTAL_MS / 1000)}s total, output ${OUT_DIR}`);
  say(`shares: ${JSON.stringify(SHARE)}`);
  const port = await freePort();
  session = await startServer(port, "main");
  ownedPids.add(session.pid);
  sc("setup");
  const warm = await call("c64_memory", { op: "read", address: "$00A0", length: 3 }, { timeoutMs: 90_000 });
  check(warm.ok, "server starts VICE and answers the first read");
  trackDescendants(session.pid);
  scenarioInfo.setup.vicePids = viceEmulatorPids(session.pid);
  const sample = () => ({
    server: { rssMb: rssMb(session.pid), fds: fdCount(session.pid) },
    vice: { rssMb: rssMb(viceEmulatorPids(session.pid)[0]) },
  });
  resources.start = sample();

  // Order: steady load, idle gaps, held pause, long feed, debugger stress, then the
  // destructive scenarios, which restart VICE and are therefore last.
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioG();
  resources.end = sample();
  await scenarioE();
  await scenarioF();

  const rssGrowth = (resources.end.server.rssMb ?? 0) - (resources.start.server.rssMb ?? 0);
  const fdGrowth = (resources.end.server.fds ?? 0) - (resources.start.server.fds ?? 0);
  resources.serverRssGrowthMb = rssGrowth;
  resources.serverFdGrowth = fdGrowth;
  currentScenario = "resources";
  scenarioInfo.resources = { start: new Date().toISOString(), ops: 0, errors: 0, checks: 0, failedChecks: 0, firstError: null };
  check(rssGrowth <= MAX_RSS_GROWTH_MB, `server RSS growth ${rssGrowth} MB is within ${MAX_RSS_GROWTH_MB} MB`);
  check(fdGrowth <= MAX_FD_GROWTH, `server open fd growth ${fdGrowth} is within ${MAX_FD_GROWTH}`);
} catch (error) {
  errors.push(`soak script: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  say(`FATAL ${errors[errors.length - 1]}`);
}

const summary = summarise(resources);
fs.writeFileSync(path.join(OUT_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
for (const [name, s] of Object.entries(scenarioInfo)) {
  say(`${name}: ops=${s.ops} errors=${s.errors} checks=${s.checks} failedChecks=${s.failedChecks}${s.latencyMs ? ` p50=${s.latencyMs.p50}ms p95=${s.latencyMs.p95}ms max=${s.latencyMs.max}ms` : ""}${s.firstError ? ` first="${s.firstError}"` : ""}`);
}
say(`resources: ${JSON.stringify(resources)}`);
say(`wall clock ${summary.wallClockSeconds}s, errors=${errors.length}, failed checks=${failedChecks.length}; summary: ${path.join(OUT_DIR, "summary.json")}`);
exitCode = errors.length || failedChecks.length ? 1 : 0;
say(exitCode === 0 ? "PASS" : "FAIL");
await finish(exitCode);
