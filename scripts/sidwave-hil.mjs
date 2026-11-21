#!/usr/bin/env node
/**
 * Hardware-in-the-loop fidelity check for SIDWAVE: compiles a song, runs it on an Ultimate, records the UDP audio
 * stream and compares the capture with the schedule (src/audio/sidwaveFidelity.ts, doc/sidwave-hil.md).
 *
 *   node scripts/sidwave-hil.mjs --host <ip> --song <file.yaml|preset:chiptune|ambient|funk>
 *        [--seconds N] [--out dir] [--latency-ms 4000] [--pan sid1=left,sid2=right] [--model 6581|8580] [--password P] [--configure]
 *
 * Primary check: the capture is compared with a sidplayfp rendering of the same song (one render per SID, SID model
 * forced to --model, default 8580 for UltiSID) by chroma similarity and onset correlation, with controls that must fail.
 * The schedule-based note presence report is kept as a diagnostic. Exit status 1 when the primary check fails.
 *
 * --host is mandatory; there is no default device. This script touches the device: it starts the audio stream, runs a
 * PRG and stops the stream. It does not change any configuration (--configure only prints what the song needs).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadModules as loadRepoModules, recordAudioStream, writeWav } from "./lib/ultimateAudioStream.mjs";

const SAMPLE_RATE = { PAL: 47982.89, NTSC: 47983.0 };
const PITCHED_MIN = 0.9;
const PERCUSSION_MIN = 0.8;

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error("usage: node scripts/sidwave-hil.mjs --host <ip> --song <file.yaml|preset:<style>> [--seconds N] [--out dir] [--latency-ms N] [--pan sid1=left,...] [--model 6581|8580] [--replay capture.wav] [--password P] [--configure]");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { configure: false, latencyMs: 4000, out: "sidwave-hil-out" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) usage(`${a} needs a value`); return v; };
    if (a === "--host") opts.host = value();
    else if (a === "--song") opts.song = value();
    else if (a === "--seconds") opts.seconds = Number(value());
    else if (a === "--out") opts.out = value();
    else if (a === "--latency-ms") opts.latencyMs = Number(value());
    else if (a === "--pan") opts.pan = value();
    else if (a === "--replay") opts.replay = value();
    else if (a === "--model") opts.model = value();
    else if (a === "--password") opts.password = value();
    else if (a === "--configure") opts.configure = true;
    else usage(`unknown argument ${a}`);
  }
  if (!opts.host) usage("--host is required (no default device)");
  if (!opts.song) usage("--song is required");
  opts.model ??= "8580";
  if (!["6581", "8580"].includes(opts.model)) usage("--model must be 6581 or 8580");
  if (opts.seconds !== undefined && !(opts.seconds > 0)) usage("--seconds must be positive");
  return opts;
}

const MODULES = ["c64Client", "sidwave", "sidwaveCompiler", "audio/sidwaveFidelity", "audio/generateSidwave", "audio/sidwaveSimilarity", "audio/sidwaveReference"];

async function loadModules() {
  return loadRepoModules(MODULES);
}

function loadSong(spec, m) {
  if (spec.startsWith("preset:")) {
    const style = spec.slice(7);
    if (!m.MUSIC_STYLES[style]) usage(`unknown preset ${style}; use ${Object.keys(m.MUSIC_STYLES).join(", ")}`);
    return m.generateSidwave({ root: "C3", preset: "classic", style, seed: m.DEFAULT_MUSIC_SEED, system: "PAL" }).score;
  }
  return fs.readFileSync(spec, "utf8");
}

/** Owner layouts of data/ultimate/multisid.md. */
function configureHints(doc) {
  const ulti1 = [0xd400, 0xd480, 0xd500, 0xd580], ulti2 = [0xd420, 0xd4a0, 0xd520, 0xd5a0];
  const addrs = doc.sids.map((s) => s.address);
  const lines = [`SID Addressing settings needed (store "SID Addressing", Auto Address Mirroring=Disabled):`];
  const inAny = (list) => addrs.some((a) => list.includes(a));
  const parts = addrs.filter((a) => ulti1.includes(a) || ulti2.includes(a));
  const split = parts.some((a) => ![0xd400, 0xd420].includes(a)) ? "1/4 (A7,A8)" : "Off";
  if (inAny(ulti1) || inAny(ulti2)) lines.push(`  UltiSID Range Split=${split}`);
  if (inAny(ulti1)) lines.push("  UltiSID 1 Address=$D400");
  if (inAny(ulti2)) lines.push("  UltiSID 2 Address=$D420");
  lines.push(addrs.includes(0xd440) ? "  SID Socket 1 Address=$D440 (a SID chip must be fitted; SID Socket 1 enabled)" : "  SID Socket 1 Address=Unmapped");
  lines.push(addrs.includes(0xd460) ? "  SID Socket 2 Address=$D460 (a SID chip must be fitted; SID Socket 2 enabled)" : "  SID Socket 2 Address=Unmapped");
  lines.push("  Ext DualSID Range Split=Off");
  const unknown = addrs.filter((a) => !ulti1.includes(a) && !ulti2.includes(a) && a !== 0xd440 && a !== 0xd460);
  if (unknown.length) lines.push(`  Addresses outside the owner layouts: ${unknown.map((a) => "$" + a.toString(16).toUpperCase()).join(", ")}; map them by hand (see "Address rules").`);
  lines.push("For hard stereo separation set Audio Mixer Pan UltiSID 1=Left 5 and Pan UltiSID 2=Right 5, then pass --pan sidN=left|right.");
  lines.push("This script does not change device configuration.");
  return lines.join("\n");
}

function parsePan(text, count) {
  const pan = {};
  if (!text) return pan;
  for (const part of text.split(",")) {
    const m = /^sid(\d+)=(left|right|center)$/.exec(part.trim());
    if (!m || Number(m[1]) < 1 || Number(m[1]) > count) usage(`bad --pan entry ${part}`);
    pan[Number(m[1]) - 1] = m[2];
  }
  return pan;
}

const opts = parseArgs(process.argv.slice(2));
const m = await loadModules();
const doc = m.parseSidwave(loadSong(opts.song, m));

if (opts.configure) {
  console.log(configureHints(doc));
  process.exit(0);
}

const compiled = m.compileSidwaveToPrg(doc, { loop: false });
const pan = parsePan(opts.pan, doc.sids.length);
const schedule = m.expectedSchedule(doc, { pan });
const system = doc.song.mode ?? "PAL";
const sampleRate = SAMPLE_RATE[system];
const seconds = opts.seconds ?? schedule.durationSeconds + 2 + opts.latencyMs / 1000;
const base = `http://${opts.host}`;
const headers = { ...(opts.password ?? process.env.C64U_PASSWORD ? { "X-Password": opts.password ?? process.env.C64U_PASSWORD } : {}) };

fs.mkdirSync(opts.out, { recursive: true });
console.log(`song ${doc.song.title}: ${schedule.notes.length} pitched notes, ${schedule.percussion.length} percussion onsets, ${schedule.durationSeconds.toFixed(1)} s; recording ${seconds.toFixed(1)} s from ${opts.host}`);
// --replay re-analyses an earlier capture.wav (16-bit stereo) and does not contact the device.
let pcm;
if (opts.replay) {
  const w = m.readWav(opts.replay);
  if (w.channels !== 2) usage("--replay needs a stereo WAV");
  pcm = Int16Array.from(w.samples, (v) => Math.round(v * 32768));
} else {
  const client = new m.C64Client(base, { networkPassword: headers["X-Password"] });
  ({ pcm } = await recordAudioStream({ base, headers, seconds, sampleRate, startSong: async () => {
    const playback = await client.playSidwave(doc, compiled);
    if (!playback.success) throw new Error("The Ultimate could not start the SIDWAVE PRG");
  } }));
  writeWav(path.join(opts.out, "capture.wav"), pcm, sampleRate);
}
const report = m.analyse(pcm, sampleRate, schedule, { latencySearchMs: opts.latencyMs });
const verdict = { pitchedOk: report.pitched.rate >= PITCHED_MIN, percussionOk: report.percussion.rate >= PERCUSSION_MIN };

// Primary check: reference rendering with sidplayfp, one SID at a time.
const toFloat = (pcm16) => {
  const n = pcm16.length >> 1, left = new Float32Array(n), right = new Float32Array(n);
  for (let i = 0; i < n; i += 1) { left[i] = pcm16[2 * i] / 32768; right[i] = pcm16[2 * i + 1] / 32768; }
  return { left, right, sampleRate };
};
const toInt16 = (l, r) => { const out = new Int16Array(l.length * 2); for (let i = 0; i < l.length; i += 1) { out[2 * i] = Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767))); out[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767))); } return out; };
let similarity = null, similarityError = null, referenceWarnings = [];
try {
  const reference = m.renderReference(doc, { model: opts.model, pan, sampleRate: 48000, workDir: opts.out });
  referenceWarnings = reference.warnings;
  for (const warning of referenceWarnings) console.error(warning);
  writeWav(path.join(opts.out, "reference.wav"), toInt16(reference.left, reference.right), reference.sampleRate);
  const capture = toFloat(pcm);
  similarity = m.compareToReference(reference, capture, { latencySearchMs: opts.latencyMs, halfBarSeconds: (schedule.bars[1] - schedule.bars[0]) / 2 });
  writeSpectrograms(opts.out, reference, capture, similarity.offsetMs / 1000);
} catch (error) {
  similarityError = error instanceof Error ? error.message : String(error);
  console.error(`reference comparison failed: ${similarityError}`);
}

/** reference.wav, aligned capture and their difference as three stacked spectrograms (ffmpeg showspectrumpic). */
function writeSpectrograms(dir, reference, capture, offsetS) {
  const n = reference.left.length, start = Math.round(offsetS * capture.sampleRate);
  const rmsOf = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length)) || 1;
  const refMono = reference.left.map((v, i) => (v + reference.right[i]) / 2);
  const capMono = new Float32Array(n).map((_, i) => ((capture.left[start + i] ?? 0) + (capture.right[start + i] ?? 0)) / 2);
  const rr = rmsOf(refMono), rc = rmsOf(capMono);
  const diff = refMono.map((v, i) => v / rr - capMono[i] / rc);
  const files = [["reference", refMono], ["capture_aligned", capMono], ["difference", diff]].map(([name, data]) => {
    const wav = path.join(dir, `${name}.mono.wav`);
    const quiet = data.map((v) => v * 0.25);
    writeWav(wav, toInt16(quiet, quiet), reference.sampleRate);
    return wav;
  });
  const png = path.join(dir, "spectrograms.png");
  const args = ["-y", "-v", "error", ...files.flatMap((f) => ["-i", f]), "-filter_complex",
    "[0:a]showspectrumpic=s=1400x300:legend=0[a];[1:a]showspectrumpic=s=1400x300:legend=0[b];[2:a]showspectrumpic=s=1400x300:legend=0[c];[a][b][c]vstack=inputs=3", "-frames:v", "1", png];
  const run = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (run.status !== 0) console.error(`warning: spectrogram PNG not written (${run.error?.message ?? run.stderr})`);
  for (const f of files) fs.rmSync(f, { force: true });
}

const primaryOk = similarity?.verdict.pass === true;
fs.writeFileSync(path.join(opts.out, "report.json"), JSON.stringify({
  song: opts.song, host: opts.host, sampleRate, model: opts.model, pass: primaryOk,
  similarity, similarityError, referenceWarnings,
  diagnostic: { note: "schedule-based note presence; sensitive to SID model and filter, not used for the exit status", thresholds: { pitched: PITCHED_MIN, percussion: PERCUSSION_MIN }, verdict, ...report },
}, null, 2));
if (similarity) {
  const s = similarity;
  console.log(`offset ${s.offsetMs.toFixed(1)} ms (first third ${s.alignment.firstThirdOffsetMs.toFixed(1)}, last third ${s.alignment.lastThirdOffsetMs.toFixed(1)}, drift ${s.alignment.driftMs.toFixed(1)} ms)`);
  const row = (name, x) => console.log(`${name.padEnd(22)} chroma median ${x.chromaMedian.toFixed(3)}  frames>0.7 ${(x.chromaAbove07 * 100).toFixed(0)} %  onset corr ${x.onset.toFixed(3)}`);
  row("capture vs reference", s.real);
  row("control: +1 semitone", s.controls.transposedSemitone);
  row("control: half-bar shift", s.controls.shiftedHalfBar);
  console.log(`thresholds: chroma >= ${s.thresholds.chromaMedian}, onset >= ${s.thresholds.onset}, margin ${s.thresholds.controlMargin} over controls${s.balance.applicable ? `, balance error <= ${s.thresholds.balanceError} (measured ${s.balance.meanAbsError.toFixed(3)})` : ""}`);
}
console.log(`diagnostic: pitched ${report.pitched.present}/${report.pitched.expected} (${(report.pitched.rate * 100).toFixed(1)} %), percussion ${report.percussion.present}/${report.percussion.expected} (${(report.percussion.rate * 100).toFixed(1)} %)`);
console.log(`${primaryOk ? "PASS" : "FAIL"}; report in ${path.join(opts.out, "report.json")}`);
process.exit(primaryOk ? 0 : 1);
