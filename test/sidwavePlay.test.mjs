// `c64_sound` op `play` against a recording client: what is detected, converted, saved and started.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSidwave } from "sidwave";
import { toolRegistry } from "../src/tools/registry/index.js";
import { createLogger } from "./meta/helpers.mjs";
import { midiFile, modFile, SCORE, sidFile } from "./helpers/musicFixtures.mjs";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-sidwave-play-"));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));
const write = (name, content) => { const file = path.join(work, name); fs.writeFileSync(file, content); return file; };

function machine({ platform = "vice", clock = 1, refuse = false } = {}) {
  const played = [];
  const start = (method) => async (bytes, options) => {
    played.push({ method, bytes: Buffer.from(bytes), options: method === "sidplayAttachment" ? options : undefined });
    return refuse ? { success: false, details: { message: "busy" } } : { success: true };
  };
  return {
    played,
    client: {
      async readMemoryRaw(address) { assert.equal(address, 0x02a6); return new Uint8Array([clock]); },
      runPrg: start("runPrg"),
      sidplayAttachment: start("sidplayAttachment"),
    },
    platform: { id: platform, features: [], limitedFeatures: [] },
    rag: {},
    logger: createLogger(),
    setPlatform() {},
  };
}

async function play(args, ctx = machine()) {
  const result = await toolRegistry.invoke("c64_sound", { op: "play", outputDir: path.join(work, "out"), ...args }, ctx);
  return { result, data: result.structuredContent?.data, text: result.content[0].text, ctx };
}

async function playing(args, ctx) {
  const outcome = await play(args, ctx);
  assert.notEqual(outcome.result.isError, true, outcome.text);
  assert.equal(outcome.data.playing, true);
  return outcome;
}

async function refused(args, pattern, ctx = machine()) {
  const { result, text } = await play(args, ctx);
  assert.equal(result.isError, true, text);
  assert.match(text, pattern);
  assert.equal(ctx.played.length, 0, "nothing was started");
}

/** The saved PRG is the one that was started, and the saved score parses. */
function savedFiles(data, ctx) {
  assert.deepEqual(ctx.played[0].bytes, fs.readFileSync(data.program.outputPath));
  assert.equal(ctx.played[0].method, "runPrg");
  return parseSidwave(fs.readFileSync(data.score.outputPath ?? data.score.inputPath, "utf8"));
}

test("play converts a MIDI file for the machine's clock and reports what it saved and lost", async () => {
  const { data, ctx } = await playing({ inputPath: write("tune.mid", await midiFile()) }, machine({ clock: 0 }));
  assert.deepEqual([data.detected.format, data.conversion, data.backend, data.system], ["midi", "converted", "vice", "NTSC"]);
  const score = savedFiles(data, ctx);
  assert.equal(score.song.mode, "NTSC");
  assert.equal(data.voices, 2);
  assert.ok(Array.isArray(data.losses) && ["info", "approx", "lost"].includes(data.severity));
  assert.match(data.summary, /Standard MIDI File.*converted.*NTSC.*on vice/);
  assert.equal(path.dirname(data.program.outputPath), fs.realpathSync(path.join(work, "out")));
});

test("play converts a ProTracker module and counts its losses", async () => {
  const { data, ctx } = await playing({ inputPath: write("tune.mod", modFile()) });
  assert.deepEqual([data.detected.format, data.conversion], ["mod", "converted"]);
  savedFiles(data, ctx);
  assert.ok(data.losses.length > 0);
  for (const loss of data.losses) assert.ok(loss.count >= 1 && loss.message, JSON.stringify(loss));
});

test("play starts a SIDWave score from a file or inline, with the same bytes as compile_play", async () => {
  const file = write("tune.sidwave.yaml", SCORE);
  const fromFile = await playing({ inputPath: file });
  assert.deepEqual([fromFile.data.conversion, fromFile.data.score.inputPath], ["none", fs.realpathSync(file)]);
  savedFiles(fromFile.data, fromFile.ctx);
  const inline = await playing({ sidwave: SCORE });
  assert.equal(fs.readFileSync(inline.data.score.outputPath, "utf8"), SCORE);
  assert.deepEqual(inline.ctx.played[0].bytes, fromFile.ctx.played[0].bytes);
  const compileContext = machine();
  await toolRegistry.invoke("c64_sound", { op: "compile_play", sidwave: SCORE }, compileContext);
  assert.deepEqual(compileContext.played[0].bytes, inline.ctx.played[0].bytes);
  const mismatch = await playing({ sidwave: SCORE }, machine({ clock: 0 }));
  assert.match(mismatch.data.warnings.join(" "), /PAL but the machine is NTSC/);
});

test("play hands an original SID to an Ultimate and reconstructs it for VICE", async () => {
  const bytes = sidFile();
  const file = write("tune.sid", bytes);
  const hardware = await playing({ inputPath: file }, machine({ platform: "c64u" }));
  assert.deepEqual([hardware.data.method, hardware.data.conversion, hardware.data.title], ["sidplay", "none", "Fixture Tune"]);
  assert.deepEqual(hardware.ctx.played, [{ method: "sidplayAttachment", bytes, options: undefined }]);
  await refused({ inputPath: file, song: 2 }, /song must be 0\.\.1/, machine({ platform: "u2" }));

  const emulator = await playing({ inputPath: file, durationSeconds: 8 });
  assert.deepEqual([emulator.data.method, emulator.data.conversion, emulator.data.approximate], ["run_prg", "reconstructed", true]);
  assert.equal(typeof emulator.data.verdict.strictExact, "boolean");
  assert.match(emulator.data.warnings.join(" "), /approximate score was reconstructed from the first 8 s/);
  assert.ok(emulator.data.losses.some((loss) => loss.code === "reconstruct.horizon"));
  savedFiles(emulator.data, emulator.ctx);
});

test("play runs a PRG unchanged", async () => {
  const prg = Buffer.from([0x01, 0x08, 0x00, 0x00]);
  const { data, ctx } = await playing({ inputPath: write("program.prg", prg) });
  assert.deepEqual([data.detected.format, data.method, data.loadAddress], ["prg", "run_prg", 0x0801]);
  assert.deepEqual(ctx.played[0].bytes, prg);
});

test("play explains unsupported, ambiguous, unreadable and broken input", async () => {
  await refused({ inputPath: write("notes.txt", "hello") }, /not a supported music file.*allowed: .*midi/);
  await refused({ inputPath: write("disk.d64", Buffer.alloc(1000)) }, /c64_disk/);
  await refused({ inputPath: write("cart.crt", "C64 CARTRIDGE   ") }, /op run_crt/);
  await refused({ inputPath: write("audio.wav", "RIFF0000WAVEfmt ") }, /can be written but not read/);
  await refused({ inputPath: write("broken.mid", "MThd") }, /./);
  await refused({ inputPath: write("tune2.bin", SCORE), from: "nope" }, /Unknown format "nope".*allowed/);
  await refused({}, /exactly one of inputPath and sidwave/);
  await refused({ sidwave: SCORE, song: 3 }, /song must be 0\.\.1/);
  const named = await playing({ inputPath: write("tune3.bin", await midiFile()), from: "midi" });
  assert.deepEqual([named.data.detected.format, named.data.detected.detectedBy], ["midi", "from"]);
});

test("play reports the saved files when the machine refuses to start", async () => {
  const { result, text } = await play({ sidwave: SCORE }, machine({ refuse: true }));
  assert.equal(result.isError, true);
  assert.match(text, /failure while starting playback/);
  assert.ok(fs.existsSync(result.metadata.error.details.program));
});

test("play is a write operation with confined input and output paths", async () => {
  const previous = process.env.C64BRIDGE_ACCESS;
  try {
    process.env.C64BRIDGE_ACCESS = "read-only";
    const blocked = machine();
    await assert.rejects(play({ sidwave: SCORE }, blocked), /effect "write".*read-only/);
    assert.equal(blocked.played.length, 0);
  } finally {
    if (previous === undefined) delete process.env.C64BRIDGE_ACCESS;
    else process.env.C64BRIDGE_ACCESS = previous;
  }
  const file = write("confined.sidwave.yaml", SCORE);
  await refused({ inputPath: "/etc/passwd" }, /outside the allowed directories/);
  await refused({ inputPath: file, outputDir: "/etc/c64bridge-play" }, /outside the allowed directories/);
  await refused({ inputPath: write(".hidden.yaml", SCORE) }, /hidden component/);
  fs.symlinkSync("/etc/passwd", path.join(work, "link.mid"));
  await refused({ inputPath: path.join(work, "link.mid") }, /outside the allowed directories/);
});
