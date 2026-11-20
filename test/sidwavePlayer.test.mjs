// Runs the compiled SIDWAVE player in a small 6502 emulator and checks the SID register writes
// frame by frame against what the SIDWAVE document specifies. No external tools are needed.
import test from "#test/runner";
import { DEFAULT_MUSIC_SEED, generateSidwave } from "../src/audio/generateSidwave.js";
import assert from "#test/assert";
import fs from "node:fs";
import { SIDWAVE_EXAMPLES, readSidwaveExample } from "../src/sidwaveExamples.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileSidwaveToPrg,
  compileSidwaveToSid,
  arrangeSidwave,
  hzToSidFrequency,
  SIDWAVE_MEMORY_END,
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
/** Base NMOS 6502 cycle count. Indexed reads and taken branches add page crossing penalties separately. */
function cycleCost(name, mode) {
  if (name === "JSR" || name === "RTS" || name === "RTI") return 6;
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
  indexed(base, index, readPenalty) {
    const addr = (base + index) & 0xffff;
    if (readPenalty && (addr >> 8) !== (base >> 8)) this.cycles += 1;
    return addr;
  }
  ea(mode, readPenalty) {
    switch (mode) {
      case "zp": return this.fetch();
      case "zpx": return (this.fetch() + this.x) & 0xff;
      case "zpy": return (this.fetch() + this.y) & 0xff;
      case "abs": return this.fetch16();
      case "abx": return this.indexed(this.fetch16(), this.x, readPenalty);
      case "aby": return this.indexed(this.fetch16(), this.y, readPenalty);
      case "izx": return this.zp16((this.fetch() + this.x) & 0xff);
      case "izy": return this.indexed(this.zp16(this.fetch()), this.y, readPenalty);
      case "ind": { const p = this.fetch16(); return this.rd(p) | (this.rd((p & 0xff00) | ((p + 1) & 0xff)) << 8); }
      default: return 0;
    }
  }
  adc(v) { const r = this.a + v + this.c; this.v = (~(this.a ^ v) & (this.a ^ r) & 0x80) ? 1 : 0; this.c = +(r > 0xff); this.a = this.nz(r); }
  cmp(r, v) { this.c = +(r >= v); this.nz(r - v); }
  br(cond) {
    const off = this.fetch();
    if (cond) {
      this.cycles += 1;
      this.pc = this.indexed(this.pc, (off << 24) >> 24, true);
    }
  }
  step() {
    const at = this.pc;
    const op = this.fetch();
    const entry = OPS[op];
    if (!entry) throw new Error(`illegal opcode $${op.toString(16)} at $${at.toString(16)}`);
    const [name, mode] = entry;
    if (this.d) throw new Error("decimal mode is not expected in the player");
    const addr = ["imp", "acc", "imm", "rel"].includes(mode) ? 0 : this.ea(mode, !name.startsWith("ST") && !RMW_OPS.has(name));
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
      case "RTI": case "PLP": { const p = this.pop(); [this.n, this.v, this.d, this.i, this.z, this.c] = [p >> 7, (p >> 6) & 1, (p >> 3) & 1, (p >> 2) & 1, (p >> 1) & 1, p & 1];
        if (name === "RTI") { const lo = this.pop(); this.pc = lo | (this.pop() << 8); }
        break; }
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
  nmi() {
    const { pc, sp } = this;
    this.push(pc >> 8);
    this.push(pc & 255);
    this.push(0x20 | (this.n << 7) | (this.v << 6) | (this.d << 3) | (this.i << 2) | (this.z << 1) | this.c);
    this.i = 1;
    this.pc = this.m[0xfffa] | (this.m[0xfffb] << 8);
    const start = this.cycles;
    this.cycles += 7;
    for (let step = 0; step < 1000; step++) {
      this.step();
      if (this.pc === pc && this.sp === sp) return this.cycles - start;
    }
    throw new Error("NMI did not return");
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
      else if (!(a === 0x01 || a === 0xdc04 || a === 0xdc05 || (a >= 0xfb && a <= 0xfe) || (a >= 0x0100 && a < 0x0200) || (a >= load && a < end))) strayWrites.push(a);
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

test("SIDWAVE speed 2 doubles the CIA call rate and keeps score tempo", () => {
  const source = SCALE.replace("sidwave: 1.0", "sidwave: 1.1").replace("title: Probe", "title: Probe\nspeed: 2");
  const { compiled, sid } = compile(source);
  assert.equal(sid.readUInt32BE(18), 1);
  assert.equal(sid.readUInt16BE(0x76), 0x04);
  const mem = new Uint8Array(65536);
  mem.set(compiled.prg.subarray(2), 0x0801);
  mem[0xea31] = 0x60;
  let raster = 0;
  const io = {};
  const cpu = new Cpu(mem, {
    read(a) { if (a === 0xd012) return (raster = (raster + 1) % 312) & 0xff; return undefined; },
    write(a, v) { if (a >= 0xdc00 && a <= 0xdc0f) io[a] = v; },
  });
  mem[0xdc0e] = 0x80;
  cpu.call(compiled.entryAddress);
  const irq = mem[0x0314] | (mem[0x0315] << 8);
  const latch = Math.round(985_248 / (sidwaveFrameRate("PAL") * 2)) - 1;
  assert.equal(io[0xdc04] | (io[0xdc05] << 8), latch);
  const onsets = [];
  for (let tick = 0; tick < 205; tick += 1) {
    const gate = mem[0xd404] & 1;
    cpu.call(irq);
    if (!gate && (mem[0xd404] & 1)) onsets.push(tick);
  }
  assert.deepEqual(onsets.slice(0, 4), [0, 1, 2, 3].map((beat) => Math.round(beat * sidwaveFrameRate("PAL"))));
  const psid = runPsid(sid, 205);
  assert.equal(psid.mem[0xdc04] | (psid.mem[0xdc05] << 8), latch, "PSID init sets the multispeed latch");
  assert.deepEqual(gateOns(voice(psid.states, 0)).slice(0, 4).map(({ frame }) => frame), onsets.slice(0, 4));
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

// ---------------------------------------------------------------------------
// Final review: vibrato precision and range, size boundary, echo minimum length

function vibratoCents(mode, note, depth) {
  // 1.566 Hz is a phase step of 8 per frame, so the triangle's peaks fall exactly on frames.
  const source = doc({
    mode,
    voices: `  - id: 1\n    waveform: sawtooth\n    patterns:\n      A: { groove: [${note}], length: 4, fx: { vibrato: { depth: ${depth}, rate: 1.566 } } }`,
    timeline: `  - { bars: 1, layers: { v1: A } }`,
  });
  const target = sidFreq(note, mode);
  const cents = voice(runPsid(compile(source).sid, 98).states, 0).freq.slice(0, 97).map((f) => 1200 * Math.log2(f / target));
  return [Math.max(...cents), Math.min(...cents)];
}

test("SIDWAVE vibrato keeps its depth in the bottom octave (amplitude and offset are rounded, not truncated)", () => {
  // At C0 one frequency unit is about 6 cents, so the best achievable swing is within ~3 cents of ±depth.
  for (const [note, depth, tolerance] of [["C0", 1, 4], ["C0", 0.25, 4], ["C1", 1, 3], ["C#0", 3, 3]]) {
    const [up, down] = vibratoCents("PAL", note, depth);
    assert.ok(Math.abs(up - depth * 100) <= tolerance, `${note} depth ${depth}: peak +${up.toFixed(1)} cents`);
    assert.ok(Math.abs(down + depth * 100) <= tolerance, `${note} depth ${depth}: trough ${down.toFixed(1)} cents`);
  }
});

test("SIDWAVE vibrato that would rise above the SID's highest frequency is rejected", () => {
  const one = (mode, notes, depth) => doc({
    mode,
    voices: `  - id: 1\n    patterns: { A: { type: arpeggio, notes: [${notes}], frame_rate: 2, fx: { vibrato: { depth: ${depth}, rate: 5 } } } }`,
    timeline: `  - { bars: 1, layers: { v1: A } }`,
  });
  assert.throws(() => compile(one("PAL", "A#7", 1)), /vibrato\.depth: a vibrato of 1 semitones on A#7 would rise above the SID's highest frequency on PAL; use a depth of at most 0\.54/);
  assert.throws(() => compile(one("NTSC", "B7", 1)), /on B7 would rise above the SID's highest frequency on NTSC; use a depth of at most 0\.19/);
  assert.throws(() => compile(one("PAL", "C7, A#7", 1)), /on A#7 would rise above/, "the highest chord tone counts");
  compile(one("PAL", "A#7", 0.54));
  const [up, down] = vibratoCents("PAL", "A#7", 0.54);
  assert.ok(Math.abs(up - 54) <= 1 && Math.abs(down + 54) <= 1, `A#7 depth 0.54: +${up.toFixed(1)} / ${down.toFixed(1)} cents`);
});

test("SIDWAVE size limit boundary: the largest song that fits ends just below $D000, one bar more is rejected", () => {
  const song = (bars) => doc({
    voices: `  - id: 1\n    patterns: { A: { groove: [C4, E4, G4, B4], length: 0.25 } }`,
    timeline: `  - { bars: ${bars}, layers: { v1: A } }`,
  });
  const fits = (bars) => {
    try {
      return compile(song(bars)).compiled;
    } catch (error) {
      if (error instanceof SidwaveValidationError && /past the \$D000 limit/.test(error.message)) return null;
      throw error;
    }
  };
  let lo = 1;
  let hi = 2000;
  assert.ok(fits(lo) && !fits(hi));
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  const largest = fits(lo);
  // The installer writes three bytes behind the program, so the program must end 3 bytes before $D000.
  const used = largest.endAddress + 3;
  assert.ok(used <= SIDWAVE_MEMORY_END && SIDWAVE_MEMORY_END === 0xd000, `largest song uses up to $${used.toString(16)}`);
  // One bar adds about 70 bytes, so the largest song that fits lands within 100 bytes of the limit.
  assert.ok(used > 0xd000 - 100, `largest song uses up to $${used.toString(16)}, more than 100 bytes below $D000`);
});

test("SIDWAVE reverb echo drops echo notes shorter than 3 frames", () => {
  // Notes at frames 0, 25, 50 and 75 of a 100-frame section; a 23-frame delay leaves the last echo only 2 frames.
  const source = doc({
    extra: `global_fx:\n  reverb_sim: { depth: 0.5, delay_frames: 23 }\n`,
    voices: `  - id: 1\n    patterns: { A: { groove: [C4, D4, E4, F4] } }`,
    timeline: `  - { bars: 1, layers: { v1: A } }`,
  });
  const { compiled, sid } = compile(source);
  assert.equal(compiled.totalFrames, 100);
  const echo = voice(runPsid(sid, 100).states, 1);
  assert.deepEqual(gateOns(echo).map((o) => [o.frame, o.freq]), [[23, sidFreq("C4")], [48, sidFreq("D4")], [73, sidFreq("E4")]]);
  assert.equal(echo.ctrl[97] & 1, 1, "the E4 echo sounds until frame 98");
  for (let f = 98; f < 100; f += 1) assert.equal(echo.ctrl[f] & 1, 0, `no 2-frame echo of F4 at frame ${f}`);
});

test("SIDWAVE 1.1 named instruments select combined waveforms and ring modulation", () => {
  const source = `sidwave: 1.1
tempo: 120
instruments:
  bell: { waveform: tri+pulse, adsr: [0, 4, 8, 3], ring: true }
voices:
  - id: 1
    instrument: bell
    patterns: { A: { groove: [C4, D4] } }
timeline:
  - { bars: 1, layers: { v1: A } }
`;
  const run = runPsid(compile(source).sid, 5);
  const v = voice(run.states, 0);
  assert.equal(v.ctrl[0] & 0x54, 0x54, "triangle+pulse wave bits and ring bit are set with gate");
  assert.equal(v.ctrl[1] & 0x54, 0x54, "the named instrument remains selected on subsequent notes");
});

test("SIDWAVE wavetable changes waveform and fixed or relative pitch per frame", () => {
  const source = doc({ extra: `instruments:\n  kick:\n    wavetable:\n      - { wave: noise, note: C6 }\n      - { wave: pulse, note: C3 }\n      - { wave: pulse, note: A2 }\n      - { wave: pulse, note: F2 }\n      - { wave: tri, test: true, ring: true, frames: 1 }\n`, voices: `  - id: 1\n    instrument: kick\n    patterns:\n      K: { groove: [C4] }`, timeline: `  - { bars: 1, layers: { v1: K } }` });
  const { states } = runPsid(compile(source).sid, 8);
  const v = voice(states, 0);
  assert.equal(v.ctrl[0], 0x81);
  assert.equal(v.freq[0], sidFreq("C6"));
  assert.equal(v.ctrl[1], 0x41);
  assert.equal(v.freq[1], sidFreq("C3"));
  assert.equal(v.freq[2], sidFreq("A2"));
  assert.equal(v.freq[3], sidFreq("F2"));
  assert.equal(v.ctrl[4], 0x1d, "triangle + gate + ring + test");
});

test("SIDWAVE wavetable relative note steps loop", () => {
  const source = doc({ extra: `instruments:\n  arp:\n    loop: 0\n    wavetable:\n      - { note: '+0' }\n      - { note: '+12' }\n`, voices: `  - id: 1\n    instrument: arp\n    patterns:\n      A: { groove: [C4] }`, timeline: `  - { bars: 1, layers: { v1: A } }` });
  const { states } = runPsid(compile(source).sid, 8);
  const v = voice(states, 0);
  assert.deepEqual(v.freq.slice(0, 6), [sidFreq("C4"), sidFreq("C5"), sidFreq("C4"), sidFreq("C5"), sidFreq("C4"), sidFreq("C5")]);
});

test("SIDWAVE portamento glides from the previous pitch and reaches the target after N calls", () => {
  for (const mode of ["PAL", "NTSC"]) {
    const source = doc({
      mode,
      extra: `instruments: { lead: { waveform: tri, portamento: 4 } }\n`,
      voices: `  - id: 1
    instrument: lead
    patterns:
      A: { groove: [C4, G4, "-", { note: D4, portamento: 2 }, { note: F4, portamento: 0 }], length: 0.5 }`,
      timeline: `  - { bars: 1, layers: { v1: A } }`,
    });
    const frame = (beat) => at(beat, 120, mode);
    const { states } = runPsid(compile(source).sid, frame(2) + 1);
    const v = voice(states, 0);
    const hz = (note) => sidFreq(note, mode);
    const rise = hz("G4") - hz("C4");
    const onset = frame(0.5);
    assert.equal(v.freq[0], hz("C4"), "the first note has no previous pitch");
    assert.deepEqual(v.freq.slice(onset, onset + 5), [0, 1, 2, 3, 4].map((i) => hz("G4") - Math.floor(rise * (4 - i) / 4)));
    assert.equal(v.ctrl[onset - 1] & 1, 0, "portamento retriggers unless legato is set");
    assert.equal(v.ctrl[onset] & 1, 1);
    const fall = hz("G4") - hz("D4");
    assert.deepEqual(v.freq.slice(frame(1.5), frame(1.5) + 3), [hz("G4"), hz("D4") + Math.floor(fall / 2), hz("D4")]);
    assert.equal(v.freq[frame(2)], hz("F4"), "entry zero overrides the instrument duration");
  }
});

test("SIDWAVE legato keeps GATE, ADSR and all three tables running while pitch glides", () => {
  const source = doc({
    extra: `instruments:
  lead:
    adsr: [1, 4, 10, 3]
    legato: true
    portamento: 3
    wavetable: [{ wave: pulse, frames: 10 }, { wave: tri+pulse }]
    pulsetable: [{ set: 1000 }, { add: 7, frames: 60 }]
    filtertable: [{ cutoff: 500, type: lowpass, resonance: 6 }, { add: 3, frames: 60 }]
`,
    voices: `  - id: 1
    instrument: lead
    patterns:
      A: { length: 0.5, groove: [C4, D4, { note: E4, legato: false }, "-", { note: G4, legato: true, portamento: 0 }] }`,
    timeline: `  - { bars: 1, layers: { v1: A } }`,
  });
  const { states } = runPsid(compile(source).sid, at(2) + 2);
  const v = voice(states, 0);
  const onset = at(0.5);
  const delta = sidFreq("D4") - sidFreq("C4");
  assert.deepEqual(v.ctrl.slice(onset - 2, onset + 4), Array(6).fill(0x51), "no gate drop or wavetable reset");
  assert.deepEqual(v.ad.slice(onset - 2, onset + 4), Array(6).fill(0x14), "no hard restart");
  assert.deepEqual(v.pw.slice(onset - 1, onset + 2), [-1, 0, 1].map((i) => 1000 + 7 * (onset + i)));
  assert.deepEqual(filterRegisters(states).slice(onset - 1, onset + 2), [-1, 0, 1].map((i) => filterFrame(500 + 3 * (onset + i), 0x61, 0x1f)));
  for (let i = 0; i <= 3; i += 1) {
    const expected = Math.round(sidFreq("C4") + delta * i / 3);
    assert.ok(Math.abs(v.freq[onset + i] - expected) <= (i % 3 ? 1 : 0), `glide call ${i}`);
  }
  assert.equal(v.ctrl[at(1) - 1] & 1, 0, "explicit false enables hard restart");
  assert.equal(v.ad[at(1) - 1], 0);
  assert.equal(v.ctrl[at(1)], 0x41, "the wavetable restarts on a normal attack");
  assert.equal(v.ctrl[at(1.5)] & 1, 0, "the rest releases the gate");
  assert.equal(v.ctrl[at(2)], 0x41, "legato after a rest plays a new attack");
  assert.equal(v.freq[at(2)], sidFreq("G4"), "portamento zero changes pitch immediately");
});

test("SIDWAVE drums shorthand plays kit letters and leaves the dots silent", () => {
  const source = doc({
    extra: `instruments: { kick: { waveform: pulse }, hat: { waveform: noise } }\n`,
    voices: `  - id: 1
    patterns:
      D: { length: 0.5, drums: { kit: { k: kick, h: hat }, steps: "k.h." } }`,
    timeline: `  - { bars: 1, layers: { v1: D } }`,
  });
  const { doc: parsed, sid } = compile(source);
  assert.equal(arrangeSidwave(parsed).voices[0].notes.length, 4);
  const v = voice(runPsid(sid, at(4)).states, 0);
  assert.deepEqual(gateOns(v).map(({ frame }) => frame), [0, at(1), at(2), at(3)]);
  assert.equal(v.ctrl[0], 0x41);
  assert.equal(v.ctrl[at(0.5)] & 1, 0);
  assert.equal(v.ctrl[at(1)], 0x81);
  assert.equal(v.ctrl[at(1.5)] & 1, 0);
  assert.throws(() => parseSidwave(source.replace('"k.h."', '"x.h."')), /no kit instrument for "x"/);
});

test("SIDWAVE built-in library recipes compile and each drum writes descending frequencies", () => {
  const drumPitches = {
    kick: ["C6", "C3", "C2", "C1"],
    snare: ["A6", "A6", "C6", "C4", "C3"],
    hat: ["G7", "C7", "C7"],
  };
  const names = ["kick", "snare", "hat", "bass_pluck", "filter_bass", "lead_pwm", "chip_arp_major", "chip_arp_minor", "bell_ring", "sync_lead", "pad_slow"];
  for (const name of names) {
    const source = doc({ voices: `  - id: 1\n    instrument: lib:${name}\n    patterns: { A: { groove: [C3] } }`, timeline: `  - { bars: 1, layers: { v1: A } }` });
    const { sid } = compile(source);
    const v = voice(runPsid(sid, 8).states, 0);
    assert.equal(v.ctrl[0] & 1, 1, `${name} starts with gate on`);
    if (drumPitches[name]) {
      assert.equal(v.ctrl[0], 0x81, `${name} starts with noise`);
      assert.deepEqual(v.freq.slice(0, drumPitches[name].length), drumPitches[name].map((note) => sidFreq(note)));
    }
    if (name === "kick") assert.equal(v.ctrl[1], 0x41);
    if (name === "snare") assert.equal(v.ctrl[3], 0x41);
    if (name === "hat") assert.equal(v.ctrl[2], 0x80);
  }
});

test("SIDWAVE three wavetable voices stay within the per-call cycle budget", () => {
  const source = doc({ extra: `instruments:\n  tab:\n    wavetable:\n      - { wave: pulse, note: '+0', frames: 2 }\n      - { wave: tri, note: '+12', frames: 2 }\n`, voices: `  - id: 1\n    instrument: tab\n    patterns:\n      A: { groove: [C4] }\n  - id: 2\n    instrument: tab\n    patterns:\n      B: { groove: [E4] }\n  - id: 3\n    instrument: tab\n    patterns:\n      C: { groove: [G4] }`, timeline: `  - { bars: 1, layers: { v1: A, v2: B, v3: C } }` });
  const { compiled, sid } = compile(source);
  const { maxPlayCycles } = runPsid(sid, 8);
  assert.ok(maxPlayCycles < 4000, `three wavetable voices use ${maxPlayCycles} cycles per call`);
  assert.equal(voice(runPsid(sid, 4).states, 0).freq[2], sidFreq("C5"));
  // The standalone PRG includes the fixed player, tables and song streams.
  assert.ok(compiled.prg.length > 0);
});

test("SIDWAVE pulse tables set, add, clamp, loop, hold and reset on note start", () => {
  const source = doc({
    extra: `instruments:
  held:
    pulsetable:
      - { set: 0.5 }
      - { add: -1000, frames: 3 }
      - { set: 1 }
      - { add: 30, frames: 1 }
      - { add: -42, frames: 2 }
  looping:
    pulse_width: 0.25
    pulsetable:
      loop: 1
      steps:
        - { add: -24, frames: 2 }
        - { set: 1200, frames: 2 }
        - { add: -400, frames: 2 }
`,
    voices: `  - id: 1
    instrument: held
    patterns: { A: { groove: [C4, D4], fx: { pwm_sweep: { depth: 500, speed: 4 } } } }
  - id: 3
    instrument: looping
    patterns: { B: { groove: [G4, F4] } }`,
    timeline: `  - { bars: 1, layers: { v1: A, v3: B } }`,
  });
  const { states } = runPsid(compile(source).sid, at(1) + 10);
  const read = (v) => states.map((s) => {
    const lo = s[2 + v * 7];
    const hi = s[3 + v * 7];
    assert.ok(hi < 16, "only the low nibble of pulse width high is used");
    return lo | (hi << 8);
  });
  const held = [2048, 1048, 48, 1, 4094, 4094, 4052, 4010, 4010, 4010];
  const looping = [1000, 976, 1200, 1200, 800, 400, 1200, 1200, 800, 400];
  for (const start of [0, at(1)]) {
    assert.deepEqual(read(0).slice(start, start + 10), held);
    assert.deepEqual(read(2).slice(start, start + 10), looping);
  }
});

function filterRegisters(states) {
  return states.map((s) => Array.from(s.slice(0x15, 0x19)));
}

function filterFrame(cutoff, resRoute, modeVolume) {
  return [cutoff & 7, cutoff >> 3, resRoute, modeVolume];
}

test("SIDWAVE filter tables update all filter registers, loop, hold and hand ownership back", () => {
  const source = doc({
    extra: `instruments:
  held:
    filtertable:
      - { cutoff: 1769, resonance: 15, type: lowpass+highpass }
      - { add: 200, frames: 2, resonance: 0 }
      - { add: -2048, frames: 1, type: all }
      - { add: 13, frames: 2 }
  looping:
    filtertable:
      loop: 0
      steps:
        - { cutoff: 1031, type: bandpass+highpass, frames: 2 }
        - { add: -16, frames: 2, resonance: 3 }
`,
    voices: `  - id: 1
    instrument: held
    patterns: { A: { groove: [C3, "~", D3, "~"] } }
  - id: 2
    instrument: looping
    patterns: { B: { groove: ["-", "-", E4, "~", "~", "-", G4, "-"], length: 0.5 } }`,
    timeline: `  - { bars: 1, layers: { v1: A, v2: B } }`,
  });
  const { states } = runPsid(compile(source).sid, at(4) + 8);
  const regs = filterRegisters(states);
  assert.deepEqual(regs.slice(0, 8), [
    filterFrame(1769, 0xf1, 0x5f),
    filterFrame(1969, 0x01, 0x5f),
    filterFrame(2047, 0x01, 0x5f),
    filterFrame(0, 0x01, 0x7f),
    filterFrame(13, 0x01, 0x7f),
    filterFrame(26, 0x01, 0x7f),
    filterFrame(26, 0x01, 0x7f),
    filterFrame(26, 0x01, 0x7f),
  ]);
  for (const [beat, routing] of [[1, 3], [3, 3]]) {
    assert.deepEqual(regs.slice(at(beat), at(beat) + 6), [
      filterFrame(1031, 0x80 | routing, 0x6f),
      filterFrame(1031, 0x80 | routing, 0x6f),
      filterFrame(1015, 0x30 | routing, 0x6f),
      filterFrame(999, 0x30 | routing, 0x6f),
      filterFrame(1031, 0x30 | routing, 0x6f),
      filterFrame(1031, 0x30 | routing, 0x6f),
    ]);
  }
  assert.deepEqual(regs[at(2)], filterFrame(1769, 0xf3, 0x5f), "a newly started lower voice takes ownership");
  assert.deepEqual(regs[at(2.5)], filterFrame(26, 0x01, 0x7f), "voice 2 stops routing when it releases");
  assert.deepEqual(regs[at(3.5)], filterFrame(26, 0x01, 0x7f), "the older note takes ownership back at its held value");
  assert.deepEqual(regs.slice(at(4), at(4) + 8), regs.slice(0, 8), "note starts reset filter state on the next song loop");
});

test("SIDWAVE filter table suspends the global envelope and ramp, preserving master volume", () => {
  const extra = `instruments:
  filtered:
    filtertable: [{ cutoff: 305, resonance: 6, type: highpass }]
global_fx:
  filter_env: { cutoff_base: 800, sweep: 800, speed: 3.99, resonance: 9, type: bandpass, voices: [1] }
`;
  const source = doc({
    extra,
    voices: `  - id: 1
    patterns: { A: { groove: [C3], length: 4, fx: { filter_mod: { sweep: "+400 over 1 steps" } } } }
  - id: 2
    instrument: filtered
    patterns: { B: { groove: ["-", E4, "-", "-"] } }`,
    timeline: `  - { bars: 1, layers: { v1: "A–", v2: "B–" } }`,
  });
  const reference = source.replace("    instrument: filtered\n", "");
  const { states } = runPsid(compile(source).sid, at(3) + 1);
  const baseline = filterRegisters(runPsid(compile(reference).sid, states.length).states);
  const regs = filterRegisters(states);
  assert.deepEqual(regs.slice(0, at(1)), baseline.slice(0, at(1)));
  for (let f = at(1); f < at(2); f += 1) {
    assert.deepEqual(regs[f], filterFrame(305, 0x62, 0x40 | (baseline[f][3] & 15)), `filter owned on call ${f}`);
  }
  assert.equal(regs[at(1)][3], 0x4b, "volume fade also applies while a filter table owns the filter");
  const paused = at(2) - at(1);
  for (let f = at(2); f < states.length; f += 1) {
    assert.deepEqual(regs[f].slice(0, 3), baseline[f - paused].slice(0, 3), `global sweep and ramp resume on call ${f}`);
    assert.equal(regs[f][3], baseline[f][3]);
  }
});

test("SIDWAVE register tables reject invalid steps and loop indices", () => {
  for (const [table, value, error] of [
    ["pulsetable", "[{set: 1.5}]", /pulsetable\[0\]\.set/],
    ["pulsetable", "[{set: 0}]", /pulsetable\[0\]\.set/],
    ["pulsetable", "[{add: 1}]", /pulsetable\[0\]\.frames/],
    ["pulsetable", "[{add: -2049, frames: 1}]", /pulsetable\[0\]\.add/],
    ["pulsetable", "[{set: 20, add: 1, frames: 1}]", /exactly one/],
    ["pulsetable", "{steps: [{set: 0.2}], loop: 1}", /pulsetable\.loop/],
    ["filtertable", "[{cutoff: 2048}]", /filtertable\[0\]\.cutoff/],
    ["filtertable", "[{cutoff: 1, resonance: 16}]", /filtertable\[0\]\.resonance/],
    ["filtertable", "[{cutoff: 1, type: toString}]", /filtertable\[0\]\.type/],
    ["filtertable", "[{add: 1, frames: 256}]", /filtertable\[0\]\.frames/],
    ["filtertable", "[]", /filtertable/],
  ]) {
    const source = doc({ extra: `instruments: {tab: {${table}: ${value}}}\n`,
      voices: `  - id: 1\n    instrument: tab\n    patterns: { A: { groove: [C4] } }`,
      timeline: `  - { bars: 1, layers: { v1: A } }` });
    assert.throws(() => parseSidwave(source), error);
  }
});

test("SIDWAVE three voices with wave and pulse tables and one filter table fit the player budget", () => {
  const pulse = "    pulsetable: {loop: 0, steps: [{set: 0.35}, {add: 23, frames: 3}, {add: -61, frames: 2}]}\n";
  const filter = "    filtertable: {loop: 1, steps: [{cutoff: 1231}, {add: -47, frames: 3, type: lowpass+highpass}, {add: 47, frames: 3}]}\n";
  const wave = "    loop: 0\n    wavetable: [{wave: pulse, note: '+0', frames: 2}, {wave: tri+pulse, note: '+12', frames: 2}]\n";
  const source = (tables) => doc({
    extra: `instruments:\n  lead:\n${wave}    adsr: [0, 5, 12, 3]\n${tables ? pulse : ""}  bass:\n${wave}    adsr: [0, 6, 8, 3]\n${tables ? pulse + filter : ""}`,
    voices: `  - id: 1
    instrument: lead
    patterns: { A: { groove: [C4, D4, E4, D4], length: 0.5 } }
  - id: 2
    instrument: lead
    patterns: { B: { groove: [E4, G4], length: 0.75 } }
  - id: 3
    instrument: bass
    patterns: { C: { groove: [C2, G2, C3, G2], length: 1 } }`,
    timeline: `  - { bars: 1, layers: { v1: A, v2: B, v3: C } }`,
  });
  const { compiled, sid } = compile(source(true));
  const baseline = compile(source(false)).compiled;
  const playerBytes = (result) => result.prg.length - 2 - result.streamBytes.reduce((sum, size) => sum + size, 0);
  const { states, maxPlayCycles, strayWrites } = runPsid(sid, compiled.totalFrames * 2);
  assert.deepEqual(strayWrites, []);
  for (let v = 0; v < 3; v += 1) {
    const { pw, ctrl } = voice(states, v);
    assert.deepEqual(pw.slice(0, 4), [1433, 1456, 1479, 1502]);
    assert.deepEqual(ctrl.slice(0, 4), [0x41, 0x41, 0x51, 0x51]);
  }
  assert.deepEqual(filterRegisters(states).slice(0, 4), [
    filterFrame(1231, 0x84, 0x1f),
    filterFrame(1184, 0x84, 0x5f),
    filterFrame(1137, 0x84, 0x5f),
    filterFrame(1090, 0x84, 0x5f),
  ]);
  assert.ok(maxPlayCycles < 4000, `three voices with tables use ${maxPlayCycles} cycles per call`);
  assert.ok(compiled.endAddress < SIDWAVE_MEMORY_END);
  const growth = playerBytes(compiled) - playerBytes(baseline);
  assert.ok(growth > 0);
  console.log(`SIDWAVE tables measurement: ${maxPlayCycles} cycles, ${playerBytes(baseline)} -> ${playerBytes(compiled)} player bytes (+${growth})`);
});


test("SIDWAVE 1.1 authoring example plays within the three-voice CPU and memory budgets", () => {
  const spec = fs.readFileSync(new URL("../data/sound/sidwave.md", import.meta.url), "utf8");
  const example = /```yaml\n(sidwave: 1\.1\n[\s\S]*?)```/.exec(spec)[1];
  const { compiled, sid } = compile(example);
  const baseline = compile(example.replace(/, portamento: \d+|, legato: true|^    portamento: \d+\n/gm, "")).compiled;
  const { maxPlayCycles, strayWrites } = runPsid(sid, compiled.totalFrames * 2);
  const playerBytes = ({ prg, streamBytes }) => prg.length - 2 - streamBytes.reduce((a, b) => a + b, 0);
  assert.deepEqual(strayWrites, []);
  assert.ok(maxPlayCycles < 4000, `authoring example uses ${maxPlayCycles} cycles`);
  assert.ok(compiled.endAddress < SIDWAVE_MEMORY_END);
  console.info(`SIDWAVE articulation measurement: ${maxPlayCycles} cycles, ${playerBytes(baseline)} -> ${playerBytes(compiled)} player bytes`);
});


test("generated SIDWAVE pieces gate on all three voices within two bars and release them at the end", () => {
  for (const style of ["chiptune", "ambient", "funk"]) {
    const generated = generateSidwave({ root: "C4", style, seed: DEFAULT_MUSIC_SEED, system: "PAL", preset: "classic" });
    const doc = parseSidwave(generated.score);
    const compiled = compileSidwaveToPrg(doc, { loop: false });
    const { sid } = compileSidwaveToSid(doc, compiled.prg);
    const { states, cpu, strayWrites } = runPsid(sid, compiled.totalFrames + 4);
    const twoBars = Math.round(8 * compiled.framesPerSecond * 60 / generated.tempo);
    for (let v = 0; v < 3; v += 1) {
      const registers = voice(states, v);
      assert.ok(gateOns(registers).some(({ frame }) => frame < twoBars), `${style} voice ${v + 1} starts`);
      assert.ok(registers.ctrl.slice(compiled.totalFrames).every((ctrl) => ctrl === 0), `${style} voice ${v + 1} finishes`);
    }
    assert.deepEqual(strayWrites, []);
    const writes = [];
    cpu.hooks.write = (address) => writes.push(address);
    cpu.call(compiled.playAddress);
    assert.deepEqual(writes, [], "no SID writes after the piece has ended");
  }
});

test("the one-shot PRG removes its IRQ after the last call", () => {
  const score = generateSidwave({ root: "C4", style: "chiptune", seed: DEFAULT_MUSIC_SEED, system: "PAL", preset: "classic" }).score;
  const compiled = compileSidwaveToPrg(parseSidwave(score), { loop: false });
  const mem = new Uint8Array(65536);
  mem.set(compiled.prg.subarray(2), compiled.loadAddress);
  mem[0xea31] = 0x60; // RTS in place of the KERNAL IRQ
  mem[0x02a6] = 1;
  let raster = 100;
  const cpu = new Cpu(mem, {
    read(address) { if (address === 0xd012) return (raster = (raster + 1) % 312) & 0xff; },
  });
  cpu.call(compiled.entryAddress);
  const irq = mem[0x0314] | (mem[0x0315] << 8);
  for (let tick = 0; tick <= compiled.totalFrames; tick += 1) cpu.call(irq);
  assert.deepEqual([...mem.slice(0x0314, 0x0316)], [0x31, 0xea]);
  assert.deepEqual([mem[0xd404], mem[0xd40b], mem[0xd412]], [0, 0, 0]);
});

const MULTI_BASES = ["$D400", "$D420", "$D500", "$D460", "$D440", "$D480", "$D4A0", "$D5A0"];
const sidMap = (count) => MULTI_BASES.slice(0, count).map((address, i) => ({
  id: `chip${i + 1}`, address, volume: 15 - i,
}));
const multiScore = (sids, voices, options = {}) => ({
  sidwave: 1.2, title: "Fanfare", tempo: 120, mode: "PAL", sids, voices,
  timeline: [{ bars: 1, layers: Object.fromEntries(voices.map((v) => [`v${v.id}`, "A"])) }],
  ...options,
});

function loadMultiPlayer(doc, options) {
  const compiled = compileSidwaveToPrg(doc, options);
  const mem = new Uint8Array(65536);
  mem.set(compiled.prg.subarray(2), compiled.loadAddress);
  mem[0xea31] = 0x60; // KERNAL IRQ stub
  mem[0x02a6] = 1;
  let raster = 100;
  const writes = [];
  const cpu = new Cpu(mem, {
    write(address, value) { writes.push([address, value]); },
    read(address) { if (address === 0xd012) return (raster = (raster + 1) % 312) & 0xff; },
  });
  return { compiled, mem, cpu, writes };
}

for (const count of [4, 8]) {
  test(`SIDWAVE 1.2 writes each ${count}-SID window and gives each filter independent ownership`, () => {
    const sids = sidMap(count);
    if (count === 8) sids[7].volume = 0;
    sids[1].filter = { filter_env: { cutoff_base: 800, sweep: 800, speed: 3.99, resonance: 9, type: "bandpass" } };
    sids[2].filter = { filter_env: { cutoff_base: 700, resonance: 4, type: "lowpass" } };
    sids[3].filter = { filter_mod: { sweep: 300, frames: 10 } };
    const pitches = ["C3", "D3", "E3", "F3", "G3", "A3", "B3", "C4"];
    const voices = sids.map((_, i) => ({
      id: 1 + 3 * i, waveform: "triangle",
      patterns: { A: { groove: [pitches[i]], length: 4 } },
    }));
    voices[2].instrument = "lower";
    voices.push({ id: 30, sid: "chip3", channel: 2, instrument: "upper", patterns: {
      A: { groove: ["G4", "-", "G4", "-"] },
    } });
    const doc = parseSidwave(multiScore(sids, voices, { instruments: {
      lower: { waveform: "triangle", filtertable: [{ cutoff: 400, resonance: 5, type: "lowpass" }] },
      upper: { waveform: "pulse", filtertable: [{ cutoff: 1200, resonance: 7, type: "highpass" }] },
    } }));
    const { cpu, mem, writes, compiled } = loadMultiPlayer(doc, { loop: false });
    mem[0xfd] = 0x12;
    mem[0xfe] = 0x34;
    cpu.call(compiled.initAddress);
    assert.deepEqual([...mem.slice(0xfd, 0xff)], [0x12, 0x34]);
    const bases = doc.sids.map((sid) => sid.address);
    for (const base of bases) assert.deepEqual([...mem.slice(base, base + 25)], Array(25).fill(0));

    const cutoff = (base) => mem[base + 21] | (mem[base + 22] << 3);
    for (let frame = 0; frame <= compiled.totalFrames + 15; frame++) {
      writes.length = 0;
      const cycles = cpu.call(compiled.playAddress);
      assert.ok(cycles <= compiled.worstCaseCyclesPerCall);
      assert.deepEqual([...mem.slice(0xfd, 0xff)], [0x12, 0x34]);
      const io = writes.filter(([address]) => address >= 0xd000 && address < 0xe000);
      assert.ok(io.every(([address]) => bases.some((base) => address >= base && address <= base + 24)));
      if (frame >= compiled.totalFrames) {
        const step = frame - compiled.totalFrames + 1;
        for (const [i, base] of bases.entries()) {
          assert.equal(mem[base + 4] & 1, 0, "the gate releases at the start of the tail");
          assert.equal(mem[base + 24] & 15, Math.max(0, sids[i].volume - step));
        }
        if (step > 15) assert.deepEqual(io, []);
        continue;
      }
      for (const [i, base] of bases.entries()) {
        assert.ok(io.some(([address]) => address === base + 4), `frame ${frame}, SID ${i + 1} control write`);
        assert.ok(io.some(([address]) => address === base + 24), `frame ${frame}, SID ${i + 1} volume write`);
        assert.equal(mem[base] | (mem[base + 1] << 8), hzToSidFrequency(midiToHz(noteNameToMidi(pitches[i])), "PAL"));
        assert.equal(mem[base + 24] & 15, Math.min(frame + 1, sids[i].volume));
      }
      if (frame < 10) {
        assert.equal(cutoff(0xd420), 800 + frame * 8);
        assert.equal(cutoff(0xd460), 1024 + frame * 30);
        assert.equal(mem[0xd437], 0x91);
        assert.equal(mem[0xd438], 0x20 | (frame + 1));
      }
      if (frame === 0) {
        assert.equal(cutoff(0xd500), 1200);
        assert.equal(mem[0xd517], 0x73);
        assert.equal(mem[0xd518], 0x41);
        assert.equal(mem[0xd507] | (mem[0xd508] << 8), hzToSidFrequency(midiToHz(noteNameToMidi("G4")), "PAL"));
      }
      if (frame === 26) {
        assert.equal(cutoff(0xd500), 400, "the still sounding table takes over on the same chip");
        assert.equal(mem[0xd517], 0x51);
        assert.equal(mem[0xd518], 0x1d);
        assert.equal(cutoff(0xd460), 1324, "the other chip retains its own ramp");
      }
    }
  });
}

test("SIDWAVE 1.2 PSID v3/v4 addresses, flags and payload offset match HVSC", () => {
  for (const count of [2, 3]) {
    const sids = sidMap(count);
    sids[0].model = "6581";
    sids[1].model = "8580";
    if (count === 3) sids[2].model = "6581";
    // PSID treats $D400 as primary even when another chip is first in the score.
    const map = count === 3 ? [sids[1], sids[0], sids[2]] : sids;
    const doc = parseSidwave(multiScore(map, [{ id: 1, patterns: { A: { groove: ["C4"] } } }]));
    const { compiled } = loadMultiPlayer(doc);
    const { sid } = compileSidwaveToSid(doc, compiled.prg);
    assert.equal(sid.readUInt16BE(4), count + 1);
    assert.equal(sid.readUInt16BE(6), 0x7c);
    assert.equal(sid.readUInt16BE(0x76), count === 2 ? 0x0094 : 0x0194);
    assert.deepEqual([...sid.subarray(0x7a, 0x7c)], [0x42, count === 2 ? 0 : 0x50]);
    assert.deepEqual(sid.subarray(0x7c), compiled.prg);
  }
});

test("SIDWAVE refuses illegal SID maps, unsupported PSID maps and songs crossing $D000", () => {
  const voices = [{ id: 1, patterns: { A: { groove: ["C4"] } } }];
  for (const address of ["$DE00", "$D410", "$D800", "$D400junk"]) {
    assert.throws(() => parseSidwave(multiScore([{ id: "main", address }], voices)), /SID address.*\$D400\.\.\$D7E0/);
  }
  const four = parseSidwave(multiScore(sidMap(4), voices));
  assert.throws(() => compileSidwaveToSid(four, compileSidwaveToPrg(four).prg), /PSID supports at most 3 SID chips.*use PRG/);
  const moved = parseSidwave(multiScore([{ id: "main", address: "$D420" }], voices));
  assert.throws(() => compileSidwaveToSid(moved, compileSidwaveToPrg(moved).prg), /primary SID at \$D400.*use PRG/);
  const large = multiScore(sidMap(8), Array.from({ length: 24 }, (_, i) => ({
    id: i + 1, patterns: { A: { groove: ["C4", "E4"], length: 0.25 } },
  })));
  large.timeline[0].bars = 60;
  assert.throws(() => compileSidwaveToPrg(parseSidwave(large)), /past the \$D000 limit/);
});

test("SIDWAVE measures the peak of a 30-voice table score and sets Ultimate turbo at PRG init", () => {
  const score = multiScore({ layout: "ultisid8+sockets" }, Array.from({ length: 30 }, (_, i) => ({
    id: i + 1, instrument: "table", patterns: { A: { groove: ["C3", "D3", "E3", "F3"] } },
  })), { instruments: {
    table: {
      waveform: "saw", adsr: [0, 0, 15, 0],
      wavetable: [{ wave: "saw", note: "+0" }, { wave: "saw", note: "+12" }], loop: 0,
      pulsetable: [{ set: 0.5 }, { add: -47, frames: 1 }],
      filtertable: [{ cutoff: 1200 }, { add: -34, frames: 1, resonance: 9, type: "highpass" }],
    },
  } });
  assert.throws(() => compileSidwaveToPrg(parseSidwave(score)), /cycles per call at speed 1.*use cpu: turbo.*at least [2-9] MHz/);
  const doc = parseSidwave({ ...score, cpu: "turbo" });
  const { compiled, cpu, writes, mem } = loadMultiPlayer(doc);
  assert.ok(compiled.warnings.some((warning) => /Sawtooth level.*30\.0.*maximum 10/.test(warning)));
  cpu.call(compiled.entryAddress);
  assert.deepEqual(writes.filter(([address]) => address === 0xd031), [[0xd031, 0x8f]]);
  const irq = mem[0x0314] | (mem[0x0315] << 8);
  cpu.hooks.read = (address) => address === 0xd012 ? (Math.floor(cpu.cycles / 63) & 255) : undefined;
  const holdCalls = Math.floor(4.25 * sidwaveFrameRate("PAL"));
  for (let i = 1; i < holdCalls; i++) {
    writes.length = 0;
    cpu.call(irq);
    assert.ok(writes.every(([a]) => a < 0xd400 || a >= 0xd800), "no SID writes during the startup hold");
  }
  cpu.call(irq);
  for (const { address } of doc.sids) {
    for (const offset of [0, 7, 14]) {
      assert.equal(mem[address + offset + 4], 0x21, "every voice starts after the hold");
      assert.equal(mem[address + offset + 2] | (mem[address + offset + 3] << 8), 2048);
    }
  }
  const stock = loadMultiPlayer(doc);
  stock.mem[0xd031] = 0xff;
  stock.cpu.call(stock.compiled.entryAddress);
  assert.equal(stock.mem[0x0314] | (stock.mem[0x0315] << 8), 0, "an overloaded tune leaves the stock IRQ alone");
  assert.ok(stock.writes.every(([address]) => address !== 0xd031));
  cpu.call(compiled.initAddress);
  let measured = 0;
  for (let frame = 0; frame <= compiled.totalFrames * 2; frame++) {
    writes.length = 0;
    measured = Math.max(measured, cpu.call(compiled.playAddress));
  }
  assert.ok(measured <= compiled.worstCaseCyclesPerCall, `observed ${measured} exceeds estimate`);
  assert.ok(measured > 18_056, `observed ${measured} fits the stock PAL budget`);
  console.info(`SIDWAVE 30 voices, speed 1, all three tables: ${measured} peak emulated cycles, ${compiled.worstCaseCyclesPerCall} estimated upper bound`);
});

test("SIDWAVE 1.2 keeps existing note effects when they are used", () => {
  const path = new URL("./fixtures/sidwave-1.0/all-fx.yaml", import.meta.url);
  const single = parseSidwave(fs.readFileSync(path, "utf8"));
  const legacy = compileSidwaveToPrg(single);
  const expected = runPsid(compileSidwaveToSid(single, legacy.prg).sid, legacy.totalFrames * 2);
  const mapped = parseSidwave({ ...single.song, sidwave: 1.2, voices: single.voices, timeline: single.timeline,
    sids: sidMap(2), cpu: "turbo" });
  const { compiled } = loadMultiPlayer(mapped);
  const observed = runPsid(compileSidwaveToSid(mapped, compiled.prg).sid, compiled.totalFrames * 2);
  const withoutVolume = (states) => states.map((s) => [...s.slice(0, 24), s[24] & 0xf0]);
  assert.deepEqual(withoutVolume(observed.states), withoutVolume(expected.states));
  assert.ok(observed.maxPlayCycles <= compiled.worstCaseCyclesPerCall);
});

const scoreVoice = (id, groove, fields = {}, length = 1) => ({ id, ...fields, patterns: { A: { groove, length } } });
const regFreq = (mem, base) => mem[base] | (mem[base + 1] << 8);
const freqAt = (note, cents = 0, mode = "PAL") => hzToSidFrequency(midiToHz(noteNameToMidi(note) + cents / 100), mode);
const playMultiScore = (score, calls) => {
  const { compiled, cpu, mem } = loadMultiPlayer(parseSidwave(score));
  cpu.call(compiled.initAddress);
  const snapshots = [];
  for (let i = 0; i < calls; i++) {
    assert.ok(cpu.call(compiled.playAddress) <= compiled.worstCaseCyclesPerCall);
    snapshots.push(mem.slice(0xd400, 0xd800));
  }
  return snapshots;
};

test("SIDWAVE 1.2 echo and unison copy notes across SIDs with independent timing, level and pitch", () => {
  const source = scoreVoice(1, ["C4", "G4"], { waveform: "triangle", adsr: [1, 2, 12, 3] });
  const score = multiScore(sidMap(3), [source]);
  score.voices.push({ id: 4, echo: { voice: 1, delay: 6, volume: 0.25, detune: -13 } }, { id: 7, unison: { voice: 1, detune: 16 } });
  const states = playMultiScore(score, 36);
  assert.equal(states[0][4], 0x11);
  assert.equal(states[0][0x24], 0);
  assert.equal(states[0][0x104], 0x11);
  assert.equal(states[0][0x106], 0xc3);
  assert.equal(regFreq(states[0], 0x100), freqAt("C4", 16));
  assert.equal(states[5][0x24], 0);
  assert.equal(states[6][0x24], 0x11);
  assert.equal(states[6][0x26], 0x33);
  assert.equal(regFreq(states[6], 0x20), freqAt("C4", -13));
  assert.equal(regFreq(states[25], 0), freqAt("G4"));
  assert.equal(regFreq(states[25], 0x100), freqAt("G4", 16));
  assert.equal(regFreq(states[31], 0x20), freqAt("G4", -13));
  assert.throws(() => compileSidwaveToPrg(parseSidwave({
    ...score, voices: [source, { id: 4, echo: { voice: 7, delay: 2, volume: 0.5 } }, { id: 7, unison: { voice: 4 } }],
  })), /copies form a cycle/);
});

test("SIDWAVE 1.2 chord forms run a wavetable arpeggio on one oscillator", () => {
  const score = multiScore(sidMap(1), [scoreVoice(1, [
    "Cm7@arp", { chord: "Cm7", arp: "0,3,7,10", speed: 2 },
  ])]);
  const states = playMultiScore(score, 35);
  const notes = ["C3", "Eb3", "G3", "Bb3"];
  assert.deepEqual(states.slice(0, 8).map((m) => regFreq(m, 0)), [...notes, ...notes].map((n) => freqAt(n)));
  assert.deepEqual(states.slice(25, 33).map((m) => regFreq(m, 0)), notes.flatMap((n) => [freqAt(n), freqAt(n)]));
  assert.ok(states.every((m) => !m[11] && !m[18]));
});

test("SIDWAVE 1.2 bends reach absolute and relative targets, and slide_from works on the first note", () => {
  const score = multiScore(sidMap(1), [scoreVoice(1, [
    { note: "C4", slide_from: "A3", portamento: 4 },
    { note: "D4", bend: { to: "G4", frames: 3 } },
    { note: "G4", bend: { to: -5, frames: 5 } },
  ])]);
  const states = playMultiScore(score, 57);
  for (const [onset, from, to, frames] of [[0, "A3", "C4", 4], [25, "D4", "G4", 3], [50, "G4", "D4", 5]]) {
    assert.equal(regFreq(states[onset], 0), freqAt(from));
    assert.equal(regFreq(states[onset + frames], 0), freqAt(to));
    for (let tick = 1; tick < frames; tick++) {
      const ideal = freqAt(from) + (freqAt(to) - freqAt(from)) * tick / frames;
      assert.ok(Math.abs(regFreq(states[onset + tick], 0) - ideal) <= 1);
    }
  }
});

test("SIDWAVE 1.2 releases early, loads restart ADSR and holds TEST until retrigger", () => {
  const score = multiScore(sidMap(1), [scoreVoice(1, [
    { note: "C4", gate_off: 6 }, "E4", "G4@off", "A4@off",
  ], { instrument: "reset" })], { instruments: {
    reset: { waveform: "pulse", adsr: [3, 4, 9, 7], wavetable: [{ wave: "pulse" }],
      hard_restart: { frames: 3, adsr: [1, 3, 2, 4], test: true } },
    off: { waveform: "triangle", hard_restart: { frames: 0 } },
  } });
  const states = playMultiScore(score, 78);
  assert.equal(states[18][4], 0x41);
  assert.equal(states[19][4], 0x40);
  assert.deepEqual(states.slice(22, 25).map((m) => [...m.slice(4, 7)]), Array.from({ length: 3 }, () => [0x48, 0x13, 0x24]));
  assert.deepEqual([...states[25].slice(4, 7)], [0x41, 0x34, 0x97]);
  assert.deepEqual([...states[49].slice(4, 7)], [0x40, 0x34, 0x97], "disabled restart still releases the gate");
  assert.equal(states[50][4], 0x11);
});

const sampleHarness = (score, options) => {
  const result = loadMultiPlayer(score.voiceSlots ? score : parseSidwave(score), options);
  const { mem, cpu, compiled } = result;
  // C64 KERNAL $FE43 is SEI / JMP ($0318). Use it in this CPU model.
  mem.set([0x78, 0x6c, 0x18, 0x03], 0xfe43);
  mem.set([0x43, 0xfe], 0xfffa);
  mem.set([0x00, 0xfe], 0x0318);
  mem[0xfe00] = 0x40; // previous NMI handler
  const read = cpu.hooks.read;
  let pending = 0;
  cpu.hooks.read = (address) => {
    if (address !== 0xdd0d) return read(address);
    const value = pending;
    pending = 0;
    return value;
  };
  cpu.call(compiled.entryAddress);
  const irq = mem[0x0314] | (mem[0x0315] << 8);
  return { ...result, irq, tick: () => { pending = 0x81; return cpu.nmi(); } };
};

test("CIA2 digi NMI uses the timer clock independently and preserves each SID's filter mode", () => {
  const sids = sidMap(2);
  sids[1].filter = { filter_env: { cutoff_base: 700, type: "bandpass" } };
  const score = multiScore(sids, [scoreVoice(4, ["C4"])], { samples: {
    rate: 2345,
    voices: [{ sid: "chip2", at: [0], hex: "018fa" }, { sid: "chip1", at: [1], base64: "wuU=" }],
  } });
  const { cpu, mem, compiled, writes, irq, tick } = sampleHarness(score, { loop: false });
  assert.ok((mem[0x0318] | (mem[0x0319] << 8)) >= 0x0801);
  assert.notEqual(mem[0x0319], 0xfe);
  assert.equal(mem[0xdd04] | (mem[0xdd05] << 8), Math.round(985_248 / 2345) - 1);
  assert.equal(mem[0xdd0e], 0);
  cpu.nmi(); // a non-CIA2 NMI follows the saved KERNAL vector
  cpu.call(irq);
  assert.deepEqual(writes.filter(([a]) => a === 0xdd0d), [[0xdd0d, 1], [0xdd0d, 0x81]]);
  assert.equal(mem[0xdd0e], 0x11);
  cpu.call(irq);
  cpu.a = 17; cpu.x = 38; cpu.y = 59; cpu.c = 1;
  mem[1] = 0x37;
  writes.length = 0;
  for (let sample = 0; sample < 7; sample++) tick();
  assert.deepEqual(writes.filter(([a]) => a === 0xd438).map(([, v]) => v), [0x20, 0x21, 0x28, 0x2f, 0x2a, 0x22]);
  assert.deepEqual(writes.filter(([a]) => a === 0xd418).map(([, v]) => v), [12, 2, 14, 5, 2]);
  assert.deepEqual([cpu.a, cpu.x, cpu.y, cpu.c, mem[1]], [17, 38, 59, 1, 0x37]);
  assert.equal(mem[0xdd0e], 0, "the timer stops after the last active sample");
  for (let i = 2; i <= compiled.totalFrames; i++) cpu.call(irq);
  assert.deepEqual([...mem.slice(0x0318, 0x031a)], [0, 0xfe], "one-shot playback restores the previous NMI vector");
  assert.equal(mem[0xdd0e], 0);
  assert.throws(() => compileSidwaveToSid(parseSidwave(score), compiled.prg), /CIA2 NMI digi samples require standalone PRG/);
});

test("CIA2 plays original kick, snare and clap sample data, including page crossings at 8 kHz", () => {
  const score = multiScore(sidMap(1), [], { samples: {
    rate: 8000,
    voices: ["kick", "snare", "clap"].map((kit, i) => ({ sid: "chip1", at: [1 + 15 * i], kit })),
  } });
  const { cpu, mem, compiled, writes, irq, tick } = sampleHarness(score);
  const timerPeriod = (mem[0xdd04] | (mem[0xdd05] << 8)) + 1;
  assert.equal(timerPeriod, 123);
  const recorded = [[], [], []];
  let peak = 0;
  // PAL spends 19,656 phi2 cycles between player calls, separately from the
  // CIA2 timer. Advance the NMI clock at its own cadence between calls.
  for (let frame = 0; frame < 46; frame++) {
    cpu.call(irq);
    writes.length = 0;
    const count = Math.floor((frame + 1) * 19_656 / timerPeriod) - Math.floor(frame * 19_656 / timerPeriod);
    for (let sample = 0; sample < count && (mem[0xdd0e] & 1); sample++) {
      peak = Math.max(peak, tick());
    }
    if (frame > 0) recorded[Math.floor((frame - 1) / 15)].push(...writes.filter(([a]) => a === 0xd418).map(([, v]) => v));
  }
  const { voices } = parseSidwave(score).samples;
  for (const [i, { data }] of voices.entries()) {
    assert.deepEqual(recorded[i], [...data, i === 0 ? 10 : 15], "writes each nibble, then restores the SID volume");
    assert.ok(new Set(recorded[i]).size > 4);
  }
  assert.equal(new Set(recorded.map((levels) => levels.slice(0, 32).join(","))).size, 3);
  assert.ok(peak < timerPeriod, `CIA2 NMI took ${peak} cycles in a ${timerPeriod}-cycle period`);
  console.info(`SIDWAVE 8 kHz single-SID digi: ${peak} peak NMI cycles in a ${timerPeriod}-cycle timer period`);
  assert.ok(compiled.warnings.some((w) => /CPU cycles.*master volume/.test(w)));
});

test("the eight new library instruments write original waveform, pitch, gate and pulse sequences", () => {
  const recipes = [
    ["tom", [0x81, 0x11, 0x11], ["D5", "C5", "F4"]],
    ["clap", [0x81, 0x80, 0x81], ["E6", "C4", "G6"]],
    ["open_hat", [0x81, 0x81, 0x81], ["A7", "F7", "F7"]],
    ["crash", [0x81, 0x81, 0x81], ["G7", "G7", "G7"]],
    ["octave_bass", [0x21, 0x21, 0x21], ["C5", "C5", "C4"]],
    ["wide_pwm_pad", [0x41, 0x41, 0x41], ["C4", "C4", "C4"]],
    ["pluck_arp", [0x41, 0x41, 0x41], ["C4", "G4", "C5"]],
    ["noise_lead_attack", [0x81, 0x21, 0x21], ["G6", "C4", "C4"]],
  ];
  for (const [recipe, controls, notes] of recipes) {
    const score = multiScore(sidMap(1), [scoreVoice(1, ["C4"], { instrument: `lib:${recipe}` }, 4)]);
    const states = playMultiScore(score, 20);
    assert.deepEqual(states.slice(0, 3).map((m) => m[4]), controls, recipe);
    assert.deepEqual(states.slice(0, 3).map((m) => regFreq(m, 0)), notes.map((n) => freqAt(n)), recipe);
    if (recipe === "wide_pwm_pad") assert.deepEqual(states.slice(0, 3).map((m) => (m[3] << 8) | m[2]), [737, 761, 785]);
    if (recipe === "open_hat") assert.equal(states[12][4], 0x80);
    if (recipe === "crash") assert.equal(regFreq(states[15], 0), freqAt("D6"));
  }
});

test("the CIA2 digi NMI load can push a score over the stock CPU budget", () => {
  const score = multiScore(sidMap(2), [scoreVoice(1, ["C4"])]);
  const stock = compileSidwaveToPrg(parseSidwave(score));
  assert.ok(stock.worstCaseCyclesPerCall < 18_056);
  const digis = { ...score, samples: { rate: 8000, voices: [
    { sid: "chip1", at: [0], kit: "kick" }, { sid: "chip2", at: [0], kit: "snare" },
  ] } };
  assert.throws(() => compileSidwaveToPrg(parseSidwave(digis)), /including \d+ for the CIA2 digi NMI.*use cpu: turbo.*at least 2 MHz/);
  const turbo = compileSidwaveToPrg(parseSidwave({ ...digis, cpu: "turbo" }));
  assert.equal(turbo.requiresTurbo, true);
  assert.ok(turbo.worstCaseCyclesPerCall > 18_056);
});

const LEGACY_PRESETS = ["chiptune_drive", "ambient_filter", "funk_bass"];
for (const { name } of SIDWAVE_EXAMPLES) {
  test(`composition ${name} uses its documented techniques within memory and cycle budgets`, () => {
    const source = readSidwaveExample(name);
    assert.match(source.split("\n").slice(0, 3).join("\n"), /^# .*BPM.*SIDs?(?:, \d+ voices)?\n# Techniques: .*\n# Learn: /);
    const doc = parseSidwave(source);
    const arrangement = arrangeSidwave(doc);
    assert.equal(doc.version, LEGACY_PRESETS.includes(name) ? "1.1" : "1.2");
    const expected = {
      chiptune_drive: [1, 3], ambient_filter: [1, 3], funk_bass: [1, 3], acid_line: [1, 3],
      arp_ballad: [1, 3], drum_and_bass: [1, 3], digi_groove: [1, 2], metal_sync: [1, 3],
      stereo_echo: [2, 6], chamber_waltz: [1, 3], title_fanfare: [2, 5],
      ultisid_orchestra: [8, 24], wall_of_sid: [9, 27],
    }[name];
    assert.deepEqual([doc.sids.length, doc.voices.length], expected);
    assert.ok(doc.timeline.length >= (name === "title_fanfare" ? 3 : LEGACY_PRESETS.includes(name) ? 2 : 4));
    const options = { loop: name !== "title_fanfare" };
    const compiled = compileSidwaveToPrg(doc, options);
    const seconds = compiled.totalFrames / compiled.framesPerSecond;
    assert.ok(compiled.endAddress + 3 <= SIDWAVE_MEMORY_END);
    assert.ok(compiled.warnings.every((warning) => !/Sawtooth level|out of memory/i.test(warning)), compiled.warnings.join("; "));
    if (!LEGACY_PRESETS.includes(name)) assert.ok(name === "title_fanfare" ? seconds >= 8 && seconds <= 12 : seconds >= 20 && seconds <= 60);
    if (doc.samples) {
      assert.throws(() => compileSidwaveToSid(doc, compiled.prg), /NMI digi samples require standalone PRG/);
    } else if (doc.sids.length <= 3) {
      const { sid } = compileSidwaveToSid(doc, compiled.prg);
      assert.equal(sid.readUInt16BE(4), doc.sids.length + 1);
    } else {
      assert.throws(() => compileSidwaveToSid(doc, compiled.prg), /at most 3 SID chips/);
    }

    const instruments = arrangement.instruments.slice(1);
    const has = (name) => instruments.some((inst) => !!inst[name]);
    const control = (flag, bit) => instruments.some((inst) =>
      !!(inst.wave & bit) || inst.wavetable?.some((step) => step[flag]));
    const tonalTable = (inst) => inst.wavetable?.some((s) => s.note !== undefined);
    const pitchedArp = () => instruments.some((inst) => inst.waveloop === 0 && inst.wavetable?.filter((s) => s.note !== undefined).length >= 3);
    const pitchGlide = () => arrangement.voices.some(({ notes }) => notes.some((note) => note.portamento || note.glideFrom !== undefined));
    const noiseDrums = () => instruments.some((inst) => inst.wavetable?.some(({ wave }) => wave === "noise") && tonalTable(inst));
    switch (name) {
      case "chiptune_drive":
        assert.ok(pitchedArp() && pitchGlide() && noiseDrums() && has("vibRate") && has("filtertable"));
        break;
      case "ambient_filter":
        assert.ok(has("filtertable") && has("vibRate") && control("ring", 4) && pitchGlide());
        break;
      case "funk_bass":
        assert.ok(has("filtertable") && pitchedArp() && control("sync", 2) && control("ring", 4) && noiseDrums());
        break;
      case "acid_line":
        assert.ok(pitchGlide() && noiseDrums());
        assert.ok(doc.voices[1].patterns.A.groove.every((entry, i) => i % 2 || entry.endsWith("@lib:kick")));
        assert.ok(instruments.some((inst) => inst.filtertable?.steps.some((s) => s.value < 0 && s.add)));
        assert.ok(new Set(instruments.flatMap((inst) => inst.filtertable?.steps.map((s) => s.resonance).filter(Boolean) ?? [])).size > 1);
        break;
      case "arp_ballad":
        assert.ok(pitchedArp() && pitchGlide() && has("pulsetable") && has("vibDelay") && !noiseDrums());
        assert.ok(instruments.some((inst) => inst.wave === 0x10));
        break;
      case "drum_and_bass":
        assert.equal(doc.speed, 4);
        assert.ok(noiseDrums());
        assert.ok(arrangement.tuning[1] < 0 && arrangement.tuning[2] > 0);
        break;
      case "digi_groove":
        assert.ok(doc.samples.voices.length === 3 && pitchedArp() && !noiseDrums());
        break;
      case "metal_sync":
        assert.ok(control("sync", 2) && control("ring", 4) && pitchedArp() && pitchGlide() && noiseDrums());
        assert.deepEqual(doc.voices[2].patterns.A.groove.slice(0, 2), ["C3@lib:kick", "C3@lib:kick"]);
        break;
      case "stereo_echo":
        assert.deepEqual(doc.sids.map(({ pan }) => pan), ["Left 5", "Right 5"]);
        assert.ok(doc.voices.some((v) => v.echo) && doc.voices.some((v) => v.unison) && arrangement.tuning && pitchedArp());
        assert.ok(arrangement.voices[2].notes[0].start < arrangement.voices[5].notes[0].start);
        break;
      case "chamber_waltz":
        assert.equal(doc.song.meter, 3);
        assert.equal(compiled.totalFrames, Math.round(doc.song.length_bars * 3 * 60 / doc.song.tempo * compiled.framesPerSecond));
        assert.ok(!arrangement.filter.used && !has("filtertable") && !noiseDrums());
        assert.deepEqual([...new Set(instruments.map((i) => i.wave))].sort(), [16, 64]);
        break;
      case "title_fanfare":
        assert.ok(instruments.some((i) => i.wave === 0x60 && i.filtertable) && noiseDrums());
        assert.ok(arrangement.voices[0].notes.at(-1).end - arrangement.voices[0].notes.at(-1).start > 90);
        break;
      case "ultisid_orchestra":
        assert.equal(doc.voices.filter((v) => v.echo).length, 2);
        assert.ok(doc.voices.filter((v) => v.unison).length >= 3 && pitchedArp() && noiseDrums() && has("pulsetable"));
        assert.deepEqual([doc.sids[0].pan, doc.sids[4].pan], ["Left 5", "Right 5"]);
        break;
      case "wall_of_sid":
        assert.equal(doc.sids[8].address, 0xd440);
        assert.ok(has("pulsetable") && has("filtertable"));
        assert.equal(doc.voices.filter((v) => v.patterns[doc.timeline[0].layers[`v${v.id}`]]).length, 3);
        break;
    }

    const seen = new Set();
    const { mem, cpu, writes, tick } = doc.samples ? sampleHarness(doc, options) : loadMultiPlayer(doc, options);
    if (!doc.samples) cpu.call(compiled.initAddress);
    const period = (mem[0xdd04] | (mem[0xdd05] << 8)) + 1;
    let max = 0;
    for (let frame = 0; frame <= compiled.totalFrames; frame++) {
      writes.length = 0;
      let cycles = cpu.call(compiled.playAddress);
      if (doc.samples) {
        const ticks = Math.floor((frame + 1) * 19_656 / period) - Math.floor(frame * 19_656 / period);
        for (let t = 0; t < ticks && (mem[0xdd0e] & 1); t++) cycles += tick();
      }
      max = Math.max(max, cycles);
      let active = 0;
      for (const [i, { address }] of doc.sids.entries()) {
        for (const offset of [4, 11, 18]) {
          if (mem[address + offset] & 1) { seen.add(i * 3 + (offset - 4) / 7); active++; }
        }
      }
      if (name === "drum_and_bass" && frame === 0) {
        assert.equal(regFreq(mem, 0xd407), freqAt("G2", -11));
        assert.equal(regFreq(mem, 0xd40e), freqAt("G2", 9));
      }
      if (name === "title_fanfare" && frame === compiled.totalFrames) assert.equal(active, 0, "the fanfare plays once");
      if (name === "wall_of_sid" && frame === compiled.totalFrames - 50) assert.equal(active, 27, "all nine desks sustain the last tonic");
    }
    for (const slot of doc.voiceSlots.values()) assert.ok(seen.has(slot), `voice slot ${slot + 1} never played`);
    const stock = Math.floor((19_656 - 1100) / doc.speed) - 500;
    assert.ok(max <= compiled.worstCaseCyclesPerCall, `${max} emulated versus ${compiled.worstCaseCyclesPerCall} estimated`);
    if (doc.cpu === "turbo") {
      assert.ok(max < 47 * stock);
      assert.throws(() => compileSidwaveToPrg({ ...doc, cpu: undefined }), /use cpu: turbo/);
    } else assert.ok(max <= stock && compiled.worstCaseCyclesPerCall <= stock);
    console.info(`SIDWAVE example ${name}: ${seconds.toFixed(2)}s, ${max} measured / ${compiled.worstCaseCyclesPerCall} estimated cycles per call`);
  });
}

test("SIDWAVE 1.2 opens the volume ramp once per video frame at speed 2 and tails off", () => {
  const doc = parseSidwave(multiScore(sidMap(1), [scoreVoice(1, ["C4"])], { speed: 2 }));
  const { cpu, compiled, mem } = loadMultiPlayer(doc, { loop: false });
  mem.fill(0xff, 0xd400, 0xd419);
  cpu.call(compiled.initAddress);
  assert.deepEqual([...mem.slice(0xd400, 0xd419)], Array(25).fill(0));
  const levels = [];
  for (let frame = 0; frame < compiled.totalFrames; frame++) {
    cpu.call(compiled.playAddress);
    levels.push(mem[0xd418] & 15);
  }
  assert.deepEqual(levels.slice(0, 8), [1, 1, 2, 2, 3, 3, 4, 4]);
  for (let call = 0; call < 30; call++) {
    cpu.call(compiled.playAddress);
    assert.equal(mem[0xd404] & 1, 0);
    assert.equal(mem[0xd418] & 15, Math.max(0, 14 - Math.floor(call / 2)));
  }
});

test("the turbo probe starts on the first IRQ when the raster shows a faster CPU", () => {
  const doc = parseSidwave(multiScore(sidMap(1), [scoreVoice(1, ["C4"])], { cpu: "turbo" }));
  const { cpu, compiled, mem } = loadMultiPlayer(doc);
  cpu.call(compiled.entryAddress);
  cpu.hooks.read = (address) => address === 0xd012 ? (Math.floor(cpu.cycles / (2.5 * 63)) & 255) : undefined;
  const irq = mem[0x0314] | (mem[0x0315] << 8);
  cpu.call(irq);
  assert.equal(mem[0xd404] & 1, 1);
  assert.equal(mem[0xd418] & 15, 1);
});
