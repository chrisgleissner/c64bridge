#!/usr/bin/env node
/**
 * Hardware-in-the-loop fidelity check for SIDWAVE: compiles a song, runs it on an Ultimate, records the UDP audio
 * stream and compares the capture with the schedule (src/audio/sidwaveFidelity.ts, doc/sidwave-hil.md).
 *
 *   node scripts/sidwave-hil.mjs --host <ip> --song <file.yaml|preset:chiptune|ambient|funk>
 *        [--seconds N] [--out dir] [--latency-ms 1500] [--pan sid1=left,sid2=right] [--password P] [--configure]
 *
 * --host is mandatory; there is no default device. This script touches the device: it starts the audio stream, runs a
 * PRG and stops the stream. It does not change any configuration (--configure only prints what the song needs).
 */
import dgram from "node:dgram";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE_RATE = { PAL: 47982.89, NTSC: 47983.0 };
const PITCHED_MIN = 0.9;
const PERCUSSION_MIN = 0.8;

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error("usage: node scripts/sidwave-hil.mjs --host <ip> --song <file.yaml|preset:<style>> [--seconds N] [--out dir] [--latency-ms N] [--pan sid1=left,...] [--password P] [--configure]");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { configure: false, latencyMs: 1500, out: "sidwave-hil-out" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) usage(`${a} needs a value`); return v; };
    if (a === "--host") opts.host = value();
    else if (a === "--song") opts.song = value();
    else if (a === "--seconds") opts.seconds = Number(value());
    else if (a === "--out") opts.out = value();
    else if (a === "--latency-ms") opts.latencyMs = Number(value());
    else if (a === "--pan") opts.pan = value();
    else if (a === "--password") opts.password = value();
    else if (a === "--configure") opts.configure = true;
    else usage(`unknown argument ${a}`);
  }
  if (!opts.host) usage("--host is required (no default device)");
  if (!opts.song) usage("--song is required");
  if (opts.seconds !== undefined && !(opts.seconds > 0)) usage("--seconds must be positive");
  return opts;
}

async function loadModules() {
  const dist = path.join(root, "dist", "src");
  if (fs.existsSync(path.join(dist, "sidwaveCompiler.js"))) {
    const [sw, comp, fid, gen] = await Promise.all(["sidwave", "sidwaveCompiler", "audio/sidwaveFidelity", "audio/generateSidwave"]
      .map((m) => import(pathToFileURL(path.join(dist, `${m}.js`)).href)));
    return { ...sw, ...comp, ...fid, ...gen };
  }
  if (!globalThis.Bun) {
    const { register } = await import("tsx/esm/api");
    register();
  }
  const src = (m) => import(pathToFileURL(path.join(root, "src", `${m}.ts`)).href);
  const [sw, comp, fid, gen] = await Promise.all([src("sidwave"), src("sidwaveCompiler"), src("audio/sidwaveFidelity"), src("audio/generateSidwave")]);
  return { ...sw, ...comp, ...fid, ...gen };
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

function writeWav(file, pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length * 2, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(Math.round(sampleRate), 24); header.writeUInt32LE(Math.round(sampleRate) * 4, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length * 2, 40);
  fs.writeFileSync(file, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]));
}

/** Local address the OS would use to reach the device (connect on a UDP socket sends nothing). */
function localAddressFor(host) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    s.once("error", reject);
    s.connect(80, host, () => { const { address } = s.address(); s.close(); resolve(address); });
  });
}

async function rest(base, headers, method, route, body) {
  const res = await fetch(`${base}${route}`, { method, headers: { ...headers, ...(body ? { "Content-Type": "application/octet-stream" } : {}) }, body });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || (json?.errors?.length ?? 0) > 0) throw new Error(`${method} ${route} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  return json;
}

async function record(host, base, headers, seconds, sampleRate, startSong) {
  const local = await localAddressFor(new URL(base).hostname);
  const socket = dgram.createSocket("udp4");
  await new Promise((res, rej) => { socket.once("error", rej); socket.bind(0, "0.0.0.0", res); });
  const port = socket.address().port;
  const wanted = Math.ceil(seconds * sampleRate) * 2;
  const chunks = []; let values = 0; let lastSeq = null; let first = false;
  let onFirst; const firstSeen = new Promise((r) => { onFirst = r; });
  let done; const finished = new Promise((r) => { done = r; });
  socket.on("message", (msg) => {
    if (msg.length < 2) return;
    const seq = msg.readUInt16LE(0);
    if (lastSeq !== null) {
      const gap = ((seq - lastSeq - 1) & 0xffff);
      if (gap > 0 && gap < 1000) { const z = new Int16Array(gap * 384); chunks.push(z); values += z.length; }
    }
    lastSeq = seq;
    const n = (msg.length - 2) >> 1;
    const s = new Int16Array(n);
    for (let i = 0; i < n; i += 1) s[i] = msg.readInt16LE(2 + 2 * i);
    chunks.push(s); values += n;
    if (!first) { first = true; onFirst(); }
    if (values >= wanted) done();
  });
  let started = false;
  try {
    await rest(base, headers, "PUT", `/v1/streams/audio:start?ip=${encodeURIComponent(`${local}:${port}`)}`);
    started = true;
    const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms));
    await Promise.race([firstSeen, timeout(5000, "no audio datagram within 5 s; check that UDP from the device reaches this host")]);
    await startSong();
    await Promise.race([finished, timeout((seconds + 5) * 1000, "capture timed out")]);
  } finally {
    socket.close();
    if (started) await rest(base, headers, "PUT", "/v1/streams/audio:stop").catch((e) => console.error(`warning: ${e.message}`));
  }
  const all = new Int16Array(Math.min(values, wanted));
  let o = 0;
  for (const c of chunks) { const k = Math.min(c.length, all.length - o); if (k <= 0) break; all.set(c.subarray(0, k), o); o += k; }
  return all;
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
const pcm = await record(opts.host, base, headers, seconds, sampleRate, async () => {
  await rest(base, headers, "POST", "/v1/runners:run_prg", compiled.prg);
});

writeWav(path.join(opts.out, "capture.wav"), pcm, sampleRate);
const report = m.analyse(pcm, sampleRate, schedule, { latencySearchMs: opts.latencyMs });
const verdict = { pitchedOk: report.pitched.rate >= PITCHED_MIN, percussionOk: report.percussion.rate >= PERCUSSION_MIN };
fs.writeFileSync(path.join(opts.out, "report.json"), JSON.stringify({ song: opts.song, host: opts.host, sampleRate, thresholds: { pitched: PITCHED_MIN, percussion: PERCUSSION_MIN }, verdict, ...report }, null, 2));
console.log(`offset ${report.offsetMs.toFixed(1)} ms (confidence ${report.offsetConfidence.toFixed(2)})`);
console.log(`pitched ${report.pitched.present}/${report.pitched.expected} (${(report.pitched.rate * 100).toFixed(1)} %), unjudged ${report.unjudged.unresolved} unresolved, ${report.unjudged.outsideCapture} outside capture`);
console.log(`percussion ${report.percussion.present}/${report.percussion.expected} (${(report.percussion.rate * 100).toFixed(1)} %)`);
console.log(`rms L ${report.rms.left.toFixed(4)} R ${report.rms.right.toFixed(4)}; report in ${path.join(opts.out, "report.json")}`);
process.exit(verdict.pitchedOk && verdict.percussionOk ? 0 : 1);
