#!/usr/bin/env node
/**
 * Records a SIDWAVE song from an Ultimate's audio stream to a WAV file, and optionally encodes an MP3 with ffmpeg.
 * The example recordings attached to the c64bridge releases are made with this script (doc/sidwave-recordings.md).
 *
 *   node scripts/sidwave-record.mjs --host <ip> --song <example name|file.yaml> --wav <out.wav>
 *        [--mp3 <out.mp3>] [--tail-seconds 6] [--password P] [--no-configure]
 *
 * The song is compiled from the checked-out sources (src/, never dist/) to play once. The script prints the SHA-256
 * of the PRG so that a recording can be tied to the exact player and score bytes.
 *
 * The script touches the device: with configure (the default) it sets the SID addressing, mixer and turbo settings
 * the song needs in RAM, starts the audio stream, starts the song without a reset, and afterwards stops the player
 * and restores the previous settings. It never saves settings to flash. --host is mandatory; there is no default.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadModules, recordAudioStream, writeWav } from "./lib/ultimateAudioStream.mjs";

/** ffmpeg arguments for the MP3: trim the silence before the song and after its last release, then LAME VBR -V2. */
const MP3_FILTER = "silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.2,"
  + "areverse,silenceremove=start_periods=1:start_threshold=-70dB:start_silence=0.5,areverse";

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error("usage: node scripts/sidwave-record.mjs --host <ip> --song <example name|file.yaml> --wav <out.wav> [--mp3 <out.mp3>] [--tail-seconds N] [--password P] [--no-configure]");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { configure: true, tailSeconds: 6 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) usage(`${a} needs a value`); return v; };
    if (a === "--host") opts.host = value();
    else if (a === "--song") opts.song = value();
    else if (a === "--wav") opts.wav = value();
    else if (a === "--mp3") opts.mp3 = value();
    else if (a === "--tail-seconds") opts.tailSeconds = Number(value());
    else if (a === "--password") opts.password = value();
    else if (a === "--no-configure") opts.configure = false;
    else usage(`unknown argument ${a}`);
  }
  if (!opts.host) usage("--host is required (no default device)");
  if (!opts.song) usage("--song is required");
  if (!opts.wav) usage("--wav is required");
  if (!(opts.tailSeconds >= 0)) usage("--tail-seconds must be 0 or more");
  return opts;
}

/** An example name such as acid_line reads data/sound/examples/acid_line.yaml; anything else is a file path. */
function songFile(spec) {
  const example = path.join(ROOT, "data", "sound", "examples", `${spec}.yaml`);
  if (/^[a-z0-9_]+$/.test(spec) && fs.existsSync(example)) return example;
  if (!fs.existsSync(spec)) usage(`${spec} is neither an example name nor a file`);
  return spec;
}

function encodeMp3(wav, mp3, title, version) {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-af", MP3_FILTER,
    "-codec:a", "libmp3lame", "-q:a", "2",
    "-metadata", `title=${title}`, "-metadata", "artist=c64bridge SIDWAVE example",
    "-metadata", `album=c64bridge ${version}`, mp3];
  const run = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (run.error) throw new Error(`ffmpeg could not be started (${run.error.message}); install ffmpeg or omit --mp3`);
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr.trim()}`);
}

const opts = parseArgs(process.argv.slice(2));
const file = songFile(opts.song);
const name = path.basename(file).replace(/\.ya?ml$/i, "");
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const m = await loadModules(["c64Client", "sidwave", "sidwaveCompiler", "streamCapture"], { preferDist: false });
const doc = m.parseSidwave(fs.readFileSync(file, "utf8"));
const compiled = m.compileSidwaveToPrg(doc, { loop: false });
const system = doc.song.mode ?? "PAL";
const sampleRate = system === "NTSC" ? m.C64U_NTSC_AUDIO_SAMPLE_RATE : m.C64U_PAL_AUDIO_SAMPLE_RATE;
const seconds = compiled.durationSeconds + opts.tailSeconds;
const sha = createHash("sha256").update(compiled.prg).digest("hex");
console.log(`song ${name}: "${doc.song.title ?? name}", ${doc.sids.length} SID(s), ${compiled.durationSeconds.toFixed(2)} s, ${system}`);
console.log(`prg ${compiled.prg.length} bytes, sha256 ${sha}`);

const base = `http://${opts.host}`;
const password = opts.password ?? process.env.C64U_PASSWORD;
const headers = password ? { "X-Password": password } : {};
const client = new m.C64Client(base, { networkPassword: password });
let launch;
let recording;
try {
  recording = await recordAudioStream({
    base, headers, seconds, sampleRate, fromSongStart: true,
    startSong: async () => {
      const result = await client.playSidwave(doc, compiled, { configure: opts.configure });
      if (!result.success) throw new Error(`The Ultimate could not start the song: ${JSON.stringify(result.details)}`);
      launch = result.details?.launch ?? "run";
    },
  });
} finally {
  // Stops the player and restores the settings that configure changed.
  await client.stopSidwavePlayback().catch((e) => console.error(`warning: stopping playback failed: ${e.message}`));
}
fs.mkdirSync(path.dirname(path.resolve(opts.wav)), { recursive: true });
writeWav(opts.wav, recording.pcm, sampleRate);
console.log(`launch ${launch}; wrote ${opts.wav} (${(recording.pcm.length / 2 / sampleRate).toFixed(2)} s)`);
if (recording.lostPackets > 0) {
  console.error(`warning: ${recording.lostPackets} stream packets were lost and replaced by silence; record again for a clean take`);
}
if (opts.mp3) {
  fs.mkdirSync(path.dirname(path.resolve(opts.mp3)), { recursive: true });
  encodeMp3(opts.wav, opts.mp3, name, version);
  console.log(`wrote ${opts.mp3}`);
}
process.exit(recording.lostPackets > 0 ? 3 : 0);
