// Fuzz and soak tests for SIDWAVE: random valid documents, mutated examples, the song generator,
// resource limits and PSID headers. SIDWAVE_FUZZ_ITERATIONS=N scales the seeded case counts.
// SIDWAVE_FUZZ_SOAK_SECONDS=600 with a "mixed round-2" test filter runs the mixed grammar for ten minutes.
// SIDWAVE_FUZZ_SEED offsets the seeds. SIDWAVE_FUZZ_REPORT=file records the smallest input seen for each finding.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import { parse as yamlParse } from "yaml";
import { generateSidwave, MUSIC_STYLES } from "../src/audio/generateSidwave.js";
import { maxSidwaveMidi } from "../src/sidwaveCompiler.js";
import { SIDWAVE_EXAMPLES, readSidwaveExample } from "../src/sidwaveExamples.js";
import { chance, checkEquivalence, exercise, genDoc, genRound2Doc, int, noteName, pick, prng, signature } from "./helpers/sidwaveFuzzKit.mjs";
import { parseSidwave } from "../src/sidwave.js";

const ITERATIONS = Number(process.env.SIDWAVE_FUZZ_ITERATIONS ?? 100);
const SOAK = process.env.SIDWAVE_FUZZ_ITERATIONS !== undefined && ITERATIONS > 100;
const SCALE = ITERATIONS / 100;
const SEED = Number(process.env.SIDWAVE_FUZZ_SEED ?? 0);
const REPORT = process.env.SIDWAVE_FUZZ_REPORT;
const TRACE = process.env.SIDWAVE_FUZZ_TRACE;
const count = (base) => Math.max(1, Math.round(base * SCALE));
/** Default runs stop at a deadline so the whole file stays well under 60 s; soak runs only stop at the case count. */
const deadline = (ms) => { const end = performance.now() + (SOAK ? Infinity : ms); return () => performance.now() > end; };
const trace = (what) => { if (TRACE) fs.writeFileSync(TRACE, show(what)); };

const found = new Map();
const stats = new Map();
const bump = (section, key, n = 1) => { const s = stats.get(section) ?? {}; s[key] = (s[key] ?? 0) + n; stats.set(section, s); };

const show = (input) => { if (typeof input === "string") return input; try { return JSON.stringify(input) ?? "undefined"; } catch { return "(document too deep to serialise)"; } };

function record(section, label, input, loop, faults) {
  for (const fault of faults) {
    const sig = signature(fault);
    const entry = found.get(sig) ?? { sig, count: 0, section, label, loop, fault, input: undefined };
    entry.count++;
    if (entry.input === undefined || show(input).length < show(entry.input).length) Object.assign(entry, { input, label, fault, loop });
    found.set(sig, entry);
  }
}

function check(section, label, input, options = {}) {
  trace({ section, label, options, input });
  const result = exercise(input, { label, ...options });
  bump(section, "cases");
  bump(section, result.outcome);
  record(section, label, input, options.loop ?? true, result.faults);
  return result;
}

function failOnNewFindings(section) {
  const mine = [...found.values()].filter((f) => f.section === section);
  const text = mine.map((f) => `${f.sig} (x${f.count}, ${f.label}): ${f.fault.detail}\n  input: ${show(f.input).slice(0, 600)}`).join("\n");
  assert.equal(mine.length, 0, `${mine.length} fuzz finding(s) in ${section}:\n${text}`);
}

function writeReport() {
  fs.writeFileSync(REPORT, JSON.stringify([...found.values()].map((f) => ({ ...f, input: show(f.input).length > 2_000_000 || show(f.input).startsWith("(document too deep") ? "(too large or too deep to store)" : f.input })), null, 1));
}

test.after?.(() => {
  const summary = Object.fromEntries(stats);
  console.info(`SIDWAVE fuzz summary: ${JSON.stringify(summary)}; findings ${found.size}`);
  if (REPORT) writeReport();
});

// ---------------------------------------------------------------------------
// 1. Grammar based valid documents

test("fuzz: random documents parse or fail with a path, compile or refuse clearly, and play within bounds", { timeout: 600_000 + 60_000 * SCALE * 100 }, () => {
  const stop = deadline(11_000);
  const total = count(260);
  let i = 0;
  for (; i < total && !stop(); i++) {
    const r = prng(SEED * 1_000_003 + 1000 + i);
    const doc = genDoc(r, { chaos: i % 4 === 0 ? 0.05 : 0, big: i % 40 === 39, badInstruments: i % 3 === 0 ? 0.5 : 0 });
    const input = chance(r, 0.3) ? JSON.stringify(doc) : doc;
    const result = check("grammar", `grammar#${i}`, input, { loop: i % 2 === 0, maxCalls: SOAK ? 3000 : 900, determinism: i % 12 === 0 });
    if (result.outcome === "played" && typeof input === "object" && i % 5 === 0) {
      const faults = checkEquivalence(r, input, { loop: false });
      bump("grammar", "equivalence checks");
      record("grammar", `grammar#${i} equivalence`, input, false, faults);
    }
  }
  bump("grammar", "planned", total);
  const s = stats.get("grammar");
  assert.ok((s.played ?? 0) >= Math.min(20, i / 6), `the grammar produced too few playable documents (${JSON.stringify(s)})`);
  failOnNewFindings("grammar");
});

const SOAK_SECONDS = Number(process.env.SIDWAVE_FUZZ_SOAK_SECONDS ?? 0);
test("fuzz: mixed round-2 grammar and mutations", { timeout: Math.max(40_000, (SOAK_SECONDS + 30) * 1000) }, () => {
  const end = performance.now() + (SOAK_SECONDS || 8) * 1000;
  let played = 0;
  const section = "round2";
  for (let i = 0; SOAK_SECONDS ? performance.now() < end : i < 36 && (i < 12 || performance.now() < end); i++) {
    const seed = SEED * 1_000_003 + 1_300_000 + i;
    const r = prng(seed);
    const score = genRound2Doc(r, i);
    const input = i % 8 === 3 ? mutateObject(r, score, 600)
      : i % 8 === 5 ? genDoc(r, { chaos: 0.03, badInstruments: 0.15 }) : score;
    const loop = !score.end || i % 4 !== 1;
    const result = check(section, `round2 seed ${seed} case ${i}`, input, {
      loop, determinism: i % 24 === 0, maxCalls: 2200,
    });
    if (input === score && result.outcome !== "played") {
      record(section, `round2 seed ${seed} case ${i}`, input, loop,
        [{ kind: "round2-valid-case-refused", detail: String(result.error?.message) }]);
    }
    if (result.outcome === "played") {
      played++;
      if (i % 12 === 0) record(section, `round2 seed ${seed} equivalence`, input, loop, checkEquivalence(r, input, { loop }));
    }
    if (found.size && REPORT) writeReport();
  }
  assert.ok(played >= 8, "must execute at least eight scores with R2 features");
  failOnNewFindings(section);
});

// ---------------------------------------------------------------------------
// 2. Mutation fuzzing of the examples

const BAD_VALUES = [null, true, false, 0, -1, -0, 1e308, -1e308, 2 ** 53, 2 ** 31, -(2 ** 31), 0.5, 1e-9, Number.NaN, Infinity, -Infinity,
  "", " ", "0", "-1", "NaN", "Infinity", "1e999", "0x10", "null", "~", "-", ".", "$", "$.", "A".repeat(5000), "\u0000", "\ud800", "‮", "😀", "日本語", " ",
  [], {}, [null], [[]], { a: 1 }, [1, 2, 3], "C4@", "@", "C#9", "H4", "+", "A+", "A↑↑↑", "A+999", "A-999", "v1", "lib:", "lib:nope", "__proto__", "constructor"];

function allPaths(value, prefix = [], out = []) {
  if (value && typeof value === "object") for (const key of Object.keys(value)) { out.push([...prefix, key]); allPaths(value[key], [...prefix, key], out); }
  return out;
}
const at = (root, path) => path.reduce((o, k) => o?.[k], root);

function nest(depth, array) {
  let v = array ? [] : {};
  for (let i = 0; i < depth; i++) v = array ? [v] : { a: v };
  return v;
}

const MAX_MUTANT_JSON = 3_000_000;

function mutateObject(r, source, hugeCap) {
  let doc = structuredClone(source);
  for (let n = int(r, 1, 3); n > 0; n--) {
    let snapshot;
    try { snapshot = structuredClone(doc); } catch { break; }
    try { applyMutation(r, doc, hugeCap); } catch { doc = snapshot; continue; }
    // Repeated "huge" mutations multiply; keep each mutant to a few MB so the harness itself stays bounded.
    if (JSON.stringify(doc)?.length > MAX_MUTANT_JSON) doc = snapshot;
  }
  return doc;
}

function applyMutation(r, doc, hugeCap) {
  {
    const paths = allPaths(doc);
    if (!paths.length) return;
    const path = pick(r, paths);
    const parent = at(doc, path.slice(0, -1));
    const key = path[path.length - 1];
    const value = parent[key];
    const op = pick(r, ["delete", "duplicate", "wrong", "wrong", "extreme", "huge", "unicode", "empty", "negative", "deep", "swap", "bad", "numstr"]);
    switch (op) {
      case "delete": Array.isArray(parent) ? parent.splice(Number(key), 1) : delete parent[key]; break;
      case "duplicate":
        if (Array.isArray(parent)) parent.splice(Number(key), 0, structuredClone(value)); else parent[`${key}${pick(r, ["", "2", " ", "_"])}`] = structuredClone(value);
        break;
      case "wrong": parent[key] = pick(r, [[], {}, null, true, "x", 7, [value], { v: value }, String(value)]); break;
      case "extreme": parent[key] = pick(r, [1e308, -1e308, 2 ** 53, 2 ** 32, -(2 ** 31), 1e-300, Number.MAX_SAFE_INTEGER, 65535, 65536, 255, 256, 4095, 4096, 2047, 2048]); break;
      case "huge":
        if (Array.isArray(value) && value.length) parent[key] = Array.from({ length: int(r, 500, hugeCap) }, (_, i) => structuredClone(value[i % value.length]));
        else if (typeof value === "string") parent[key] = value.repeat(int(r, 100, hugeCap));
        else parent[key] = Array.from({ length: int(r, 500, hugeCap) }, () => pick(r, ["C4", 1, "-"]));
        break;
      case "unicode": parent[key] = pick(r, ["日本語", "\u0000", "😀😀", "\ud800", "é", "‮", "﻿", "ａｂｃ"]) + (typeof value === "string" ? value : ""); break;
      case "empty": parent[key] = pick(r, ["", [], {}]); break;
      case "negative": parent[key] = typeof value === "number" ? -value - 1 : -1; break;
      case "deep": parent[key] = nest(int(r, 20, SOAK ? 2000 : 150), chance(r, 0.5)); break;
      case "swap": { const other = pick(r, paths); const op2 = at(doc, other.slice(0, -1)); const ok = other[other.length - 1]; if (op2 && !other.slice(0, path.length).every((k, j) => k === path[j])) { [parent[key], op2[ok]] = [op2[ok], parent[key]]; } break; }
      case "bad": parent[key] = pick(r, BAD_VALUES); break;
      case "numstr": parent[key] = typeof value === "number" ? String(value) : value; break;
    }
  }
}

function mutateText(r, text) {
  const lines = text.split("\n");
  const i = int(r, 0, lines.length - 1);
  switch (pick(r, ["dupline", "delline", "truncate", "tab", "colon", "anchor", "tag", "merge", "indent", "bom", "crlf", "flow", "alias-bomb", "ctrl"])) {
    case "dupline": lines.splice(i, 0, lines[i]); break;
    case "delline": lines.splice(i, 1); break;
    case "truncate": return text.slice(0, int(r, 0, text.length));
    case "tab": lines[i] = `\t${lines[i]}`; break;
    case "colon": lines[i] = lines[i].replace(": ", ":"); break;
    case "anchor": lines[i] = lines[i].replace(/: (\S)/, ": &x $1"); lines.push("extra: *x"); break;
    case "tag": lines[i] = lines[i].replace(/: (\S)/, `: ${pick(r, ["!!binary", "!!python/object:os.system", "!!set", "!!float", "!!int", "!!str", "!custom"])} $1`); break;
    case "merge": lines.splice(i, 0, "<<: {bars: 1}"); break;
    case "indent": lines[i] = ` ${lines[i]}`; break;
    case "bom": return `﻿${text}`;
    case "crlf": return text.replace(/\n/g, "\r\n");
    case "flow": lines[i] = `{${lines[i]}`; break;
    case "alias-bomb": return `${["a: &a [x,x,x,x,x,x,x,x,x]", ...Array.from({ length: 12 }, (_, k) => `${String.fromCharCode(98 + k)}: &${String.fromCharCode(98 + k)} [${Array(9).fill(`*${String.fromCharCode(97 + k)}`).join(",")}]`)].join("\n")}\n${text}`;
    case "ctrl": lines[i] += pick(r, ["\u0000", "\u0007", "\u0085", " "]); break;
  }
  return lines.join("\n");
}

test("fuzz: mutated examples are rejected with a path, never crash or hang", { timeout: 600_000 + 60_000 * SCALE * 100 }, () => {
  const stop = deadline(6_000);
  const sources = SIDWAVE_EXAMPLES.map(({ name }) => ({ name, text: readSidwaveExample(name), doc: yamlParse(readSidwaveExample(name)) }));
  sources.push({ name: "fuer_elise", text: readSidwaveExample("fuer_elise"), doc: yamlParse(readSidwaveExample("fuer_elise")) });
  const total = count(520);
  const hugeCap = SOAK ? 20_000 : 3000;
  let slow = 0;
  for (let i = 0; i < total && !stop(); i++) {
    const r = prng(SEED * 1_000_003 + 500_000 + i);
    const source = sources[i % sources.length];
    const mode = pick(r, ["object", "object", "json", "text"]);
    const started = performance.now();
    if (mode === "text") check("mutation", `${source.name}~text#${i}`, mutateText(r, source.text), { loop: false, maxCalls: 300, compileBudgetMs: 20_000 });
    else {
      const mutated = mutateObject(r, source.doc, hugeCap);
      check("mutation", `${source.name}~${mode}#${i}`, mode === "json" ? JSON.stringify(mutated) : mutated, { loop: false, maxCalls: 300, compileBudgetMs: 20_000 });
    }
    if (performance.now() - started > 4000) slow++;
  }
  bump("mutation", "slowCases", slow);
  failOnNewFindings("mutation");
});

test("fuzz: very deep and very wide documents are rejected with a path", () => {
  const holder = (depth, array) => { let v = array ? [] : {}; for (let i = 0; i < depth; i++) v = array ? [v] : { a: v }; return v; };
  // A frozen score, so that rewriting the live example does not change which paths exist.
  const base = yamlParse(fs.readFileSync(new URL("./fixtures/sidwave-1.1/chiptune_drive.yaml", import.meta.url), "utf8"));
  const cases = [];
  for (const depth of SOAK ? [1000, 20_000, 100_000] : [1000, 20_000]) for (const array of [false, true]) {
    for (const where of ["title", "voices.0.patterns.launch.groove", "instruments", "global_fx", "timeline.0.layers.v1", "sids"]) {
      const doc = structuredClone(base);
      const keys = where.split(".");
      let parent = doc;
      for (const k of keys.slice(0, -1)) parent = (parent[k] ??= {});
      parent[keys[keys.length - 1]] = holder(depth, array);
      cases.push([`deep ${array ? "array" : "object"} ${depth} at ${where}`, doc]);
    }
    cases.push([`deep text ${array ? "flow sequence" : "flow map"} ${depth}`, array ? `${"[".repeat(depth)}${"]".repeat(depth)}` : `${"{a: ".repeat(depth)}1${"}".repeat(depth)}`]);
    cases.push([`deep text block ${depth}`, Array.from({ length: Math.min(depth, 5000) }, (_, i) => `${" ".repeat(i)}a:`).join("\n")]);
  }
  const wide = SOAK ? 1_000_000 : 200_000;
  cases.push(["a very long groove", { sidwave: "1.1", voices: [{ id: 1, patterns: { A: { groove: new Array(wide).fill("C3") } } }], timeline: [{ bars: 1, layers: { v1: "A" } }] }]);
  cases.push(["a very long voice list", { sidwave: "1.2", voices: Array.from({ length: wide }, (_, i) => ({ id: i })), timeline: [{ bars: 1, layers: {} }] }]);
  cases.push(["a very long timeline", { sidwave: "1.1", voices: [{ id: 1, patterns: { A: { groove: ["C3"] } } }], timeline: Array.from({ length: wide }, () => ({ bars: 1, layers: { v1: "A" } })) }]);
  cases.push(["a very long title", { sidwave: "1.1", title: "x".repeat(SOAK ? 10_000_000 : 1_000_000), voices: [{ id: 1, patterns: { A: { groove: ["C3"] } } }], timeline: [{ bars: 1, layers: { v1: "A" } }] }]);
  for (const [label, input] of cases) {
    const started = performance.now();
    check("deep", label, input, { loop: false, maxCalls: 50, compileBudgetMs: 20_000 });
    const ms = performance.now() - started;
    if (ms > 5000) record("deep", label, typeof input === "string" ? input.slice(0, 200) : "(large generated document)", false, [{ kind: "parse-slow-case", detail: `${Math.round(ms)} ms` }]);
  }
  failOnNewFindings("deep");
});

test("fuzz: every example survives the unmutated pipeline", { timeout: 120_000 }, () => {
  for (const { name } of [...SIDWAVE_EXAMPLES, { name: "fuer_elise" }]) {
    check("examples", `example:${name}`, readSidwaveExample(name), { loop: false, maxCalls: SOAK ? 6000 : 700 });
  }
  failOnNewFindings("examples");
});

// ---------------------------------------------------------------------------
// 3. Generator

const CLASSIC_OPTIONS = ["pattern", "steps", "tempoMs", "waveform", "preset"];

function genOptions(r, system, i) {
  const options = { root: noteName(int(r, 12, maxSidwaveMidi(system))), style: pick(r, Object.keys(MUSIC_STYLES)), seed: pick(r, [0, 1, 2 ** 31 - 1, 0xffffffff, int(r, 0, 0xffffffff), 65]), system, preset: pick(r, ["classic", "expression"]) };
  if (i % 3 === 0) return options;
  for (const key of CLASSIC_OPTIONS) {
    if (!chance(r, 0.4)) continue;
    if (key === "pattern") options.intervals = Array.from({ length: int(r, 1, 8) }, () => int(r, -24, 24));
    if (key === "steps") options.steps = pick(r, [1, 2, 16, int(r, 1, 128), 128]);
    if (key === "tempoMs") options.tempoMs = pick(r, [20, 21, 125, 250, int(r, 20, 2000), 2000]);
    if (key === "waveform") options.waveform = pick(r, ["pulse", "saw", "tri", "noise"]);
    if (key === "preset") options.preset = pick(r, ["classic", "expression"]);
  }
  return options;
}

test("fuzz: generateSidwave output parses, compiles, plays and is deterministic for every style, root and seed", { timeout: 600_000 + 60_000 * SCALE * 100 }, () => {
  const stop = deadline(8_000);
  const total = count(140);
  // The first cases walk the extremes: lowest and highest valid root for every style and system.
  const extremes = [];
  for (const system of ["PAL", "NTSC"]) for (const style of Object.keys(MUSIC_STYLES)) for (const root of [12, maxSidwaveMidi(system)]) {
    extremes.push({ root: noteName(root), style, seed: 0, system, preset: "classic" }, { root: noteName(root), style, seed: 2 ** 31 - 1, system, preset: "expression" });
  }
  for (let i = 0; i < total && !stop(); i++) {
    const r = prng(SEED * 1_000_003 + 900_000 + i);
    const system = i % 2 ? "NTSC" : "PAL";
    const options = i < extremes.length ? extremes[i] : genOptions(r, system, i);
    const label = `generate#${i} ${JSON.stringify(options)}`;
    let generated;
    try { generated = generateSidwave(options); } catch (error) {
      record("generator", label, options, false, [{ kind: `generator-throws:${error?.constructor?.name}`, detail: String(error?.message).split("\n")[0] }]);
      continue;
    }
    bump("generator", "cases");
    const again = generateSidwave(options);
    if (JSON.stringify(again.score) !== JSON.stringify(generated.score)) record("generator", label, options, false, [{ kind: "generator-nondeterministic", detail: "two calls with the same options returned different scores" }]);
    const max = maxSidwaveMidi(system);
    const leadOutOfRange = generated.leadTimeline.some(({ note }) => { const m = noteMidi(note); return m > max || m < 12; });
    const result = exercise(JSON.stringify(generated.score), { loop: false, maxCalls: SOAK ? 4000 : 500, label });
    bump("generator", result.outcome);
    // The music_generate tool rejects lead notes above the SID range before compiling, so a refusal for them is expected.
    if (result.outcome !== "played" && !leadOutOfRange) record("generator", label, options, false, [{ kind: `generator-output-${result.outcome}`, detail: String(result.error?.message ?? "").slice(0, 200) }, ...result.faults]);
    else record("generator", label, options, false, result.faults);
  }
  failOnNewFindings("generator");
});

function noteMidi(note) {
  const m = /^([A-G])([#b]?)(-?\d+)$/.exec(note);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return (Number(m[3]) + 1) * 12 + base;
}

// ---------------------------------------------------------------------------
// 4. Resource limits

function voiceDense(id, length) {
  const notes = ["C3", "E3", "G3", "A3", "C4", "D4", "E4", { note: "G4", legato: true, portamento: 3 }, "-", "F3", "~", "B3"];
  return { id, waveform: ["pulse", "sawtooth", "triangle", "noise"][id % 4], patterns: { A: { length: 0.25, groove: Array.from({ length: length }, (_, i) => notes[(i + id) % notes.length]),
    fx: { vibrato: { depth: 0.3, rate: 5, delay: 4 }, slide: { depth: 2, speed: 3 }, pwm_sweep: { depth: 0.2, speed: 1 } } } } };
}
const full = (voices, bars, extra = {}) => ({ sidwave: "1.2", tempo: 140, sids: { layout: "ultisid8+sockets" }, voices, timeline: [{ bars, layers: Object.fromEntries(voices.map((v) => [`v${v.id}`, "A"])) }], ...extra });

function limitCases() {
  const ids30 = Array.from({ length: 30 }, (_, i) => i + 1);
  const cases = [];
  cases.push(["30 dense voices, 64 bars", full(ids30.map((id) => voiceDense(id, 32)), 64)]);
  cases.push(["30 dense voices, speed 4, turbo", full(ids30.map((id) => voiceDense(id, 32)), 3, { cpu: "turbo", speed: 4 })]);
  cases.push(["30 dense voices, speed 4, no turbo", full(ids30.map((id) => voiceDense(id, 32)), 8, { speed: 4 })]);
  cases.push(["30 simple voices, many bars", full(ids30.map((id) => ({ id, patterns: { A: { groove: ["C3", "-"] } } })), SOAK ? 4096 : 1024)]);
  cases.push(["30 simple voices, length_bars 1024 over a short timeline", full(ids30.map((id) => ({ id, patterns: { A: { groove: ["C3", "-"] } } })), 1, { length_bars: 1024 })]);
  cases.push(["one voice, 5000 note groove", { sidwave: "1.1", voices: [{ id: 1, patterns: { A: { length: 0.25, groove: Array.from({ length: 5000 }, (_, i) => noteName(36 + (i % 24))) } } }], timeline: [{ bars: 300, layers: { v1: "A" } }] }]);
  cases.push(["one voice, 100000 entry groove", { sidwave: "1.1", voices: [{ id: 1, patterns: { A: { length: 0.25, groove: Array.from({ length: 100_000 }, () => "C3") } } }], timeline: [{ bars: 4096, layers: { v1: "A" } }] }]);
  cases.push(["70 distinct instruments (limit 63)", { sidwave: "1.1", instruments: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`i${i}`, { waveform: "pulse", pulse_width: 100 + i * 10, adsr: [i % 16, 1, 2, 3] }])),
    voices: [{ id: 1, patterns: { A: { groove: Array.from({ length: 70 }, (_, i) => `C3@i${i}`) } } }], timeline: [{ bars: 20, layers: { v1: "A" } }] }]);
  const steps255 = (key) => Array.from({ length: 255 }, (_, i) => (key === "set" ? { set: 100 + i, frames: 1 } : { cutoff: i * 8 }));
  cases.push(["255 pulse and filter table steps", { sidwave: "1.1", instruments: { t: { waveform: "pulse", pulsetable: steps255("set"), filtertable: steps255("cutoff") } },
    voices: [{ id: 1, instrument: "t", patterns: { A: { groove: ["C3", "E3"] } } }], timeline: [{ bars: 4, layers: { v1: "A" } }] }]);
  cases.push(["255 wavetable steps with 255 frames each", { sidwave: "1.1", instruments: { t: { wavetable: Array.from({ length: 255 }, (_, i) => ({ wave: i % 2 ? "noise" : "pulse", note: i % 3 ? "+0" : "+12", frames: 255 })) } },
    voices: [{ id: 1, instrument: "t", patterns: { A: { groove: ["C3"] } } }], timeline: [{ bars: 1, layers: { v1: "A" } }] }]);
  const defs = (n, bytes) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`d${i}`, { b64: Buffer.alloc(bytes, (i % 15) * 17 + 1).toString("base64") }]));
  const trig = (n) => [{ sample: "d0", at_beat: Array.from({ length: n }, (_, i) => i * 0.25) }];
  cases.push(["255 sample definitions of 100 bytes", { sidwave: "1.2", samples: { rate: 4000, defs: defs(255, 100), voices: trig(10) }, voices: [], timeline: [{ bars: 4, layers: {} }] }]);
  cases.push(["255 sample definitions of 400 bytes (over memory)", { sidwave: "1.2", samples: { rate: 4000, defs: defs(255, 400), voices: trig(10) }, voices: [], timeline: [{ bars: 4, layers: {} }] }]);
  cases.push(["20000 sample triggers", { sidwave: "1.2", cpu: "turbo", samples: { rate: 2000, defs: defs(1, 10), voices: trig(20_000) }, voices: [], timeline: [{ bars: 4096, layers: {} }] }]);
  cases.push(["20001 sample triggers", { sidwave: "1.2", cpu: "turbo", samples: { rate: 2000, defs: defs(1, 10), voices: [...trig(10_000), { sample: "d0", at_beat: Array.from({ length: 10_001 }, (_, i) => 3000 + i * 0.25) }] }, voices: [], timeline: [{ bars: 4096, layers: {} }] }]);
  cases.push(["8 kHz synth samples with 16 layers", { sidwave: "1.2", cpu: "turbo", samples: { rate: 8000, defs: { z: { synth: { layers: Array.from({ length: 16 }, (_, i) => ({ osc: "saw", freq: 100 + i * 50, ms: 150 })) } } }, voices: [{ sample: "z", at: [0, 10, 20] }] }, voices: [], timeline: [{ bars: 2, layers: {} }] }]);
  const copies = Array.from({ length: 8 }, (_, i) => ({ id: 4 + i * 3, [i % 2 ? "echo" : "unison"]: i % 2 ? { voice: 1, delay: 2 + i, volume: 0.5 } : { voice: 1 } }));
  cases.push(["echo and unison copies across 9 SIDs", { sidwave: "1.2", tempo: 140, cpu: "turbo", sids: { layout: "ultisid8+sockets" }, voices: [voiceDense(1, 16), ...copies], timeline: [{ bars: 16, layers: { v1: "A" } }] }]);
  return cases;
}

test("limits: the largest valid documents compile within a time bound or refuse cleanly", { timeout: 300_000 }, () => {
  for (const [name, doc] of limitCases()) {
    const started = performance.now();
    const result = check("limits", `limit: ${name}`, doc, { loop: false, maxCalls: 400, compileBudgetMs: 20_000 });
    const elapsed = performance.now() - started;
    if (process.env.SIDWAVE_FUZZ_VERBOSE) console.info(`limit ${Math.round(elapsed)} ms ${result.outcome} ${name}`);
    bump("limits", result.outcome === "played" ? "played" : "refused");
    if (elapsed > 40_000) record("limits", `limit: ${name}`, doc, false, [{ kind: "limit-case-slow", detail: `${Math.round(elapsed)} ms` }]);
    if (result.outcome === "refused") {
      const message = String(result.error?.message);
      if (!/memory|\$D000|cycles|turbo|limit|at most|too many|maximum|up to|instrument|fit|distinct|combinations/i.test(message)) record("limits", `limit: ${name}`, doc, false, [{ kind: "limit-refusal-unclear", detail: message.slice(0, 160) }]);
    }
  }
  // Grow a song until the compiler refuses it: the last accepted PRG must end below $D000 and the refusal must be clean.
  let bars = 64;
  let lastOk = 0;
  for (let step = 0; step < 14; step++, bars *= 2) {
    const doc = full(Array.from({ length: 6 }, (_, id) => ({ id: id + 1, patterns: { A: { length: 0.5, groove: Array.from({ length: 64 }, (_, i) => noteName(36 + ((i * (id + 3)) % 30))) } } })), Math.min(bars, 4096));
    const result = check("limits", `growth: ${bars} bars`, doc, { loop: false, maxCalls: 100, compileBudgetMs: 20_000 });
    if (result.outcome === "played") lastOk = bars; else if (result.outcome === "refused") break;
    if (bars >= 4096) break;
  }
  bump("limits", "largestAcceptedBars", lastOk);
  failOnNewFindings("limits");
});

// ---------------------------------------------------------------------------
// 5. PSID round trips

test("round trip: PSID headers match the document for 1 to 3 SIDs, speeds and clocks; unsupported maps are refused", { timeout: 300_000 }, () => {
  const stop = deadline(4_000);
  const total = count(120);
  const addresses = ["$D420", "$D440", "$D480", "$D500", "$D5A0", "$D7E0", "$D460", "$D620"];
  for (let i = 0; i < total && !stop(); i++) {
    const r = prng(SEED * 1_000_003 + 700_000 + i);
    const sidCount = i % 5 === 4 ? int(r, 4, 5) : 1 + (i % 3);
    const sids = [{ id: "a", address: "$D400", ...(chance(r, 0.7) ? { model: pick(r, ["6581", "8580"]) } : {}) }];
    for (let k = 1; k < sidCount; k++) {
      let address = pick(r, addresses);
      while (sids.some((s) => s.address === address)) address = pick(r, addresses);
      sids.push({ id: `s${k}`, address, ...(chance(r, 0.7) ? { model: pick(r, ["6581", "8580"]) } : {}), ...(chance(r, 0.3) ? { volume: int(r, 0, 15) } : {}) });
    }
    if (i % 7 === 6) sids.reverse();
    const voices = sids.map((_, k) => ({ id: k * 3 + 1, waveform: pick(r, ["pulse", "sawtooth", "triangle"]), patterns: { A: { groove: [pick(r, ["C3", "E4", "G2"]), "-", "D3"] } } }));
    const doc = { sidwave: "1.2", title: pick(r, ["Round trip", "Ünï ♪ 日本 title that is longer than thirty-two chars", ""]), ...(chance(r, 0.5) ? { author: "Fuzz ä" } : {}),
      tempo: int(r, 60, 200), mode: pick(r, ["PAL", "NTSC"]), speed: int(r, 1, 4), sids, cpu: "turbo", voices, timeline: [{ bars: 1, layers: Object.fromEntries(voices.map(({ id }) => [`v${id}`, "A"])) }] };
    check("roundtrip", `psid#${i}`, doc, { loop: i % 2 === 0, maxCalls: 30 });
  }
  // A map without the primary SID at $D400 and a digi score cannot be a PSID.
  const noPrimary = { sidwave: "1.2", sids: [{ id: "a", address: "$D420" }], voices: [{ id: 1, patterns: { A: { groove: ["C3"] } } }], timeline: [{ bars: 1, layers: { v1: "A" } }] };
  const noPrimaryResult = exercise(noPrimary, { loop: false, maxCalls: 10 });
  record("roundtrip", "psid without primary SID", noPrimary, false, noPrimaryResult.faults);
  failOnNewFindings("roundtrip");
});

// Keep the parser import used by tooling that evaluates this file with a trace.
void parseSidwave;
