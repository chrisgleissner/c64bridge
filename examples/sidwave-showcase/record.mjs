#!/usr/bin/env node
// Records the showcase video: `node examples/sidwave-showcase/record.mjs`.
//
// VICE runs headless; the script plays the game through the joystick, takes every frame from the emulator over
// the binary monitor and lets VICE record its own sound to a WAV file, so picture and sound come from the same
// emulation and stay in step. The finished video is cut from that session (title, first wave, boss, wave clear),
// scaled to 1920 x 1080 without filtering, with the sound normalised to -16 LUFS.
//
// Output: <output directory>/video/pulse_guard.mp4. Needs x64sc, Xvfb and ffmpeg.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildGame } from "./build.mjs";
import { ffmpeg, measure, normaliseFilter, onset, readWav, writeWav } from "./lib/audio.mjs";
import { playSession } from "./lib/session.mjs";
import { outputDir as root } from "./lib/sidwave.mjs";
import { FPS } from "./lib/vice.mjs";

const out = path.join(root, "video");
const work = path.join(root, "work");
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(work, { recursive: true });
const FRAMES = Number(process.env.FRAMES ?? 4300);

const game = await buildGame();
const raw = path.join(work, "session.mkv");
const wav = path.join(work, "session.wav");
let encoder;
let finished;
const session = await playSession(game, {
  frames: FRAMES,
  wav,
  titleFrames: 340,
  carelessAfterWave2: 100000, // the video ends before the ship needs to be destroyed
  logFile: path.join(work, "vice-video.log"),
  onFrame: async ({ monitor, palette }) => {
    const picture = await monitor.picture(palette);
    if (!encoder) {
      encoder = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${picture.width}x${picture.height}`, "-r", String(FPS), "-i", "-",
        "-c:v", "libx264", "-preset", "veryfast", "-qp", "0", "-pix_fmt", "yuv444p", raw], { stdio: ["pipe", "inherit", "inherit"] });
      finished = new Promise((resolve, reject) => encoder.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ended with ${code}`)))));
    }
    if (!encoder.stdin.write(picture.rgb)) await new Promise((resolve) => encoder.stdin.once("drain", resolve));
  },
});
encoder.stdin.end();
await finished;

// The cuts, in frames of the session, from the recorded state changes.
const first = (state) => session.transitions.find((t) => t.state === state)?.frame;
const [play, warn, boss, dies, clear] = ["play", "warn", "boss", "bossDies", "clear"].map(first);
if ([play, warn, boss, dies, clear].includes(undefined)) throw new Error(`the session did not reach the end of the first wave: ${JSON.stringify(session.transitions)}`);
const nextWave = session.transitions.find((t) => t.state === "play" && t.frame > clear)?.frame;
const s = (seconds) => Math.round(seconds * FPS);
const cuts = [
  [0, play + s(19)], // title, then the start of the first wave
  [warn - s(5), boss + s(Math.min(14, (dies - boss) / FPS))], // end of the wave, warning, boss
];
if (dies - s(3) > cuts[1][1]) cuts.push([dies - s(3), (nextWave ?? clear) + s(4)]);
else cuts[1][1] = (nextWave ?? clear) + s(4);
for (const cut of cuts) cut[1] = Math.min(cut[1], session.frames);

const sound = readWav(wav);
const start = onset(sound) ?? 0; // the first note of the title song starts with the first frame
const fade = 0.12;
const parts = cuts.map(([from, to]) => {
  const a = Math.round((start + from / FPS) * sound.rate);
  const samples = Int16Array.from({ length: Math.round(((to - from) / FPS) * sound.rate) }, (_, i) => sound.samples[a + i] ?? 0);
  const ramp = Math.round(fade * sound.rate);
  for (let i = 0; i < ramp; i += 1) {
    samples[i] = Math.round((samples[i] * i) / ramp);
    samples[samples.length - 1 - i] = Math.round((samples[samples.length - 1 - i] * i) / ramp);
  }
  return samples;
});
const joined = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
parts.reduce((at, p) => (joined.set(p, at), at + p.length), 0);
const cutWav = path.join(work, "video-sound.wav");
writeWav(cutWav, { rate: sound.rate, channels: 1, samples: joined });
const total = joined.length / sound.rate;
const { filter } = normaliseFilter(cutWav, { extra: [`afade=t=out:st=${(total - 1.5).toFixed(2)}:d=1.5`] });

const video = path.join(out, "pulse_guard.mp4");
const segments = cuts.map(([from, to], i) => `[0:v]trim=start_frame=${from}:end_frame=${to},setpts=PTS-STARTPTS[v${i}]`);
const chain = `${segments.join(";")};${cuts.map((_, i) => `[v${i}]`).join("")}concat=n=${cuts.length}:v=1:a=0,scale=iw*4:ih*4:flags=neighbor,crop=iw:1080,pad=1920:1080:(ow-iw)/2:0:black,fade=t=out:st=${(total - 1).toFixed(2)}:d=1,format=yuv420p[v];[1:a]${filter}[a]`;
ffmpeg(["-i", raw, "-i", cutWav, "-filter_complex", chain, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-r", "50", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", "-movflags", "+faststart", video]);

const loudness = measure(video);
const report = { video, seconds: Number(total.toFixed(1)), cuts: cuts.map(([a, b]) => [Number((a / FPS).toFixed(1)), Number((b / FPS).toFixed(1))]), audio: loudness, audioOffsetSeconds: Number(start.toFixed(3)), recordedSeconds: sound.samples.length / sound.rate, framesSeconds: session.frames / FPS, transitions: session.transitions };
fs.writeFileSync(path.join(out, "pulse_guard.video.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${video}: ${report.seconds} s, ${loudness.lufs} LUFS, true peak ${loudness.truePeak} dBTP`);
console.log(`sound recording ${report.recordedSeconds.toFixed(2)} s = offset ${report.audioOffsetSeconds} s + ${report.framesSeconds.toFixed(2)} s of frames (difference ${(report.recordedSeconds - report.audioOffsetSeconds - report.framesSeconds).toFixed(3)} s)`);
