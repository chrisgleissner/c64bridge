import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSidwave } from "sidwave/sidwave";
import { compileSidwaveToPrg } from "sidwave/compiler";
import { audioModule } from "../src/tools/audio.js";
import { metaModule } from "../src/tools/meta/index.js";
import { toolRegistry } from "../src/tools/registry/index.js";
import { hostSidwaveReadOptions } from "../src/sidwaveHost.js";
import { analyzePcmForTest } from "../src/audio/record_and_analyze_audio.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const SONG = "sidwave: 1.0\ntempo: 120\nvoices:\n  - id: 1\n    patterns: { A: { groove: [C4, E4] } }\ntimeline:\n  - { bars: 2, layers: { v1: A } }\n";

const IMPORT_DIR = path.join("test", `sidwave-imports-${process.pid}`);
const LIBRARY = `sidwave: 1.4\nlibrary: { name: lib, version: 1.0.0, licence: CC0-1.0, provenance: { author: a, source: s, created: 2026-01-01 } }\ninstruments: { bell: { waveform: pulse } }\n`;
const IMPORTED_SONG = `sidwave: 1.4\ntempo: 120\nimports:\n  - { as: x, from: ${JSON.stringify(path.posix.join(IMPORT_DIR, "lib.yaml"))} }\nvoices:\n  - id: 1\n    patterns: { A: { groove: [C4, E4] } }\ntimeline:\n  - { bars: 1, layers: { v1: A } }\n`;

function pipelineContext(playedPrgs = []) {
  return {
    logger,
    platform: { id: "vice", features: [], limitedFeatures: [] },
    client: {
      async runPrg(prg) { playedPrgs.push(Buffer.from(prg)); return { success: true }; },
      async sidSilenceAll() { return { success: true }; },
    },
  };
}

async function compileOperations(score) {
  const compile = await audioModule.invoke("music_compile_and_play", { sidwave: score, dryRun: true }, { client: {}, logger });
  const pipeline = await metaModule.invoke("music_compile_play_analyze", {
    sidwave: score, waitBeforeCaptureMs: 0, verifySilenceBefore: false, verifySilenceAfter: false,
  }, pipelineContext());
  return [compile, pipeline];
}

test("compile_play and pipeline preserve bytes without imports", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c64b-sidwave-bytes-"));
  try {
    const expected = Buffer.from(compileSidwaveToPrg(parseSidwave(SONG, hostSidwaveReadOptions)).prg);
    const outputPath = path.join(directory, "score.prg");
    const compile = await audioModule.invoke("music_compile_and_play", { sidwave: SONG, dryRun: true, outputPath }, { client: {}, logger });
    assert.equal(compile.isError, undefined, JSON.stringify(compile).slice(0, 400));
    assert.deepEqual(fs.readFileSync(outputPath), expected);

    const playedPrgs = [];
    const pipeline = await metaModule.invoke("music_compile_play_analyze", {
      sidwave: SONG, waitBeforeCaptureMs: 0, verifySilenceBefore: false, verifySilenceAfter: false,
    }, pipelineContext(playedPrgs));
    assert.equal(pipeline.isError, undefined, JSON.stringify(pipeline).slice(0, 400));
    assert.deepEqual(playedPrgs[0], expected);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("compile_play and pipeline resolve imports with host path confinement", async () => {
  const directory = path.join(process.cwd(), IMPORT_DIR);
  fs.mkdirSync(directory, { recursive: true });
  const originalConfig = process.env.C64BRIDGE_CONFIG;
  try {
    fs.writeFileSync(path.join(directory, "lib.yaml"), LIBRARY);
    for (const result of await compileOperations(IMPORTED_SONG)) {
      assert.equal(result.isError, undefined, JSON.stringify(result).slice(0, 400));
    }

    const outside = path.relative(process.cwd(), "/etc/passwd").split(path.sep).join("/");
    for (const from of [outside, path.posix.join(IMPORT_DIR, ".hidden.yaml"), path.posix.join(IMPORT_DIR, "server-owned.yaml")]) {
      const protectedPath = path.join(process.cwd(), from);
      if (!from.startsWith("../")) {
        fs.mkdirSync(path.dirname(protectedPath), { recursive: true });
        fs.writeFileSync(protectedPath, LIBRARY);
      }
      if (from.endsWith("server-owned.yaml")) process.env.C64BRIDGE_CONFIG = protectedPath;
      const score = IMPORTED_SONG.replace(path.posix.join(IMPORT_DIR, "lib.yaml"), from);
      const validation = await toolRegistry.invoke("c64_sound", { op: "validate", sidwave: score }, { logger, client: {} });
      assert.equal(validation.isError, true, from);
      const expectedError = validation.content[0].text;
      for (const result of await compileOperations(score)) {
        assert.equal(result.isError, true, from);
        assert.equal(result.metadata.error?.kind, "validation", from);
        assert.equal(result.content[0].text, expectedError, from);
      }
      if (from.endsWith("server-owned.yaml")) delete process.env.C64BRIDGE_CONFIG;
      if (!from.startsWith("../")) fs.rmSync(protectedPath, { force: true });
    }
  } finally {
    if (originalConfig === undefined) delete process.env.C64BRIDGE_CONFIG;
    else process.env.C64BRIDGE_CONFIG = originalConfig;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the expected score of an audio analysis resolves imports", async () => {
  const directory = path.join(process.cwd(), IMPORT_DIR);
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(path.join(directory, "lib.yaml"), LIBRARY);
    const rate = 44100;
    const signal = Float32Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / rate));
    const report = await analyzePcmForTest(signal, rate, IMPORTED_SONG);
    // The score expects C4 and E4, so a 440 Hz tone is measured against E4, not against its nearest semitone.
    assert.ok(Math.abs(report.analysis.voices[0].detected_notes[0].deviation_cents) > 400, JSON.stringify(report.analysis.voices[0]));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("compile_play dryRun with outputPath writes the PSID and reports duration and entry (SOUND-8)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64b-sidout-"));
  try {
    const file = path.join(dir, "tune.sid");
    const res = await audioModule.invoke("music_compile_and_play", { sidwave: SONG, output: "sid", dryRun: true, outputPath: file }, { client: {}, logger });
    assert.equal(res.isError, undefined, JSON.stringify(res).slice(0, 300));
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "PSID");
    assert.equal(res.metadata.sidSize, bytes.length);
    assert.equal(res.metadata.outputPath, fs.realpathSync(file));
    // 2 bars at 120 BPM = 4 s
    assert.ok(Math.abs(res.metadata.durationSeconds - 4) < 0.1);
    assert.ok(res.metadata.totalFrames > 190);
    assert.ok(res.content[0].text.includes("$080D"), res.content[0].text);
    assert.ok(res.content[0].text.includes("4 s per loop") || res.content[0].text.includes("4.0 s"), res.content[0].text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compile_play writes a PRG file with the BASIC stub and rejects paths outside the allowed roots (SOUND-8)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64b-prgout-"));
  try {
    const file = path.join(dir, "tune.prg");
    const res = await audioModule.invoke("music_compile_and_play", { sidwave: SONG, dryRun: true, outputPath: file }, { client: {}, logger });
    const bytes = fs.readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 2)], [0x01, 0x08]);
    assert.equal(res.metadata.prgSize, bytes.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const outside = await audioModule.invoke("music_compile_and_play", { sidwave: SONG, dryRun: true, outputPath: "/etc/c64bridge-test.prg" }, { client: {}, logger });
  assert.equal(outside.isError, true);
});
