#!/usr/bin/env node
/**
 * SIDWAVE S0 baseline recorder.
 *
 * Usage: node scripts/sidwave-baseline.mjs [--out file] [--compare a.json b.json]
 *
 * Records hashes and metadata of SIDWAVE compile, lint, generator and reference-render output
 * so that a later code move can be checked for byte-identical behaviour. Keys under `timing`
 * are measurements and are ignored by --compare.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Module resolver. After the SIDWAVE code move, only this function changes.
// ---------------------------------------------------------------------------
async function loadSidwaveModules() {
  const api = await import("sidwave"); // the public exports of the sidwave package
  return {
    parser: api,    // parseSidwave, SidwaveValidationError
    compiler: api,  // compileSidwaveToPrg, compileSidwaveToSid, arrangeSidwave
    lint: api,      // formatFinding
    generator: api, // MUSIC_STYLES, DEFAULT_MUSIC_SEED, generateSidwave
    reference: api, // renderReference
  };
}
// ---------------------------------------------------------------------------

const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const rel = (p) => path.relative(root, p).split(path.sep).join("/");

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
function normalize(v) {
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, normalize(x)]));
  return v;
}
/** Scalars stay; small arrays stay; large arrays and buffers are reduced to length + hash. */
function meta(v) {
  if (Buffer.isBuffer(v)) return { length: v.length, sha256: sha(v) };
  if (Array.isArray(v)) {
    const n = normalize(v);
    return v.length > 64 ? { length: v.length, sha256: sha(JSON.stringify(sortKeys(n))) } : n.map((x) => (x && typeof x === "object" ? meta(x) : x));
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, meta(x)]));
  return normalize(v);
}
const errInfo = (e) => ({ error: { class: e?.constructor?.name ?? typeof e, name: e?.name, message: String(e?.message ?? e), path: e?.path } });
function attempt(fn) { try { return fn(); } catch (e) { return errInfo(e); } }

function listYaml(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => path.join(dir, f));
}

function compileRecord(mod, text, { forRender = false } = {}) {
  const rec = {};
  let doc;
  try { doc = mod.parser.parseSidwave(text); } catch (e) { return { doc: undefined, rec: { parse: errInfo(e) } }; }
  rec.parse = { ok: true, version: doc.version, sids: doc.sids?.length, speed: doc.speed, end: !!doc.end };
  rec.prg = {};
  for (const loop of [false, true]) {
    const key = `loop_${loop}`;
    try {
      const r = mod.compiler.compileSidwaveToPrg(doc, { loop });
      const { prg, lint, ...rest } = r;
      const o = { prg_sha256: sha(prg), prg_length: prg.length, metadata: meta(rest) };
      o.lint = (lint ?? []).map((f) => mod.lint.formatFinding(f));
      o.lint_raw = meta(lint ?? []);
      try { o.psid_sha256 = sha(mod.compiler.compileSidwaveToSid(doc, prg).sid); } catch (e) { o.psid = errInfo(e); }
      try { o.psid_explicit_addresses_sha256 = sha(mod.compiler.compileSidwaveToSid(doc, prg, { initAddress: r.initAddress, playAddress: r.playAddress }).sid); } catch (e) { o.psid_explicit = errInfo(e); }
      rec.prg[key] = o;
    } catch (e) { rec.prg[key] = errInfo(e); }
  }
  try {
    const r = mod.compiler.compileSidwaveToPrg(doc, { loop: false, compress: false });
    rec.prg.loop_false_uncompressed = { prg_sha256: sha(r.prg), prg_length: r.prg.length };
  } catch (e) { rec.prg.loop_false_uncompressed = errInfo(e); }
  return { doc, rec };
}

function collectScores() {
  const items = [];
  for (const f of listYaml(path.join(root, "data/sound/examples"))) items.push({ kind: "example", file: f });
  const fx = path.join(root, "packages/sidwave/test/fixtures");
  for (const d of fs.readdirSync(fx).filter((d) => /^sidwave/.test(d)).sort()) {
    for (const f of listYaml(path.join(fx, d))) items.push({ kind: "fixture", file: f });
  }
  return items;
}

function renderRecord(mod, doc, seconds) {
  const run = () => {
    const r = mod.reference.renderReference(doc, { model: "8580", useScoreModels: true, seconds, sampleRate: 48000 });
    const h = crypto.createHash("sha256");
    h.update(Buffer.from(r.left.buffer, r.left.byteOffset, r.left.byteLength));
    h.update(Buffer.from(r.right.buffer, r.right.byteOffset, r.right.byteLength));
    return { sha256: h.digest("hex"), frames: r.left.length, sampleRate: r.sampleRate, warnings: r.warnings };
  };
  try {
    const a = run(), b = run();
    const same = a.sha256 === b.sha256;
    // sidplayfp output differs between identical runs (sample count and values), so a non-deterministic render
    // records only the flag; the per-run hashes and frame counts would make --compare unstable.
    return { deterministic: same, seconds, sampleRate: a.sampleRate, warnings: a.warnings, ...(same ? { frames: a.frames, samples_sha256: a.sha256 } : { note: "sidplayfp renders differ between runs; samples not recorded" }) };
  } catch (e) { return { skipped: true, reason: String(e?.message ?? e).slice(0, 300) }; }
}

function hashDir(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[rel(p)] = sha(fs.readFileSync(p));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

function resourceUris() {
  const file = path.join(root, "mcp/resources.json");
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const uris = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") { if (typeof v.uri === "string") uris.push(v.uri); Object.values(v).forEach(walk); }
  };
  walk(j);
  return { all_count: uris.length, sound: uris.filter((u) => u.startsWith("c64://sound/")).sort(), all_sha256: sha(JSON.stringify([...uris].sort())) };
}

function packList() {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) return { error: { message: (r.stderr || "").slice(0, 300) } };
  const j = JSON.parse(r.stdout)[0];
  const files = j.files.map((f) => ({ path: f.path, size: f.size, mode: f.mode })).sort((a, b) => (a.path < b.path ? -1 : 1));
  return { name: j.name, version: j.version, entryCount: j.entryCount, size_unpacked: j.unpackedSize, file_count: files.length, files };
}

async function startupTimes(runs = 3) {
  const times = [];
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-baseline-home-"));
  try {
    for (let i = 0; i < runs; i += 1) {
      const t0 = process.hrtime.bigint();
      const ms = await new Promise((resolve) => {
        const child = spawn(process.execPath, ["dist/index.js"], {
          cwd: root, stdio: ["pipe", "ignore", "pipe"],
          env: { ...process.env, C64_MODE: "vice", C64BRIDGE_CONFIG: "", HOME: tmpHome, VICE_VISIBLE: "false" },
        });
        let buf = "", done = false;
        const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child.kill("SIGKILL"); } catch {} resolve(v); };
        const timer = setTimeout(() => finish(null), 60000);
        child.stderr.on("data", (d) => { buf += d; if (/MCP server running on/.test(buf)) finish(Number(process.hrtime.bigint() - t0) / 1e6); });
        child.on("exit", () => finish(null));
      });
      times.push(ms);
    }
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }); }
  const ok = times.filter((t) => t !== null).sort((a, b) => a - b);
  return { runs_ms: times, median_ms: ok.length ? ok[Math.floor(ok.length / 2)] : null };
}

async function record() {
  const t0 = Date.now();
  const mod = await loadSidwaveModules();
  const timing = {};
  const out = { schema: 1, package: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, node_major: undefined, scores: {}, generator: {}, reference: {}, mcp_files: {}, resources: {}, pack: {} };
  delete out.node_major;

  let t = Date.now();
  const docs = new Map();
  for (const item of collectScores()) {
    const key = rel(item.file).replace(/^packages\/sidwave\//, ""); // keys of moved fixtures stay test/fixtures/...
    const { doc, rec } = compileRecord(mod, fs.readFileSync(item.file, "utf8"));
    rec.kind = item.kind;
    rec.source_sha256 = sha(fs.readFileSync(item.file));
    out.scores[key] = rec;
    if (doc) docs.set(key, doc);
  }
  timing.scores_ms = Date.now() - t;

  t = Date.now();
  const seeds = [mod.generator.DEFAULT_MUSIC_SEED, 1, 12345];
  for (const style of Object.keys(mod.generator.MUSIC_STYLES)) {
    for (const seed of seeds) for (const system of ["PAL", "NTSC"]) for (const preset of ["classic", "expression"]) {
      const key = `${style}/seed${seed}/${system}/${preset}`;
      try {
        const g = mod.generator.generateSidwave({ root: "C3", preset, style, seed, system });
        const text = JSON.stringify(g.score);
        const { rec } = compileRecord(mod, text);
        out.generator[key] = { text_sha256: sha(text), text_length: text.length, key: g.key, progression: g.progression, tempo: g.tempo, bars: g.bars, speed: g.speed, lead_timeline_sha256: sha(JSON.stringify(sortKeys(normalize(g.leadTimeline)))), compiled: { parse: rec.parse, loop_false: rec.prg?.loop_false && pick(rec.prg.loop_false), loop_true: rec.prg?.loop_true && pick(rec.prg.loop_true) } };
      } catch (e) { out.generator[key] = errInfo(e); }
    }
  }
  timing.generator_ms = Date.now() - t;

  t = Date.now();
  const bin = "/usr/bin/sidplayfp";
  for (const [key, doc] of docs) {
    if (!fs.existsSync(bin)) { out.reference[key] = { skipped: true, reason: "sidplayfp not installed" }; continue; }
    const arr = mod.compiler.arrangeSidwave(doc);
    const full = Math.ceil(arr.totalFrames / arr.fps);
    const rr = renderRecord(mod, doc, Math.min(4, full));
    if (doc.samples) rr.digi = true;
    // Deterministic input to sidplayfp: the per-SID stem PSIDs that renderReference writes.
    rr.stem_input_sha256 = doc.sids.map((_, chip) => sha(mod.compiler.compileSidwaveStem(doc, arr, chip)));
    out.reference[key] = rr;
  }
  timing.reference_ms = Date.now() - t;

  out.mcp_files = hashDir(path.join(root, "mcp"));
  out.resources = resourceUris();
  out.pack = packList();
  t = Date.now();
  out.startup = { note: "measurement, ignored by --compare", ...(await startupTimes(3)) };
  timing.startup_ms = Date.now() - t;
  timing.total_ms = Date.now() - t0;
  out.timing = timing;
  return out;
}

function pick(o) {
  if (o.error) return o;
  return { prg_sha256: o.prg_sha256, psid_sha256: o.psid_sha256, psid: o.psid };
}

// --------------------------- compare ---------------------------------------
const IGNORED_TOP = new Set(["timing", "startup"]);
function flatten(v, prefix, into) {
  if (v && typeof v === "object") {
    const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
    if (!keys.length) into.set(prefix, Array.isArray(v) ? "[]" : "{}");
    for (const k of keys) flatten(v[k], prefix ? `${prefix}.${k}` : String(k), into);
  } else into.set(prefix, JSON.stringify(v));
  return into;
}
function compare(a, b) {
  const strip = (j) => Object.fromEntries(Object.entries(j).filter(([k]) => !IGNORED_TOP.has(k)));
  const fa = flatten(strip(a), "", new Map()), fb = flatten(strip(b), "", new Map());
  const diffs = [];
  for (const k of new Set([...fa.keys(), ...fb.keys()])) {
    if (fa.get(k) !== fb.get(k)) diffs.push(`${k}: ${fa.has(k) ? fa.get(k) : "<absent>"} != ${fb.has(k) ? fb.get(k) : "<absent>"}`);
  }
  return diffs.sort();
}

const args = process.argv.slice(2);
if (args[0] === "--compare") {
  if (args.length !== 3) { console.error("usage: --compare a.json b.json"); process.exit(2); }
  const diffs = compare(JSON.parse(fs.readFileSync(args[1], "utf8")), JSON.parse(fs.readFileSync(args[2], "utf8")));
  if (diffs.length) {
    for (const d of diffs.slice(0, 200)) console.log(d.length > 240 ? d.slice(0, 237) + "..." : d);
    if (diffs.length > 200) console.log(`... ${diffs.length - 200} more`);
    console.log(`${diffs.length} difference(s)`);
    process.exit(1);
  }
  console.log("identical (timing and startup ignored)");
  process.exit(0);
}
const oi = args.indexOf("--out");
const outFile = path.resolve(oi >= 0 ? args[oi + 1] : path.join(root, "evidence/baseline/sidwave-baseline.json"));
const result = await record();
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(sortKeys(result), null, 2) + "\n");
const s = result.scores, rf = Object.values(result.reference);
console.log(`wrote ${rel(outFile)}: scores=${Object.keys(s).length} generator=${Object.keys(result.generator).length} reference rendered=${rf.filter((r) => !r.skipped).length} deterministic=${rf.filter((r) => r.deterministic).length} skipped=${rf.filter((r) => r.skipped).length} total=${result.timing.total_ms}ms`);
