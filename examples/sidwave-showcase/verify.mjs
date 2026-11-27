#!/usr/bin/env node
// Plays Pulse Guard in headless VICE for more than three minutes of C64 time and checks it:
//
//   run 1  the game as built: every state is reached, the interrupt runs in every frame, the music is audible in
//          the sound recording; screenshots of each state
//   run 2  the same game with silent songs, so that the recording holds the sound effects only: every effect is
//          started by the game and audible after it starts
//
// Output: <output directory>/verify/ (screenshots, recordings, report.json). Needs x64sc, Xvfb and ffmpeg.
import fs from "node:fs";
import path from "node:path";
import { buildGame } from "./build.mjs";
import { onset, readWav, rmsDb } from "./lib/audio.mjs";
import { playSession } from "./lib/session.mjs";
import { outputDir as root } from "./lib/sidwave.mjs";
import { FPS, writePng } from "./lib/vice.mjs";

const out = path.join(root, "verify");
const FRAMES = Number(process.env.FRAMES ?? 9600);
const REQUIRED = ["title", "play", "warn", "boss", "bossDies", "clear", "dies", "over"];

fs.mkdirSync(out, { recursive: true });
const failures = [];
const check = (ok, text) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) failures.push(text);
};

// ------------------------------------------------------------------------------------------------- run 1
const game = await buildGame();
const shots = new Map();
const wav = path.join(out, "session.wav");
const run = await playSession(game, {
  frames: FRAMES,
  wav,
  logFile: path.join(out, "vice.log"),
  onFrame: async ({ frame, state, monitor, palette, since }) => {
    // One screenshot 2 seconds into the first visit of each state (earlier for the short ones).
    const delay = { title: 190, play: 260, warn: 40, boss: 250, bossDies: 50, clear: 100, dies: 20, over: 120 }[state.state];
    if (frame - since === delay && !shots.has(state.state)) {
      const file = path.join(out, `${String(shots.size + 1).padStart(2, "0")}_${state.state}.png`);
      writePng(file, await monitor.picture(palette), 3);
      shots.set(state.state, file);
    }
    if (frame === FRAMES - 1) writePng(path.join(out, "99_last_frame.png"), await monitor.picture(palette), 3);
  },
});
const seconds = run.frames / FPS;
console.log(`run 1: ${run.frames} frames (${seconds.toFixed(1)} s of C64 time)`);
check(seconds >= 180, "the session covers at least three minutes");
check(run.frameGaps === 0 && run.rasterFrames === run.frames, `the frame interrupt ran in every frame (${run.frames} interrupts in ${run.rasterFrames} frames counted by CIA 1, ${run.frameGaps} gaps in the game's counter)`);
const states = run.transitions.map((t) => t.state);
for (const state of REQUIRED) check(states.includes(state), `state "${state}" reached`);
check(states.indexOf("over") >= 0 && states.indexOf("play", states.indexOf("over")) > 0, "a second game starts after game over and the title");
check(run.maxWave >= 2, `wave ${run.maxWave} reached, score ${run.maxScore}`);
check(run.overruns <= 4, `main loop overruns: ${run.overruns} (screen redraws on state changes)`);
check(run.playMax > 0 && run.playMax < 19656, `longest player call measured in VICE with CIA 2: ${run.playMax} cycles of 19656 per frame`);

const audio = readWav(wav);
const start = onset(audio) ?? 0;
const at = (frame) => start + frame / FPS;
const musicLevels = [];
for (let i = 0; i < run.transitions.length; i += 1) {
  const from = run.transitions[i].frame;
  const to = Math.min(run.transitions[i + 1]?.frame ?? run.frames, run.transitions[i].state === "over" ? from + 400 : Infinity);
  if (to - from < 60) continue;
  // The quietest one second window of the state.
  let quietest = Infinity;
  for (let t = at(from) + 0.3; t + 1 <= at(to); t += 1) quietest = Math.min(quietest, rmsDb(audio, t, t + 1));
  musicLevels.push({ state: run.transitions[i].state, fromSeconds: Number(at(from).toFixed(1)), rmsDb: Number(rmsDb(audio, at(from), at(to)).toFixed(1)), quietestSecondDb: Number(quietest.toFixed(1)) });
}
check(musicLevels.every((l) => l.rmsDb > -40), `sound audible in every state (RMS ${Math.min(...musicLevels.map((l) => l.rmsDb))} to ${Math.max(...musicLevels.map((l) => l.rmsDb))} dBFS)`);
const clipped = audio.samples.reduce((n, s) => n + (Math.abs(s) >= 32767 ? 1 : 0), 0);
check(clipped === 0, `${clipped} clipped samples in the VICE recording`);

// ------------------------------------------------------------------------------------------------- run 2
const quiet = await buildGame({ quiet: true, silentMusic: true, name: "pulse_guard_effects_only" });
const effectsWav = path.join(out, "effects-only.wav");
const triggers = [];
await playSession(quiet, { frames: FRAMES, wav: effectsWav, onSfx: (effect, frame) => triggers.push({ effect, frame }), logFile: path.join(out, "vice-effects.log") });
const effects = readWav(effectsWav);
const names = quiet.info.effects;
// The first effect of the session ("start") marks the position of the recording.
const first = triggers[0];
const offset = (onset(effects) ?? 0) - (first.frame + 1) / FPS;
const table = names.map((name, index) => {
  const mine = triggers.filter((t) => t.effect === index);
  const levels = mine.map((t) => rmsDb(effects, offset + (t.frame + 1) / FPS, offset + (t.frame + 1) / FPS + 0.1)).sort((a, b) => a - b);
  return { effect: name, started: mine.length, medianDb: Number((levels[levels.length >> 1] ?? -Infinity).toFixed(1)) };
});
console.log("run 2: effects only");
for (const row of table) check(row.started > 0 && row.medianDb > -40, `effect "${row.effect}": requested ${row.started} times, median level ${row.medianDb} dBFS in the 100 ms after the request`);

const report = { frames: run.frames, seconds, run, screenshots: [...shots.values()], musicLevels, effects: table, cycles: game.info.cycles, failures };
fs.writeFileSync(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`report: ${path.join(out, "report.json")}`);
if (failures.length) process.exitCode = 1;
