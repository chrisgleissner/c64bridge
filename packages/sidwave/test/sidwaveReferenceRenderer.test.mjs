import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSidwave } from "../src/sidwave.js";
import { renderReference } from "../src/audio/sidwaveReference.js";

test("reference renderer applies firmware and explicit pan gains using a deterministic SID renderer", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-reference-renderer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const wav = Buffer.alloc(46);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(12_000, 24);
  wav.writeUInt32LE(24_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(2, 40);
  wav.writeInt16LE(8192, 44);

  const fakeSidplayfp = path.join(dir, "fake-sidplayfp");
  fs.writeFileSync(fakeSidplayfp, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const output = process.argv.find((arg) => arg.startsWith("-w"));
if (!output) process.exit(2);
appendFileSync(output.slice(2) + ".args", process.argv.filter((arg) => arg === "-mnf" || arg === "-mof").join(" ") + "\\n");
writeFileSync(output.slice(2), Buffer.from("${wav.toString("base64")}", "base64"));
`);
  fs.chmodSync(fakeSidplayfp, 0o755);

  const doc = parseSidwave(`sidwave: 1.2
tempo: 120
sids:
  - { id: a, address: "$D400", pan: "Left 3" }
voices:
  - { id: 1, waveform: saw, patterns: { p: { groove: "C4" } } }
timeline: [{ bars: 1, layers: { v1: p } }]
`);
  const render = (pan) => renderReference(doc, {
    model: "8580",
    sampleRate: 12_000,
    seconds: 1,
    sidplayfp: fakeSidplayfp,
    ...(pan ? { pan: { 0: pan } } : {}),
  });
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

  const firmwarePan = render();
  near(firmwarePan.left[0], 0.25 * 243 / 256);
  near(firmwarePan.right[0], 0.25 * 79 / 256);

  const left = render("left");
  near(left.left[0], 0.25);
  near(left.right[0], 0);

  const right = render("right");
  near(right.left[0], 0);
  near(right.right[0], 0.25);

  const center = render("center");
  near(center.left[0], 0.25 / Math.SQRT2);
  near(center.right[0], 0.25 / Math.SQRT2);
});

test("reference renderer selects each SID's declared model", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-reference-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeSidplayfp = path.join(dir, "fake-sidplayfp");
  const wav = Buffer.alloc(46);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(12_000, 24); wav.writeUInt32LE(24_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(2, 40); wav.writeInt16LE(8192, 44);
  fs.writeFileSync(fakeSidplayfp, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const output = process.argv.find((arg) => arg.startsWith("-w"));
appendFileSync(output.slice(2) + ".args", process.argv.filter((arg) => arg === "-mnf" || arg === "-mof").join(" ") + "\\n");
writeFileSync(output.slice(2), Buffer.from("${wav.toString("base64")}", "base64"));
`);
  fs.chmodSync(fakeSidplayfp, 0o755);
  const doc = parseSidwave(`sidwave: 1.3
tempo: 120
sids:
  - { id: a, address: "$D400", model: "8580" }
  - { id: b, address: "$D420", model: "6581" }
voices:
  - { id: 1, waveform: saw, patterns: { p: { groove: "C4" } } }
timeline: [{ bars: 1, layers: { v1: p } }]
`);
  const render = (useScoreModels) => renderReference(doc, {
    model: "8580", useScoreModels, sampleRate: 12_000, sidplayfp: fakeSidplayfp, workDir: dir,
  });
  render(false);
  const forced = fs.readFileSync(path.join(dir, "sid1.wav.args"), "utf8") + fs.readFileSync(path.join(dir, "sid2.wav.args"), "utf8");
  assert.equal((forced.match(/-mnf/g) ?? []).length, 2, "the explicit override forces 8580 on every stem");
  assert.ok(!forced.includes("-mof"), "the explicit override keeps the existing HIL forced-model behavior");
  fs.writeFileSync(path.join(dir, "sid1.wav.args"), "");
  fs.writeFileSync(path.join(dir, "sid2.wav.args"), "");
  render(true);
  const perScore = fs.readFileSync(path.join(dir, "sid1.wav.args"), "utf8") + fs.readFileSync(path.join(dir, "sid2.wav.args"), "utf8");
  assert.ok(perScore.includes("-mnf"), "the first score-declared 8580 stem keeps its model");
  assert.ok(perScore.includes("-mof"), "the second score-declared 6581 stem keeps its model");
});
