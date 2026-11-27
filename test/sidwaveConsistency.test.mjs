// `c64_sound` consistency: background tasks, cancellation, labels of approximate formats and schema hints.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import { lookupAllowlist } from "../src/tasks/allowlist.js";
import { runWithInlineWindow, waitForTask, cancelTask, __resetForTests } from "../src/tasks/engine.js";
import { acquireLease } from "../src/tasks/resources.js";
import { toolRegistry } from "../src/tools/registry/index.js";
import { createLogger } from "./meta/helpers.mjs";
import { SCORE, sidFile } from "./helpers/musicFixtures.mjs";
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

test("formats that need a driver file are listed and refused as not writable", async () => {
  const { formats } = await ok({ op: "formats" });
  assert.deepEqual(formats.filter((format) => ["sf2", "cheesecutter"].includes(format.id)).map((format) => format.write), [false, false]);
  assert.equal((await ok({ op: "formats", from: "sf2" })).format.write, false);
  for (const to of ["sf2", "cheesecutter"]) await rejected({ op: "convert", sidwave: SCORE, to }, /needs a driver file.*sidwave export/);
});

test("generate and note_on keep their limits in the merged c64_sound schema", () => {
  const { properties } = toolRegistry.list().find((tool) => tool.name === "c64_sound").inputSchema;
  assert.match(properties.voice.description, /note_on: 1-3/);
  assert.ok(properties.root.pattern, "the note pattern of root");
  assert.equal(properties.style.default, "chiptune");
  assert.match(properties.seed.description, /compose: 65/);
});
