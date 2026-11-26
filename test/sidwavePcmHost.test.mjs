import test from "#test/runner";
import assert from "#test/assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSynth, renderSample, quantizePcm, readPcmFile, unpackNibbles } from "sidwave/pcm";
import { parseSidwave } from "sidwave/sidwave";
import { compileSidwaveToPrg } from "sidwave/compiler";
import { hostSidwaveFileReader, hostSidwaveReadOptions } from "../src/sidwaveHost.js";
import { soundModuleGroup } from "../src/tools/registry/sound.js";

const RATE = 4000;
const toPcm = ({ data, sampleCount }) => Float64Array.from(unpackNibbles(data, sampleCount), (x) => (2 * x - 15) / 15);

function goertzel(samples, frequency, rate = RATE) {
  const factor = 2 * Math.cos(2 * Math.PI * frequency / rate);
  let previous = 0, before = 0;
  for (const x of samples) {
    const next = x + factor * previous - before;
    before = previous;
    previous = next;
  }
  return previous ** 2 + before ** 2 - factor * previous * before;
}

function strongest(samples, low, high) {
  let bestHz = low, power = 0;
  for (let hz = low; hz <= high; hz++) {
    const candidate = goertzel(samples, hz);
    if (candidate > power) { bestHz = hz; power = candidate; }
  }
  return bestHz;
}

const score = (samples) => ({ sidwave: "1.2", tempo: 120, voices: [], timeline: [{ bars: 1, layers: {} }], samples });

test("PCM import refuses a file outside the allowed host roots", () => {
  assert.throws(() => renderSample({ file: "/etc/hosts" }, RATE, hostSidwaveReadOptions), /outside.*allowed|allowed roots/i);
});

test("sample_render and analyze round-trip a quantized WAV with no device client", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sidwave-preview-"));
  try {
    const ctx = { client: new Proxy({}, { get() { throw new Error("Preview accessed the device"); } }),
      platform: { id: "c64u" }, logger: { info: () => {} } };
    const definition = { synth: { osc: "sine", freq: "A4", ms: 160 } };
    const result = await soundModuleGroup.invoke("c64_sound", { op: "sample_render", definition, outputDir: dir }, ctx);
    assert.ok(!result.isError, JSON.stringify(result));
    const { outputPath, stats } = result.structuredContent.data;
    assert.equal(stats.bytes, 320);
    assert.equal(readFileSync(outputPath).toString("ascii", 0, 4), "RIFF");
    const wav = readPcmFile(outputPath, undefined, hostSidwaveFileReader);
    assert.equal(wav.rate, RATE);
    assert.equal(wav.data.length, 640);
    assert.equal(strongest(wav.data, 425, 455), 440);
    const analysis = await soundModuleGroup.invoke("c64_sound", { op: "analyze", wavPath: outputPath }, ctx);
    assert.ok(!analysis.isError, JSON.stringify(analysis));
    assert.equal(analysis.metadata.analysis.analysis.source, "wav");
    assert.ok(analysis.metadata.analysis.analysis.voices[0].detected_notes.some((note) => note.note === "A4"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compile_play dry run exposes sample statistics and NMI budget", async () => {
  const sidwave = score({ rate: RATE, defs: { hit: { b64: "5w==" } }, triggers: [{ sample: "hit", at: [0] }] });
  const ctx = { client: new Proxy({}, { get() { throw new Error("Dry run accessed the device"); } }),
    platform: { id: "c64u" }, logger: { info: () => {} } };
  const result = await soundModuleGroup.invoke("c64_sound", { op: "compile_play", sidwave, dryRun: true }, ctx);
  assert.ok(!result.isError, JSON.stringify(result));
  const report = result.metadata;
  assert.equal(report.sampleBytes, 1);
  assert.equal(report.sampleDefinitions.hit.source, "b64");
  assert.equal(report.digiWorstCaseCyclesPerNmi, 116);
  assert.ok(report.digiCyclesPerCall >= report.digiWorstCaseCyclesPerNmi);
  assert.ok(report.bytesBelowD000 > 0);
});
