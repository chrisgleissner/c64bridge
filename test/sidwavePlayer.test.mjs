// Runs the compiled SIDWAVE player in a small 6502 emulator and checks the SID register writes
// frame by frame against what the SIDWAVE document specifies. No external tools are needed.
import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileSidwaveToPrg,
  compileSidwaveToSid,
  hzToSidFrequency,
  sidwaveFrameRate,
  SIDWAVE_HARD_RESTART_FRAMES,
} from "../src/sidwaveCompiler.js";
import { midiToHz, noteNameToMidi, parseSidwave, SidwaveValidationError } from "../src/sidwave.js";

// ---------------------------------------------------------------------------
// Minimal NMOS 6502 (official opcodes; decimal mode is not used by the player)

const OPS = [];
function def(name, list) { for (const [op, mode] of list) OPS[op] = [name, mode]; }
def("ADC", [[0x69, "imm"], [0x65, "zp"], [0x75, "zpx"], [0x6d, "abs"], [0x7d, "abx"], [0x79, "aby"], [0x61, "izx"], [0x71, "izy"]]);
def("AND", [[0x29, "imm"], [0x25, "zp"], [0x35, "zpx"], [0x2d, "abs"], [0x3d, "abx"], [0x39, "aby"], [0x21, "izx"], [0x31, "izy"]]);
def("ASL", [[0x0a, "acc"], [0x06, "zp"], [0x16, "zpx"], [0x0e, "abs"], [0x1e, "abx"]]);
def("BIT", [[0x24, "zp"], [0x2c, "abs"]]);
def("BPL", [[0x10, "rel"]]); def("BMI", [[0x30, "rel"]]); def("BVC", [[0x50, "rel"]]); def("BVS", [[0x70, "rel"]]);
def("BCC", [[0x90, "rel"]]); def("BCS", [[0xb0, "rel"]]); def("BNE", [[0xd0, "rel"]]); def("BEQ", [[0xf0, "rel"]]);
def("BRK", [[0x00, "imp"]]);
def("CMP", [[0xc9, "imm"], [0xc5, "zp"], [0xd5, "zpx"], [0xcd, "abs"], [0xdd, "abx"], [0xd9, "aby"], [0xc1, "izx"], [0xd1, "izy"]]);
def("CPX", [[0xe0, "imm"], [0xe4, "zp"], [0xec, "abs"]]);
def("CPY", [[0xc0, "imm"], [0xc4, "zp"], [0xcc, "abs"]]);
def("DEC", [[0xc6, "zp"], [0xd6, "zpx"], [0xce, "abs"], [0xde, "abx"]]);
def("EOR", [[0x49, "imm"], [0x45, "zp"], [0x55, "zpx"], [0x4d, "abs"], [0x5d, "abx"], [0x59, "aby"], [0x41, "izx"], [0x51, "izy"]]);
def("CLC", [[0x18, "imp"]]); def("SEC", [[0x38, "imp"]]); def("CLI", [[0x58, "imp"]]); def("SEI", [[0x78, "imp"]]);
def("CLV", [[0xb8, "imp"]]); def("CLD", [[0xd8, "imp"]]); def("SED", [[0xf8, "imp"]]);
def("INC", [[0xe6, "zp"], [0xf6, "zpx"], [0xee, "abs"], [0xfe, "abx"]]);
def("JMP", [[0x4c, "abs"], [0x6c, "ind"]]); def("JSR", [[0x20, "abs"]]);
def("LDA", [[0xa9, "imm"], [0xa5, "zp"], [0xb5, "zpx"], [0xad, "abs"], [0xbd, "abx"], [0xb9, "aby"], [0xa1, "izx"], [0xb1, "izy"]]);
def("LDX", [[0xa2, "imm"], [0xa6, "zp"], [0xb6, "zpy"], [0xae, "abs"], [0xbe, "aby"]]);
def("LDY", [[0xa0, "imm"], [0xa4, "zp"], [0xb4, "zpx"], [0xac, "abs"], [0xbc, "abx"]]);
def("LSR", [[0x4a, "acc"], [0x46, "zp"], [0x56, "zpx"], [0x4e, "abs"], [0x5e, "abx"]]);
def("NOP", [[0xea, "imp"]]);
def("ORA", [[0x09, "imm"], [0x05, "zp"], [0x15, "zpx"], [0x0d, "abs"], [0x1d, "abx"], [0x19, "aby"], [0x01, "izx"], [0x11, "izy"]]);
def("TAX", [[0xaa, "imp"]]); def("TXA", [[0x8a, "imp"]]); def("DEX", [[0xca, "imp"]]); def("INX", [[0xe8, "imp"]]);
def("TAY", [[0xa8, "imp"]]); def("TYA", [[0x98, "imp"]]); def("DEY", [[0x88, "imp"]]); def("INY", [[0xc8, "imp"]]);
def("ROL", [[0x2a, "acc"], [0x26, "zp"], [0x36, "zpx"], [0x2e, "abs"], [0x3e, "abx"]]);
def("ROR", [[0x6a, "acc"], [0x66, "zp"], [0x76, "zpx"], [0x6e, "abs"], [0x7e, "abx"]]);
def("RTI", [[0x40, "imp"]]); def("RTS", [[0x60, "imp"]]);
def("SBC", [[0xe9, "imm"], [0xe5, "zp"], [0xf5, "zpx"], [0xed, "abs"], [0xfd, "abx"], [0xf9, "aby"], [0xe1, "izx"], [0xf1, "izy"]]);
def("STA", [[0x85, "zp"], [0x95, "zpx"], [0x8d, "abs"], [0x9d, "abx"], [0x99, "aby"], [0x81, "izx"], [0x91, "izy"]]);
def("STX", [[0x86, "zp"], [0x96, "zpy"], [0x8e, "abs"]]); def("STY", [[0x84, "zp"], [0x94, "zpx"], [0x8c, "abs"]]);
def("TSX", [[0xba, "imp"]]); def("TXS", [[0x9a, "imp"]]);
def("PHA", [[0x48, "imp"]]); def("PLA", [[0x68, "imp"]]); def("PHP", [[0x08, "imp"]]); def("PLP", [[0x28, "imp"]]);

const RMW_OPS = new Set(["ASL", "LSR", "ROL", "ROR", "INC", "DEC"]);
/** Base NMOS 6502 cycle count (page-crossing penalties ignored; taken branches add one in br()). */
function cycleCost(name, mode) {
  if (name === "JSR" || name === "RTS") return 6;
  if (name === "JMP") return mode === "ind" ? 5 : 3;
  if (name === "PHA" || name === "PHP") return 3;
  if (name === "PLA" || name === "PLP") return 4;
  if (["imp", "acc", "imm", "rel"].includes(mode)) return 2;
  if (RMW_OPS.has(name)) return { zp: 5, zpx: 6, abs: 6, abx: 7 }[mode];
  if (name.startsWith("ST")) return { zp: 3, zpx: 4, zpy: 4, abs: 4, abx: 5, aby: 5, izx: 6, izy: 6 }[mode];
  return { zp: 3, zpx: 4, zpy: 4, abs: 4, abx: 4, aby: 4, izx: 6, izy: 5 }[mode];
}

class Cpu {
  constructor(mem, hooks = {}) { Object.assign(this, { m: mem, a: 0, x: 0, y: 0, sp: 0xfd, pc: 0, c: 0, z: 0, i: 1, d: 0, v: 0, n: 0, hooks, steps: 0, cycles: 0 }); }
  rd(a) { a &= 0xffff; const r = this.hooks.read?.(a); return r === undefined ? this.m[a] : r; }
  wr(a, v) { a &= 0xffff; this.hooks.write?.(a, v & 0xff); this.m[a] = v & 0xff; }
  push(v) { this.m[0x100 + this.sp] = v & 0xff; this.sp = (this.sp - 1) & 0xff; }
  pop() { this.sp = (this.sp + 1) & 0xff; return this.m[0x100 + this.sp]; }
  nz(v) { v &= 0xff; this.z = +(v === 0); this.n = v >> 7; return v; }
  fetch() { const v = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; }
  fetch16() { const lo = this.fetch(); return lo | (this.fetch() << 8); }
  zp16(a) { return this.m[a & 0xff] | (this.m[(a + 1) & 0xff] << 8); }
  ea(mode) {
    switch (mode) {
      case "zp": return this.fetch();
      case "zpx": return (this.fetch() + this.x) & 0xff;
      case "zpy": return (this.fetch() + this.y) & 0xff;
      case "abs": return this.fetch16();
      case "abx": return (this.fetch16() + this.x) & 0xffff;
      case "aby": return (this.fetch16() + this.y) & 0xffff;
      case "izx": return this.zp16((this.fetch() + this.x) & 0xff);
      case "izy": return (this.zp16(this.fetch()) + this.y) & 0xffff;
      case "ind": { const p = this.fetch16(); return this.rd(p) | (this.rd((p & 0xff00) | ((p + 1) & 0xff)) << 8); }
      default: return 0;
    }
  }
  adc(v) { const r = this.a + v + this.c; this.v = (~(this.a ^ v) & (this.a ^ r) & 0x80) ? 1 : 0; this.c = +(r > 0xff); this.a = this.nz(r); }
  cmp(r, v) { this.c = +(r >= v); this.nz(r - v); }
  br(cond) { const off = this.fetch(); if (cond) { this.cycles += 1; this.pc = (this.pc + ((off << 24) >> 24)) & 0xffff; } }
  step() {
    const at = this.pc;
    const op = this.fetch();
    const entry = OPS[op];
    if (!entry) throw new Error(`illegal opcode $${op.toString(16)} at $${at.toString(16)}`);
    const [name, mode] = entry;
    if (this.d) throw new Error("decimal mode is not expected in the player");
    const addr = ["imp", "acc", "imm", "rel"].includes(mode) ? 0 : this.ea(mode);
    const val = () => (mode === "imm" ? this.fetch() : this.rd(addr));
    const rmw = (fn) => { const v = mode === "acc" ? this.a : this.rd(addr); const r = fn(v) & 0xff; this.nz(r); if (mode === "acc") this.a = r; else this.wr(addr, r); };
    this.steps += 1;
    this.cycles += cycleCost(name, mode);
    switch (name) {
      case "LDA": this.a = this.nz(val()); break; case "LDX": this.x = this.nz(val()); break; case "LDY": this.y = this.nz(val()); break;
      case "STA": this.wr(addr, this.a); break; case "STX": this.wr(addr, this.x); break; case "STY": this.wr(addr, this.y); break;
      case "ADC": this.adc(val()); break; case "SBC": this.adc(val() ^ 0xff); break;
      case "AND": this.a = this.nz(this.a & val()); break; case "ORA": this.a = this.nz(this.a | val()); break; case "EOR": this.a = this.nz(this.a ^ val()); break;
      case "CMP": this.cmp(this.a, val()); break; case "CPX": this.cmp(this.x, val()); break; case "CPY": this.cmp(this.y, val()); break;
      case "BIT": { const v = val(); this.z = +((this.a & v) === 0); this.n = v >> 7; this.v = (v >> 6) & 1; break; }
      case "ASL": rmw((v) => { this.c = v >> 7; return v << 1; }); break;
      case "LSR": rmw((v) => { this.c = v & 1; return v >> 1; }); break;
      case "ROL": rmw((v) => { const r = (v << 1) | this.c; this.c = v >> 7; return r; }); break;
      case "ROR": rmw((v) => { const r = (v >> 1) | (this.c << 7); this.c = v & 1; return r; }); break;
      case "INC": rmw((v) => v + 1); break; case "DEC": rmw((v) => v - 1); break;
      case "INX": this.x = this.nz(this.x + 1); break; case "INY": this.y = this.nz(this.y + 1); break;
      case "DEX": this.x = this.nz(this.x - 1); break; case "DEY": this.y = this.nz(this.y - 1); break;
      case "TAX": this.x = this.nz(this.a); break; case "TAY": this.y = this.nz(this.a); break;
      case "TXA": this.a = this.nz(this.x); break; case "TYA": this.a = this.nz(this.y); break;
      case "TSX": this.x = this.nz(this.sp); break; case "TXS": this.sp = this.x; break;
      case "PHA": this.push(this.a); break; case "PLA": this.a = this.nz(this.pop()); break;
      case "PHP": this.push(0x30 | (this.n << 7) | (this.v << 6) | (this.d << 3) | (this.i << 2) | (this.z << 1) | this.c); break;
      case "PLP": { const p = this.pop(); [this.n, this.v, this.d, this.i, this.z, this.c] = [p >> 7, (p >> 6) & 1, (p >> 3) & 1, (p >> 2) & 1, (p >> 1) & 1, p & 1]; break; }
      case "CLC": this.c = 0; break; case "SEC": this.c = 1; break; case "CLI": this.i = 0; break; case "SEI": this.i = 1; break;
      case "CLD": this.d = 0; break; case "SED": this.d = 1; break; case "CLV": this.v = 0; break; case "NOP": break;
      case "BPL": this.br(!this.n); break; case "BMI": this.br(this.n); break; case "BVC": this.br(!this.v); break; case "BVS": this.br(this.v); break;
      case "BCC": this.br(!this.c); break; case "BCS": this.br(this.c); break; case "BNE": this.br(!this.z); break; case "BEQ": this.br(this.z); break;
      case "JMP": this.pc = addr; break;
      case "JSR": { const ret = (this.pc - 1) & 0xffff; this.push(ret >> 8); this.push(ret & 0xff); this.pc = addr; break; }
      case "RTS": { const lo = this.pop(); this.pc = (((this.pop() << 8) | lo) + 1) & 0xffff; break; }
      default: throw new Error(`${name} at $${at.toString(16)} is not expected in the player`);
    }
  }
  /** Calls a subroutine and returns the number of CPU cycles it took. */
  call(addr, a = 0, limit = 100_000) {
    this.a = a;
    this.push(0xff); this.push(0xef); // return to $FFF0
    const sp0 = this.sp;
    this.pc = addr;
    const start = this.steps;
    const startCycles = this.cycles;
    while (!(this.pc === 0xfff0 && this.sp === ((sp0 + 2) & 0xff))) {
      this.step();
      if (this.steps - start > limit) throw new Error(`call $${addr.toString(16)} did not return (pc=$${this.pc.toString(16)})`);
    }
    return this.cycles - startCycles;
  }
}

// ---------------------------------------------------------------------------
// Helpers

function compile(source) {
  const doc = parseSidwave(source);
  const compiled = compileSidwaveToPrg(doc);
  const { sid } = compileSidwaveToSid(doc, compiled.prg);
  return { doc, compiled, sid };
}

/** Loads a PSID, calls init once and play `frames` times; returns the SID register file after each play call. */
function runPsid(sid, frames) {
  const dataOffset = sid.readUInt16BE(6);
  const init = sid.readUInt16BE(10);
  const play = sid.readUInt16BE(12);
  const body = sid.subarray(dataOffset);
  const load = body.readUInt16LE(0);
  const mem = new Uint8Array(65536);
  mem.set(body.subarray(2), load);
  const end = load + body.length - 2;
  const regs = new Uint8Array(25);
  const strayWrites = [];
  const cpu = new Cpu(mem, {
    write(a, v) {
      if (a >= 0xd400 && a <= 0xd418) regs[a - 0xd400] = v;
      else if (!(a === 0x01 || (a >= 0xfb && a <= 0xfe) || (a >= 0x0100 && a < 0x0200) || (a >= load && a < end))) strayWrites.push(a);
    },
  });
  cpu.call(init, 0);
  const states = [];
  let maxPlayCycles = 0;
  for (let f = 0; f < frames; f += 1) {
    maxPlayCycles = Math.max(maxPlayCycles, cpu.call(play));
    states.push(Uint8Array.from(regs));
  }
  return { states, strayWrites, maxPlayCycles, cpu, mem };
}

function voice(states, v) {
  const b = v * 7;
  return {
    freq: states.map((s) => s[b] | (s[b + 1] << 8)),
    pw: states.map((s) => s[b + 2] | ((s[b + 3] & 0x0f) << 8)),
    ctrl: states.map((s) => s[b + 4]),
    ad: states.map((s) => s[b + 5]),
    sr: states.map((s) => s[b + 6]),
  };
}

/** Frames where the gate bit rises, with the frequency written in that frame. */
function gateOns(vv) {
  const out = [];
  for (let f = 0; f < vv.ctrl.length; f += 1) {
    if ((vv.ctrl[f] & 1) && !(f > 0 && (vv.ctrl[f - 1] & 1))) out.push({ frame: f, freq: vv.freq[f] });
  }
  return out;
}

const sidFreq = (note, mode = "PAL") => hzToSidFrequency(midiToHz(noteNameToMidi(note)), mode);
/** Frame of a beat at a tempo: the player runs at the real video rate (50.1245 Hz PAL, 59.826 Hz NTSC). */
const at = (beat, tempo = 120, mode = "PAL") => Math.round((beat * sidwaveFrameRate(mode) * 60) / tempo);

function doc({ tempo = 120, mode = "PAL", voices, timeline, extra = "" }) {
  return `sidwave: 1.0\ntitle: Probe\ntempo: ${tempo}\nmode: ${mode}\n${extra}voices:\n${voices}\ntimeline:\n${timeline}\n`;
}

// ---------------------------------------------------------------------------
// Notes, rhythm, gate handling

const SCALE = doc({
  voices: `  - id: 1
    waveform: triangle
    adsr: [0, 9, 8, 2]
    patterns:
      S: { groove: [C4, D4, C4, C4, "-", E4, "~", "~"] }`,
  timeline: `  - { bars: 2, layers: { v1: S } }`,
});

test("SIDWAVE player: groove notes start on the beat grid with exact frequencies", () => {
  const { states } = runPsid(compile(SCALE).sid, 200);
  const ons = gateOns(voice(states, 0));
  // 120 BPM PAL = 25 frames per beat. Entries: C4 D4 C4 C4 rest E4 tie tie, then the pattern repeats.
  assert.deepEqual(ons.map((o) => o.frame), [0, 25, 50, 75, 125, 200].filter((f) => f < 200));
  assert.deepEqual(ons.map((o) => o.freq), ["C4", "D4", "C4", "C4", "E4"].map((n) => sidFreq(n)));
});

test("SIDWAVE player: repeated notes are retriggered after a hard restart", () => {
  const { states } = runPsid(compile(SCALE).sid, 200);
  const v = voice(states, 0);
  for (const onset of [25, 50, 75]) {
    for (let k = 1; k <= SIDWAVE_HARD_RESTART_FRAMES; k += 1) {
      const f = onset - k;
      assert.equal(v.ctrl[f] & 1, 0, `gate must be off at frame ${f}`);
      assert.equal(v.ad[f], 0, `attack/decay must be zeroed during hard restart at frame ${f}`);
      assert.equal(v.sr[f], 0, `sustain/release must be zeroed during hard restart at frame ${f}`);
    }
    assert.equal(v.ctrl[onset], 0x11, "triangle with gate on");
    assert.equal(v.ad[onset], 0x09);
    assert.equal(v.sr[onset], 0x82);
  }
});

test("SIDWAVE player: rests release the gate and ties hold it", () => {
  const { states } = runPsid(compile(SCALE).sid, 200);
  const v = voice(states, 0);
  // The fourth note (C4 at frame 75) is followed by a rest: the gate drops at frame 100 (release), not earlier.
  assert.equal(v.ctrl[99] & 1, 1);
  assert.equal(v.ctrl[100] & 1, 0);
  assert.equal(v.sr[100], 0x82, "a plain rest keeps the release rate so the note decays naturally");
  // E4 at frame 125 is tied over two more beats: one gate-on run until the hard restart before the loop.
  for (let f = 125; f < 198; f += 1) assert.equal(v.ctrl[f] & 1, 1, `gate held at frame ${f}`);
  assert.equal(v.freq[150], sidFreq("E4"));
});

test("SIDWAVE player: '-' layers and undeclared voices stay silent", () => {
  const source = doc({
    voices: `  - id: 1
    waveform: pulse
    patterns:
      A: { groove: [C4] }
  - id: 2
    waveform: sawtooth
    patterns:
      B: { groove: [G3] }`,
    timeline: `  - { bars: 1, layers: { v1: A, v2: "-" } }
  - { bars: 1, layers: { v1: "-", v2: B } }`,
  });
  const { states } = runPsid(compile(source).sid, 200);
  const [v1, v2, v3] = [0, 1, 2].map((i) => voice(states, i));
  assert.ok(v1.ctrl.slice(0, 98).some((c) => c & 1), "voice 1 plays in section 1");
  assert.ok(v1.ctrl.slice(100, 198).every((c) => !(c & 1)), "voice 1 is silent in section 2");
  assert.ok(v2.ctrl.slice(0, 98).every((c) => !(c & 1)), "voice 2 is silent in section 1");
  assert.deepEqual(gateOns(v2).map((o) => o.frame), [100, 125, 150, 175]);
  assert.ok(v3.ctrl.every((c) => c === 0), "undeclared voice 3 never sounds");
});

test("SIDWAVE player: onsets follow the exact tempo without drift (92 BPM)", () => {
  const source = doc({
    tempo: 92,
    voices: `  - id: 1
    patterns:
      A: { groove: [C4, E4] }`,
    timeline: `  - { bars: 16, layers: { v1: A } }`,
  });
  const { compiled, sid } = compile(source);
  const framesPerBeat = (sidwaveFrameRate("PAL") * 60) / 92;
  assert.equal(compiled.totalFrames, Math.round(64 * framesPerBeat));
  const ons = gateOns(voice(runPsid(sid, compiled.totalFrames).states, 0));
  assert.equal(ons.length, 64);
  ons.forEach((o, k) => assert.equal(o.frame, Math.round(k * framesPerBeat), `beat ${k}`));
});

test("SIDWAVE player: songs longer than 255 frames play to the end and loop seamlessly", () => {
  const source = doc({
    voices: `  - id: 1
    patterns:
      A: { groove: [C4, D4, E4, F4, G4, A4, B4, C5] }`,
    timeline: `  - { bars: 8, layers: { v1: A } }`,
  });
  const { compiled, sid } = compile(source);
  const total = compiled.totalFrames;
  assert.equal(total, at(32));
  const { states } = runPsid(sid, 2 * total + 50);
  const v = voice(states, 0);
  assert.equal(v.freq[at(31) + 5], sidFreq("C5"), "the last beat is reached");
  for (let f = 3; f < total; f += 1) {
    assert.deepEqual(Array.from(states[f + total]), Array.from(states[f]), `loop frame ${f}`);
  }
  assert.deepEqual(gateOns(v).slice(32, 34).map((o) => o.frame), [total, total + 25]);
});

// ---------------------------------------------------------------------------
// Pattern features

test("SIDWAVE player: fast arpeggio cycles chord tones every frame_rate frames and retriggers per entry", () => {
  const source = doc({
    voices: `  - id: 1
    waveform: pulse
    patterns:
      ARP: { type: arpeggio, notes: [C4, E4, G4], frame_rate: 2, length: 2, transpositions: [0, 5] }`,
    timeline: `  - { bars: 1, layers: { v1: ARP } }`,
  });
  const v = voice(runPsid(compile(source).sid, 100).states, 0);
  assert.deepEqual(v.freq.slice(0, 8), ["C4", "C4", "E4", "E4", "G4", "G4", "C4", "C4"].map((n) => sidFreq(n)));
  // Second chord (two beats later) is transposed by +5 semitones and retriggered.
  assert.deepEqual(gateOns(v).map((o) => o.frame), [0, 50]);
  assert.deepEqual(v.freq.slice(50, 54), ["F4", "F4", "A4", "A4"].map((n) => sidFreq(n)));
});

test("SIDWAVE player: motif chord symbols, transpositions and layer modifiers", () => {
  const source = doc({
    voices: `  - id: 1
    waveform: sawtooth
    patterns:
      A: { motif: "Cmin9 pad motif", length: 1, transpositions: [0, 7] }`,
    timeline: `  - { bars: 3, layers: { v1: A } }
  - { bars: 2, layers: { v1: "A↑" } }
  - { bars: 2, layers: { v1: "A-2" } }`,
  });
  const ons = gateOns(voice(runPsid(compile(source).sid, 700).states, 0));
  const names = ["C3", "D#3", "G3", "A#3", "D4", "G3", "A#3", "D4", "F4", "A4", "C3", "D#3"];
  assert.deepEqual(ons.slice(0, 12).map((o) => o.freq), names.map((n) => sidFreq(n)));
  // Section 2 restarts the cycle one octave up, section 3 two semitones down.
  assert.equal(ons[12].frame, at(12));
  assert.equal(ons[12].freq, sidFreq("C4"));
  assert.equal(ons[20].frame, at(20));
  assert.equal(ons[20].freq, sidFreq("A#2"));
});

test("SIDWAVE player: vibrato oscillates around the note with the requested depth and rate", () => {
  const source = doc({
    voices: `  - id: 1
    waveform: sawtooth
    patterns:
      A: { groove: [A4], length: 4, fx: { vibrato: { depth: 0.5, rate: 5, delay: 10 } } }`,
    timeline: `  - { bars: 1, layers: { v1: A } }`,
  });
  const v = voice(runPsid(compile(source).sid, 95).states, 0);
  const center = sidFreq("A4");
  for (let f = 0; f <= 10; f += 1) assert.equal(v.freq[f], center, `no vibrato during the delay (frame ${f})`);
  const window = v.freq.slice(11, 91);
  const cents = (x) => 1200 * Math.log2(x / center);
  assert.ok(Math.abs(cents(Math.max(...window)) - 50) < 6, `peak +${cents(Math.max(...window)).toFixed(1)} cents`);
  assert.ok(Math.abs(cents(Math.min(...window)) + 50) < 8, `trough ${cents(Math.min(...window)).toFixed(1)} cents`);
  // 5 Hz at 50.12 frames/s: a 10-frame period, so upward zero crossings are 10 frames apart.
  const ups = [];
  for (let f = 12; f < 91; f += 1) if (v.freq[f - 1] <= center && v.freq[f] > center) ups.push(f);
  assert.ok(ups.length >= 6);
  ups.slice(1).forEach((f, i) => assert.ok(Math.abs(f - ups[i] - 10) <= 1, `period ${f - ups[i]} frames`));
});

test("SIDWAVE player: slide starts depth semitones away and reaches the note after speed frames", () => {
  const source = doc({
    voices: `  - id: 1
    waveform: triangle
    patterns:
      A: { groove: [C3, G2], fx: { slide: { depth: 2, speed: 4 } } }
      B: { groove: [C3], fx: { slide: { depth: -3, speed: 2 } } }`,
    timeline: `  - { bars: 1, layers: { v1: A } }
  - { bars: 1, layers: { v1: B } }`,
  });
  const v = voice(runPsid(compile(source).sid, 110).states, 0);
  assert.equal(v.freq[0], sidFreq("A#2"));
  assert.ok(v.freq[1] > v.freq[0] && v.freq[2] > v.freq[1] && v.freq[3] > v.freq[2], "rises monotonically");
  assert.equal(v.freq[4], sidFreq("C3"));
  assert.equal(v.freq[20], sidFreq("C3"));
  assert.equal(v.freq[25], sidFreq("F2"));
  assert.equal(v.freq[29], sidFreq("G2"));
  assert.equal(v.freq[100], sidFreq("D#3"), "negative depth slides down from above");
  assert.equal(v.freq[102], sidFreq("C3"));
});

test("SIDWAVE player: pulse-width sweep moves between base ± depth at the requested rate", () => {
  const source = doc({
    voices: `  - id: 1
    waveform: pulse
    pulse_width: 0.5
    patterns:
      A: { groove: [C4], length: 4, fx: { pwm_sweep: { depth: 0.25, speed: 1 } } }`,
    timeline: `  - { bars: 1, layers: { v1: A } }`,
  });
  const v = voice(runPsid(compile(source).sid, 98).states, 0);
  const base = Math.round(0.5 * 4095);
  const depth = Math.round(0.25 * 4095);
  assert.equal(v.pw[0], base);
  assert.equal(Math.max(...v.pw.slice(0, 98)), base + depth);
  assert.equal(Math.min(...v.pw.slice(0, 98)), base - depth);
  // 1 Hz: the top is reached a quarter period (12.5 frames) after the start.
  const top = v.pw.indexOf(base + depth);
  assert.ok(top >= 12 && top <= 14, `top at frame ${top}`);
  const bottom = v.pw.indexOf(base - depth);
  assert.ok(v.pw[bottom + 1] > v.pw[bottom], "the sweep turns at the bottom without holding the minimum");
});

test("SIDWAVE player: pulse-width sweep turns at both limits without holding them (exact 40-frame cycle)", () => {
  // Range 1648..2448 with 1.25 cycles/s: steps of 40 units land exactly on both limits.
  const source = doc({
    voices: `  - id: 1
    waveform: pulse
    pulse_width: 2048
    patterns:
      A: { groove: [C4], length: 4, fx: { pwm_sweep: { depth: 400, speed: 1.25 } } }`,
    timeline: `  - { bars: 1, layers: { v1: A } }`,
  });
  const pw = voice(runPsid(compile(source).sid, 95).states, 0).pw;
  assert.deepEqual(pw.slice(0, 12), [2048, 2088, 2128, 2168, 2208, 2248, 2288, 2328, 2368, 2408, 2448, 2408]);
  assert.equal(pw[30], 1648);
  assert.equal(pw[31], 1688);
  for (let f = 0; f < 50; f += 1) assert.equal(pw[f + 40], pw[f], `frame ${f}: one cycle is 40 frames (1.25 Hz)`);
});

test("SIDWAVE player: filter envelope, filter_mod ramp and routing", () => {
  // speed 3.99 beats = 99.999 frames, so the step (256 = 8 cutoff units per frame) lands exactly on the limits.
  const source = doc({
    extra: `global_fx:\n  filter_env: { cutoff_base: 1600, sweep: -800, speed: 3.99, resonance: 12, type: bandpass, voices: [1] }\n`,
    voices: `  - id: 1
    waveform: sawtooth
    patterns:
      A: { groove: [C3], length: 4 }
  - id: 2
    waveform: pulse
    patterns:
      B: { groove: [C4, C4], length: 2, fx: { filter_mod: { sweep: "+400 over 1 steps" } } }
  - id: 3
    waveform: triangle
    patterns:
      C: { groove: [C2], length: 4 }`,
    timeline: `  - { bars: 2, layers: { v1: A, v3: C } }
  - { bars: 1, layers: { v1: A, v2: B, v3: C } }`,
  });
  const { states } = runPsid(compile(source).sid, 300);
  const cutoff = states.map((s) => (s[0x16] << 3) | (s[0x15] & 7));
  assert.equal(cutoff[0], 1600);
  assert.ok(Math.abs(cutoff[100] - 800) <= 2, `bottom ${cutoff[100]}`);
  assert.ok(Math.abs(cutoff[50] - 1200) <= 4, `midway ${cutoff[50]}`);
  assert.equal(cutoff[100], 800, "the bottom is reached after exactly 100 frames");
  assert.equal(cutoff[101], 808, "and the sweep turns immediately");
  assert.equal(cutoff[200], 1600, "a full up-and-down cycle takes 200 frames");
  for (const s of states.slice(0, 199)) {
    assert.equal(s[0x17], 0xc1, "resonance 12, only voice 1 routed");
    assert.equal(s[0x18], 0x2f, "band-pass, full volume");
  }
  // Section 2: voice 2's filter_mod adds a ramp of +400 over one entry (2 beats = 50 frames) and routes voice 2.
  assert.equal(states[210][0x17], 0xc3);
  const s2 = at(8);
  const envAt = (f) => 1600 - Math.abs(((f - 200) * 800) / 100);
  const rampEnd = s2 + at(2) - 1;
  assert.ok(Math.abs(cutoff[rampEnd] - (envAt(rampEnd) + 400)) <= 8, `ramp end ${cutoff[rampEnd]} vs ${envAt(rampEnd) + 400}`);
});

test("SIDWAVE player: fade lowers sustain; a section where every voice fades also fades the volume", () => {
  const source = doc({
    voices: `  - id: 1
    adsr: [0, 0, 12, 0]
    patterns:
      A: { groove: [C4], length: 4 }`,
    timeline: `  - { bars: 1, layers: { v1: A } }
  - { bars: 2, layers: { v1: "A–" } }`,
  });
  const { states } = runPsid(compile(source).sid, 400);
  const v = voice(states, 0);
  assert.equal(v.sr[50] >> 4, 12, "no fade in section 1");
  const sustain = [4, 5, 6, 7, 8, 9, 10, 11].map((b) => v.sr[at(b) + 1] >> 4);
  for (let i = 1; i < sustain.length; i += 1) assert.ok(sustain[i] <= sustain[i - 1], `sustain ${sustain}`);
  assert.equal(sustain[0], 12);
  assert.ok(sustain[7] <= 2);
  const vol = states.map((s) => s[0x18] & 15);
  assert.equal(vol[99], 15);
  assert.ok(vol[200] > 5 && vol[200] < 10, `half-way volume ${vol[200]}`);
  assert.ok(vol[at(12) - 1] <= 2);
  assert.equal(vol[at(12)], 15, "volume is restored when the song loops");
});

test("SIDWAVE player: reverb_sim echoes the lead on a free voice, delayed and quieter", () => {
  const source = doc({
    extra: `global_fx:\n  reverb_sim: { depth: 0.5, delay_frames: 4 }\n`,
    voices: `  - id: 1
    adsr: [1, 2, 10, 4]
    patterns:
      A: { groove: [C4, E4] }`,
    timeline: `  - { bars: 1, layers: { v1: A } }`,
  });
  const v = voice(runPsid(compile(source).sid, 100).states, 1);
  const ons = gateOns(v);
  assert.deepEqual(ons.map((o) => o.frame), [4, 29, 54, 79]);
  assert.deepEqual(ons.slice(0, 2).map((o) => o.freq), [sidFreq("C4"), sidFreq("E4")]);
  assert.equal(v.sr[10], 0x54, "sustain 10 scaled by depth 0.5");
});

// ---------------------------------------------------------------------------
// System, packaging and limits

test("SIDWAVE PSID header: entry points, clock flag and latin-1 strings", () => {
  for (const mode of ["PAL", "NTSC"]) {
    const { sid, compiled } = compile(doc({ mode, extra: `author: "Jürgen Ä"\n`, voices: `  - id: 1\n    patterns: { A: { groove: [C4] } }`, timeline: `  - { bars: 1, layers: { v1: A } }` }).replace("title: Probe", "title: Für Elise"));
    assert.equal(sid.toString("ascii", 0, 4), "PSID");
    assert.equal(sid.readUInt16BE(4), 2);
    assert.equal(sid.readUInt16BE(6), 0x7c);
    assert.equal(sid.readUInt16BE(8), 0, "load address comes from the data");
    assert.equal(sid.readUInt16LE(0x7c), 0x0801);
    assert.equal(sid.readUInt16BE(10), compiled.initAddress);
    assert.equal(sid.readUInt16BE(12), compiled.playAddress);
    assert.notEqual(compiled.initAddress, compiled.playAddress, "separate init and play routines");
    assert.equal(sid.readUInt16BE(14), 1);
    assert.equal(sid.readUInt16BE(16), 1);
    assert.equal(sid.readUInt32BE(18), 0, "vertical-blank play timing");
    assert.equal(sid.readUInt16BE(0x76), mode === "PAL" ? 0x04 : 0x08, "clock flag");
    assert.equal(sid.toString("latin1", 0x16, 0x16 + 10), "Für Elise\0");
    assert.equal(sid.toString("latin1", 0x36, 0x36 + 8), "Jürgen Ä");
  }
});

test("SIDWAVE NTSC: 60 frames per second and NTSC frequency values", () => {
  const { states } = runPsid(compile(doc({ mode: "NTSC", voices: `  - id: 1\n    patterns: { A: { groove: [A4, C5] } }`, timeline: `  - { bars: 1, layers: { v1: A } }` })).sid, 60);
  const ons = gateOns(voice(states, 0));
  assert.deepEqual(ons.map((o) => o.frame), [0, 30]);
  assert.deepEqual(ons.map((o) => o.freq), [sidFreq("A4", "NTSC"), sidFreq("C5", "NTSC")]);
});

test("SIDWAVE PRG runs standalone: SYS stub, machine detection, CIA timer and IRQ playback", () => {
  for (const [machineLines, label] of [[312, "PAL"], [263, "NTSC"]]) {
    const { compiled, sid, doc: parsed } = compile(SCALE);
    const prg = compiled.prg;
    assert.equal(prg.readUInt16LE(0), 0x0801);
    assert.equal(prg.toString("latin1", 6, 11), "\x9e2061");
    assert.equal(compiled.entryAddress, 2061);
    const mem = new Uint8Array(65536);
    mem.set(prg.subarray(2), 0x0801);
    mem[0xea31] = 0x60; // stand-in for the KERNAL IRQ tail
    let raster = 0;
    const regs = new Uint8Array(25);
    const io = {};
    const cpu = new Cpu(mem, {
      read(a) { if (a === 0xd012) { raster = (raster + 1) % machineLines; return raster & 0xff; } return undefined; },
      write(a, v) { if (a >= 0xd400 && a <= 0xd418) regs[a - 0xd400] = v; if (a >= 0xdc00 && a <= 0xdc0f) io[a] = v; },
    });
    mem[0xdc0e] = 0x80;
    cpu.call(compiled.entryAddress);
    const irq = mem[0x0314] | (mem[0x0315] << 8);
    assert.ok(irq > compiled.entryAddress && irq < compiled.endAddress, "IRQ vector points into the player");
    const clock = label === "PAL" ? 985_248 : 1_022_727;
    assert.equal(io[0xdc04] | (io[0xdc05] << 8), Math.round(clock / sidwaveFrameRate("PAL")) - 1, `${label} machine: CIA timer at the PAL frame rate`);
    assert.equal(io[0xdc0e], 0x91, "timer started, TOD setting kept");
    const states = [];
    for (let f = 0; f < 120; f += 1) { cpu.call(irq); states.push(Uint8Array.from(regs)); }
    const ons = gateOns(voice(states, 0));
    assert.deepEqual(ons.map((o) => o.frame), [0, 25, 50, 75]);
    assert.deepEqual(ons.map((o) => o.freq), ["C4", "D4", "C4", "C4"].map((n) => sidFreq(n, label)), `${label} machine uses its own clock's frequency table`);
    assert.equal(parsed.song.mode, "PAL");
  }
});

test("SIDWAVE player stays inside its memory and the frame budget", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "sound", "sidwave.md"), "utf8");
  const yaml = /```yaml\n([\s\S]*?)```/.exec(source)[1];
  const { sid, compiled } = compile(yaml);
  assert.ok(compiled.endAddress <= 0xd000);
  const run = runPsid(sid, 3000);
  assert.deepEqual(run.strayWrites, [], "no writes outside zero page/stack, the player image and the SID");
  // A PAL frame has 19,656 cycles (312 lines x 63); the spec example needs about 4,100 (65 raster lines).
  assert.ok(run.maxPlayCycles < 4500, `play routine took up to ${run.maxPlayCycles} cycles`);
  assert.equal(run.mem[0xfb], 0, "zero-page pointer restored");
});

test("SIDWAVE note range: C0..A#7 on PAL, B7 only on NTSC", () => {
  const range = (mode, notes) => doc({ mode, voices: `  - id: 1\n    patterns: { A: { groove: [${notes}] } }`, timeline: `  - { bars: 1, layers: { v1: A } }` });
  const { states } = runPsid(compile(range("PAL", "C0, A#7")).sid, 30);
  assert.deepEqual(gateOns(voice(states, 0)).map((o) => o.freq), [sidFreq("C0"), sidFreq("A#7")]);
  assert.throws(() => compile(range("PAL", "B7")), /B7.*outside the playable range C0..A#7 on PAL/);
  const ntsc = runPsid(compile(range("NTSC", "B7")).sid, 5).states;
  assert.equal(voice(ntsc, 0).freq[0], sidFreq("B7", "NTSC"));
  assert.throws(() => compile(range("PAL", "B8")), /outside the supported range/);
  assert.throws(() => compile(doc({ voices: `  - id: 1\n    patterns: { A: { groove: [G7], transpositions: [12] } }`, timeline: `  - { bars: 1, layers: { v1: A } }` })), /G8 \(after transposition \+12\)/);
});

test("SIDWAVE tempo extremes: 220 BPM sixteenths still retrigger; notes shorter than 3 frames are rejected", () => {
  const fast = doc({ tempo: 220, voices: `  - id: 1\n    patterns: { A: { groove: [C4, D4], length: 0.25 } }`, timeline: `  - { bars: 1, layers: { v1: A } }` });
  const { compiled, sid } = compile(fast);
  const fastV = voice(runPsid(sid, compiled.totalFrames).states, 0);
  const ons = gateOns(fastV);
  assert.equal(ons.length, 16);
  // Every note sounds with the gate on for at least one frame before its hard restart.
  for (const o of ons) assert.equal(fastV.ctrl[o.frame] & 1, 1);
  const tooFast = fast.replace("length: 0.25", "length: 0.125");
  assert.throws(() => compile(tooFast), /at least 3 frames per note \(one sounding frame plus the 2-frame hard restart\)/);
  // 0.2 beats at 220 BPM is 2.73 frames: some entries would get 2 frames, leaving no sounding frame after the hard restart.
  assert.throws(() => compile(fast.replace("length: 0.25", "length: 0.2")), /at least 3 frames per note/);
  const slow = doc({ tempo: 30, voices: `  - id: 1\n    patterns: { A: { groove: [C4] } }`, timeline: `  - { bars: 1, layers: { v1: A } }` });
  const slowRun = compile(slow);
  assert.equal(slowRun.compiled.totalFrames, at(4, 30));
  assert.deepEqual(gateOns(voice(runPsid(slowRun.sid, at(4, 30)).states, 0)).map((o) => o.frame), [0, 1, 2, 3].map((b) => at(b, 30)));
});

test("SIDWAVE size limit: a long sparse song fits, an over-long dense song fails with a clear error", () => {
  const sparse = doc({ voices: `  - id: 1\n    patterns: { A: { groove: [C4, E4], length: 4 } }`, timeline: `  - { bars: 2000, layers: { v1: A } }` });
  const big = compile(sparse);
  assert.equal(big.compiled.totalFrames, at(8000));
  assert.ok(big.compiled.endAddress <= 0xd000);
  const ons = gateOns(voice(runPsid(big.sid, 1000).states, 0));
  assert.deepEqual(ons.map((o) => o.frame), [0, 4, 8, 12, 16, 20, 24, 28, 32, 36].map((b) => at(b)).filter((f) => f < 1000));
  const dense = doc({
    voices: [1, 2, 3].map((id) => `  - id: ${id}\n    patterns: { A: { groove: [C4, E4, G4, B4], length: 0.25 } }`).join("\n"),
    timeline: `  - { bars: 400, layers: { v1: A, v2: A, v3: A } }`,
  });
  assert.throws(() => compile(dense), /past the \$D000 limit \(about 50 KB\); shorten the timeline/);
});

test("SIDWAVE legacy song: block compiles to the same player as the top-level format", () => {
  const top = compile(SCALE).compiled.prg;
  const legacy = compile(`song: { title: Probe, tempo: 120, mode: PAL }
voices:
  - id: 1
    waveform: triangle
    adsr: [0, 9, 8, 2]
    patterns:
      S: { groove: [C4, D4, C4, C4, "-", E4, "~", "~"] }
timeline:
  - { bars: 2, layers: { v1: S } }`).compiled.prg;
  assert.deepEqual(legacy, top);
});

test("SIDWAVE length_bars truncates or repeats the timeline", () => {
  const base = (bars) => doc({ extra: `length_bars: ${bars}\n`, voices: `  - id: 1\n    patterns: { A: { groove: [C4] }, B: { groove: [G4] } }`, timeline: `  - { bars: 1, layers: { v1: A } }\n  - { bars: 1, layers: { v1: B } }` });
  assert.equal(compile(base(1)).compiled.totalFrames, at(4));
  const { compiled, sid } = compile(base(3));
  assert.equal(compiled.totalFrames, at(12));
  const ons = gateOns(voice(runPsid(sid, at(12)).states, 0));
  assert.deepEqual([ons[0].freq, ons[4].freq, ons[8].freq], ["C4", "G4", "C4"].map((n) => sidFreq(n)));
});

test("SIDWAVE player: arpeggio, groove and motif patterns start on their first step (legacy song: block)", () => {
  // 120 BPM PAL: 25 frames per beat.
  const source = {
    song: { title: "Order", tempo: 120, mode: "PAL" },
    voices: [
      { id: 1, waveform: "triangle", patterns: { A: { type: "arpeggio", notes: ["C4", "E4", "G4"] } } },
      { id: 2, waveform: "triangle", patterns: { B: { groove: ["C3", "G3"] } } },
      { id: 3, waveform: "triangle", patterns: { M: { motif: "0 4 7", length: 1 } } },
    ],
    timeline: [{ section: "S", bars: 2, layers: { v1: "A", v2: "B", v3: "M" } }],
  };
  const { states } = runPsid(compile(source).sid, 200);
  const [v1, v2, v3] = [0, 1, 2].map((i) => gateOns(voice(states, i)));
  assert.deepEqual(v1.slice(0, 4).map((o) => [o.frame, o.freq]), [[0, sidFreq("C4")], [25, sidFreq("E4")], [50, sidFreq("G4")], [75, sidFreq("C4")]]);
  assert.deepEqual(v2.slice(0, 3).map((o) => [o.frame, o.freq]), [[0, sidFreq("C3")], [25, sidFreq("G3")], [50, sidFreq("C3")]]);
  assert.deepEqual(v3.slice(0, 4).map((o) => [o.frame, o.freq]), [[0, sidFreq("C3")], [25, sidFreq("E3")], [50, sidFreq("G3")], [75, sidFreq("C3")]]);
});

test("SIDWAVE odd lengths: entries cut at the section end, all-silent songs, declared but unused voices", () => {
  const source = doc({
    voices: `  - id: 1
    patterns:
      A: { groove: [C4, D4, E4], length: 1.5 }
  - id: 2
    patterns:
      UNUSED: { groove: [C5] }`,
    timeline: `  - { bars: 1, layers: { v1: A } }
  - { bars: 1, layers: { v1: "-" } }`,
  });
  const { compiled, sid } = compile(source);
  const { states } = runPsid(sid, compiled.totalFrames);
  const v = voice(states, 0);
  // Entries at beats 0, 1.5 and 3; the third is cut to one beat by the section end, then the voice rests.
  assert.deepEqual(gateOns(v).map((o) => [o.frame, o.freq]), [[at(0), sidFreq("C4")], [at(1.5), sidFreq("D4")], [at(3), sidFreq("E4")]]);
  assert.equal(v.ctrl[at(4) - 1] & 1, 1);
  assert.equal(v.ctrl[at(4)] & 1, 0, "the note is released exactly at the section end");
  assert.ok(voice(states, 1).ctrl.every((c) => c === 0), "a declared voice without layers stays silent");

  const silent = compile(doc({ voices: `  - id: 1\n    patterns: { A: { groove: [C4] } }`, timeline: `  - { bars: 3, layers: { v1: "-" } }` }));
  const run = runPsid(silent.sid, silent.compiled.totalFrames * 2);
  assert.ok(run.states.every((s) => s[4] === 0 && s[11] === 0 && s[18] === 0), "an all-silent song never opens a gate");
  assert.equal(run.states[10][0x18], 0x0f, "volume set, filter off");
});

test("SIDWAVE player worst case: three voices with arpeggio, vibrato, slide, PWM and filter stay within the frame budget", () => {
  const fxVoice = (id, wave) => `  - id: ${id}
    waveform: ${wave}
    patterns:
      A: { type: arpeggio, notes: [C4, E4, G4], frame_rate: 1, length: 0.25, fx: { vibrato: { depth: 1, rate: 6 }, slide: { depth: -5, speed: 3 }, pwm_sweep: { depth: 0.4, speed: 3 }, filter_mod: { sweep: -300, frames: 7 } } }`;
  const source = doc({
    tempo: 200,
    extra: `global_fx:\n  filter_env: { cutoff_base: 900, sweep: 900, speed: 1 }\n`,
    voices: [fxVoice(1, "pulse"), fxVoice(2, "sawtooth"), fxVoice(3, "pulse")].join("\n"),
    timeline: `  - { bars: 4, layers: { v1: A, v2: A, v3: A } }`,
  });
  const { sid, compiled } = compile(source);
  const run = runPsid(sid, compiled.totalFrames + 20);
  assert.deepEqual(run.strayWrites, []);
  // Starting three notes with every effect in one frame is the most expensive case (about 9,800 cycles,
  // half a PAL frame, mostly the vibrato and slide arithmetic); it must stay below 60% of an NTSC frame (17,095 cycles).
  assert.ok(run.maxPlayCycles < 17_095 * 0.6, `play routine took up to ${run.maxPlayCycles} cycles`);
});

// ---------------------------------------------------------------------------
// Review fixes: effect ranges, ties across sections, size and BASIC limits

const cutoffOf = (s) => (s[0x16] << 3) | (s[0x15] & 7);
const centsOf = (freq, note) => 1200 * Math.log2(freq / sidFreq(note));

test("SIDWAVE filter_mod sweeps beyond ±1023 ramp smoothly and clamp to 0..2047", () => {
  for (const [sweep, end, mid] of [["+1500", 2047, 1774], ["-1500", 0, 274], ["+2047", 2047, null], ["-2047", 0, null], ["+800", 1824, 1424]]) {
    const source = doc({
      voices: `  - id: 1\n    waveform: sawtooth\n    patterns:\n      A: { groove: [C3], length: 4, fx: { filter_mod: { sweep: "${sweep} over 4 beats" } } }`,
      timeline: `  - { bars: 1, layers: { v1: A } }`,
    });
    const cutoff = runPsid(compile(source).sid, at(4)).states.map(cutoffOf);
    assert.equal(cutoff[0], 1024, "default base cutoff");
    const up = sweep.startsWith("+");
    for (let f = 1; f < cutoff.length; f += 1) {
      assert.ok(up ? cutoff[f] >= cutoff[f - 1] : cutoff[f] <= cutoff[f - 1], `${sweep}: frame ${f} moves ${cutoff[f - 1]} -> ${cutoff[f]}`);
    }
    if (mid !== null) assert.ok(Math.abs(cutoff[50] - mid) <= 2, `${sweep}: half-way ${cutoff[50]}, expected ${mid}`);
    assert.ok(Math.abs(cutoff[at(4) - 1] - end) <= 9, `${sweep}: ends at ${cutoff[at(4) - 1]}, expected ${end}`);
  }
});

test("SIDWAVE slide: depths up to ±24 semitones and speeds up to 255 frames glide linearly from the right start pitch", () => {
  for (const [note, depth] of [["E5", -24], ["G5", -24], ["F5", 24], ["F7", 24], ["C2", 12], ["A4", -12]]) {
    for (const speed of [1, 3, 40, 100, 200, 255]) {
      const source = doc({
        voices: `  - id: 1\n    waveform: triangle\n    patterns:\n      A: { groove: [${note}], length: 12, fx: { slide: { depth: ${depth}, speed: ${speed} } } }`,
        timeline: `  - { bars: 3, layers: { v1: A } }`,
      });
      const freq = voice(runPsid(compile(source).sid, speed + 2).states, 0).freq;
      const target = sidFreq(note);
      const start = hzToSidFrequency(midiToHz(noteNameToMidi(note) - depth), "PAL");
      const label = `${note} depth ${depth} speed ${speed}`;
      assert.equal(freq[0], start, `${label}: starts ${depth} semitones away`);
      for (let k = 1; k < speed; k += 1) {
        const expected = start + ((target - start) * k) / speed;
        assert.ok(Math.abs(freq[k] - expected) <= 1 + 0.002 * Math.abs(target - start), `${label}: frame ${k} is ${freq[k]}, expected ${expected.toFixed(1)}`);
      }
      assert.equal(freq[speed], target, `${label}: reaches the note after ${speed} frames`);
      assert.equal(freq[speed + 1], target);
    }
  }
  const outOfRange = doc({ voices: `  - id: 1\n    patterns: { A: { groove: [F7], fx: { slide: { depth: -24, speed: 3 } } } }`, timeline: `  - { bars: 1, layers: { v1: A } }` });
  assert.throws(() => compile(outOfRange), /slide into F7 would start at F9, outside the playable range C0..A#7 on PAL/);
});

test("SIDWAVE vibrato swings ±depth semitones symmetrically up to the maximum depth; rates above 12 Hz are rejected", () => {
  for (const depth of [0.1, 0.5, 2, 4, 6]) {
    // 1.566 Hz is a phase step of 8 per frame, so the triangle's peaks fall exactly on frames.
    const source = doc({
      voices: `  - id: 1\n    waveform: sawtooth\n    patterns:\n      A: { groove: [A4], length: 4, fx: { vibrato: { depth: ${depth}, rate: 1.566 } } }`,
      timeline: `  - { bars: 1, layers: { v1: A } }`,
    });
    const cents = voice(runPsid(compile(source).sid, 98).states, 0).freq.slice(0, 97).map((f) => centsOf(f, "A4"));
    assert.ok(Math.abs(Math.max(...cents) - depth * 100) <= 2.5, `depth ${depth}: peak ${Math.max(...cents).toFixed(1)} cents`);
    assert.ok(Math.abs(Math.min(...cents) + depth * 100) <= 2.5, `depth ${depth}: trough ${Math.min(...cents).toFixed(1)} cents`);
  }
  const fast = doc({ voices: `  - id: 1\n    patterns: { A: { groove: [A4], fx: { vibrato: { depth: 0.5, rate: 13 } } } }`, timeline: `  - { bars: 1, layers: { v1: A } }` });
  assert.throws(() => compile(fast), /vibrato\.rate: 13 is above the maximum 12/);
});

test("SIDWAVE: songs larger than 64 KB fail with the same validation error as songs just over the limit", () => {
  for (const bars of [400, 600, 2000]) {
    const dense = doc({
      voices: [1, 2, 3].map((id) => `  - id: ${id}\n    patterns: { A: { groove: [C4, E4, G4, B4], length: 0.25 } }`).join("\n"),
      timeline: `  - { bars: ${bars}, layers: { v1: A, v2: A, v3: A } }`,
    });
    assert.throws(() => compile(dense), (error) => error instanceof SidwaveValidationError && /past the \$D000 limit/.test(error.message), `${bars} bars`);
  }
});

test("SIDWAVE: a tie at the start of a section holds the note from the previous section", () => {
  const source = doc({
    voices: `  - id: 1
    waveform: triangle
    patterns:
      A: { groove: [C4, "~", "~", E4] }
      B: { groove: ["~", "~", G4, "~"] }`,
    timeline: `  - { bars: 1, layers: { v1: A } }
  - { bars: 1, layers: { v1: B } }`,
  });
  const v = voice(runPsid(compile(source).sid, at(8)).states, 0);
  assert.deepEqual(gateOns(v).map((o) => [o.frame, o.freq]), [[0, sidFreq("C4")], [at(3), sidFreq("E4")], [at(6), sidFreq("G4")]]);
  for (let f = at(3); f < at(6) - 2; f += 1) {
    assert.equal(v.ctrl[f] & 1, 1, `E4 is held across the section boundary (frame ${f})`);
    assert.equal(v.freq[f], sidFreq("E4"));
  }
});

test("SIDWAVE: the filter_env sweep restarts with the song, so every pass is identical", () => {
  const source = doc({
    extra: `global_fx:\n  filter_env: { cutoff_base: 1500, sweep: -700, speed: 3 }\n`,
    voices: `  - id: 1\n    waveform: sawtooth\n    patterns: { A: { groove: [C3], length: 4 } }`,
    timeline: `  - { bars: 1, layers: { v1: A } }`,
  });
  const { compiled, sid } = compile(source);
  const total = compiled.totalFrames;
  const cutoff = runPsid(sid, 2 * total).states.map(cutoffOf);
  assert.equal(cutoff[total], 1500);
  for (let f = 0; f < total; f += 1) assert.equal(cutoff[f + total], cutoff[f], `frame ${f} of the second pass`);
});

test("SIDWAVE PRG keeps BASIC usable: program and variables move behind the player", () => {
  const { compiled } = compile(SCALE);
  const mem = new Uint8Array(65536);
  mem.set(compiled.prg.subarray(2), 0x0801);
  mem.fill(0xaa, compiled.endAddress, compiled.endAddress + 3);
  mem[0xea31] = 0x60;
  let raster = 0;
  const cpu = new Cpu(mem, { read(a) { return a === 0xd012 ? (raster = (raster + 1) % 312) & 0xff : undefined; } });
  cpu.call(compiled.entryAddress);
  const word = (a) => mem[a] | (mem[a + 1] << 8);
  const end = compiled.endAddress;
  assert.equal(word(0x2b), end + 1, "start of BASIC (TXTTAB) is behind the player");
  for (const ptr of [0x2d, 0x2f, 0x31]) assert.equal(word(ptr), end + 3, `VARTAB/ARYTAB/STREND at $${ptr.toString(16)}`);
  assert.deepEqual(Array.from(mem.subarray(end, end + 3)), [0, 0, 0], "an empty BASIC program behind the player");
  assert.equal(compiled.basicFreeBytes, 0xa000 - (end + 3));
  assert.deepEqual(compiled.warnings, []);

  const large = compile(doc({
    voices: [1, 2, 3].map((id) => `  - id: ${id}\n    patterns: { A: { groove: [C4, E4, G4, B4], length: 0.25 } }`).join("\n"),
    timeline: `  - { bars: 210, layers: { v1: A, v2: A, v3: A } }`,
  })).compiled;
  assert.ok(large.endAddress > 0xa000, `end $${large.endAddress.toString(16)}`);
  assert.equal(large.basicFreeBytes, 0);
  assert.match(large.warnings.join(" "), /past BASIC's memory \(\$A000\).*OUT OF MEMORY/);
});
