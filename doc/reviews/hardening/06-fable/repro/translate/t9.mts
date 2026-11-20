import { assemblyToPrgDetailed } from "/home/claude/c64bridge/src/tools/translation/assembler.ts";
import { disassemble, formatDisassembly } from "/home/claude/c64bridge/src/tools/translation/disassembler.ts";
import { OPCODE_INVENTORY } from "/home/claude/c64bridge/src/tools/translation/opcodeInventory.ts";
// Independent legal set from t1 table: regenerate by known matrix: legal opcodes = 151
const legalList = `00 01 05 06 08 09 0a 0d 0e 10 11 15 16 18 19 1d 1e 20 21 24 25 26 28 29 2a 2c 2d 2e 30 31 35 36 38 39 3d 3e 40 41 45 46 48 49 4a 4c 4d 4e 50 51 55 56 58 59 5d 5e 60 61 65 66 68 69 6a 6c 6d 6e 70 71 75 76 78 79 7d 7e 81 84 85 86 88 8a 8c 8d 8e 90 91 94 95 96 98 99 9a 9d a0 a1 a2 a4 a5 a6 a8 a9 aa ac ad ae b0 b1 b4 b5 b6 b8 b9 ba bc bd be c0 c1 c4 c5 c6 c8 c9 ca cc cd ce d0 d1 d5 d6 d8 d9 dd de e0 e1 e4 e5 e6 e8 e9 ea ec ed ee f0 f1 f5 f6 f8 f9 fd fe`.split(/\s+/).map(h=>parseInt(h,16));
console.log("legal count",legalList.length);
const set=new Set(legalList);
let bad=0;
for(const e of OPCODE_INVENTORY){ if(e.illegal===set.has(e.opcode)){bad++;console.log("flag mismatch",e.opcode.toString(16),e.mnemonic,e.illegal)} }
console.log("illegal flag mismatches",bad);
// sizes of illegal ops: known reference
const sizeRef=(op:number)=>{ // by addressing pattern (cc==1,2,3 etc.) use inventory trust; check known sample
 return 0};
// known illegal facts
const facts: Record<number,[string,string]> = {0x0b:["ANC","imm"],0x2b:["ANC","imm"],0x4b:["ALR","imm"],0x6b:["ARR","imm"],0x8b:["XAA","imm"],0xab:["LAX","imm"],0xcb:["AXS","imm"],0xeb:["SBC","imm"],0x9b:["TAS","absY"],0x9c:["SHY","absX"],0x9e:["SHX","absY"],0x9f:["AHX","absY"],0x93:["AHX","indirectY"],0xbb:["LAS","absY"],0x80:["NOP","imm"],0x1a:["NOP","imp"],0x0c:["NOP","abs"],0x1c:["NOP","absX"],0x04:["NOP","zp"],0x14:["NOP","zpX"],0x02:["JAM","imp"],0x97:["SAX","zpY"],0xb7:["LAX","zpY"],0xbf:["LAX","absY"],0xa3:["LAX","indX"],0x03:["SLO","indX"],0x73:["RRA","indY"],0xd3:["DCP","indY"],0xff:["ISC","absX"],0x4f:["SRE","abs"],0x2f:["RLA","abs"],0x8f:["SAX","abs"]};
for (const [op,[m,mode]] of Object.entries(facts)) { const e=OPCODE_INVENTORY[Number(op)]; const modeShort:Record<string,string>={zeroPage:"zp",zeroPageX:"zpX",zeroPageY:"zpY",absoluteX:"absX",absoluteY:"absY",absolute:"abs",immediate:"imm",implied:"imp"}; const em=modeShort[e.mode]??e.mode; if(e.mnemonic!==m||em!==mode) console.log("FACT MISMATCH",Number(op).toString(16),e.mnemonic,e.mode,"expected",m,mode); }
// 12 JAM opcodes
const jam=OPCODE_INVENTORY.filter(e=>e.mnemonic==="JAM").map(e=>e.opcode.toString(16)); console.log("JAM",jam.join(","));
// round trip: for each legal opcode, disassemble -> reassemble
let rtBad=0;
for(const op of legalList){
  const bytes=new Uint8Array([op,0x12,0x34]);
  const d=disassemble(bytes,0xc000,1);
  const text=`* = $c000\n${d[0].mnemonic} ${d[0].operand}\n`;
  try{const r=assemblyToPrgDetailed(text);const out=[...r.prg].slice(2);const exp=[...bytes].slice(0,d[0].bytes.length);
   // zp-with-value fits etc; Rel target compare
   if(JSON.stringify(out)!==JSON.stringify(exp)){rtBad++;console.log("RT mismatch",op.toString(16),text.trim().split("\n")[1],out,exp)}
  }catch(e:any){rtBad++;console.log("RT err",op.toString(16),text.split("\n")[1],e.message)}
}
console.log("rt bad",rtBad);
// illegal opcodes round trip through assembler
let il=0,ilBad=0;
for(const e of OPCODE_INVENTORY){ if(!e.illegal) continue; const d=disassemble(new Uint8Array([e.opcode,0x12,0x34]),0xc000,1); il++;
  try{const r=assemblyToPrgDetailed(`* = $c000\n${d[0].mnemonic} ${d[0].operand}\n`);const out=[...r.prg].slice(2); if(out[0]!==e.opcode){ilBad++;console.log("illegal RT",e.opcode.toString(16),d[0].mnemonic,d[0].operand,"->",out[0].toString(16))}}catch(x:any){ilBad++;console.log("illegal RT err",e.opcode.toString(16),d[0].mnemonic,d[0].operand,x.message.slice(0,70))}}
console.log("illegal",il,"bad",ilBad);
// wrap
console.log(formatDisassembly(disassemble(new Uint8Array([0xea,0x4c,0x00,0x00,0xea,0xea]),0xfffe)));
console.log(formatDisassembly(disassemble(new Uint8Array([0xd0,0x10,0xd0,0xf0]),0xfff0)));
console.log(formatDisassembly(disassemble(new Uint8Array([0xd0,0xfe,0xd0,0x7f,0xd0,0x80]),0x0000)));
console.log(formatDisassembly(disassemble(new Uint8Array([0xad,0x00]),0x1000)));
console.log(formatDisassembly(disassemble(new Uint8Array([0xad,0x00,0xd0,0x20,0x10,0xff,0x6c,0xfe,0xff]),0x1000,undefined,new Map([[0xd000,"VIC"],[0xff10,"foo"]]))));
console.log(JSON.stringify(disassemble(new Uint8Array([0x02,0x0a]),0x1000,{allowUndocumented:false})));
console.log(JSON.stringify(disassemble(new Uint8Array([0xea,0xea]),0x10000+0x10)));
console.log(JSON.stringify(disassemble(new Uint8Array([0xea]),-1)));
