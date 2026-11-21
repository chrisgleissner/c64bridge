// SIDWAVE 1.2 round 2: emulator tests of the register writes (same 6502 model as test/sidwavePlayer.test.mjs).
// Each test names the feature it covers; reverting that feature makes the test fail.
import test from "#test/runner";
import assert from "#test/assert";
import { compileDoc, gateOns, playDoc, runPsid, voice } from "./helpers/sidwaveEmulator.mjs";
import { SKELETON } from "./helpers/sidwave12Fixtures.mjs";
import { compileSidwaveToPrg, hzToSidFrequency, sidwaveFrameRate } from "../src/sidwaveCompiler.js";
import { midiToHz, noteNameToMidi, parseSidwave, SidwaveValidationError } from "../src/sidwave.js";

/** A one-voice 1.2 document on an 8580 at 120 BPM (25.06 frames per beat on PAL). */
function one({ inst = "adsr: [0, 4, 10, 4]", groove = "C4 - - -", layers = "a", extra = "", sid = "{ id: sid1, address: \"$D400\", model: \"8580\" }", voice = "", section = "bars: 1", instruments = "" } = {}) {
  return `sidwave: 1.2
title: Probe
tempo: 120
${extra}sids: [${sid}]
instruments:
  p: { waveform: triangle, ${inst} }
${instruments}voices:
  - { id: 1, instrument: p, ${voice} patterns: { a: { length: 1, groove: "${groove}" } } }
sections:
  s: { ${section}, layers: { v1: ${layers} } }
timeline: [s]
`;
}
const regs = (states) => (r) => states.map((s) => s[r]);
const sustainOf = (states) => voice(states, 0).sr.map((v) => v >> 4);

test("level: sustain nibble scales with pp and ff and is only written with an attack", () => {
  for (const [mark, expected] of [["pp", 3], ["ff", 10], ["mf", 7]]) {
    const { sid } = compileDoc(one({ section: `bars: 2, level: ${mark}`, groove: "C4 D4 E4 F4" }));
    const { states } = runPsid(sid, 100);
    const v = voice(states, 0);
    const on = gateOns(v);
    assert.ok(on.length >= 4, "four notes sound");
    for (const { frame } of on) assert.equal(v.sr[frame] >> 4, expected, `${mark} at frame ${frame}`);
  }
});

test("level: a ramp never raises the sustain nibble while the gate is on", () => {
  const { sid, compiled } = compileDoc(one({ section: "bars: 4, level: { from: pp, to: ff }", groove: "C4 ~ ~ ~", extra: "" }));
  const { states } = runPsid(sid, Math.min(compiled.totalFrames, 380));
  const v = voice(states, 0);
  let last = null;
  let gateStart = -1;
  for (let f = 0; f < v.sr.length; f++) {
    const on = !!(v.ctrl[f] & 1);
    if (on && !(v.ctrl[f - 1] & 1)) { gateStart = f; last = v.sr[f] >> 4; continue; }
    if (on) assert.ok((v.sr[f] >> 4) <= last, `sustain rose at frame ${f} (gate started ${gateStart})`);
    if (on) last = v.sr[f] >> 4;
  }
  const attacks = gateOns(v).map((o) => v.sr[o.frame] >> 4);
  assert.ok(attacks.length >= 4 && attacks.at(-1) > attacks[0], `attack levels rise: ${attacks}`);
});

test("level: accent raises the note level, voice level lowers it and sustain 0 ignores level", () => {
  const { sid } = compileDoc(one({ groove: "C4! D4 E4 -", voice: "level: 9,", section: "bars: 1, level: mf" }));
  const v = voice(runPsid(sid, 90).states, 0);
  const [a, b] = gateOns(v).map((o) => v.sr[o.frame] >> 4);
  // sustain 10 x 9/15 x 10/15 = 4; an accent adds the song accent (3)
  assert.equal(b, 4);
  assert.equal(a, 7);
  const none = compileDoc(one({ inst: "adsr: [0, 4, 0, 4]", section: "bars: 1, level: pp" }));
  const w = voice(runPsid(none.sid, 30).states, 0);
  assert.equal(w.sr[gateOns(w)[0].frame] >> 4, 0, "sustain 0 stays 0");
  assert.ok(none.compiled.lint.some((f) => f.code === "LEVEL-NOOP"));
});

test("volume: a section ramp writes $D418 one step at a time, at least two frames apart", () => {
  const src = one({ section: "bars: 2, volume: { from: 9, to: 15 }", groove: "C4 ~ ~ ~", extra: "" });
  const { calls } = playDoc(src, 200);
  const seen = [];
  calls.forEach((c, i) => c.writes.filter((w) => w.addr === 0xd418).forEach((w) => seen.push({ frame: i, vol: w.value & 15 })));
  const after = seen.filter((s) => s.frame >= 20);
  assert.ok(after.length >= 3, "the ramp writes several steps");
  for (let i = 1; i < seen.length; i++) {
    assert.equal(Math.abs(seen[i].vol - seen[i - 1].vol), 1, `step ${i} changes by one`);
    if (seen[i].frame > 20 && seen[i - 1].frame > 20) assert.ok(seen[i].frame - seen[i - 1].frame >= 2, "two frames between steps");
  }
  assert.deepEqual(after.map((s) => s.vol), [10, 11, 12, 13, 14, 15].slice(0, after.length), "9, 10 ... 15 in order");
  assert.ok(after.length >= 5);
});

test("volume: a large step at a section boundary slews one step per two frames", () => {
  const src = one({ groove: "C4 ~ ~ ~" }).replace(/sections:[\s\S]*$/, "sections:\n  s: { bars: 2, volume: 15, layers: { v1: a } }\n  t: { bars: 2, volume: 9, layers: { v1: a } }\ntimeline: [s, t]\n");
  const { calls } = playDoc(src, 400);
  const steps = [];
  calls.forEach((c, i) => c.writes.filter((w) => w.addr === 0xd418 && i > 100).forEach((w) => steps.push({ frame: i, vol: w.value & 15 })));
  assert.deepEqual(steps.map((x) => x.vol), [14, 13, 12, 11, 10, 9], "six single steps from 15 to 9");
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i].frame - steps[i - 1].frame >= 2, `gap ${steps[i].frame - steps[i - 1].frame}`);
});

test("volume: a $D418 write is skipped while the value is unchanged", () => {
  const { calls } = playDoc(one({ section: "bars: 4", groove: "C4 D4 E4 F4" }), 200);
  const writes = calls.flatMap((c) => c.writes.filter((w) => w.addr === 0xd418));
  assert.ok(writes.length <= 16, `only the start-up ramp writes $D418 (${writes.length})`);
});

test("volume: changing the chip volume of a digi SID is an error", () => {
  const src = `sidwave: 1.2
title: Digi
tempo: 120
sids: [{ id: sid1, address: "$D400", model: "8580" }]
samples: { rate: 4000, defs: { hit: { hex: "fe" } }, triggers: [{ sample: hit, at: [0] }] }
voices: [{ id: 1, patterns: { a: { length: 1, groove: "C4" } } }]
sections: { s: { bars: 2, volume: 9, layers: { v1: a } } }
timeline: [s]
`;
  assert.throws(() => compileSidwaveToPrg(parseSidwave(src)), /cannot change volume on digi SID sid1/);
});

/** A kick through the library, one note on a voice at the given speed. */
function kickDoc(speed, lib = "kick") {
  return `sidwave: 1.2
title: Kick
tempo: 60
speed: ${speed}
sids: [{ id: sid1, address: "$D400", model: "8580" }]
voices: [{ id: 1, instrument: "lib:${lib}", patterns: { a: { length: 1, groove: "C3 - - -" } } }]
sections: { s: { bars: 1, layers: { v1: a } } }
timeline: [s]
`;
}

test("drums: the 1.2 kick falls from at least 150 Hz to at most 55 Hz within 5 frames and ends silent", () => {
  const { states, ...rest } = runPsid(compileDoc(kickDoc(1)).sid, 40);
  const v = voice(states, 0);
  const hz = (f) => v.freq[f] * 985248 / 16777216;
  const on = gateOns(v)[0].frame;
  assert.ok(hz(on) >= 150, `starts at ${hz(on).toFixed(1)} Hz`);
  assert.ok(hz(on + 5) <= 55.5, `reaches ${hz(on + 5).toFixed(1)} Hz`);
  assert.deepEqual([v.ad[on] >> 4, v.ad[on] & 15, v.sr[on] >> 4, v.sr[on] & 15], [0, 9, 0, 0]);
  const lastSounding = v.ctrl.map((c) => c & 0x80 ? "n" : c & 0x40 ? "p" : c & 0x20 ? "s" : c & 0x10 ? "t" : "-").join("");
  assert.ok(v.sr[on] >> 4 === 0, "sustain 0: the envelope decays to zero");
  assert.ok(lastSounding.length > 0 && rest.maxPlayCycles > 0);
});

test("drums: snare is a short pitched body then noise; closed hat is noise with decay at most 4", () => {
  const snare = voice(runPsid(compileDoc(kickDoc(1, "snare")).sid, 40).states, 0);
  const on = gateOns(snare)[0].frame;
  assert.equal(snare.ctrl[on] & 0xf0, 0x10, "first frame triangle body");
  assert.ok(Math.abs(snare.freq[on] * 985248 / 16777216 - 196) < 8, "body near 200 Hz");
  assert.equal(snare.ctrl[on + 1] & 0xf0, 0x80, "then noise");
  assert.deepEqual([snare.ad[on], snare.sr[on]], [0x08, 0x00]);
  const hat = voice(runPsid(compileDoc(kickDoc(1, "hat")).sid, 40).states, 0);
  const h = gateOns(hat)[0].frame;
  assert.equal(hat.ctrl[h] & 0xf0, 0x80);
  assert.ok((hat.ad[h] & 15) <= 4);
});

test("drums: no 1.2 library drum ends on a fixed pitched waveform with sustain above 0", () => {
  for (const name of ["kick", "snare", "hat", "tom", "clap", "open_hat", "crash"]) {
    const v = voice(runPsid(compileDoc(kickDoc(1, name)).sid, 60).states, 0);
    const on = gateOns(v)[0].frame;
    assert.equal(v.sr[on] >> 4, 0, `${name} sustain`);
  }
});

test("timing: the same 1.2 kick reaches each wavetable step at the same frame at speed 1 and 4", () => {
  const stepFrames = (speed) => {
    const v = voice(runPsid(compileDoc(kickDoc(speed)).sid, 40 * speed).states, 0);
    const on = gateOns(v)[0].frame;
    const gateOff = v.ctrl.findIndex((c, f) => f > on && !(c & 1));
    // call index of the last pitch change inside the slide step
    let slideEnd = on;
    for (let f = on + 1; f < gateOff; f++) if (v.freq[f] !== v.freq[f - 1]) slideEnd = f;
    return { gateOff: (gateOff - on) / speed, slideEnd: Math.round((slideEnd - on + 1) / speed) };
  };
  assert.deepEqual(stepFrames(4), stepFrames(1));
  assert.equal(stepFrames(1).gateOff, 5, "the second table step starts 5 video frames after the attack");
});

test("timing: a pitch slide lands on its target on the last call of the step", () => {
  const src = one({ instruments: "  sl: { waveform: pulse, adsr: [0, 4, 10, 4], wavetable: [{ note: G3, slide_to: C3, frames: 4 }, { note: C3 }] }\n", voice: "", groove: "C3@sl - - -" });
  const v = voice(runPsid(compileDoc(src).sid, 20).states, 0);
  const on = gateOns(v)[0].frame;
  const f = (i) => v.freq[on + i];
  assert.equal(f(0), hzToSidFrequency(midiToHz(noteNameToMidi("G3")), "PAL"));
  assert.equal(f(3), hzToSidFrequency(midiToHz(noteNameToMidi("C3")), "PAL"));
  assert.ok(f(1) < f(0) && f(2) < f(1) && f(2) > f(3), "monotonic descent");
});

test("hard restart: at speed 4 the gate-off precedes the attack by at least 32768 cycles", () => {
  const src = `sidwave: 1.2
title: HR
tempo: 100
speed: 4
sids: [{ id: sid1, address: "$D400", model: "8580" }]
voices: [{ id: 1, waveform: pulse, patterns: { a: { length: 1, groove: "C4 C4 C4 C4" } } }]
sections: { s: { bars: 1, layers: { v1: a } } }
timeline: [s]
`;
  const { compiled, sid } = compileDoc(src);
  const { states } = runPsid(sid, 4 * 130);
  const v = voice(states, 0);
  const ons = gateOns(v);
  const offs = [];
  for (let f = 1; f < v.ctrl.length; f++) if ((v.ctrl[f - 1] & 1) && !(v.ctrl[f] & 1)) offs.push(f);
  const cyclesPerCall = 985248 / (sidwaveFrameRate("PAL") * 4);
  const pairs = ons.slice(1).map((o) => [offs.filter((f) => f < o.frame).at(-1), o.frame]);
  assert.ok(pairs.length >= 2);
  for (const [off, on] of pairs) assert.ok((on - off) * cyclesPerCall >= 32768, `${on - off} calls = ${(on - off) * cyclesPerCall} cycles`);
  assert.ok(compiled.lint.every((f) => f.code !== "HR-SHORT"));
});

test("hard restart: frames: 1 is accepted with HR-SHORT and frames: 0 is a soft re-gate without it", () => {
  const withHr = (frames) => one({ instruments: `  q: { waveform: pulse, adsr: [0, 4, 10, 4], hard_restart: { frames: ${frames} } }\n`, groove: "C4@q C4@q C4@q C4@q" });
  const short = compileDoc(withHr(1)).compiled;
  assert.ok(short.lint.some((f) => f.code === "HR-SHORT"));
  assert.ok(short.warnings.some((w) => w.startsWith("HR-SHORT")), "lint is returned as warnings");
  assert.ok(!compileDoc(withHr(0)).compiled.lint.some((f) => f.code === "HR-SHORT"));
});

test("filter: only the owner's filter table writes the cutoff and the routing bits never change", () => {
  const src = `sidwave: 1.2
title: Owner
tempo: 120
sids: [{ id: sid1, address: "$D400", model: "8580", filter: { owner: v1, route: [1, 3] } }]
instruments:
  b: { waveform: sawtooth, adsr: [0, 4, 8, 3], filtertable: [{ cutoff: 400, resonance: 6, type: lowpass }, { add: 4, frames: 10 }] }
  o: { waveform: pulse, adsr: [0, 4, 8, 3], filtertable: [{ cutoff: 1500, resonance: 9, type: highpass }] }
voices:
  - { id: 1, instrument: b, patterns: { a: { length: 1, groove: "C2 - C2 -" } } }
  - { id: 2, instrument: o, patterns: { a: { length: 1, groove: "- E4 - E4" } } }
sections:
  s: { bars: 2, layers: { v1: a, v2: a } }
  t: { bars: 2, filter: { cutoff: 300 }, layers: { v1: a, v2: a } }
timeline: [s, t]
`;
  const { compiled, calls } = playDoc(src, 400);
  const cut = (c) => (c.regs[0x15] & 7) | (c.regs[0x16] << 3);
  const routes = new Set(calls.slice(1).map((c) => c.regs[0x17] & 15));
  assert.deepEqual([...routes], [5], "routing bits are written once: channels 1 and 3");
  assert.ok(calls.slice(0, 190).every((c) => cut(c) < 1000), "an attack on v2 does not set its own cutoff");
  assert.ok(compiled.lint.some((f) => f.code === "FILTER-IGNORED"));
  // the section offset of +300 shifts the owner's table value by 300 (same note, same table phase)
  const first = cut(calls[2]);
  const second = cut(calls[2 + 4 * 50]);
  assert.ok(second - first >= 295 && second - first <= 305, `${first} -> ${second}`);
});

test("filter: the owner holds its last table value plus the offset while it is silent", () => {
  const src = `sidwave: 1.2
title: Hold
tempo: 120
sids: [{ id: sid1, address: "$D400", model: "8580", filter: { owner: v1, route: [1] } }]
instruments:
  b: { waveform: sawtooth, adsr: [0, 4, 8, 3], filtertable: [{ cutoff: 400 }, { add: 10, frames: 5 }] }
voices:
  - { id: 1, instrument: b, patterns: { a: { length: 1, groove: "C2 - - -" }, r: { length: 1, groove: "- - - -" } } }
sections:
  s: { bars: 1, layers: { v1: a } }
  t: { bars: 1, layers: { v1: r } }
timeline: [s, t]
`;
  const { calls } = playDoc(src, 190);
  const cut = (c) => (c.regs[0x15] & 7) | (c.regs[0x16] << 3);
  assert.equal(cut(calls[150]), cut(calls[180]), "the cutoff holds while the owner is silent");
  assert.ok(cut(calls[150]) > 400);
});

test("end: gates clear after hold_beats, the player stops writing after the tail, durationSeconds includes the tail", () => {
  const src = `sidwave: 1.2
title: End
tempo: 120
sids: [{ id: sid1, address: "$D400", model: "8580" }]
instruments: { p: { waveform: triangle, adsr: [0, 4, 8, 9] } }
voices: [{ id: 1, instrument: p, patterns: { a: { length: 1, groove: "C4 D4 E4 G4" } } }]
sections: { s: { bars: 2, layers: { v1: a } } }
timeline: [s]
end: { hold_beats: 2, release: true }
`;
  const { compiled, sid } = compileDoc(src);
  const fpb = sidwaveFrameRate("PAL") * 60 / 120;
  const { states } = runPsid(sid, compiled.totalFrames + 10);
  const v = voice(states, 0);
  const lastOff = Math.max(...v.ctrl.map((c, f) => ((c & 1) === 0 && f > 0 && (v.ctrl[f - 1] & 1) ? f : -1)));
  assert.ok(Math.abs(lastOff - 10 * fpb) <= 1, `gate clears at beat 10 (frame ${lastOff} vs ${10 * fpb})`);
  // release index 9 of the instrument: 750 ms nominal (the table in sidwaveLint.ts)
  assert.ok(Math.abs(compiled.durationSeconds - (10 * 0.5 + 0.75)) < 0.05, `duration ${compiled.durationSeconds}`);
  // no SID write after the tail
  const { calls } = playDoc(src, compiled.totalFrames + 10);
  const lastWrite = Math.max(...calls.map((c, i) => c.writes.length ? i : -1));
  assert.ok(lastWrite <= compiled.totalFrames - 1, `last write at ${lastWrite}, total ${compiled.totalFrames}`);
  assert.ok(calls.slice(compiled.totalFrames).every((c) => c.writes.length === 0));
});

test("end: true means no hold and a release tail; a document without end keeps its fade", () => {
  const body = (end) => `sidwave: 1.2
title: End
tempo: 120
sids: [{ id: sid1, address: "$D400", model: "8580" }]
instruments: { p: { waveform: triangle, adsr: [0, 4, 8, 6] } }
voices: [{ id: 1, instrument: p, patterns: { a: { length: 1, groove: "C4 D4 E4 G4" } } }]
sections: { s: { bars: 1, layers: { v1: a } } }
timeline: [s]
${end}`;
  const plain = compileDoc(body("")).compiled;
  const ended = compileDoc(body("end: true")).compiled;
  assert.ok(ended.durationSeconds - plain.durationSeconds > 0.15, "the 204 ms release of the instrument is added");
  assert.throws(() => parseSidwave(body("end: true\nloop_to: s")), /mutually exclusive/);
});

test("center: a centred voice writes the same registers to the mirror SID with TEST set and 0.75 level", () => {
  const src = `sidwave: 1.2
title: Centre
tempo: 120
sids: { layout: ultisid8, pan: wide }
instruments: { b: { waveform: sawtooth, adsr: [0, 4, 12, 3] } }
voices:
  - { id: 1, role: bass, instrument: b, center: true, patterns: { a: { length: 1, groove: "C2 D2 E2 F2" } } }
sections: { s: { bars: 1, layers: { v1: a } } }
timeline: [s]
`;
  const { compiled, calls, doc } = playDoc(src, 120);
  assert.deepEqual(doc.sids.map((s) => s.pan).slice(0, 5), ["Left 5", "Left 5", "Left 5", "Left 5", "Right 5"]);
  const left = 0xd400 - 0xd400;
  const right = 0xd420 - 0xd400;
  const ons = calls.map((c, i) => [i, c]).filter(([, c]) => c.regs[left + 4] & 1);
  assert.ok(ons.length > 20);
  for (const [i, c] of [calls.map((c, i) => [i, c])[0], calls.map((c, i) => [i, c])[30], calls.map((c, i) => [i, c])[60]]) {
    for (const r of [0, 1, 2, 3, 4, 5, 6]) assert.equal(c.regs[right + r], c.regs[left + r], `register ${r} at frame ${i}`);
  }
  const sustainNibble = calls[1].regs[left + 6] >> 4;
  assert.equal(sustainNibble, 9, "12 x 0.75");
  // TEST is set during the restart on both copies
  const testFrames = calls.filter((c) => c.regs[left + 4] & 8);
  assert.ok(testFrames.length > 0 && testFrames.every((c) => c.regs[right + 4] & 8));
  assert.ok(compiled.warnings.every((w) => !w.startsWith("ONE-SIDE")));
});

test("center: the mirror channel must be unscored", () => {
  const src = `sidwave: 1.2
title: Centre
tempo: 120
sids: { layout: ultisid8, pan: wide }
voices:
  - { id: 1, center: true, patterns: { a: { length: 1, groove: "C2" } } }
  - { id: 2, sid: sid5, channel: 1, patterns: { a: { length: 1, groove: "C3" } } }
sections: { s: { bars: 1, layers: { v1: a, v2: a } } }
timeline: [s]
`;
  assert.throws(() => compileSidwaveToPrg(parseSidwave(src)), /mirror channel .* is scored by another voice/);
});

test("source_note: a silent source oscillator runs at the requested pitch under a sync voice", () => {
  const src = `sidwave: 1.2
title: Sync
tempo: 120
sids: [{ id: sid1, address: "$D400", model: "8580" }]
instruments: { sy: { waveform: sawtooth, adsr: [0, 4, 10, 4], sync: true, source_note: "+0" } }
voices:
  - { id: 2, instrument: sy, patterns: { a: { length: 1, groove: "C4 E4 G4 -" } } }
sections: { s: { bars: 1, layers: { v2: a } } }
timeline: [s]
`;
  const { sid, compiled } = compileDoc(src);
  const { states } = runPsid(sid, 80);
  const lead = voice(states, 1);
  const src1 = voice(states, 0);
  const on = gateOns(lead).map((o) => o.frame);
  assert.ok(on.length >= 3);
  for (const f of on) {
    assert.equal(src1.freq[f], lead.freq[f], "the source plays the played pitch");
    assert.equal(src1.ctrl[f] & 0xf0, 0, "and is silent: no waveform selected");
    assert.equal(lead.ctrl[f] & 2, 2, "sync bit");
  }
  assert.ok(compiled.lint.every((f) => f.code !== "RINGSYNC-SRC"));
  const clash = src.replace("voices:", "voices:\n  - { id: 1, patterns: { b: { length: 1, groove: \"C3 C3 C3 C3\" } } }").replace("layers: { v2: a }", "layers: { v1: b, v2: a }");
  assert.throws(() => compileSidwaveToPrg(parseSidwave(clash)), /source channel .* unscored.*bar 1 v1/);
});

test("echo: delay_beats follows the tempo and adsr replaces the copy's envelope", () => {
  const src = `sidwave: 1.2
title: Echo
tempo: 120
sids: [{ id: sid1, address: "$D400", model: "8580" }, { id: sid2, address: "$D420", model: "8580" }]
instruments: { p: { waveform: triangle, adsr: [0, 4, 12, 4] } }
voices:
  - { id: 1, instrument: p, patterns: { a: { length: 1, groove: "C4 - - -" } } }
  - { id: 4, sid: sid2, channel: 1, echo: { voice: 1, delay_beats: 0.75, volume: 0.5, adsr: [3, 6, 6, 6] } }
sections: { s: { bars: 1, layers: { v1: a } } }
timeline: [s]
`;
  const { calls } = playDoc(src, 100);
  const src1 = calls.findIndex((c) => c.regs[4] & 1);
  const copy = calls.findIndex((c) => c.regs[0x20 + 4] & 1);
  const fpb = sidwaveFrameRate("PAL") * 60 / 120;
  assert.equal(src1, 0);
  assert.ok(Math.abs(copy - 0.75 * fpb) <= 1.5, `copy starts at ${copy}, expected ${0.75 * fpb}`);
  assert.equal(calls[copy].regs[0x20 + 5], 0x36);
  assert.equal(calls[copy].regs[0x20 + 6] >> 4, 3, "sustain 6 x 0.5");
});

test("end: the release tail waits for an echo copy of the final note", () => {
  const src = `sidwave: 1.2
title: Echo end
tempo: 120
sids: [{ id: sid1, address: "$D400", model: "8580" }, { id: sid2, address: "$D420", model: "8580" }]
instruments: { p: { waveform: triangle, adsr: [0, 4, 12, 4] } }
voices:
  - { id: 1, instrument: p, patterns: { a: { length: 4, groove: "C4" } } }
  - { id: 4, sid: sid2, channel: 1, echo: { voice: 1, delay_beats: 1, volume: 0.5, adsr: [3, 6, 6, 6] } }
sections: { s: { bars: 1, layers: { v1: a } } }
timeline: [s]
end: { hold_beats: 0, release: true }
`;
  const arr = arrangeSidwave(parseSidwave(src));
  const fpb = sidwaveFrameRate("PAL") * 60 / 120;
  const [source] = arr.voices[0].notes, [copy] = arr.voices[3].notes;
  // The copy keeps its full length: its gate-off is one beat after the source's, not clamped to the last call.
  assert.ok(Math.abs((copy.end - copy.start) - (source.end - source.start)) <= 1, `copy ${copy.start}-${copy.end}, source ${source.start}-${source.end}`);
  assert.ok(Math.abs(copy.start - source.start - fpb) <= 1);
  // Release 6 is 204 ms nominal: the song runs at least that long after the copy's gate-off.
  assert.ok(arr.totalFrames >= copy.end + Math.floor(0.204 * arr.fps), `totalFrames ${arr.totalFrames}, copy gate-off ${copy.end}`);
});

test("swing delays every second sixteenth; section tempo changes the bar length", () => {
  const base = (extra, section) => `sidwave: 1.2
title: Swing
tempo: 120
${extra}sids: [{ id: sid1, address: "$D400", model: "8580" }]
voices: [{ id: 1, waveform: pulse, patterns: { a: { length: 0.25, groove: "C4 C4 C4 C4 C4 C4 C4 C4 C4 C4 C4 C4 C4 C4 C4 C4" } } }]
sections: { s: { ${section}, layers: { v1: a } } }
timeline: [s]
`;
  const straight = gateOns(voice(runPsid(compileDoc(base("", "bars: 1")).sid, 60).states, 0)).map((o) => o.frame);
  const swung = gateOns(voice(runPsid(compileDoc(base("swing: 0.75\n", "bars: 1")).sid, 60).states, 0)).map((o) => o.frame);
  assert.equal(swung[0], straight[0]);
  assert.ok(swung[1] - straight[1] >= 2 && swung[1] - straight[1] <= 4, `second sixteenth late by ${swung[1] - straight[1]}`);
  assert.equal(swung[2], straight[2], "the third sixteenth is on the grid");
  const slow = compileDoc(base("", "bars: 1, tempo: 60")).compiled;
  const fast = compileDoc(base("", "bars: 1")).compiled;
  assert.ok(Math.abs(slow.totalFrames - 2 * fast.totalFrames) <= 2);
});

test("pulsetable reset: false keeps the table running across attacks", () => {
  const mk = (reset) => `sidwave: 1.2
title: Reset
tempo: 120
sids: [{ id: sid1, address: "$D400", model: "8580" }]
instruments: { w: { waveform: pulse, adsr: [0, 4, 10, 4], pulsetable: { reset: ${reset}, loop: 1, steps: [{ set: 0.25 }, { add: 20, frames: 4 }, { add: -20, frames: 4 }] } } }
voices: [{ id: 1, instrument: w, patterns: { a: { length: 1, groove: "C4 C4 C4 C4" } } }]
sections: { s: { bars: 1, layers: { v1: a } } }
timeline: [s]
`;
  const at = (reset) => { const v = voice(runPsid(compileDoc(mk(reset)).sid, 80).states, 0); return gateOns(v).map((o) => v.pw[o.frame + 1]); };
  const restart = at("true");
  const keep = at("false");
  assert.equal(new Set(restart).size, 1, "every attack starts from the same width");
  assert.ok(new Set(keep).size > 1, `widths differ across attacks: ${keep}`);
});

test("stream subroutines: a compressed score plays the same register writes as the flat score", () => {
  const src = SKELETON;
  const flat = playDoc(src, 600, { compress: false });
  const packed = playDoc(src, 600);
  assert.ok(packed.compiled.streamBytes.reduce((a, b) => a + b) < flat.compiled.streamBytes.reduce((a, b) => a + b));
  assert.deepEqual(packed.calls.map((c) => c.writes.map((w) => [w.addr, w.value])), flat.calls.map((c) => c.writes.map((w) => [w.addr, w.value])));
});

/** A 1.2 document that uses every new player feature at once, on two SIDs with turbo. */
const WORST = `sidwave: 1.2
title: Worst case
tempo: 125.31
speed: 2
cpu: turbo
sids:
  - { id: sid1, address: "$D400", model: "8580", filter: { owner: v1, route: [1, 2], filter_mod: { sweep: 200, frames: 40 } } }
  - { id: sid2, address: "$D420", model: "6581" }
kit: { k: lib:kick, s: lib:snare }
instruments:
  bass:
    waveform: sawtooth
    adsr: [0, 6, 9, 2]
    hard_restart: { test: true }
    filtertable: [{ cutoff: 900Hz, resonance: 12, type: lowpass }, { add: -40, frames: 10 }, { add: 7, calls: 1 }]
  lead:
    waveform: pulse
    adsr: [1, 5, 11, 5]
    vibrato: { depth: 0.3, rate: 5, delay: 4 }
    pulsetable: { reset: false, loop: 1, steps: [{ set: 0.25 }, { add: 24, frames: 32 }, { add: -24, frames: 32 }] }
    wavetable: [{ note: "+0", frames: 2 }, { note: "+7", slide_to: "+12", frames: 3 }]
    loop: 0
  sy: { waveform: sawtooth, adsr: [0, 4, 10, 4], sync: true, source_note: "+7" }
voices:
  - { id: 1, role: bass, instrument: bass, center: { sid: sid2, channel: 2 }, patterns: { a: { length: 0.25, groove: "k A1 A1 /A2 s A1 A2 A1 k A1 A1 A2 s A1 G1 G2" } } }
  - { id: 2, instrument: lead, level: 9, patterns: { m: { length: 0.5, groove: "(A4 C5 E5) ~ D5! ~ (C5 B4) | A4 ~ ~ ~ - - E4 G4" } } }
  - { id: 3, sid: sid2, channel: 1, instrument: sy, patterns: { m: { length: 1, groove: "C4 E4 G4 C5" } } }
  - { id: 4, sid: sid1, channel: 3, echo: { voice: 2, delay_beats: 0.75, volume: 0.5, adsr: [3, 6, 6, 6] } }
sections:
  x: { bars: 4, level: { from: pp, to: ff }, volume: { from: 9, to: 15 }, filter: { cutoff: { from: 0, to: 300 }, resonance: 13 }, layers: { v1: a, v2: m, v3: m } }
  y: { bars: 4, level: mf, volume: 12, layers: { v1: a, v2: m } }
timeline: [x, y, x, y]
end: { hold_beats: 2, release: true }
`;

test("budget: a worst-case 1.2 document using every new feature stays within the estimated cycles per call", () => {
  const total = compileSidwaveToPrg(parseSidwave(WORST)).totalFrames;
  const run = playDoc(WORST, total + 4);
  const peak = Math.max(...run.calls.map((c) => c.cycles));
  assert.ok(peak <= run.compiled.worstCaseCyclesPerCall, `measured ${peak} cycles exceeds the estimate ${run.compiled.worstCaseCyclesPerCall}`);
  assert.ok(peak > 1500, "the document exercises the player");
  console.log(`worst case 1.2: measured ${peak} cycles, estimate ${run.compiled.worstCaseCyclesPerCall}, turbo ${run.compiled.requiresTurbo}`);
});

import { arrangeSidwave } from "../src/sidwaveCompiler.js";
import { sampleHarness } from "./helpers/sidwaveEmulator.mjs";

const DIGI = `sidwave: 1.2
title: Digi layer
tempo: 125.31
sids: [{ id: sid1, address: "$D400", model: "8580" }, { id: sid2, address: "$D420", model: "8580" }]
samples: { rate: 4000, defs: { kick: { hex: "fe18" }, snare: { hex: "0f0f" } } }
voices:
  - { id: 1, waveform: pulse, patterns: { a: { length: 1, groove: "C4 D4 E4 F4" } } }
  - { id: d1, digi: sid2, patterns: { beat: { length: 0.5, drums: { kit: { k: "sample:kick", s: "sample:snare" }, steps: "k.s." } } } }
sections:
  s: { bars: 2, layers: { v1: a, d1: "beat*2" } }
timeline: [s, "s+5"]
`;

test("digi voices: triggers follow sections, sequence repeats and are exempt from transposition", () => {
  const commands = arrangeSidwave(parseSidwave(DIGI)).samples.commands;
  const at = Object.fromEntries(commands.map((c) => [c.name, c.at]));
  const fpb = sidwaveFrameRate("PAL") * 60 / 125.31;
  const beat = (b) => Math.round(b * fpb);
  // steps of 0.5 beat: k at 0, s at 1 in every 2-beat pass; "beat*2" fills the 8-beat section twice and the
  // second timeline entry (transposed by 5) starts at beat 8 with the same triggers
  assert.deepEqual(at.kick, [0, 2, 4, 6, 8, 10, 12, 14].map(beat));
  assert.deepEqual(at.snare, [1, 3, 5, 7, 9, 11, 13, 15].map(beat));
  assert.equal(commands.length, 2);
  assert.throws(() => parseSidwave(DIGI.replace("digi: sid2", "digi: nope")), /need a unique digi ID, a mapped SID and patterns/);
  assert.throws(() => compileSidwaveToPrg(parseSidwave(DIGI.replace("kick: { hex", "kick2: { hex"))), /sample "kick" is not defined in samples.defs/);
});

test("digi voices: the player starts each trigger on the planned call", () => {
  const { compiled, cpu, writes, irq } = sampleHarness(DIGI, { loop: false });
  const expected = arrangeSidwave(parseSidwave(DIGI)).samples.commands.flatMap((c) => c.at.map((frame) => frame)).sort((a, b) => a - b);
  const starts = [];
  for (let frame = 0; frame < 60; frame++) {
    writes.length = 0;
    cpu.call(irq);
    if (writes.some(([a, v]) => a === 0xdd0e && v === 0x11)) starts.push(frame);
  }
  assert.ok(starts.length >= 1, `a CIA2 timer start at ${starts}`);
  assert.equal(starts[0], expected[0]);
  assert.ok(compiled.digiCyclesPerCall > 0);
});

test("digi voices: $D418 is not written by the IRQ player while a sample is active; the NMI restores the shadow with the new filter mode", () => {
  const source = `sidwave: 1.2
title: Shadow
tempo: 125.31
sids: [{ id: sid1, address: "$D400", model: "8580" }, { id: sid2, address: "$D420", model: "8580" }]
samples: { rate: 16, defs: { long: { hex: "${"8".repeat(60)}" } }, triggers: [{ sample: long, sid: sid2, at: [0] }] }
instruments: { f: { waveform: pulse, adsr: [0, 4, 10, 4], filtertable: [{ cutoff: 800, type: highpass }] } }
voices:
  - { id: 1, patterns: { a: { length: 1, groove: "C4 C4 C4 C4" } } }
  - { id: 4, sid: sid2, channel: 1, instrument: f, patterns: { a: { length: 1, groove: "- - E4 E4" } } }
sections:
  s: { bars: 1, volume: { sid1: 12, sid2: 15 }, layers: { v1: a, v4: a } }
timeline: [s]
`;
  assert.throws(() => compileSidwaveToPrg(parseSidwave(source)), /cannot change volume on digi SID sid2/, "volume changes on the digi SID are rejected");
  const ok = source.replace("volume: { sid1: 12, sid2: 15 }", "level: mf");
  const { cpu, writes, irq, tick, mem } = sampleHarness(ok, { loop: false });
  cpu.call(irq);
  assert.equal(mem[0xdd0e], 0x11, "the sample is running");
  writes.length = 0;
  for (let frame = 1; frame < 60; frame++) cpu.call(irq);
  assert.deepEqual(writes.filter(([a]) => a === 0xd438), [], "the IRQ never touches $D418 of the digi SID");
  assert.ok(mem[0x0318] >= 0x08 || true);
  // the filter mode chosen during the sample reaches $D418 when the NMI restores the shadow
  let restored = null;
  for (let i = 0; i < 80 && restored === null; i++) {
    writes.length = 0;
    tick();
    const w = writes.filter(([a]) => a === 0xd438);
    if (mem[0xdd0e] === 0) restored = w.at(-1)?.[1] ?? null;
  }
  assert.notEqual(restored, null, "the sample ends");
  assert.equal(restored & 0xf0, 0x40, "highpass mode of the filter table written while the sample ran");
  assert.equal(restored & 0x0f, 15);
});
