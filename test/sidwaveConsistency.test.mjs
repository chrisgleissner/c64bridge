// `c64_sound` consistency: background tasks, cancellation, labels of approximate formats and schema hints.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import { lookupAllowlist } from "../src/tasks/allowlist.js";
import { runWithInlineWindow, waitForTask, cancelTask, __resetForTests } from "../src/tasks/engine.js";
import { acquireLease } from "../src/tasks/resources.js";
import { toolRegistry } from "../src/tools/registry/index.js";
import { createLogger } from "./meta/helpers.mjs";
import { CT } from "sidwave/export";
import { parseSidwave } from "sidwave";
import { writeArtifact } from "../src/tools/sidwaveShared.js";
import { SCORE, modFile, sidFile } from "./helpers/musicFixtures.mjs";
import { ok, rejected, workspace } from "./helpers/sidwaveCalls.mjs";

const { at, write } = workspace("sidwave-consistency");
const score = write("tune.sidwave.yaml", SCORE);
const ABC = "X:1\nT:Scale\nM:4/4\nL:1/4\nQ:1/4=120\nK:C\nCDEF|GABc|\n";

const context = (signal) => ({
  client: { async readMemoryRaw() { return new Uint8Array([1]); }, async getActiveBackendType() { return "vice"; } },
  platform: { id: "vice", features: [], limitedFeatures: [] },
  rag: {},
  logger: createLogger(),
  setPlatform() {},
  ...(signal ? { signal } : {}),
});

test("the offline SIDWave operations run as background tasks without a lease", async () => {
  __resetForTests();
  for (const [op, effect] of [["convert", "write"], ["reconstruct", "write"], ["render", "write"], ["analyze_music", "read"], ["compare", "read"]]) {
    const entry = lookupAllowlist(`c64_sound.${op}`);
    assert.deepEqual([entry?.effect, entry?.lease, entry?.cancellation], [effect, "none", "honoured"], op);
  }
  const outcome = await runWithInlineWindow(
    { tool: "c64_sound", op: "render", args: { inputPath: score, durationSeconds: 1, outputPath: at("task.wav") }, ctx: context() },
    { inlineMs: 0 },
  );
  assert.equal(outcome.kind, "task");
  const finished = await waitForTask(outcome.task.id, 60_000);
  assert.equal(finished.state, "completed", finished.error);
  assert.ok(fs.statSync(at("task.wav")).size > 44);
});

// 600 s is above the 180 s default of the library's renderer, so the task must still be working when it is cancelled.
test("a render longer than 180 s of a score or SID file runs until its task is cancelled", async () => {
  for (const [name, inputPath] of [["score", score], ["sid", write("long.sid", sidFile())]]) {
    __resetForTests();
    const outputPath = at(`${name}-cancelled.wav`);
    const outcome = await runWithInlineWindow(
      { tool: "c64_sound", op: "render", args: { inputPath, durationSeconds: 600, outputPath }, ctx: context() },
      { inlineMs: 0 },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const task = cancelTask(outcome.task.id);
    assert.equal(task.state, "cancelled", task.result?.content[0].text ?? task.error);
    // Give the engine time to reach its next slice.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(fs.existsSync(outputPath), false, name);
  }
});

test("operations that work synchronously write nothing when cancelled during their work", async () => {
  const calls = {
    compose: { style: "funk", seed: 3 },
    complete: { sidwave: SCORE, action: "continue", bars: 4 },
    retarget: { sidwave: SCORE, system: "NTSC" },
    transform: { sidwave: SCORE, action: "transpose", semitones: 2 },
    format: { sidwave: SCORE },
    compile: { sidwave: SCORE },
  };
  for (const [op, args] of Object.entries(calls)) {
    const controller = new AbortController();
    // Arrives like a client message: on a later turn of the event loop than the call.
    setTimeout(() => controller.abort(), 0);
    const outputPath = at(`${op}.sidwave.yaml`);
    const result = await toolRegistry.invoke("c64_sound", { op, ...args, outputPath }, context(controller.signal));
    assert.equal(result.metadata?.cancelled, true, `${op}: ${result.content[0].text}`);
    assert.equal(fs.existsSync(outputPath), false, op);
  }
});

test("host file operations run while another task holds the exclusive lease; operations that read the machine do not", async () => {
  __resetForTests();
  acquireLease({ taskId: "other", backendId: "vice", mode: "exclusive", tool: "c64_sound", op: "pipeline", pinned: false });
  try {
    await ok({ op: "validate", sidwave: SCORE });
    await ok({ op: "convert", sidwave: SCORE, to: "midi", outputPath: at("leased.mid") });
    await ok({ op: "render", sidwave: SCORE, durationSeconds: 1, outputPath: at("leased.wav") });
    await assert.rejects(toolRegistry.invoke("c64_sound", { op: "compose", seed: 1 }, context()), /blocked by task other/);
  } finally {
    __resetForTests();
  }
});

test("approximate formats are labelled in formats, inspect, convert, play and render", async () => {
  const { formats } = await ok({ op: "formats" });
  const labelled = formats.filter((format) => format.approximate).map((format) => format.id).sort();
  assert.deepEqual(labelled, ["abc", "cheesecutter", "jch", "sf2", "sid", "siddump", "vice-dump"]);
  assert.ok(formats.filter((format) => format.approximate && format.read !== "no").every((format) => format.read === "approximate"));
  const one = await ok({ op: "formats", from: "jch" });
  assert.deepEqual([one.approximate, one.format.readApproximate], [true, true]);
  const abc = write("scale.abc", ABC);
  assert.equal((await ok({ op: "inspect", inputPath: abc })).approximate, true);
  const converted = await ok({ op: "convert", inputPath: abc, to: "sidwave" });
  assert.match(converted.approximateNote, /ABC import is approximate/);
  const rendered = await ok({ op: "render", inputPath: abc, durationSeconds: 1 });
  assert.equal(rendered.conversion.approximate, true);
  const exact = await ok({ op: "convert", sidwave: SCORE, to: "midi" });
  assert.equal(exact.approximate, undefined);
  const recovered = await ok({ op: "convert", inputPath: write("tune.sid", sidFile()), to: "sidwave", durationSeconds: 2 });
  assert.match(recovered.approximateNote, /Experimental recovery/);
  const instruments = await ok({ op: "extract_instruments", inputPath: at("tune.sid"), durationSeconds: 2 });
  assert.match(instruments.approximateNote, /Experimental recovery/);
});

/**
 * A CheeseCutter player binary for the export: a PRG at $0E00 with the pointer table the exporter reads. It holds no
 * player code; every table gets its own 1 KiB block and every sequence its own page.
 */
function cheeseCutterStub() {
  const image = new Uint8Array(CT.IMAGE);
  const tables = Object.values(CT.OFS);
  for (let index = 0; index < CT.PTR_COUNT; index += 1) {
    const at = tables.includes(index) ? 0x1000 + tables.indexOf(index) * 0x400 : 0x0e00;
    image[CT.PTR_TABLE + index * 2] = at & 0xff;
    image[CT.PTR_TABLE + index * 2 + 1] = at >> 8;
  }
  const low = 0x1000 + tables.indexOf(CT.OFS.sequenceLow) * 0x400;
  const high = 0x1000 + tables.indexOf(CT.OFS.sequenceHigh) * 0x400;
  for (let sequence = 0; sequence < CT.SEQUENCES; sequence += 1) {
    image[low + sequence] = 0;
    image[high + sequence] = 0x7f + sequence;
  }
  return Buffer.concat([Buffer.from([0x00, 0x0e]), image.subarray(0x0e00, 0xff00)]);
}

test("formats that need a driver file are written only with driverPath", async () => {
  const { formats } = await ok({ op: "formats" });
  assert.deepEqual(formats.filter((format) => ["sf2", "cheesecutter"].includes(format.id)).map((format) => [format.write, format.writeNeeds]), [[true, "driverPath"], [true, "driverPath"]]);
  assert.equal((await ok({ op: "formats", from: "sf2" })).format.writeNeeds, "driverPath");
  for (const to of ["sf2", "cheesecutter"]) await rejected({ op: "convert", sidwave: SCORE, to }, /needs a driver file: pass driverPath/);
  const driver = write("player.prg", cheeseCutterStub());
  await rejected({ op: "convert", sidwave: SCORE, to: "midi", driverPath: driver }, /driverPath applies to sf2 and cheesecutter/);
  await rejected({ op: "convert", sidwave: SCORE, to: "cheesecutter", driverPath: "/etc/passwd" }, /outside the allowed directories/);
  await rejected({ op: "convert", sidwave: SCORE, to: "cheesecutter", driverPath: driver, outputPath: driver, overwrite: true }, /output file is an input file/);
  await rejected({ op: "convert", sidwave: SCORE, to: "sf2", driverPath: driver }, /SID Factory II/);
  const data = await ok({ op: "convert", sidwave: SCORE, to: "cheesecutter", driverPath: driver, outputPath: at("tune.ct") });
  assert.equal(data.to, "cheesecutter");
  assert.equal((await ok({ op: "inspect", inputPath: data.outputPath })).format, "cheesecutter");
  assert.deepEqual(fs.readFileSync(driver), cheeseCutterStub());
});

test("sids keeps the fourth channel of a module, and applies to MOD input only", async () => {
  const module = modFile();
  // Channels 3 and 4 play a note on every fourth row as well.
  for (let row = 0; row < 64; row += 4) for (const channel of [2, 3]) module.set([0x01, 0xac, 0x10, 0], 1084 + (row * 4 + channel) * 4);
  const input = write("four.mod", module);
  const one = await ok({ op: "convert", inputPath: input, to: "sidwave", outputPath: at("four-1.yaml") });
  assert.match(JSON.stringify(one.losses), /Channels 4 are not imported/);
  const two = await ok({ op: "convert", inputPath: input, to: "sidwave", sids: 2, outputPath: at("four-2.yaml") });
  assert.doesNotMatch(JSON.stringify(two.losses), /Channels 4 are not imported/);
  assert.equal(parseSidwave(fs.readFileSync(two.outputPath, "utf8")).voices.length, 4);
  await rejected({ op: "convert", sidwave: SCORE, to: "midi", sids: 2 }, /MOD input/);
  await rejected({ op: "play", sidwave: SCORE, sids: 2 }, /sids applies to a MOD file only/);
});

test("an output path that changed while the operation ran is not written", async () => {
  const planned = at("moved/out.bin");
  fs.mkdirSync(at("elsewhere"));
  // The directory of the planned path is replaced by a link to another directory after the path was checked.
  fs.symlinkSync(at("elsewhere"), at("moved"));
  await assert.rejects(writeArtifact(planned, "x", false, {}), /output path changed while the operation ran/);
  assert.deepEqual(fs.readdirSync(at("elsewhere")), []);
});

test("generate and note_on keep their limits in the merged c64_sound schema", () => {
  const { properties } = toolRegistry.list().find((tool) => tool.name === "c64_sound").inputSchema;
  assert.match(properties.voice.description, /note_on: 1-3/);
  assert.ok(properties.root.pattern, "the note pattern of root");
  assert.equal(properties.style.default, "chiptune");
  assert.match(properties.seed.description, /compose: 65/);
});
