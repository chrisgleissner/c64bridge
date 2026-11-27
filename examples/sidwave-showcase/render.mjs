#!/usr/bin/env node
// Renders the audio clips of the showcase: `node examples/sidwave-showcase/render.mjs`.
//
//   tunes        the five songs of pulse_guard.yaml, rendered by `sidwave render` (reSIDfp)
//   conversions  harbour_lights.mid and tin_robot.mod: "before" (the source file) and "after" (converted to a
//                SID file with `sidwave convert`, then rendered)
//
// Every clip is normalised to -16 LUFS with a true peak below -1.5 dBTP and written as WAV and MP3 to
// <showcase directory>/clips/, with the measurements in measurements.json and measurements.md.
// The MIDI "before" clip uses the small synthesiser of lib/preview-synth.mjs, so that no third-party sound font
// is involved; the MOD "before" clip is decoded by ffmpeg (libopenmpt).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PEAK_CEILING_DBTP, TARGET_LUFS, ffmpeg, measure, normaliseFilter, readWav, writeWav } from "./lib/audio.mjs";
import { renderMidi } from "./lib/preview-synth.mjs";
import { showcaseDir, sidwaveCli } from "./lib/sidwave.mjs";

const root = process.env.SHOWCASE_DIR ?? path.join(os.homedir(), ".c64bridge", "sidwave-standalone", "showcase");
const clips = path.join(root, "clips");
const work = path.join(root, "work");
fs.mkdirSync(clips, { recursive: true });
fs.mkdirSync(work, { recursive: true });
const source = (name) => path.join(showcaseDir, name);
const results = [];

/** Normalises `input`, writes clips/<name>.wav and .mp3 and records the measurements of both. */
function clip(name, input, description, { fade = 0 } = {}) {
  const seconds = (({ samples, rate, channels }) => samples.length / rate / channels)(readWav(input));
  const extra = fade ? [`afade=t=out:st=${(seconds - fade).toFixed(3)}:d=${fade}`] : [];
  const { filter, gainDb, limitedDb } = normaliseFilter(input, { extra });
  const wav = path.join(clips, `${name}.wav`);
  const mp3 = path.join(clips, `${name}.mp3`);
  ffmpeg(["-i", input, "-af", filter, "-ar", "44100", "-c:a", "pcm_s16le", wav]);
  ffmpeg(["-i", wav, "-c:a", "libmp3lame", "-b:a", "192k", "-metadata", `title=${description}`, mp3]);
  const full = readWav(wav).samples.reduce((n, s) => n + (Math.abs(s) >= 32767 ? 1 : 0), 0);
  const row = { name, description, seconds: Number(seconds.toFixed(1)), gainDb, limitedDb, clippedSamples: full, wav: measure(wav), mp3: measure(mp3) };
  results.push(row);
  console.log(`${name}: ${row.seconds} s, ${row.wav.lufs} LUFS, true peak ${row.wav.truePeak} dBTP (MP3 ${row.mp3.truePeak}), ${full} clipped samples${limitedDb ? `, peaks limited by ${limitedDb} dB` : ""}`);
}

// Each looping song: one full pass plus the start of the loop, then a fade.
const songs = [
  { song: 0, name: "tune1-deep-field", title: "Deep Field (title, atmospheric)", seconds: 77, fade: 4 },
  { song: 1, name: "tune2-pulse-guard", title: "Pulse Guard (in game, driving)", seconds: 71, fade: 4 },
  { song: 2, name: "tune3-iron-moth", title: "Iron Moth (boss fight, 7/8)", seconds: 51, fade: 3 },
  { song: 3, name: "jingle-clear", title: "Wave cleared", seconds: 6, fade: 0.4 },
  { song: 4, name: "jingle-game-over", title: "Game over", seconds: 12, fade: 0.5 },
];
for (const { song, name, title, seconds, fade } of songs) {
  const raw = path.join(work, `${name}.wav`);
  sidwaveCli(["render", source("pulse_guard.yaml"), "--song", String(song + 1), "--seconds", String(seconds), "-o", raw]);
  clip(name, raw, `Pulse Guard soundtrack: ${title}`, { fade });
}

const conversions = [
  { file: "harbour_lights.mid", name: "convert-midi", title: "Harbour Lights", seconds: 40 },
  { file: "tin_robot.mod", name: "convert-mod", title: "Tin Robot", seconds: 39 },
];
const losses = [];
for (const { file, name, title, seconds } of conversions) {
  const input = source(path.join("convert", file));
  const before = path.join(work, `${name}-before.wav`);
  if (file.endsWith(".mid")) writeWav(before, renderMidi(fs.readFileSync(input), { seconds }));
  else ffmpeg(["-i", input, "-t", String(seconds), "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", before]);
  const sid = path.join(clips, `${name}.sid`);
  const report = path.join(clips, `${name}-loss-report.txt`);
  const text = sidwaveCli(["convert", input, sid, "--keep-score", path.join(clips, `${name}.sidwave.yaml`), "--force"]);
  fs.writeFileSync(report, text.replaceAll(showcaseDir, "examples/sidwave-showcase").replaceAll(clips, "clips"));
  losses.push({ name, report: text });
  const after = path.join(work, `${name}-after.wav`);
  sidwaveCli(["render", sid, "--seconds", String(seconds), "-o", after]);
  clip(`${name}-1-before`, before, `${title}: the source ${path.extname(file).slice(1).toUpperCase()} file`, { fade: 2 });
  clip(`${name}-2-after`, after, `${title}: converted to SID by sidwave convert`, { fade: 2 });
  // One file for listening: the first 16 seconds of each side, one after the other.
  const pair = path.join(clips, `${name}-before-then-after.mp3`);
  ffmpeg(["-i", path.join(clips, `${name}-1-before.wav`), "-i", path.join(clips, `${name}-2-after.wav`), "-filter_complex",
    "[0:a]atrim=0:16,afade=t=out:st=15.4:d=0.6,apad=pad_dur=0.8[a];[1:a]atrim=0:16,afade=t=out:st=15.4:d=0.6[b];[a][b]concat=n=2:v=0:a=1", "-c:a", "libmp3lame", "-b:a", "192k", pair]);
}

fs.writeFileSync(path.join(clips, "measurements.json"), `${JSON.stringify({ target: { lufs: TARGET_LUFS, truePeakDbtp: PEAK_CEILING_DBTP }, clips: results }, null, 2)}\n`);
fs.writeFileSync(path.join(clips, "measurements.md"), [
  `Target: ${TARGET_LUFS} LUFS integrated, true peak at most ${PEAK_CEILING_DBTP} dBTP (EBU R 128, measured with ffmpeg ebur128).`,
  "",
  "| Clip | Seconds | LUFS | True peak WAV (dBTP) | True peak MP3 (dBTP) | Peaks limited by (dB) | Clipped samples |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...results.map((r) => `| ${r.name} | ${r.seconds} | ${r.wav.lufs} | ${r.wav.truePeak} | ${r.mp3.truePeak} | ${r.limitedDb} | ${r.clippedSamples} |`),
  "",
].join("\n"));
console.log(`clips: ${clips}`);
const bad = results.filter((r) => r.clippedSamples > 0 || r.wav.truePeak > -1 || r.mp3.truePeak > -0.3 || Math.abs(r.wav.lufs - TARGET_LUFS) > 1.5);
if (bad.length) {
  console.error(`outside the limits: ${bad.map((r) => r.name).join(", ")}`);
  process.exitCode = 1;
}
