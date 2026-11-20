#!/usr/bin/env node
/**
 * Objective quality gate for a SIDWAVE rendering or capture (src/audio/sidwaveQuality.ts, doc/sidwave-hil.md).
 *
 *   node scripts/sidwave-review.mjs --wav <file.wav> [--song <file.yaml|preset:<style>>] [--offset-ms N] [--out report.json]
 *
 * With --song the score is used for scheduled onsets, bars and sections. The song start in the WAV is found by comparing
 * with a sidplayfp rendering unless --offset-ms is given. Offline: no device is contacted. Exit 1 on a FAIL verdict.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULES = ["sidwave", "sidwaveCompiler", "audio/sidwaveFidelity", "audio/generateSidwave", "audio/sidwaveSimilarity", "audio/sidwaveReference", "audio/sidwaveQuality"];

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error("usage: node scripts/sidwave-review.mjs --wav <file.wav> [--song <file.yaml|preset:<style>>] [--offset-ms N] [--model 6581|8580] [--out report.json]");
  process.exit(2);
}

const opts = { model: "8580" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i], value = () => argv[++i] ?? usage(`${a} needs a value`);
  if (a === "--wav") opts.wav = value(); else if (a === "--song") opts.song = value(); else if (a === "--offset-ms") opts.offsetMs = Number(value());
  else if (a === "--model") opts.model = value(); else if (a === "--out") opts.out = value(); else usage(`unknown argument ${a}`);
}
if (!opts.wav) usage("--wav is required");

if (!globalThis.Bun) { const { register } = await import("tsx/esm/api"); register(); }
const m = Object.assign({}, ...(await Promise.all(MODULES.map((x) => import(pathToFileURL(path.join(root, "src", `${x}.ts`)).href)))));

const w = m.readWav(opts.wav);
const n = w.channels === 2 ? w.samples.length >> 1 : w.samples.length;
const left = new Float32Array(n), right = new Float32Array(n);
for (let i = 0; i < n; i += 1) { left[i] = w.channels === 2 ? w.samples[2 * i] : w.samples[i]; right[i] = w.channels === 2 ? w.samples[2 * i + 1] : w.samples[i]; }
const signal = { left, right, sampleRate: w.sampleRate };

let doc, schedule, offsetSeconds = (opts.offsetMs ?? 0) / 1000;
if (opts.song) {
  let source;
  if (opts.song.startsWith("preset:")) {
    const style = opts.song.slice(7);
    if (!m.MUSIC_STYLES[style]) usage(`unknown preset ${style}`);
    source = m.generateSidwave({ root: "C3", preset: "classic", style, seed: m.DEFAULT_MUSIC_SEED, system: "PAL" }).score;
  } else source = fs.readFileSync(opts.song, "utf8");
  doc = m.parseSidwave(source);
  schedule = m.expectedSchedule(doc);
  if (opts.offsetMs === undefined) {
    const reference = m.renderReference(doc, { model: opts.model, sampleRate: 48000 });
    const cmp = m.compareToReference(reference, signal, { latencySearchMs: 4000, halfBarSeconds: 120 / doc.song.tempo });
    offsetSeconds = cmp.offsetMs / 1000;
    console.error(`song start found at ${cmp.offsetMs.toFixed(0)} ms (chroma ${cmp.real.chromaMedian.toFixed(2)} against the reference)`);
  }
}

const report = m.analyseQuality({ signal, schedule, doc, offsetSeconds });
console.log(m.formatQuality(report));
if (opts.out) fs.writeFileSync(opts.out, JSON.stringify({ wav: opts.wav, song: opts.song, offsetSeconds, ...report }, null, 2));
process.exit(report.verdict === "FAIL" ? 1 : 0);
