import test from "#test/runner";
import assert from "#test/assert";
import { parseSidwave } from "../src/sidwave.js";
import { arrangeSidwave, compileSidwaveToPrg } from "../src/sidwaveCompiler.js";
import { playDoc } from "./helpers/sidwaveEmulator.mjs";

const lead = ({ version = "1.3", vibrato, speed = 1, groove = "A4 ~ ~ ~" }) => `
sidwave: ${version}
tempo: 60
speed: ${speed}
voices:
  - id: 1
    waveform: sawtooth
    adsr: [0, 0, 15, 0]
    patterns: { a: { groove: "${groove}", fx: { vibrato: ${vibrato} } } }
timeline: [{ bars: 1, layers: { v1: a } }]
end: true
`;

const frequencies = (source, calls) => playDoc(source, calls).calls.map((c) => c.regs[0] | (c.regs[1] << 8));

test("vibrato fade, a fade inside an instrument and a per-note vibrato require sidwave: 1.3", () => {
  assert.throws(() => parseSidwave(lead({ version: "1.2", vibrato: "{ depth: 1, rate: 5, fade: 20 }" })),
    /\$\.voices\[0\]\.patterns\.a\.fx\.vibrato\.fade: requires sidwave: 1\.3/);
  assert.throws(() => parseSidwave({ sidwave: 1.2, tempo: 120, instruments: { l: { vibrato: { depth: 1, rate: 5, fade: 9 } } },
    voices: [{ id: 1, instrument: "l", patterns: { a: { groove: ["C4"] } } }], timeline: [{ bars: 1, layers: { v1: "a" } }] }),
  /\$\.instruments\.l\.vibrato\.fade: requires sidwave: 1\.3/);
  assert.throws(() => parseSidwave({ sidwave: 1.2, tempo: 120,
    voices: [{ id: 1, patterns: { a: { groove: [{ note: "E5", vibrato: { depth: 0.5 } }] } } }], timeline: [{ bars: 1, layers: { v1: "a" } }] }),
  /\$\.voices\[0\]\.patterns\.a\.groove\[0\]\.vibrato: requires sidwave: 1\.3/);
  assert.throws(() => parseSidwave(lead({ vibrato: "{ depth: 1, rate: 5, fade: 0 }" })), /fade: 0 is below the minimum 1/);
  assert.throws(() => parseSidwave(lead({ vibrato: "{ depth: 1, rate: 5, fade: 256 }" })), /fade: 256 is above the maximum 255/);
});

test("the vibrato depth rises linearly from zero over fade frames after the delay, then holds", () => {
  const delay = 10;
  const fade = 40;
  const full = frequencies(lead({ vibrato: `{ depth: 1, rate: 5, delay: ${delay} }` }), 160);
  const faded = frequencies(lead({ vibrato: `{ depth: 1, rate: 5, delay: ${delay}, fade: ${fade} }` }), 160);
  const base = full[0];
  // The note starts on the first call; the vibrato starts after the delay.
  const start = full.findIndex((f) => f !== base);
  assert.ok(start > delay && start <= delay + 2, `vibrato starts at call ${start}`);
  assert.deepEqual(faded.slice(0, start), full.slice(0, start));
  const vibratoStart = start - 1;
  // From the fade's last frame on, the faded vibrato is the full vibrato.
  assert.deepEqual(faded.slice(vibratoStart + fade), full.slice(vibratoStart + fade));
  let previousRatio = 0;
  for (let k = 1; k < fade; k++) {
    const f = vibratoStart + k;
    const deviation = full[f] - base;
    if (Math.abs(deviation) < 60) continue;
    const ratio = (faded[f] - base) / deviation;
    // Depth k / fade, less the player's 1/128 triangle and 1/256 level resolution.
    assert.ok(Math.abs(ratio - k / fade) < 0.06, `call ${k}: depth ratio ${ratio.toFixed(3)}, expected ${(k / fade).toFixed(3)}`);
    assert.ok(ratio >= previousRatio - 0.02, "the depth does not fall during the fade");
    previousRatio = ratio;
  }
  assert.ok(
    faded.slice(vibratoStart, vibratoStart + fade).some((value, index) => value !== full[vibratoStart + index]),
    "the vibrato fade interval differs from the full-depth interval",
  );
});

test("the fade counts video frames at every speed", () => {
  const full = frequencies(lead({ speed: 2, vibrato: "{ depth: 1, rate: 5 }" }), 200);
  const faded = frequencies(lead({ speed: 2, vibrato: "{ depth: 1, rate: 5, fade: 30 }" }), 200);
  const differs = faded.map((f, i) => f !== full[i]);
  const last = differs.lastIndexOf(true);
  // 30 frames are 60 calls at speed 2; the first vibrato call has zero depth in both runs.
  assert.ok(last >= 50 && last < 61, `the fade ends at call ${last}`);
  const instrument = arrangeSidwave(parseSidwave(lead({ speed: 2, vibrato: "{ depth: 1, rate: 5, fade: 30 }" }))).instruments[1];
  assert.equal(instrument.vibFade, Math.ceil(65536 / 60));
});

test("the 16-bit fade level reaches full depth on exactly the last call for fades up to 256 calls", () => {
  for (let calls = 1; calls <= 256; calls++) {
    const step = Math.ceil(65536 / calls);
    assert.equal(Math.ceil(65536 / step), calls);
  }
  // Longer fades (speed above 1) finish at most 15 calls early, at 1,020 calls.
  let worst = 0;
  for (let calls = 257; calls <= 1020; calls++) worst = Math.max(worst, calls - Math.ceil(65536 / Math.ceil(65536 / calls)));
  assert.equal(worst, 15);
});

test("a per-note vibrato merges over the instrument vibrato and becomes its own instrument", () => {
  const doc = parseSidwave({
    sidwave: 1.3, tempo: 120,
    instruments: { l: { waveform: "sawtooth", vibrato: { depth: 0.2, rate: 5, delay: 6 } } },
    voices: [{ id: 1, instrument: "l", patterns: { a: { groove: ["C5", { note: "E5", vibrato: { depth: 0.5, fade: 30 } }, "G5", "C6"] } } }],
    timeline: [{ bars: 1, layers: { v1: "a" } }],
  });
  const arr = arrangeSidwave(doc);
  const [plain, swelling] = arr.voices[0].notes.slice(0, 2).map((n) => arr.instruments[n.inst]);
  assert.equal(plain.vibFade, undefined);
  assert.equal(swelling.vibFade, Math.ceil(65536 / 30));
  assert.equal(swelling.vibRate, plain.vibRate);
  assert.equal(swelling.vibDelay, plain.vibDelay);
  assert.ok(swelling.vibUp[0] !== plain.vibUp[0] || swelling.vibUp[1] !== plain.vibUp[1], "the depth comes from the note");
  assert.throws(() => arrangeSidwave(parseSidwave({ sidwave: 1.3, tempo: 120,
    voices: [{ id: 1, patterns: { a: { groove: [{ note: "E5", vibrato: { depth: 0.5 } }] } } }], timeline: [{ bars: 1, layers: { v1: "a" } }] })),
  /\$\.timeline\[0\]\.layers\.v1\.vibrato: a per-note vibrato needs depth and rate/);
});

/** Six voices on two SIDs start notes with a fading vibrato on the same call, so the fades run together. */
const fadeBudget = (fade) => `
sidwave: 1.3
title: Fade budget
tempo: 125
speed: 2
cpu: turbo
sids:
  - { id: a, address: "$D400" }
  - { id: b, address: "$D420" }
instruments:
  v: { waveform: pulse, adsr: [0, 4, 12, 4], vibrato: { depth: 0.6, rate: 6, delay: 2${fade} }, slide: { depth: 2, speed: 6 } }
voices:
${[1, 2, 3, 4, 5, 6].map((id) => `  - { id: ${id}, instrument: v, patterns: { m: { length: 0.5, groove: "C4 E4 G4 C5 B4 G4 E4 D4" } } }`).join("\n")}
timeline: [{ bars: 4, layers: { v1: m, v2: m, v3: m, v4: m, v5: m, v6: m } }]
end: true
`;

test("budget: the cycle estimate stays an upper bound with six fading vibratos and covers the added cost", () => {
  const measure = (fade) => {
    const total = compileSidwaveToPrg(parseSidwave(fadeBudget(fade))).totalFrames;
    const run = playDoc(fadeBudget(fade), total + 4);
    return { peak: Math.max(...run.calls.map((c) => c.cycles)), estimate: run.compiled.worstCaseCyclesPerCall, bytes: run.compiled.prg.length };
  };
  const plain = measure("");
  const faded = measure(", fade: 200");
  assert.ok(faded.peak <= faded.estimate, `measured ${faded.peak} cycles exceeds the estimate ${faded.estimate}`);
  assert.ok(faded.peak > plain.peak, "the fade costs cycles");
  assert.ok(faded.estimate - plain.estimate >= faded.peak - plain.peak, "the estimate grows at least by the measured cost");
  // 66 bytes of player code, two step bytes per instrument and three state bytes per channel.
  const instruments = arrangeSidwave(parseSidwave(fadeBudget(", fade: 200"))).instruments.length;
  assert.equal(faded.bytes - plain.bytes, 66 + 2 * instruments + 3 * 6);
  console.log(`vibrato fade: peak ${plain.peak} -> ${faded.peak} cycles, estimate ${plain.estimate} -> ${faded.estimate}, PRG ${plain.bytes} -> ${faded.bytes} bytes`);
});

test("the schema lists the vibrato fade and the per-note vibrato", async () => {
  const fs = await import("node:fs");
  const schema = JSON.parse(fs.readFileSync(new URL("../data/sound/sidwave.schema.json", import.meta.url), "utf8"));
  assert.ok(schema.$defs.vibrato.properties.fade);
  assert.equal(schema.$defs.fx.properties.vibrato.$ref, "#/$defs/vibrato");
  assert.equal(schema.$defs.instrument.properties.vibrato.$ref, "#/$defs/vibrato");
  assert.equal(schema.$defs.grooveEntry.properties.vibrato.$ref, "#/$defs/vibrato");
});
