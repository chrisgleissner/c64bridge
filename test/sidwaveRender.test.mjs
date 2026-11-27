// `c64_sound` op `render`: WAV files of a mix, stems and single voices of scores, converted files and SID files.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { midiFile, SCORE, sidFile } from "./helpers/musicFixtures.mjs";
import { blockedWhenReadOnly, ok, rejected, workspace } from "./helpers/sidwaveCalls.mjs";

const { at, write } = workspace("sidwave-render");
const score = write("tune.sidwave.yaml", SCORE);
const sid = write("tune.sid", sidFile());

/** The samples of a mono 16-bit WAV file, after its RIFF header was checked. */
function samples(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
  assert.equal(bytes.readUInt32LE(24), 48_000);
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.length));
}
/** Compared as buffers: a failing deep comparison of long sample arrays spends minutes on its diff. */
const differ = (a, b) => !fs.readFileSync(a).equals(fs.readFileSync(b));

/** Energy around the mean: an idle SID adds a constant offset. */
const energy = (file) => {
  const data = samples(file);
  const mean = data.reduce((sum, value) => sum + value, 0) / data.length;
  return data.reduce((sum, value) => sum + (value - mean) ** 2, 0) / data.length;
};

test("render writes the mix of a score, of a converted file and of a SID file", async () => {
  const mix = await ok({ op: "render", inputPath: score, durationSeconds: 2, outputPath: at("mix.wav") });
  assert.deepEqual([mix.action, mix.outputPath, mix.seconds, mix.sampleRate, mix.engine.emulation], ["mix", at("mix.wav"), 2, 48_000, "residfp"]);
  assert.equal(samples(mix.outputPath).length, 96_000);
  const whole = await ok({ op: "render", sidwave: SCORE });
  assert.equal(whole.seconds, 7, "the default length is the length of the score");
  const midi = await ok({ op: "render", inputPath: write("tune.mid", await midiFile()), durationSeconds: 2 });
  assert.equal(midi.conversion.from, "midi");
  const tune = await ok({ op: "render", inputPath: sid, durationSeconds: 2 });
  assert.ok(energy(tune.outputPath) > 1000);
});

test("render writes one stem per voice and reports whether they add up", async () => {
  const data = await ok({ op: "render", inputPath: score, action: "stems", durationSeconds: 2, outputDir: at("stems") });
  assert.deepEqual(data.files.map((file) => file.file), ["tune.mix.wav", "tune.v1.wav", "tune.v2.wav"]);
  assert.deepEqual(data.files.slice(1).map((file) => file.voices), [[1], [2]]);
  assert.equal(typeof data.additive, "boolean");
  assert.deepEqual(fs.readdirSync(at("stems")).sort(), data.files.map((file) => file.file));
  for (const file of data.files) assert.ok(energy(path.join(data.outputDir, file.file)) > 1000, file.file);
  await rejected({ op: "render", inputPath: score, action: "stems", outputDir: at("stems") }, /exists; pass overwrite/);
});

test("render solos and mutes a voice of a score and of a SID file", async () => {
  const render = (name, extra) => ok({ op: "render", durationSeconds: 3, outputPath: at(name), ...extra });
  const mix = await render("all.wav", { inputPath: score });
  const solo = await render("solo.wav", { inputPath: score, action: "solo", voice: 1 });
  const mute = await render("mute.wav", { inputPath: score, action: "mute", voice: 1 });
  assert.deepEqual([solo.soundingVoices, mute.soundingVoices], [[1], [2]]);
  assert.ok(differ(solo.outputPath, mix.outputPath));
  assert.ok(differ(solo.outputPath, mute.outputPath));
  assert.ok(energy(solo.outputPath) < energy(mix.outputPath));
  const isolated = await render("sid-solo.wav", { inputPath: sid, action: "solo", voice: 2 });
  assert.deepEqual([isolated.voice, isolated.method], [2, "reconstruct-and-recompile"]);
  assert.equal(typeof isolated.coupling.nonAdditive, "boolean");
  assert.equal(typeof isolated.reconstructionStrictExact, "boolean");
  assert.ok(energy(isolated.outputPath) > 1000);
});

test("render selects a song of a score with several songs", async () => {
  const songs = path.resolve("data/sound/examples/game_songs.yaml");
  const first = await ok({ op: "render", inputPath: songs, durationSeconds: 2, outputPath: at("song1.wav") });
  const second = await ok({ op: "render", inputPath: songs, song: 2, durationSeconds: 2, outputPath: at("song2.wav") });
  assert.ok(differ(second.outputPath, first.outputPath));
  const stems = await ok({ op: "render", inputPath: songs, song: 2, action: "stems", durationSeconds: 2, outputDir: at("song2-stems") });
  assert.deepEqual(stems.files.map((file) => file.voices), [undefined, [1], [2], [3]]);
  assert.ok(differ(path.join(stems.outputDir, "game_songs.mix.wav"), first.outputPath));
  await rejected({ op: "render", inputPath: songs, song: 9 }, /song must be 1\.\.3/);
});

test("render refuses impossible requests, protected paths and read-only mode", async () => {
  await rejected({ op: "render", inputPath: score, action: "solo" }, /needs voice/);
  await rejected({ op: "render", inputPath: score, action: "solo", voice: 3 }, /no voice 3.*allowed: 1, 2/);
  await rejected({ op: "render", inputPath: score, action: "loud" }, /Unknown render action.*allowed: mix, stems, solo, mute/);
  await rejected({ op: "render", inputPath: sid, action: "stems" }, /Stems need a score/);
  await rejected({ op: "render", inputPath: sid, song: 2 }, /song must be 1\.\.1/);
  await rejected({ op: "render", inputPath: score, outputDir: at("x") }, /pass outputPath/);
  await rejected({ op: "render", inputPath: score, outputPath: "/etc/c64bridge.wav" }, /outside the allowed directories/);
  await rejected({ op: "render", inputPath: "/etc/passwd" }, /outside the allowed directories/);
  await rejected({ op: "render", inputPath: score, action: "stems", outputDir: "/etc/c64bridge-stems" }, /outside the allowed directories/);
  await blockedWhenReadOnly({ op: "render", inputPath: score });
});
