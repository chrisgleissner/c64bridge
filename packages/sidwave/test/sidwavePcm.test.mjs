import test from "#test/runner";
import assert from "#test/assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSynth, renderSample, quantizePcm, readPcmFile, unpackNibbles } from "../src/sidwavePcm.js";
import { parseSidwave } from "../src/sidwave.js";
import { compileSidwaveToPrg } from "../src/sidwaveCompiler.js";

const RATE = 4000;
const reader = (path) => readFileSync(path);
const files = { readFile: reader };
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

function stereoToneWav() {
  const rate = 44100, frames = rate / 2;
  const wav = Buffer.alloc(44 + frames * 4);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 4, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const tone = Math.sin(2 * Math.PI * i * 440 / rate);
    const aliased = Math.sin(2 * Math.PI * i * 5500 / rate);
    const side = Math.sin(2 * Math.PI * i * 700 / rate);
    wav.writeInt16LE(Math.round(tone * 14000 + aliased * 9000 + side * 5000 + 1000), 44 + i * 4);
    wav.writeInt16LE(Math.round(tone * 10000 + aliased * 9000 - side * 5000 + 1000), 46 + i * 4);
  }
  return wav;
}


const score = (samples) => ({ sidwave: "1.2", tempo: 120, voices: [], timeline: [{ bars: 1, layers: {} }], samples });

test("built-in kick's fundamental falls and all six kits are distinct", () => {
  const kick = toPcm(renderSample({ kit: "kick" }, RATE));
  const attack = strongest(kick.subarray(0, 150), 35, 230);
  const tail = strongest(kick.subarray(340, 600), 35, 230);
  assert.ok(attack > 100, `kick attack measured ${attack} Hz`);
  assert.ok(tail >= 40 && tail <= 60, `kick tail measured ${tail} Hz`);
  const kits = ["kick", "snare", "clap", "hat", "tom", "zap"];
  assert.equal(new Set(kits.map((kit) => renderSample({ kit }, RATE).data.join(","))).size, kits.length);
});

test("synth renders requested notes in order and silence during rests", () => {
  const synth = { layers: [{ osc: "sine" }], notes: "C4:120 E4:120 G4:240 r:60" };
  const audio = renderSynth(synth, RATE);
  assert.equal(audio.length, 2160);
  for (const [i, hz] of [261.63, 329.63, 392].entries()) {
    const section = audio.subarray(480 * i + 26, 480 * i + 454);
    assert.ok(Math.abs(strongest(section, 220, 420) - hz) < 3);
  }
  assert.ok(audio.slice(-200).every((x) => x === 0));
});

test("seeded layered noise, filters, envelope, crush and vowel rendering are reproducible", () => {
  const spec = { layers: [{ osc: "noise", ms: 90, gain: 0.25 }, { osc: "square", freq: "A3", to: "A2", ms: 90, duty: 0.3 }],
    seed: 42, env: { a: 4, d: 20, s: 0.5, r: 10 }, formant: "a", lp: 1200, hp: 100, crush: { bits: 9, rate: 3000 }, drive: 2 };
  const rendered = renderSample({ synth: spec }, RATE);
  assert.deepEqual(rendered, renderSample({ synth: spec }, RATE));
  assert.notEqual(rendered.data.join(","), renderSample({ synth: { ...spec, seed: 43 } }, RATE).data.join(","));
  assert.ok(rendered.stats.rms > 0);
  assert.ok(rendered.stats.snrDb > 0);
});

test("stereo 44.1 kHz WAV import mixes to mono, removes DC and rejects aliasing at 4 kHz", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidwave-wav-"));
  try {
    const path = join(dir, "tone.wav");
    writeFileSync(path, stereoToneWav());
    const rendered = renderSample({ file: path, dither: "none" }, RATE, files);
    const samples = toPcm(rendered);
    const stable = samples.subarray(100, 1900);
    assert.equal(samples.length, 2000);
    assert.equal(strongest(stable, 420, 460), 440);
    assert.ok(goertzel(stable, 440) > 1000 * goertzel(stable, 1500), "anti-alias filter suppresses the 5.5 kHz input");
    assert.ok(goertzel(stable, 440) > 1000 * goertzel(stable, 700), "opposite stereo signals cancel");
    assert.ok(Math.abs(samples.reduce((sum, x) => sum + x, 0) / samples.length) < 0.01);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quantizer normalizes signed peaks, trims silence and packs odd lengths", () => {
  const normalized = quantizePcm(Float64Array.of(0, 0, -0.4, 0, 0.4, 0, 0), { trim: true });
  assert.deepEqual([...normalized.samples].filter((_, i) => i !== 1), [0, 15]);
  assert.equal(normalized.peak, 1);
  assert.equal(normalized.packed.length, Math.ceil(normalized.samples.length / 2));
  assert.deepEqual(unpackNibbles(normalized.packed, normalized.samples.length), normalized.samples);
});

test("shaped dither reduces coherent and low frequency error on a quiet sine", () => {
  const quiet = Float64Array.from({ length: 4000 }, (_, i) => 0.025 * Math.sin(2 * Math.PI * 125 * i / RATE));
  const error = (dither) => Float64Array.from(quantizePcm(quiet, { dither, gainDb: 0 }).samples,
    (x, i) => (2 * x - 15) / 15 - quiet[i]);
  const none = error("none"), shaped = error("shaped"), tpdf = error("tpdf");
  const bandPower = (signal) => Array.from({ length: 400 }, (_, i) => goertzel(signal, i + 1)).reduce((a, b) => a + b);
  assert.ok(goertzel(shaped, 125) < goertzel(none, 125) / 10);
  assert.ok(bandPower(shaped) < bandPower(none));
  assert.ok(goertzel(tpdf, 125) < goertzel(none, 125));
});

test("compiler reports unique packed bytes, headroom, timing and source statistics", () => {
  const doc = parseSidwave(score({ rate: RATE,
    defs: { tone: { synth: { osc: "sine", freq: 440, ms: 20 } }, tiny: { b64: "jxA=" } },
    voices: [{ sample: "tone", at: [0, 20] }, { sample: "tiny", at: [40] }, { at: [60], hex: "0f3" }],
  }));
  const compiled = compileSidwaveToPrg(doc);
  assert.equal(compiled.sampleDefinitions.tone.bytes, 40);
  assert.equal(compiled.sampleDefinitions.tone.duration, 0.02);
  assert.equal(compiled.sampleDefinitions.tone.rate, RATE);
  assert.equal(compiled.sampleDefinitions.tone.peak, 1);
  assert.ok(compiled.sampleDefinitions.tone.rms > 0.6);
  assert.ok(compiled.sampleDefinitions.tone.snrDb > 15);
  assert.equal(compiled.sampleDefinitions.tiny.source, "b64");
  assert.equal(compiled.sampleDefinitions.tiny.snrDb, null);
  assert.equal(compiled.sampleBytes, 44);
  assert.equal(compiled.bytesBelowD000, 0xd000 - compiled.endAddress - 3);
  assert.ok(compiled.digiCyclesPerCall > 0);
  assert.throws(() => parseSidwave(score({ rate: RATE, defs: { bad: { kit: "kick", hex: "ab" } } })), /exactly one/);
});

test("an oversize packed score reports sample bytes and mitigation", () => {
  const doc = parseSidwave(score({ rate: 4000,
    defs: { huge: { hex: "7".repeat(98000) } }, voices: [{ sample: "huge", at: [0] }],
  }));
  assert.throws(() => compileSidwaveToPrg(doc), /needs \d+ bytes and includes 49000 sample bytes.*lower sample rate or shorter samples/i);
});

test("PCM decoder accepts 8-bit, signed 24-bit and float32 WAV plus raw u8 and s16", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidwave-formats-"));
  try {
    const buffers = [
      ["8.wav", 1, 8, Buffer.from([0, 64, 128, 192])],
      ["24.wav", 1, 24, Buffer.from("0000800000c0000000000040", "hex")],
      ["float.wav", 3, 32, Buffer.alloc(16)],
    ];
    [-1, -0.5, 0, 0.5].forEach((x, i) => buffers[2][3].writeFloatLE(x, i * 4));
    for (const [name, encoding, bits, raw] of buffers) {
      const wav = stereoToneWav().subarray(0, 44 + raw.length);
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.writeUInt16LE(encoding, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(RATE, 24);
      wav.writeUInt32LE(RATE * bits / 8, 28);
      wav.writeUInt16LE(bits / 8, 32);
      wav.writeUInt16LE(bits, 34);
      wav.writeUInt32LE(raw.length, 40);
      raw.copy(wav, 44);
      const path = join(dir, name);
      writeFileSync(path, wav);
      assert.deepEqual([...readPcmFile(path, undefined, reader).data], [-1, -0.5, 0, 0.5]);
    }

    const u8 = join(dir, "samples.u8"), s16 = join(dir, "samples.s16");
    writeFileSync(u8, Buffer.from([0, 128, 192]));
    writeFileSync(s16, Buffer.from("008000000040", "hex"));
    for (const file of [u8, s16]) {
      assert.deepEqual([...readPcmFile(file, RATE, reader).data], [-1, 0, 0.5]);
      assert.throws(() => renderSample({ file }, RATE, files), /file_rate/);
      assert.equal(renderSample({ file, file_rate: RATE }, RATE, files).stats.source, "file");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file: sample source without a reader is an error, and the size limit is an option", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidwave-noreader-"));
  try {
    const file = join(dir, "a.u8");
    writeFileSync(file, Uint8Array.of(0, 128, 255, 128));
    assert.throws(() => renderSample({ file, file_rate: RATE }, RATE), /file reader/);
    assert.throws(() => parseSidwave(score({ rate: RATE, defs: { a: { file, file_rate: RATE } } })), /file reader/);
    assert.throws(() => readPcmFile(file, RATE, reader, 3), /size limit/);
    assert.equal(readPcmFile(file, RATE, reader, 4).data.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

