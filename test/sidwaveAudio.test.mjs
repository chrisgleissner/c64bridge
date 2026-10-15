// Renders compiled SIDWAVE songs with sidplayfp and checks what is audible: pitch of every note,
// the hard-restart gap between repeated notes, and silence during rests. Skips when sidplayfp is missing.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileSidwaveToPrg, compileSidwaveToSid } from "../src/sidwaveCompiler.js";
import { midiToHz, noteNameToMidi, parseSidwave } from "../src/sidwave.js";
import { runSidToWav, SidplayExecutionError } from "../src/sidplayRunner.js";

function readMonoPcm16(file) {
  const buf = fs.readFileSync(file);
  let offset = 12;
  let channels = 1;
  let rate = 44100;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") { channels = buf.readUInt16LE(offset + 10); rate = buf.readUInt32LE(offset + 12); }
    if (id === "data") {
      const n = Math.floor(size / 2 / channels);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        let acc = 0;
        for (let c = 0; c < channels; c += 1) acc += buf.readInt16LE(offset + 8 + (i * channels + c) * 2) / 32768;
        out[i] = acc / channels;
      }
      return { samples: out, rate };
    }
    offset += 8 + size;
  }
  throw new Error("no data chunk");
}

/** YIN-style fundamental estimate over `size` samples starting at `start`. */
function pitchAt(x, rate, start, size = 2048) {
  const seg = x.subarray(start, start + size);
  const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
  const maxLag = Math.floor(rate / 50);
  const d = new Float64Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < seg.length - maxLag; i += 1) { const diff = (seg[i] - mean) - (seg[i + lag] - mean); sum += diff * diff; }
    d[lag] = sum;
  }
  let running = 0;
  for (let lag = 1; lag <= maxLag; lag += 1) {
    running += d[lag];
    const cmnd = (d[lag] * lag) / running;
    if (lag > 8 && cmnd < 0.1) {
      while (lag < maxLag && d[lag + 1] < d[lag]) lag += 1;
      const a = d[lag - 1], b = d[lag], c = d[lag + 1];
      const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
      return rate / (lag + shift);
    }
  }
  return NaN;
}

async function render(source, seconds, t) {
  const doc = parseSidwave(source);
  const { prg } = compileSidwaveToPrg(doc);
  const { sid } = compileSidwaveToSid(doc, prg);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidwave-audio-"));
  const sidPath = path.join(dir, "song.sid");
  const wavPath = path.join(dir, "song.wav");
  fs.writeFileSync(sidPath, sid);
  try {
    await runSidToWav({ sidPath, wavPath, mode: doc.song.mode === "NTSC" ? "ntsc" : "pal", limitCycles: seconds * 1_000_000 });
  } catch (error) {
    if (error instanceof SidplayExecutionError && error.exitCode === 127) {
      t.skip("sidplayfp not installed");
      return null;
    }
    throw error;
  }
  const pcm = readMonoPcm16(wavPath);
  fs.rmSync(dir, { recursive: true, force: true });
  return pcm;
}

/** Quiet stretches (AC level below 10% of the median), as [start, end] sample indices. */
function quietSpans(x, hop = 128) {
  const env = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let m = 0;
    for (let j = i; j < i + hop; j += 1) m += x[j];
    m /= hop;
    let v = 0;
    for (let j = i; j < i + hop; j += 1) v += (x[j] - m) ** 2;
    env.push(Math.sqrt(v / hop));
  }
  const loud = env.filter((e) => e > 0.01).sort((a, b) => a - b);
  const threshold = 0.1 * (loud[Math.floor(loud.length / 2)] ?? 0);
  const spans = [];
  let start = -1;
  env.forEach((e, i) => {
    if (e < threshold && start < 0) start = i;
    if (e >= threshold && start >= 0) { spans.push([start * hop, i * hop]); start = -1; }
  });
  return spans;
}

const cents = (hz, note) => 1200 * Math.log2(hz / midiToHz(noteNameToMidi(note)));

test("SIDWAVE audio: rendered notes have the written pitches, retriggers and rests", async (t) => {
  const notes = ["C4", "E4", "G4", "G4", "-", "A3", "C5", "D4"];
  const source = `sidwave: 1.0
title: Audio probe
tempo: 120
mode: PAL
voices:
  - id: 1
    waveform: sawtooth
    adsr: [0, 0, 15, 0]
    patterns:
      A: { groove: [${notes.map((n) => JSON.stringify(n)).join(", ")}] }
timeline:
  - { bars: 2, layers: { v1: A } }
`;
  const audio = await render(source, 7, t);
  if (!audio) return;
  const { samples, rate } = audio;
  const beat = 0.5 * rate;
  // sidplayfp starts after a randomised power-on delay, so the song position is recovered from the
  // quiet spans: every retrigger (and the rest) leaves one, and each ends where a new note starts.
  // The leading silence (sidplayfp's random power-on delay) is not a note gap: when the delay is
  // shorter than 1.2 beats it would otherwise shift the inferred song start by a beat.
  const spans = quietSpans(samples).filter(([a, b]) => a > 0 && b - a < 1.2 * beat);
  const ends = spans.map(([, b]) => b);
  const firstRetrigger = ends.find((e, i) => i + 1 < ends.length && Math.abs(ends[i + 1] - e - beat) < 0.02 * rate);
  assert.ok(firstRetrigger !== undefined, "retrigger gaps are one beat apart");
  const songStart = firstRetrigger - beat;
  const expectedOnsets = [1, 2, 3, 5, 6, 7].map((k) => songStart + k * beat);
  for (const onset of expectedOnsets) {
    const span = spans.find(([, b]) => Math.abs(b - onset) < 0.01 * rate);
    assert.ok(span, `a gap ends at the note onset ${(onset / rate).toFixed(3)} s; gaps: ${JSON.stringify(spans.map(([a, b]) => [+(a / rate).toFixed(3), +(b / rate).toFixed(3)]))}`);
  }
  // The repeated G4 (entries 2 and 3) is separated by the 2-frame hard restart: a gap of about 40 ms.
  const repeat = spans.find(([, b]) => Math.abs(b - (songStart + 3 * beat)) < 0.01 * rate);
  const gapMs = ((repeat[1] - repeat[0]) / rate) * 1000;
  assert.ok(gapMs > 25 && gapMs < 50, `retrigger gap ${gapMs.toFixed(1)} ms`);
  // The rest (entry 4) is silent from its start: gate off with release 0.
  const rest = spans.find(([, b]) => Math.abs(b - (songStart + 5 * beat)) < 0.01 * rate);
  assert.ok((rest[1] - rest[0]) / rate > 0.45, "the rest is silent for its whole beat");
  notes.forEach((note, k) => {
    if (note === "-") return;
    const hz = pitchAt(samples, rate, Math.round(songStart + k * beat + 0.2 * rate));
    assert.ok(Math.abs(cents(hz, note)) < 15, `entry ${k}: expected ${note}, measured ${hz.toFixed(1)} Hz (${cents(hz, note).toFixed(1)} cents)`);
  });
});
