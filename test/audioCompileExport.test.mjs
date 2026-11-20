import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { audioModule } from "../src/tools/audio.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const SONG = "sidwave: 1.0\ntempo: 120\nvoices:\n  - id: 1\n    patterns: { A: { groove: [C4, E4] } }\ntimeline:\n  - { bars: 2, layers: { v1: A } }\n";

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
