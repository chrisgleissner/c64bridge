// Shared 6502 emulator and PSID runner for the SIDWAVE 1.2 tests (same model as test/sidwavePlayer.test.mjs).
import { compileSidwaveToPrg, compileSidwaveToSid } from "../../src/sidwaveCompiler.js";
import { parseSidwave } from "../../src/sidwave.js";

export const OPS = [];
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

export class Cpu {
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

export function compile(source) {
  const doc = parseSidwave(source);
  const compiled = compileSidwaveToPrg(doc);
  const { sid } = compileSidwaveToSid(doc, compiled.prg);
  return { doc, compiled, sid };
}

/** Loads a PSID, calls init once and play `frames` times; returns the SID register file after each play call. */
export function runPsid(sid, frames) {
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

export function voice(states, v) {
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
export function gateOns(vv) {
  const out = [];
  for (let f = 0; f < vv.ctrl.length; f += 1) {
    if ((vv.ctrl[f] & 1) && !(f > 0 && (vv.ctrl[f - 1] & 1))) out.push({ frame: f, freq: vv.freq[f] });
  }
  return out;
}


/** Like runPsid, but also records every SID write per play call as { addr, value, cycle }. */
export function runPsidWrites(sid, frames, { extraInit = () => {} } = {}) {
  const dataOffset = sid.readUInt16BE(6);
  const init = sid.readUInt16BE(10);
  const play = sid.readUInt16BE(12);
  const body = sid.subarray(dataOffset);
  const load = body.readUInt16LE(0);
  const mem = new Uint8Array(65536);
  mem.set(body.subarray(2), load);
  const regs = new Uint8Array(0x400);
  let writes = [];
  const cpu = new Cpu(mem, {
    write(a, v) { if (a >= 0xd400 && a < 0xd800) { regs[a - 0xd400] = v; writes.push({ addr: a, value: v, cycle: cpu.cycles }); } },
  });
  extraInit(cpu);
  cpu.call(init, 0);
  const calls = [];
  for (let f = 0; f < frames; f += 1) {
    writes = [];
    const start = cpu.cycles;
    cpu.call(play);
    calls.push({ writes: writes.map((w) => ({ ...w, cycle: w.cycle - start })), regs: Uint8Array.from(regs) });
  }
  return { calls, cpu };
}

/** Compiles a document string; the PSID is built from the PRG. */
export function compileDoc(source, options) {
  const doc = parseSidwave(source);
  const compiled = compileSidwaveToPrg(doc, options);
  return { doc, compiled, sid: compileSidwaveToSid(doc, compiled.prg).sid };
}

/**
 * Runs a compiled PRG (any SID map) through init and `frames` play calls. Each entry holds that call's SID
 * writes ({ addr, value, cycle }), the register file ($D400-$D7FF) after the call and the call's cycle count.
 */
export function runPrg(compiled, frames) {
  const mem = new Uint8Array(65536);
  mem.set(compiled.prg.subarray(2), compiled.loadAddress);
  mem[0xea31] = 0x60; // KERNAL IRQ stub
  mem[0x02a6] = 1;
  let raster = 100;
  const regs = new Uint8Array(0x400);
  let writes = [];
  const cpu = new Cpu(mem, {
    write(a, v) { if (a >= 0xd400 && a < 0xd800) { regs[a - 0xd400] = v; writes.push({ addr: a, value: v, cycle: cpu.cycles }); } },
    read(a) { if (a === 0xd012) return (raster = (raster + 1) % 312) & 0xff; },
  });
  cpu.call(compiled.initAddress);
  const calls = [];
  for (let f = 0; f < frames; f += 1) {
    writes = [];
    const start = cpu.cycles;
    const cycles = cpu.call(compiled.playAddress);
    calls.push({ writes: writes.map((w) => ({ ...w, cycle: w.cycle - start })), regs: Uint8Array.from(regs), cycles });
  }
  return { calls, cpu, mem };
}

/** Compiles a document string and runs its PRG. */
export function playDoc(source, frames, options) {
  const doc = parseSidwave(source);
  const compiled = compileSidwaveToPrg(doc, options);
  return { doc, compiled, ...runPrg(compiled, frames) };
}

/** PRG harness with a CIA2 NMI: `tick()` delivers one timer NMI, `irq` is the player's IRQ routine. */
export function sampleHarness(source, options) {
  const doc = typeof source === "string" ? parseSidwave(source) : source;
  const compiled = compileSidwaveToPrg(doc, options);
  const mem = new Uint8Array(65536);
  mem.set(compiled.prg.subarray(2), compiled.loadAddress);
  mem[0xea31] = 0x60;
  mem[0x02a6] = 1;
  const writes = [];
  let raster = 100;
  let pending = 0;
  const cpu = new Cpu(mem, {
    write(address, value) { writes.push([address, value]); },
    read(address) {
      if (address === 0xd012) return (raster = (raster + 1) % 312) & 0xff;
      if (address === 0xdd0d) { const value = pending; pending = 0; return value; }
    },
  });
  mem.set([0x78, 0x6c, 0x18, 0x03], 0xfe43);
  mem.set([0x43, 0xfe], 0xfffa);
  mem.set([0x00, 0xfe], 0x0318);
  mem[0xfe00] = 0x40;
  cpu.call(compiled.entryAddress);
  const irq = mem[0x0314] | (mem[0x0315] << 8);
  return { doc, compiled, mem, cpu, writes, irq, tick: () => { pending = 0x81; return cpu.nmi(); } };
}
