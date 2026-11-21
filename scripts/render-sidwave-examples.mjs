#!/usr/bin/env node
/** Render the 13 public SIDWAVE examples as matched, full-length MP3/YAML assets. */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, loadModules, writeWav } from "./lib/ultimateAudioStream.mjs";
import { resolveVice8580ModelArgs } from "./vice-sid-model.mjs";

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error("usage: node scripts/render-sidwave-examples.mjs --out-dir <directory> [--resume] [--jobs 1..4]");
  process.exit(2);
}

const argv = process.argv.slice(2);
let outDir;
let resume = false;
let worker;
let manifestOut;
let jobs = Math.max(1, Math.min(3, os.availableParallelism?.() ?? 2));
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--out-dir") outDir = argv[++i];
  else if (arg === "--resume") resume = true;
  else if (arg === "--worker") worker = argv[++i];
  else if (arg === "--manifest-out") manifestOut = argv[++i];
  else if (arg === "--jobs") jobs = Number(argv[++i]);
  else usage(`unknown argument ${arg}`);
}
if (!outDir) usage("--out-dir is required");
if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4) usage("--jobs must be an integer from 1 to 4");

const m = await loadModules(["sidwave", "sidwaveCompiler", "sidwaveExamples", "audio/sidwaveReference"]);
const examples = m.SIDWAVE_EXAMPLES.map(({ name }) => name);
if (examples.length !== 13 || new Set(examples).size !== 13) throw new Error("expected 13 unique public SIDWAVE examples");
if (worker && (!examples.includes(worker) || !manifestOut)) usage("invalid worker invocation");
const output = path.resolve(outDir);
if (!worker && !resume && fs.existsSync(output) && fs.readdirSync(output).length > 0) {
  throw new Error(`output directory is not empty: ${output}; choose an empty directory or pass --resume`);
}
fs.mkdirSync(output, { recursive: true });
const workDir = worker ? fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-example-render-")) : undefined;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const run = (bin, args, label, options = {}) => {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  return result;
};
function writeStereoWav(file, left, right, sampleRate) {
  if (left.length !== right.length) throw new Error("renderer returned mismatched stereo channel lengths");
  const pcm = new Int16Array(left.length * 2);
  for (let i = 0; i < left.length; i += 1) {
    pcm[i * 2] = Math.round(Math.max(-1, Math.min(1, left[i])) * 32767);
    pcm[i * 2 + 1] = Math.round(Math.max(-1, Math.min(1, right[i])) * 32767);
  }
  writeWav(file, pcm, sampleRate);
}
function readStereoWav(file) {
  const wav = fs.readFileSync(file);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error(`invalid WAV ${file}`);
  let pos = 12, rate, channels, bits, offset, size;
  while (pos + 8 <= wav.length) {
    const id = wav.toString("ascii", pos, pos + 4), n = wav.readUInt32LE(pos + 4);
    if (id === "fmt ") { channels = wav.readUInt16LE(pos + 10); rate = wav.readUInt32LE(pos + 12); bits = wav.readUInt16LE(pos + 22); }
    if (id === "data") { offset = pos + 8; size = Math.min(n, wav.length - offset); break; }
    pos += 8 + n + (n & 1);
  }
  if (!rate || (channels !== 1 && channels !== 2) || bits !== 16 || offset === undefined || size === undefined) {
    throw new Error(`unsupported VICE WAV format in ${file}`);
  }
  const values = size >> 1, frames = Math.floor(values / channels), left = new Float32Array(frames), right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const l = wav.readInt16LE(offset + i * channels * 2) / 32768;
    const r = channels === 2 ? wav.readInt16LE(offset + i * 4 + 2) / 32768 : l;
    left[i] = r === l ? l : (l + r) * 0.5;
    right[i] = left[i];
  }
  return { left, right, sampleRate: rate };
}
function trimLeadingDigitalSilence(signal) {
  // Trim only pre-playback audio. Require a sustained -60 dBFS onset so VICE's reset transient is not mistaken for
  // the song. Nothing after this onset is silence-trimmed; pauses and the full compiled end tail remain intact.
  const threshold = 10 ** (-60 / 20), window = Math.round(signal.sampleRate * 0.02);
  const onsetWindows = 5;
  let first = 0, consecutive = 0;
  for (let offset = 0; offset + window <= signal.left.length; offset += window) {
    let energy = 0;
    for (let i = offset; i < offset + window; i += 1) energy += signal.left[i] ** 2 + signal.right[i] ** 2;
    if (Math.sqrt(energy / (window * 2)) >= threshold) consecutive += 1;
    else consecutive = 0;
    if (consecutive === onsetWindows) { first = offset - (onsetWindows - 1) * window; break; }
  }
  if (consecutive < onsetWindows) throw new Error("VICE capture has no sustained audio onset");
  return { ...signal, left: signal.left.slice(first), right: signal.right.slice(first) };
}
function encodeMp3(wav, mp3, title, gainDb = 0) {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", wav];
  if (gainDb !== 0) args.push("-af", `volume=${gainDb}dB`);
  args.push("-codec:a", "libmp3lame", "-q:a", "2",
    "-metadata", `title=${title}`, "-metadata", "artist=c64bridge SIDWAVE example", mp3);
  run("ffmpeg", args, `encode ${path.basename(mp3)}`);
}

if (!worker) {
  const manifest = { format: "c64bridge-sidwave-render-v1", sampleRate: 48_000, songs: {} };
  const pending = [];
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  for (const name of examples) {
    const yaml = fs.readFileSync(path.join(ROOT, "data", "sound", "examples", `${name}.yaml`));
    const doc = m.parseSidwave(yaml.toString("utf8"));
    const arrangement = m.arrangeSidwave(doc);
    const expectedSeconds = arrangement.totalFrames / arrangement.fps;
    const mp3Path = path.join(output, `${name}.mp3`), yamlPath = path.join(output, `${name}.yaml`);
    if (resume && fs.existsSync(mp3Path) && fs.existsSync(yamlPath)
      && fs.readFileSync(yamlPath).equals(yaml) && fs.statSync(mp3Path).size > 0) {
      const mp3 = fs.readFileSync(mp3Path);
      manifest.songs[name] = {
        title: doc.song.title ?? name,
        engine: doc.samples ? "VICE PRG capture (CIA2 NMI samples and all configured SIDs)" : "sidplayfp per-SID PSID renders mixed with SIDWAVE pan law",
        durationSeconds: Number(expectedSeconds.toFixed(3)),
        expectedSeconds: Number(expectedSeconds.toFixed(3)),
        audioGainDb: doc.samples ? 10 : 0,
        yamlSha256: sha256(yaml),
        mp3Sha256: sha256(mp3),
      };
      console.log(`${name}: reused exact source and existing rendered pair`);
    } else pending.push(name);
  }

  const workerDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-example-workers-"));
  try {
    let index = 0, failure;
    const renderNext = async () => {
      while (!failure && index < pending.length) {
        const name = pending[index++];
        const manifestPath = path.join(workerDir, `${name}.json`);
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--out-dir", output, "--worker", name, "--manifest-out", manifestPath], { stdio: "inherit" });
        try {
          const code = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (status, signal) => status === 0 ? resolve(0) : reject(new Error(`${name} renderer exited ${signal ?? status}`)));
          });
          if (code === 0) manifest.songs[name] = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        } catch (error) { failure ??= error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, pending.length) }, renderNext));
    if (failure) throw failure;
    manifest.songs = Object.fromEntries(examples.map((name) => [name, manifest.songs[name]]));
    if (Object.values(manifest.songs).some((entry) => !entry)) throw new Error("one or more songs did not produce a manifest entry");
    fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const names = fs.readdirSync(output).sort();
    if (names.length !== 27 || examples.some((name) => !names.includes(`${name}.mp3`) || !names.includes(`${name}.yaml`))) {
      throw new Error("render output is missing one or more expected MP3/YAML pairs");
    }
  } finally {
    fs.rmSync(workerDir, { recursive: true, force: true });
  }
  process.exit(0);
}

try {
  const manifest = { format: "c64bridge-sidwave-render-v1", sampleRate: 48_000, songs: {} };
  for (const name of [worker]) {
    const yaml = fs.readFileSync(path.join(ROOT, "data", "sound", "examples", `${name}.yaml`));
    const doc = m.parseSidwave(yaml.toString("utf8"));
    const arrangement = m.arrangeSidwave(doc);
    const expectedSeconds = arrangement.totalFrames / arrangement.fps;
    const wavPath = path.join(workDir, `${name}.wav`), mp3Path = path.join(output, `${name}.mp3`);
    const yamlPath = path.join(output, `${name}.yaml`);
    if (resume && fs.existsSync(mp3Path) && fs.existsSync(yamlPath)
      && fs.readFileSync(yamlPath).equals(yaml) && fs.statSync(mp3Path).size > 0) {
      const mp3 = fs.readFileSync(mp3Path);
      manifest.songs[name] = {
        title: doc.song.title ?? name,
        engine: doc.samples ? "VICE PRG capture (CIA2 NMI samples and all configured SIDs)" : "sidplayfp per-SID PSID renders mixed with SIDWAVE pan law",
        durationSeconds: Number(expectedSeconds.toFixed(3)),
        expectedSeconds: Number(expectedSeconds.toFixed(3)),
        audioGainDb: doc.samples ? 10 : 0,
        yamlSha256: sha256(yaml),
        mp3Sha256: sha256(mp3),
      };
      console.log(`${name}: reused exact source and existing rendered pair`);
      continue;
    }
    let signal, engine;
    if (doc.samples) {
      if (doc.song.mode !== "PAL" || doc.sids.length !== 2
        || doc.sids[0]?.address !== 0xd400 || doc.sids[1]?.address !== 0xd420
        || doc.sids.some((sid) => sid.model !== "8580" || sid.pan !== "Center")) {
        throw new Error(`${name}: the VICE sample capture requires its declared PAL, D400/D420 centered 8580 layout`);
      }
      const prg = m.compileSidwaveToPrg(doc, { loop: false });
      const prgPath = path.join(workDir, `${name}.prg`), rawWav = path.join(workDir, `${name}-vice.wav`);
      fs.writeFileSync(prgPath, prg.prg);
      const cyclesPerSecond = doc.song.mode === "NTSC" ? 1_022_727 : 985_248;
      const cycles = Math.ceil((expectedSeconds + 5) * cyclesPerSecond);
      const vice = process.env.VICE ?? "x64sc";
      const headless = !process.env.DISPLAY && Boolean(process.env.CI);
      const sidModelArgs = resolveVice8580ModelArgs(vice, headless);
      const romDir = process.env.C64BRIDGE_VICE_ROM_DIR;
      if (!romDir) throw new Error("C64BRIDGE_VICE_ROM_DIR must point to the pinned open C64 ROM set");
      const romArgs = ["-basic", path.join(romDir, "basic.rom"), "-kernal", path.join(romDir, "kernal.rom"), "-chargen", path.join(romDir, "chargen.rom")];
      for (const romPath of [romArgs[1], romArgs[3], romArgs[5]]) {
        if (!fs.existsSync(romPath)) throw new Error(`VICE ROM is missing: ${romPath}`);
      }
      const viceArgs = ["-default", ...romArgs, "-pal", "-console", "-sound", "-sounddev", "alsa", "-soundarg", "null", "-soundrecdev", "wav", "-soundrecarg", rawWav,
        "-soundrate", "48000", "-soundoutput", "2", "-soundfragsize", "0", "+autostart-warp",
        "-sidextra", "1", "-sid2address", `0x${doc.sids[1].address.toString(16)}`, ...sidModelArgs,
        "-autostartprgmode", "1", "-autostart-delay", "0", "-autostart", prgPath,
        "-limitcycles", String(cycles)];
      const executable = headless ? "xvfb-run" : vice;
      const args = executable === "xvfb-run" ? ["-a", vice, ...viceArgs] : viceArgs;
      // Keep VICE stdin attached and send its noisy GTK/VICE output to a file. VICE 3.7 exits
      // before machine startup when launched with Node's captured stdin/stdout pipes.
      const viceLogPath = path.join(workDir, `${name}-vice.log`);
      const logFd = fs.openSync(viceLogPath, "w");
      let captured;
      try {
        captured = spawnSync(executable, args, { stdio: ["inherit", logFd, logFd], timeout: 10 * 60 * 1000 });
      } finally {
        fs.closeSync(logFd);
      }
      if (captured.error) throw new Error(`VICE failed: ${captured.error.message}`);
      const viceLog = fs.readFileSync(viceLogPath, "utf8").replace(/\u001b\[[0-9;]*m/g, "");
      // VICE intentionally exits with an error when -limitcycles is reached; reject any other exit or dropped audio.
      if (!/Error - cycle limit reached\./.test(viceLog)) {
        throw new Error(`VICE did not reach its requested cycle limit (status ${captured.status ?? "null"}, signal ${captured.signal ?? "none"}; ${executable} ${args.join(" ")}): ${viceLog.trim()}`);
      }
      if (!/AUTOSTART: Starting program\./.test(viceLog)) throw new Error("VICE reached the cycle limit without starting the PRG");
      if ((viceLog.match(/reSID: MOS8580/g) ?? []).length < 2) throw new Error("VICE did not confirm both configured SIDs are MOS8580");
      if (/Sound buffer overflow/i.test(viceLog)) throw new Error("VICE reported a sound buffer overflow; capture is incomplete");
      if (!fs.existsSync(rawWav)) throw new Error(`VICE produced no WAV for ${name}: ${(captured.stderr || captured.stdout).trim()}`);
      if (fs.statSync(rawWav).size <= 44) throw new Error(`VICE WAV for ${name} contains no audio samples`);
      run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", rawWav, "-ar", "48000", "-ac", "2",
        "-c:a", "pcm_s16le", wavPath], `normalize VICE WAV for ${name}`);
      signal = trimLeadingDigitalSilence(readStereoWav(wavPath));
      if (signal.sampleRate !== 48_000) throw new Error(`VICE returned unexpected sample rate ${signal.sampleRate}`);
      engine = "VICE PRG capture (CIA2 NMI samples and all configured SIDs)";
    } else {
      const rendered = m.renderReference(doc, { model: "8580", useScoreModels: true, sampleRate: 48_000, arrangement, workDir });
      if (rendered.warnings.length) throw new Error(`${name}: ${rendered.warnings.join("; ")}`);
      signal = rendered;
      engine = "sidplayfp per-SID PSID renders mixed with SIDWAVE pan law";
    }
    const expectedFrames = Math.ceil(expectedSeconds * signal.sampleRate);
    const frames = signal.left.length;
    const seconds = frames / signal.sampleRate;
    if (seconds + 0.02 < expectedSeconds) throw new Error(`${name}: rendered ${seconds.toFixed(3)} s, expected at least ${expectedSeconds.toFixed(3)} s`);
    // Keep precisely the arranged duration (including score-defined release tails), excluding emulator guard time.
    signal = { ...signal, left: signal.left.slice(0, expectedFrames), right: signal.right.slice(0, expectedFrames) };
    const outputSeconds = expectedFrames / signal.sampleRate;
    writeStereoWav(wavPath, signal.left, signal.right, signal.sampleRate);
    const audioGainDb = doc.samples ? 10 : 0;
    encodeMp3(wavPath, mp3Path, doc.song.title ?? name, audioGainDb);
    fs.copyFileSync(path.join(ROOT, "data", "sound", "examples", `${name}.yaml`), yamlPath);
    const mp3 = fs.readFileSync(mp3Path);
    manifest.songs[name] = {
      title: doc.song.title ?? name,
      engine,
      durationSeconds: Number(outputSeconds.toFixed(3)),
      expectedSeconds: Number(expectedSeconds.toFixed(3)),
      audioGainDb,
      yamlSha256: sha256(yaml),
      mp3Sha256: sha256(mp3),
    };
    console.log(`${name}: ${outputSeconds.toFixed(2)} s (${engine})`);
  }
  fs.writeFileSync(manifestOut, `${JSON.stringify(manifest.songs[worker], null, 2)}\n`);
} finally {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
}
