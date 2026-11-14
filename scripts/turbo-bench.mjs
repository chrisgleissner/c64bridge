#!/usr/bin/env node
/*
 * turbo-bench: assemble, run and decode the c64bridge Ultimate turbo benchmarks over REST.
 *
 *   node scripts/turbo-bench.mjs --host <ip> --probe
 *   node scripts/turbo-bench.mjs --host <ip> --program cpu --set IDX_MASK_LO=1 --set IDX_MASK_HI=0 --out out/
 *   node scripts/turbo-bench.mjs --host <ip> --suite quick|full --out out/
 *   node scripts/turbo-bench.mjs --decode result.bin [--json]
 *   node scripts/turbo-bench.mjs --program cpu --assemble-only --out out/      (no device)
 *   node scripts/turbo-bench.mjs --collect out/ --device "Ultimate 64" --date YYYY-MM-DD   (merge a suite's .json files into
 *       results/<device>-<date>.json and a markdown summary on stdout; reads device-info.json from the same directory)
 *
 * Shared C64U: run the whole invocation under the device lock, e.g.
 *   ~/dev/c64/worktrees/1541ultimate-tools-main/tooling/with_device_locks.py --wait 600 c64u -- \
 *       node scripts/turbo-bench.mjs --host 192.168.1.146 --suite full --out out/
 *
 * Rules the script follows: it never writes to flash, never resets power, reads the device memory exactly once
 * per measurement run (after the computed duration; reads pause the C64 CPU) and restores every configuration
 * item it changed, also on failure.  It needs the built assembler (npm run build) or tsx/bun for the .ts sources.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.C64BRIDGE_ROOT ?? resolve(here, "..");
const benchDir = process.env.TURBO_BENCH_DIR ?? (existsSync(join(root, "data/ultimate/bench")) ? join(root, "data/ultimate/bench") : here);

// ------------------------------------------------------------------ args
const args = process.argv.slice(2);
const opt = { set: [], cfg: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const take = () => args[++i];
  if (a === "--set") opt.set.push(take());
  else if (a === "--cfg") opt.cfg.push(take());
  else if (a.startsWith("--")) {
    const k = a.slice(2);
    if (["probe", "json", "assemble-only", "no-restore", "help"].includes(k)) opt[k] = true;
    else opt[k] = take();
  }
}
if (opt.help || args.length === 0) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
  process.exit(0);
}
const host = opt.host;
const base = host ? `http://${host}` : undefined;
const headers = process.env.C64U_PASSWORD ? { "X-Password": process.env.C64U_PASSWORD } : {};
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const outDir = resolve(opt.out ?? ".");
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------------ REST
async function rest(method, path, body, ct) {
  const res = await fetch(base + path, { method, headers: { ...headers, ...(ct ? { "Content-Type": ct } : {}) }, body });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status} ${buf.toString("utf8").slice(0, 200)}`);
  return buf;
}
const json = async (m, p) => JSON.parse((await rest(m, p)).toString("utf8"));
const enc = encodeURIComponent;

function dig(o, key) { // finds the object holding `key` anywhere in a nested response
  if (o && typeof o === "object") {
    if (key in o) return o[key];
    for (const v of Object.values(o)) { const r = dig(v, key); if (r !== undefined) return r; }
  }
  return undefined;
}
async function findCategory(item) {
  if (opt.category) return opt.category;
  const cats = dig(await json("GET", "/v1/configs"), "categories") ?? [];
  for (const c of cats) {
    const r = await json("GET", `/v1/configs/${enc(c)}`).catch(() => undefined);
    if (r && dig(r, item) !== undefined) return c;
  }
  throw new Error(`no category with item "${item}"; use --category`);
}
async function itemInfo(cat, item) {
  const r = await json("GET", `/v1/configs/${enc(cat)}/${enc(item)}`);
  const v = dig(r, item);
  if (v && typeof v === "object") return { current: v.current ?? v.value, values: v.values ?? v.options ?? v.allowed ?? [] };
  return { current: v, values: [] };
}

// ------------------------------------------------------------------ assemble
async function loadAssembler() {
  for (const p of ["dist/tools/translation/assembler.js", "src/tools/translation/assembler.ts"]) {
    try { return await import(pathToFileURL(join(root, p)).href); } catch { /* try next */ }
  }
  throw new Error("assembler not found: run `npm run build`, or run this script with tsx/bun");
}
function applyParams(src, sets) {
  for (const s of sets) {
    const [k, v] = s.split("=");
    const re = new RegExp(`^(${k}\\s*=\\s*)\\S+`, "m");
    if (!re.test(src)) throw new Error(`parameter ${k} not found in program`);
    src = src.replace(re, `$1${v}`);
  }
  return src;
}
function param(src, k) {
  const m = new RegExp(`^${k}\\s*=\\s*(\\S+)`, "m").exec(src);
  if (!m) return undefined;
  return m[1].startsWith("$") ? parseInt(m[1].slice(1), 16) : parseInt(m[1], 10);
}
const popcount = (n) => n.toString(2).replace(/0/g, "").length;
function estimateSeconds(prog, src) {
  const idxMask = (param(src, "IDX_MASK_HI") ?? 0) << 8 | (param(src, "IDX_MASK_LO") ?? 0);
  const nidx = popcount(idxMask), nrep = param(src, "NREP") ?? 3;
  if (prog === "cpu") {
    const nc = popcount(param(src, "COND_MASK")), nv = popcount(param(src, "VAR_MASK"));
    return 0.56 * nidx * nc * nv * nrep + nidx * (0.2 + 0.07 * nc) + 4;
  }
  if (prog === "reu") return nidx * (0.3 * popcount(param(src, "COND_MASK")) * nrep + 0.3) + 4;
  return (param(src, "MAX_ATTEMPTS") ?? 120) * 0.12 + 3;
}

// ------------------------------------------------------------------ decode (port of decode.py)
const Q = 13575; // CPU cycles per outer pass of the measurement loop
const COND = ["screen on", "screen blank", "on+8 sprites", "blank+8 sprites"];
const VAR = ["RAM lda", "VIC sta $D020", "VIC lda $D012", "CIA lda $DC05"];
const XF = ["stash 32K", "stash 16K", "stash 1B", "fetch 32K", "fetch 16K", "fetch 1B"];
const ticks = (d, o) => (0xffff - (d[o + 2] | (d[o + 3] << 8))) * 65536 + (0xffff - (d[o] | (d[o + 1] << 8)));
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
export function decode(d) {
  if (d[0] === 0x54 + 0 && d.length >= 3840) { /* raw */ }
  if (!(d[0] === 0x54 && d[1] === 0x55 && d[2] === 0x52 && d[3] === 0x42)) {
    if (d[2] === 0x54 && d[3] === 0x55) d = d.subarray(2); else throw new Error("bad magic: not a turbo result block");
  }
  const H = { version: d[4], done: d[5] === 0xa5, program: d[6], idxMask: d[8] | (d[9] << 8), condMask: d[10], varMask: d[11], nrep: d[12],
    useD031: d[13], badbit: d[14], d030Write: d[15], speedTable: d[0x11], nominalM: d[0x12], d031Before: d[0x13], reuPresent: d[0x15] };
  H.frameTicks = [0, 1, 2].map((i) => ticks(d, 0x18 + 4 * i));
  const ft = median(H.frameTicks);
  H.status = [...d.subarray(0x30, 0x40)]; H.readback = [...d.subarray(0x40, 0x50)]; H.mUsed = [...d.subarray(0x60, 0x70)];
  const lines = ft > 18000 ? 312 : 263;
  const pts = [];
  if (H.program === 1) {
    for (let idx = 0; idx < 16; idx++) {
      if (!((H.idxMask >> idx) & 1)) continue;
      const m = H.useD031 ? d[0x60 + idx] : H.nominalM, n = 29 * m;
      for (let c = 0; c < 4; c++) for (let v = 0; v < 4; v++) {
        if (!((H.condMask >> c) & 1) || !((H.varMask >> v) & 1)) continue;
        const b = 0x300 + idx * 192 + c * 48 + v * 12, g = idx * 16 + c * 4 + v;
        const reps = [...Array(H.nrep).keys()].map((r) => ticks(d, b + 4 * r));
        const mult = median(reps.map((t) => (n * Q) / t));
        pts.push({ idx, mhz: m, cond: COND[c], load: VAR[v], multiple: +mult.toFixed(4), cyclesPerFrame: Math.round(mult * ft), cyclesPerLine: +(mult * ft / lines).toFixed(2),
          spreadPct: +((100 * (Math.max(...reps) - Math.min(...reps))) / Math.min(...reps)).toFixed(3), interference: d[0x100 + g], status: d[0x30 + idx], ticks: reps });
      }
    }
  } else if (H.program === 2) {
    for (let idx = 0; idx < 16; idx++) {
      if (!((H.idxMask >> idx) & 1)) continue;
      const m = H.useD031 ? d[0x60 + idx] : H.nominalM;
      for (let c = 0; c < 2; c++) {
        if (!((H.condMask >> c) & 1)) continue;
        for (let r = 0; r < H.nrep; r++) {
          const b = 0x300 + idx * 144 + c * 72 + r * 24, t = XF.map((_, x) => ticks(d, b + 4 * x));
          pts.push({ idx, mhz: m, cond: COND[c], rep: r, ticks: Object.fromEntries(XF.map((k, x) => [k, t[x]])),
            stashBperTick: +(16384 / (t[0] - t[1])).toFixed(4), fetchBperTick: +(16384 / (t[3] - t[4])).toFixed(4), status: d[0x30 + idx] });
        }
      }
    }
  } else if (H.program === 3) {
    H.attempts = d[0x20]; H.firstFast = d[0x21] === 0xff ? null : d[0x21];
    for (let k = 0; k < H.attempts; k++) {
      const b = 0x300 + 8 * k, probe = ticks(d, b), wall = ticks(d, b + 4);
      pts.push({ attempt: k + 1, probeTicks: probe, sinceStartMs: +(wall / 985.248).toFixed(1), fast: probe < 65536 });
    }
  }
  return { header: H, frameTicksMedian: ft, points: pts };
}
function printTable(r) {
  const H = r.header;
  console.log(`program ${H.program} v${H.version} done=${H.done}${H.program === 3 ? "" : ` frame=${r.frameTicksMedian} ticks`}, $D031 before=${H.d031Before}, speed-set attempts/idx=${JSON.stringify(H.status)}`);
  if (!H.done) console.log("WARNING: done flag not set - result incomplete or the run was disturbed");
  for (const p of r.points) {
    if (p.multiple !== undefined)
      console.log(`idx${String(p.idx).padStart(2)} ${String(p.mhz).padStart(2)}MHz ${p.cond.padEnd(16)} ${p.load.padEnd(14)} x${p.multiple.toFixed(4).padStart(8)} ${String(p.cyclesPerFrame).padStart(7)} c/frame ${String(p.cyclesPerLine).padStart(7)} c/line spread ${p.spreadPct}%${p.interference ? "  INTERFERENCE" : ""}${p.status === 255 ? "  SPEED-NOT-LIVE" : ""}`);
    else if (p.stashBperTick !== undefined)
      console.log(`idx${String(p.idx).padStart(2)} ${String(p.mhz).padStart(2)}MHz ${p.cond.padEnd(12)} rep${p.rep} stash ${p.stashBperTick} B/PHI2 fetch ${p.fetchBperTick} B/PHI2 (32K ticks ${p.ticks["stash 32K"]}/${p.ticks["fetch 32K"]})`);
    else console.log(JSON.stringify(p));
  }
}


// ------------------------------------------------------------------ collect: merge run files into one result file and a summary table
function collect(dir, device, date) {
  const runs = {};
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json") || /^(config-|device-info|summary)/.test(f)) continue;
    const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (r.header) runs[f.slice(0, -5)] = r;
  }
  const info = existsSync(join(dir, "device-info.json")) ? JSON.parse(readFileSync(join(dir, "device-info.json"), "utf8")) : {};
  const firmware = { product: info.product, firmware: info.firmware_version, fpga: info.fpga_version, core: info.core_version };
  return { device, date, firmware, phi2KHz: PHI2_PAL_KHZ, runs };
}
const PHI2_PAL_KHZ = 985.248;
function summarize(res) {
  const out = [];
  const f = res.firmware ?? {};
  out.push(`## ${res.device}, ${res.date}`, "", `Firmware ${f.firmware ?? "?"}, FPGA ${f.fpga ?? "?"}, core ${f.core ?? "?"}. PAL (frame ${res.runs["cpu-regs-all"]?.frameTicksMedian ?? "?"} ticks). Multiples are relative to PHI2 (0.985248 MHz).`, "");
  const mhz = (m) => (m * PHI2_PAL_KHZ / 1000).toFixed(2);
  const get = (run, idx, cond, load) => run?.points.find((p) => p.idx === idx && p.cond === cond && p.load === load);
  const cpu = res.runs["cpu-regs-all"], reu = res.runs["reu-regs-all"];
  if (cpu) {
    out.push("### CPU, Turbo Control = U64 Turbo Registers, Badline Timing as configured, `$D031` bit 7 clear", "",
      "| idx | nominal MHz | blank RAM multiple of PHI2 | blank RAM MHz | on RAM MHz | blank $D020 MHz | blank $D012 MHz | blank CIA MHz | cycles/frame blank | on | on+sprites | blank+sprites | cycles/line on |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (let i = 0; i < 16; i++) {
      const b = get(cpu, i, "screen blank", "RAM lda"); if (!b) continue;
      const n = get(cpu, i, "screen on", "RAM lda"), s1 = get(cpu, i, "on+8 sprites", "RAM lda"), s2 = get(cpu, i, "blank+8 sprites", "RAM lda");
      const x = (c, l) => { const p = get(cpu, i, c, l); return p ? mhz(p.multiple) : "-"; };
      out.push(`| ${i} | ${b.mhz} | ${b.multiple} | ${x("screen blank", "RAM lda")} | ${x("screen on", "RAM lda")} | ${x("screen blank", "VIC sta $D020")} | ${x("screen blank", "VIC lda $D012")} | ${x("screen blank", "CIA lda $DC05")} | ${b.cyclesPerFrame} | ${n?.cyclesPerFrame ?? "-"} | ${s1?.cyclesPerFrame ?? "-"} | ${s2?.cyclesPerFrame ?? "-"} | ${n?.cyclesPerLine ?? "-"} |`);
    }
    out.push("");
  }
  if (reu) {
    out.push("### REU DMA, bytes per microsecond (median of repetitions; 32 KB minus 16 KB slope), 1-byte transfer overhead in PHI2 ticks", "",
      "| idx | nominal MHz | stash blank | fetch blank | stash on | fetch on | 1-byte stash ticks | 1-byte fetch ticks |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (let i = 0; i < 16; i++) {
      const pts = reu.points.filter((p) => p.idx === i); if (!pts.length) continue;
      const med = (c, k) => { const v = pts.filter((p) => p.cond === c).map((p) => p[k] * PHI2_PAL_KHZ / 1000); return v.length ? median(v).toFixed(2) : "-"; };
      const ov = (c, k) => { const v = pts.filter((p) => p.cond === c).map((p) => p.ticks[k]); return v.length ? median(v) : "-"; };
      out.push(`| ${i} | ${pts[0].mhz} | ${med("screen blank", "stashBperTick")} | ${med("screen blank", "fetchBperTick")} | ${med("screen on", "stashBperTick")} | ${med("screen on", "fetchBperTick")} | ${ov("screen blank", "stash 1B")} | ${ov("screen blank", "fetch 1B")} |`);
    }
    out.push("");
  }
  const others = Object.entries(res.runs).filter(([k]) => !["cpu-regs-all", "reu-regs-all", "window"].includes(k));
  if (others.length) {
    out.push("### Other runs (RAM loop; multiple of PHI2 and cycles per frame; for the manual and enablebit runs the idx column is 0 and the nominal MHz is the CPU Speed setting)", "", "| run | idx | nominal MHz | condition | load | multiple | cycles/frame | spread % | flags |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const [k, r] of others) {
      if (r.header.program === 1) for (const p of r.points.filter((q) => q.load === "RAM lda" && /^screen/.test(q.cond))) out.push(`| ${k} | ${p.idx} | ${p.mhz} | ${p.cond} | ${p.load} | ${p.multiple} | ${p.cyclesPerFrame} | ${p.spreadPct} | ${p.interference ? "INTERFERENCE " : ""}${p.status === 255 ? "SPEED-NOT-LIVE" : ""} |`);
      else if (r.header.program === 2) for (const i of [...new Set(r.points.map((p) => p.idx))]) {
        const q = r.points.filter((p) => p.idx === i && p.cond === "screen blank");
        out.push(`| ${k} | ${i} | ${q[0]?.mhz} | screen blank | REU stash/fetch B/us | ${median(q.map((p) => p.stashBperTick * PHI2_PAL_KHZ / 1000)).toFixed(2)} / ${median(q.map((p) => p.fetchBperTick * PHI2_PAL_KHZ / 1000)).toFixed(2)} | - | - | |`);
      }
    }
    out.push("");
  }
  const w = res.runs.window;
  if (w) {
    const fast = w.points.find((p) => p.fast);
    out.push("### Reset window (speed request ignored after the reset done by run_prg)", "", `Attempts: ${w.header.attempts}; first attempt that ran faster than 1 MHz: ${w.header.firstFast ?? "never"}${fast ? `, ${fast.sinceStartMs} ms after program start` : ""}.`, "");
  }
  return out.join("\n");
}

// ------------------------------------------------------------------ one measurement run
async function runProgram(label, prog, sets) {
  const { assemblyToPrgDetailed } = await loadAssembler();
  const src = applyParams(readFileSync(join(benchDir, `turbo-${prog}.asm`), "utf8"), sets);
  const { prg } = assemblyToPrgDetailed(src, { fileName: `turbo-${prog}.asm` });
  writeFileSync(join(outDir, `${label}.prg`), prg);
  const wait = estimateSeconds(prog, src) * Number(opt["wait-factor"] ?? 1);
  console.log(`[${label}] ${prg.length} bytes, expected run time ${wait.toFixed(0)} s`);
  if (opt["assemble-only"]) return;
  await rest("POST", "/v1/runners:run_prg", prg, "application/octet-stream"); // resets the machine, loads, runs
  await sleep(wait); // no reads before this: a memory read pauses the CPU and disturbs the measurement
  let data;
  for (let tries = 0; tries < 6; tries++) {
    data = await rest("GET", "/v1/machine:readmem?address=C000&length=3840");
    if (data[5] === 0xa5) break;
    console.log(`[${label}] not done yet, waiting 20 s (this early read may have disturbed the run: check the interference flags)`);
    await sleep(20);
  }
  writeFileSync(join(outDir, `${label}.bin`), data);
  const r = decode(data);
  writeFileSync(join(outDir, `${label}.json`), JSON.stringify(r, null, 1));
  printTable(r);
  return r;
}

// ------------------------------------------------------------------ config handling with restore
const saved = new Map(); // "cat/item" -> original value
async function setCfg(cat, item, value) {
  const key = `${cat}/${item}`;
  if (!saved.has(key)) saved.set(key, (await itemInfo(cat, item)).current);
  await rest("PUT", `/v1/configs/${enc(cat)}/${enc(item)}?value=${enc(value)}`);
}
async function restoreAll() {
  if (opt["no-restore"]) return;
  for (const [key, val] of [...saved].reverse()) {
    const [cat, item] = key.split("/");
    try { await rest("PUT", `/v1/configs/${enc(cat)}/${enc(item)}?value=${enc(val)}`); console.log(`restored ${key} = ${val}`); }
    catch (e) { console.error(`RESTORE FAILED for ${key} (original value ${JSON.stringify(val)}): ${e.message}`); }
  }
  saved.clear();
}
const pick = (values, re, what) => { const v = values.find((x) => re.test(String(x))); if (v === undefined) throw new Error(`no ${what} value matching ${re} in ${JSON.stringify(values)}`); return v; };

// ------------------------------------------------------------------ suites
const IDX = (...ix) => [`IDX_MASK_LO=${ix.reduce((m, i) => (i < 8 ? m | (1 << i) : m), 0)}`, `IDX_MASK_HI=${ix.reduce((m, i) => (i >= 8 ? m | (1 << (i - 8)) : m), 0)}`];
async function main() {
  if (opt.collect) {
    const res = collect(resolve(opt.collect), opt.device ?? "device", opt.date ?? new Date().toISOString().slice(0, 10));
    if (opt["results-out"]) writeFileSync(resolve(opt["results-out"]), JSON.stringify(res, null, 1) + "\n");
    console.log(summarize(res));
    return;
  }
  if (opt.decode) { const r = decode(readFileSync(opt.decode)); if (opt.json) console.log(JSON.stringify(r, null, 1)); else printTable(r); return; }
  if (opt["assemble-only"]) { await runProgram(opt.program ?? "cpu", opt.program ?? "cpu", opt.set); return; }
  if (!host) throw new Error("--host required");
  const cat = await findCategory("Turbo Control");
  const tc = await itemInfo(cat, "Turbo Control");
  const sp = await itemInfo(cat, "CPU Speed");
  const bl = await itemInfo(cat, "Badline Timing").catch(() => ({ current: undefined, values: [] }));
  console.log(`category "${cat}"\n  Turbo Control = ${tc.current}  allowed ${JSON.stringify(tc.values)}\n  CPU Speed = ${sp.current}  allowed ${JSON.stringify(sp.values)}\n  Badline Timing = ${bl.current}  allowed ${JSON.stringify(bl.values)}`);
  writeFileSync(join(outDir, "config-before.json"), JSON.stringify({ cat, tc, sp, bl }, null, 1));
  const catBefore = await json("GET", `/v1/configs/${enc(cat)}`);
  writeFileSync(join(outDir, "config-category-before.json"), JSON.stringify(catBefore, null, 1));
  const info = await json("GET", "/v1/info").catch(() => ({}));
  writeFileSync(join(outDir, "device-info.json"), JSON.stringify(info, null, 1));
  const reuCat = "C64 and Cartridge Settings";
  const reuBefore = await json("GET", `/v1/configs/${enc(reuCat)}`).catch(() => undefined);
  if (reuBefore) writeFileSync(join(outDir, "config-reu-category-before.json"), JSON.stringify(reuBefore, null, 1));
  if (opt.probe) return;
  const speeds = sp.values.length === 16 ? sp.values : [];
  const table = /64/.test(speeds.join(" ")) ? 2 : 1; // 64 MHz present: C64U / U64E2 table
  const T = `SPEED_TABLE=${table}`;
  const results = {};
  try {
    const reuNow = reuBefore && dig(reuBefore, "RAM Expansion Unit");
    if (reuNow !== undefined && reuNow !== "Enabled") { console.log(`REU is "${reuNow}": enabling for this session (restored afterwards)`); await setCfg(reuCat, "RAM Expansion Unit", "Enabled"); }
    const regs = pick(tc.values, /regist/i, "Turbo Control registers");
    const off = pick(tc.values, /^off$/i, "Turbo Control off");
    const encBit = tc.values.find((x) => /enable.?bit/i.test(String(x)));
    const run = async (label, prog, sets) => { results[label] = await runProgram(label, prog, prog === "window" ? sets : [...sets, T]); };

    if (opt.program && !opt.suite) { // single run, config from --cfg Item=Value
      for (const c of opt.cfg) { const [k, ...v] = c.split("="); await setCfg(cat, k, v.join("=")); }
      await run(opt.program, opt.program, opt.set);
    } else if (opt.suite) {
      const mid = 8, top = 15;
      // 1. registers mode: all speed indexes, badline bit clear
      await setCfg(cat, "Turbo Control", regs);
      if (opt.suite === "full") {
        await run("cpu-regs-all", "cpu", [...IDX(...Array(16).keys())]);
        await run("cpu-regs-badbit80", "cpu", [...IDX(0, mid, top), "BADBIT=$80", "VAR_MASK=5"]);
        await run("reu-regs-all", "reu", [...IDX(...Array(16).keys())]);
        await run("reu-regs-badbit80", "reu", [...IDX(0, mid, top), "BADBIT=$80"]);
      } else {
        await run("cpu-regs-quick", "cpu", [...IDX(0, mid, top), "COND_MASK=7", "VAR_MASK=5"]);
        await run("reu-regs-quick", "reu", [...IDX(0, mid, top)]);
      }
      // 2. reset window (program started right after run_prg resets the machine)
      await run("window", "window", ["TARGET_IDX=15"]);
      // 3. Badline Timing config values (registers mode, bit 7 clear)
      for (const v of bl.values) {
        await setCfg(cat, "Badline Timing", v);
        await run(`cpu-badlinecfg-${String(v).replace(/\W+/g, "_")}`, "cpu", [...IDX(0, mid, top), "COND_MASK=3", "VAR_MASK=5"]);
      }
      if (bl.current !== undefined) await setCfg(cat, "Badline Timing", bl.current);
      // 4. fixed-speed modes: "Manual" (CPU Speed always applies) and "TurboEnable Bit" ($D030 bit 0 from the program)
      const manual = tc.values.find((x) => /manual/i.test(String(x)));
      for (const [mode, tag, d030] of [[manual, "manual", 0], [encBit, "enablebit", 1]]) {
        if (mode === undefined) { console.log(`Turbo Control has no ${tag} value on this device, skipped`); continue; }
        await setCfg(cat, "Turbo Control", mode);
        for (const i of [0, mid, top]) {
          const s = speeds[i]; if (s === undefined) continue;
          await setCfg(cat, "CPU Speed", s);
          const m = parseInt(String(s).replace(/\D+/g, ""), 10);
          await run(`cpu-${tag}-${m}MHz`, "cpu", ["IDX_MASK_LO=1", "IDX_MASK_HI=0", "USE_D031=0", `D030_WRITE=${d030}`, "D030_VALUE=1", `NOMINAL_M=${m}`, "VAR_MASK=5"]);
        }
      }
      // 5. Turbo Control Off: expect 1 MHz and $D031 reading $FF
      await setCfg(cat, "Turbo Control", off);
      await run("cpu-off", "cpu", ["IDX_MASK_LO=1", "IDX_MASK_HI=0", "USE_D031=0", "NOMINAL_M=1", "VAR_MASK=5"]);
    }
  } finally {
    await restoreAll();
    if (!opt.probe && !opt["no-restore"]) {
      const after = await json("GET", `/v1/configs/${enc(cat)}`);
      writeFileSync(join(outDir, "config-category-after.json"), JSON.stringify(after, null, 1));
      const same = JSON.stringify(after) === JSON.stringify(catBefore);
      if (reuBefore) {
        const reuAfter = await json("GET", `/v1/configs/${enc(reuCat)}`);
        writeFileSync(join(outDir, "config-reu-category-after.json"), JSON.stringify(reuAfter, null, 1));
        console.log(JSON.stringify(reuAfter) === JSON.stringify(reuBefore) ? `RESTORE VERIFIED: category "${reuCat}" identical` : `RESTORE DIFF in category "${reuCat}"`);
      }
      console.log(same ? `RESTORE VERIFIED: category "${cat}" identical to the values before the run` : `RESTORE DIFF in category "${cat}": compare config-category-before.json and config-category-after.json`);
    }
    writeFileSync(join(outDir, "summary.json"), JSON.stringify(results, null, 1));
  }
}
main().catch((e) => { console.error(e.message); restoreAll().finally(() => process.exit(1)); });
