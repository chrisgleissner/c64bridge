// End to end on a real VICE, all through the MCP server: compose, compile, play, capture and verify; a game build;
// and op play with a MIDI file, a ProTracker module, a SIDWave score and a SID file.
//
// Runs only with C64BRIDGE_SIDWAVE_VICE_E2E=1 (needs x64sc and Xvfb; takes about two minutes of real time):
//   C64BRIDGE_SIDWAVE_VICE_E2E=1 node scripts/run-tests.mjs test/sidwaveViceE2e.test.mjs
// VICE_PORT (default 6523) and VICE_XVFB_DISPLAY (default :123) select the private emulator instance.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createConnectedClient } from "./helpers/mcpTestClient.mjs";
import { BASS, MELODY, midiFile, MOD_NOTES, modFile, SCORE, sidFile } from "./helpers/musicFixtures.mjs";

const enabled = process.env.C64BRIDGE_SIDWAVE_VICE_E2E === "1";
const port = Number(process.env.VICE_PORT || 6523);
const display = process.env.VICE_XVFB_DISPLAY || ":123";
/** About 20 s of PAL machine time: the boot and well over 10 s of music. */
const RUN_CYCLES = 20_000_000;

const serverEnv = (viceArgs, cycles = RUN_CYCLES) => ({
  C64_MODE: "vice", C64BRIDGE_CONFIG: "", VICE_PORT: String(port), VICE_XVFB_DISPLAY: display, FORCE_XVFB: "1",
  VICE_VISIBLE: "false", VICE_WARP: "false", VICE_TEST_TARGET: "", VICE_ARGS: `${viceArgs} -limitcycles ${cycles}`,
});

/** The program of the sid-music skill's game workflow: init once, then one play call a frame. */
const hostProgram = (player) => `* = $7FC0
start:   sei
         lda #$00
         ldx #$FF
         jsr $8000
frame:   lda #$F8
wait:    cmp $D012
         bne wait
leave:   cmp $D012
         beq leave
         jsr $8003
         jmp frame
         .res $8000 - *
         .incbin "${player}"
`;

const portInUse = () => new Promise((resolve) => {
  const socket = net.connect(port, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

async function emulatorEnded() {
  for (const deadline = Date.now() + 60_000; await portInUse();) {
    assert.ok(Date.now() < deadline, "VICE did not end after its cycle limit");
    await delay(500);
  }
}

/** Note frequencies in the order they start (a gate that rises), for one voice of a VICE register dump. */
function noteStarts(dump, voice) {
  const base = voice * 7;
  const registers = new Uint8Array(32);
  const notes = [];
  let gate = 0;
  for (const line of dump.split("\n")) {
    const [, register, value] = line.trim().split(/\s+/).map(Number);
    if (!(register >= 0 && register < 32)) continue;
    registers[register] = value;
    if (register !== base + 4) continue;
    if ((value & 1) && !gate) notes.push(registers[base] | (registers[base + 1] << 8));
    gate = value & 1;
  }
  return notes.filter((frequency) => frequency > 0);
}

/** Root mean square of the samples of a PCM16 WAV file. */
function rmsOfWav(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
  const start = bytes.indexOf("data") + 8;
  let sum = 0;
  let count = 0;
  for (let offset = start; offset + 1 < bytes.length; offset += 2) {
    const sample = bytes.readInt16LE(offset) / 32768;
    sum += sample * sample;
    count += 1;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

/** Every voice of the captured dump starts the same first notes, in the same order, as the offline trace. */
function verifyNotes(referenceFile, dumpFile) {
  const expected = fs.readFileSync(referenceFile, "utf8");
  const captured = fs.readFileSync(dumpFile, "utf8");
  let verified = 0;
  for (let voice = 0; voice < 3; voice += 1) {
    const want = noteStarts(expected, voice).slice(0, 12);
    const got = noteStarts(captured, voice);
    if (want.length === 0) continue;
    const first = got.findIndex((_, index) => want.every((note, offset) => got[index + offset] === note));
    assert.ok(first >= 0, `voice ${voice + 1}: expected ${want.join(" ")} within ${got.slice(0, 40).join(" ")}`);
    verified += want.length;
  }
  assert.ok(verified >= 12, `only ${verified} notes were compared`);
  return verified;
}

const callTool = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  assert.notEqual(result.isError, true, `${name} ${args.op}: ${result.content?.[0]?.text}`);
  return result.structuredContent?.data ?? result.structuredContent;
};
const sound = (client, args) => callTool(client, "c64_sound", args);

/** Opens MCP server connections that end their emulator and delete `work` after the test. */
function connections(t, work) {
  const opened = [];
  t.after(async () => {
    for (const open of opened) {
      if (await portInUse()) await open.client.callTool({ name: "c64_system", arguments: { op: "poweroff" } }).catch(() => {});
      await open.close().catch(() => {});
    }
    fs.rmSync(work, { recursive: true, force: true });
  });
  return async (viceArgs, cycles) => {
    const connection = await createConnectedClient({ env: serverEnv(viceArgs, cycles) });
    opened.push(connection);
    return connection;
  };
}

test("compose, compile, play, capture and verify on VICE", { skip: !enabled, timeout: 240_000 }, async (t) => {
  assert.equal(await portInUse(), false, `port ${port} is in use; set VICE_PORT to a free port`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-sidwave-e2e-"));
  const wav = path.join(work, "capture.wav");
  const dump = path.join(work, "capture.dump");
  // The register writes of the playback go to the dump file, which VICE writes as its sound device. VICE completes
  // its sound file only when it ends by itself, so each run ends after a fixed number of cycles.
  const connect = connections(t, work);
  const connection = await connect(`-sounddev dump -soundarg ${dump}`);
  const { client } = connection;

  // Compose for the machine's clock, check the score and compile it.
  const composed = await sound(client, { op: "compose", style: "chiptune", seed: 5, outputPath: path.join(work, "song.yaml"), includeScore: true });
  assert.equal(composed.system, "PAL");
  assert.match(composed.systemSource, /\$02A6/);
  const compiled = await sound(client, { op: "compile", inputPath: composed.outputPath, forDevice: true, outputPath: path.join(work, "song.prg") });
  assert.equal(compiled.backend, "vice");
  const reference = await sound(client, { op: "convert", inputPath: composed.outputPath, to: "vice-dump", durationSeconds: 5, outputPath: path.join(work, "reference.dump") });

  // Deploy and capture the register writes.
  await sound(client, { op: "compile_play", sidwave: composed.sidwave });
  await emulatorEnded();

  // Verify the captured register writes.
  const verified = verifyNotes(reference.outputPath, dump);
  await connection.close();

  // Capture audio from a second run and analyze it with the existing host WAV analysis.
  const wavConnection = await connect(`-sounddev wav -soundarg ${wav}`);
  await sound(wavConnection.client, { op: "compile_play", sidwave: composed.sidwave });
  await emulatorEnded();
  assert.ok(rmsOfWav(wav) > 0.01, `the capture is silent (RMS ${rmsOfWav(wav)})`);
  const analysis = await sound(wavConnection.client, { op: "analyze", wavPath: wav, request: "does the music sound right?", expectedSidwave: composed.sidwave });
  assert.ok(analysis, "the analysis returned data");
  t.diagnostic(`verified ${verified} notes; analysis: ${JSON.stringify(analysis).slice(0, 600)}`);
});

test("a game build runs inside an example program on VICE", { skip: !enabled, timeout: 240_000 }, async (t) => {
  assert.equal(await portInUse(), false, `port ${port} is in use; set VICE_PORT to a free port`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-sidwave-game-"));
  const dump = path.join(work, "game.dump");
  const connect = connections(t, work);
  const { client } = await connect(`-sounddev dump -soundarg ${dump}`);

  const composed = await sound(client, { op: "compose", style: "funk", seed: 9, system: "PAL", outputPath: path.join(work, "level.yaml") });
  const build = await sound(client, { op: "compile", inputPath: composed.outputPath, output: "game", origin: 0x8000, symbols: ["acme"], outputDir: path.join(work, "build") });
  assert.equal(build.contract.playCallsPerFrame, 1, "the example program calls play once a frame");
  assert.ok(build.cycles.worst > 0 && build.cycles.worst < 19_656, "one play call fits in a PAL frame");
  const reference = await sound(client, { op: "convert", inputPath: composed.outputPath, to: "vice-dump", durationSeconds: 5, outputPath: path.join(work, "reference.dump") });

  await callTool(client, "c64_program", { op: "upload_run_asm", program: hostProgram(path.join(work, "build", "level.bin")) });
  await emulatorEnded();
  t.diagnostic(`verified ${verifyNotes(reference.outputPath, dump)} notes, worst play call ${build.cycles.worst} cycles`);
});

const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** The PAL SID frequency register value of a note such as C4. */
const palRegister = (note) => ((440 * 2 ** ((SEMITONES[note[0]] + 12 * (Number(note.at(-1)) + 1) - 69) / 12)) * 16_777_216) / 985_248;
const amigaPeriods = { "C-2": 428, "E-2": 339, "G-2": 285, "C-3": 214 };

/** Some voice of the dump starts notes whose frequencies are `expected` (register values or ratios), in order. */
function assertMelody(dump, expected, { relative = false } = {}) {
  const text = fs.readFileSync(dump, "utf8");
  const voices = [0, 1, 2].map((voice) => noteStarts(text, voice));
  const matches = (notes) => notes.some((_, start) => expected.every((value, offset) => {
    const got = relative ? notes[start + offset] / notes[start] : notes[start + offset];
    return Math.abs(got / value - 1) < 0.006;
  }));
  assert.ok(voices.some(matches), `no voice plays ${expected.map((v) => v.toFixed(relative ? 3 : 0)).join(" ")}; got ${JSON.stringify(voices.map((v) => v.slice(0, 12)))}`);
}

test("play starts a MIDI file, a MOD, a SIDWave score and a SID file on VICE", { skip: !enabled, timeout: 600_000 }, async (t) => {
  assert.equal(await portInUse(), false, `port ${port} is in use; set VICE_PORT to a free port`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-sidwave-play-"));
  const connect = connections(t, work);
  const melody = MELODY.map(palRegister);
  const modRatios = MOD_NOTES.map((note) => amigaPeriods[MOD_NOTES[0]] / amigaPeriods[note]);
  const inputs = [
    ["tune.mid", await midiFile(), "midi", "converted", (dump) => { assertMelody(dump, melody); assertMelody(dump, BASS.map(palRegister)); }],
    ["tune.mod", modFile(), "mod", "converted", (dump) => assertMelody(dump, modRatios, { relative: true })],
    ["tune.sidwave.yaml", SCORE, "sidwave", "none", (dump) => assertMelody(dump, melody)],
    ["tune.sid", sidFile(), "sid", "reconstructed", (dump) => assertMelody(dump, melody)],
  ];
  for (const [name, content, format, conversion, check] of inputs) {
    const file = path.join(work, name);
    fs.writeFileSync(file, content);
    const dump = path.join(work, `${format}.dump`);
    const connection = await connect(`-sounddev dump -soundarg ${dump}`, 14_000_000);
    const started = Date.now();
    const played = await sound(connection.client, { op: "play", inputPath: file, outputDir: path.join(work, "out") });
    const elapsed = Date.now() - started;
    assert.deepEqual([played.playing, played.backend, played.detected.format, played.conversion], [true, "vice", format, conversion]);
    await emulatorEnded();
    check(dump);
    // The captured register writes also match an offline trace of the score that play saved.
    const score = played.score.outputPath ?? played.score.inputPath;
    const reference = await sound(connection.client, { op: "convert", inputPath: score, to: "vice-dump", durationSeconds: 5, outputPath: path.join(work, `${format}.reference.dump`) });
    t.diagnostic(`${format}: ${played.summary} Started after ${elapsed} ms; ${verifyNotes(reference.outputPath, dump)} notes verified`);
    await connection.close();
  }
});
