import { compileSidwaveToPrg, compileSidwaveToSid, hzToSidFrequency, sidwaveFrameRate } from "/home/claude/c64bridge/src/sidwaveCompiler.ts";
import { midiToHz, noteNameToMidi, parseSidwave } from "/home/claude/c64bridge/src/sidwave.ts";
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


let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a:any[]) => a[Math.floor(rnd()*a.length)];
const NOTES = ["C1","E2","A2","C3","G3","C4","E4","A4","C5","G5","C6","A#7","C7"];
function voiceDoc(id:number){
  const fx:any = {};
  if (rnd()<.4) fx.vibrato={depth:+(0.1+rnd()*5).toFixed(2),rate:+(0.5+rnd()*11).toFixed(1),delay:Math.floor(rnd()*30)};
  if (rnd()<.3) fx.slide={depth:pick([-12,-5,3,7,12,24,-24]),speed:Math.floor(1+rnd()*40)};
  if (rnd()<.3) fx.pwm_sweep={depth:+(0.05+rnd()*0.4).toFixed(2),speed:+(0.2+rnd()*10).toFixed(1)};
  if (rnd()<.2) fx.filter_mod={sweep:Math.floor(-2000+rnd()*4000),beats:2};
  const kind = pick(["groove","arp","motif"]);
  let pat:any;
  if (kind==="groove") pat={groove:Array.from({length:1+Math.floor(rnd()*8)},()=>pick([...NOTES,"-","~"])), length:pick([0.25,0.5,1,2])};
  else if (kind==="arp") pat={type:"arpeggio",notes:Array.from({length:2+Math.floor(rnd()*3)},()=>pick(NOTES.slice(0,9))),frame_rate:Math.floor(1+rnd()*6),length:pick([1,2])};
  else pat={motif:pick(["Cmin9 -","C4 Eb4 G4 ~","0 3 7 12","Am7 F"]),root:"C3",length:pick([0.5,1])};
  pat.fx=fx; if (rnd()<.3) pat.transpositions=[0,pick([-12,5,7,12])];
  return {id,waveform:pick(["pulse","saw","tri","noise"]),adsr:[Math.floor(rnd()*16),Math.floor(rnd()*16),Math.floor(rnd()*16),Math.floor(rnd()*16)],pulse_width:pick([0.1,0.5,0.9,2048,100]),patterns:{A:pat}};
}
let ok=0, rejected=0, bad=0; const reasons=new Map<string,number>();
for (let it=0; it<300; it++){
  const nv = 1+Math.floor(rnd()*3);
  const d:any = {sidwave:"1.0",tempo:Math.floor(60+rnd()*160),mode:pick(["PAL","NTSC"]),voices:Array.from({length:nv},(_,i)=>voiceDoc(i+1)),timeline:[{bars:1+Math.floor(rnd()*3),layers:Object.fromEntries(Array.from({length:nv},(_,i)=>["v"+(i+1),"A"+pick(["","","^","-"])]))}]};
  if (rnd()<.3) d.global_fx={reverb_sim:{depth:0.5,delay_frames:3},filter_env:{cutoff_base:500,sweep:900,speed:2,resonance:9,type:pick(["lowpass","bandpass","highpass"])}};
  let c:any;
  try { c = compile(d); } catch(e:any){ rejected++; reasons.set(String(e.message).replace(/\d+/g,"N").slice(0,90),(reasons.get(String(e.message).replace(/\d+/g,"N").slice(0,90))||0)+1); continue; }
  try {
    const frames = Math.min(c.compiled.totalFrames*2+10, 1500);
    const r = runPsid(c.sid, frames);
    if (r.strayWrites.length) { bad++; console.log("STRAY", it, r.strayWrites.slice(0,5).map(x=>x.toString(16))); }
    if (r.maxPlayCycles > 15000) { bad++; console.log("CYCLES", it, r.maxPlayCycles, c.compiled.framesPerSecond); }
    ok++;
  } catch(e:any){ bad++; console.log("RUNFAIL", it, e.message, JSON.stringify(d).slice(0,400)); }
}
console.log({ok,rejected,bad}); console.log([...reasons.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8));
