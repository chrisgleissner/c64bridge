import { assemblyToPrgDetailed } from "/home/claude/c64bridge/src/tools/translation/assembler.ts";
import { disassemble } from "/home/claude/c64bridge/src/tools/translation/disassembler.ts";
// Independent reference: standard 6502 legal opcodes (mnemonic -> mode -> opcode)
const ref: Record<string, Record<string, number>> = {};
const add=(m:string,mode:string,op:number)=>{(ref[m]??={})[mode]=op};
const grp=(m:string,imm:number|null,zp:number,zpx:number,abs:number,absx:number,absy:number,indx:number,indy:number)=>{
 if(imm!==null)add(m,"imm",imm);add(m,"zp",zp);add(m,"zpx",zpx);add(m,"abs",abs);add(m,"absx",absx);add(m,"absy",absy);add(m,"indx",indx);add(m,"indy",indy)};
grp("ORA",0x09,0x05,0x15,0x0d,0x1d,0x19,0x01,0x11);
grp("AND",0x29,0x25,0x35,0x2d,0x3d,0x39,0x21,0x31);
grp("EOR",0x49,0x45,0x55,0x4d,0x5d,0x59,0x41,0x51);
grp("ADC",0x69,0x65,0x75,0x6d,0x7d,0x79,0x61,0x71);
grp("LDA",0xa9,0xa5,0xb5,0xad,0xbd,0xb9,0xa1,0xb1);
grp("CMP",0xc9,0xc5,0xd5,0xcd,0xdd,0xd9,0xc1,0xd1);
grp("SBC",0xe9,0xe5,0xf5,0xed,0xfd,0xf9,0xe1,0xf1);
add("STA","zp",0x85);add("STA","zpx",0x95);add("STA","abs",0x8d);add("STA","absx",0x9d);add("STA","absy",0x99);add("STA","indx",0x81);add("STA","indy",0x91);
for (const [m,a] of Object.entries({ASL:0x0a,ROL:0x2a,LSR:0x4a,ROR:0x6a})){add(m,"acc",a);add(m,"zp",a-0x04);add(m,"zpx",a+0x0c);add(m,"abs",a+0x04);add(m,"absx",a+0x14);}
add("DEC","zp",0xc6);add("DEC","zpx",0xd6);add("DEC","abs",0xce);add("DEC","absx",0xde);
add("INC","zp",0xe6);add("INC","zpx",0xf6);add("INC","abs",0xee);add("INC","absx",0xfe);
add("LDX","imm",0xa2);add("LDX","zp",0xa6);add("LDX","zpy",0xb6);add("LDX","abs",0xae);add("LDX","absy",0xbe);
add("LDY","imm",0xa0);add("LDY","zp",0xa4);add("LDY","zpx",0xb4);add("LDY","abs",0xac);add("LDY","absx",0xbc);
add("STX","zp",0x86);add("STX","zpy",0x96);add("STX","abs",0x8e);
add("STY","zp",0x84);add("STY","zpx",0x94);add("STY","abs",0x8c);
add("CPX","imm",0xe0);add("CPX","zp",0xe4);add("CPX","abs",0xec);
add("CPY","imm",0xc0);add("CPY","zp",0xc4);add("CPY","abs",0xcc);
add("BIT","zp",0x24);add("BIT","abs",0x2c);
add("JMP","abs",0x4c);add("JMP","ind",0x6c);add("JSR","abs",0x20);
const br={BPL:0x10,BMI:0x30,BVC:0x50,BVS:0x70,BCC:0x90,BCS:0xb0,BNE:0xd0,BEQ:0xf0};
for(const [m,o] of Object.entries(br))add(m,"rel",o);
const imp={BRK:0,PHP:8,CLC:0x18,PLP:0x28,SEC:0x38,RTI:0x40,PHA:0x48,CLI:0x58,RTS:0x60,PLA:0x68,SEI:0x78,DEY:0x88,TXA:0x8a,TYA:0x98,TXS:0x9a,TAY:0xa8,TAX:0xaa,CLV:0xb8,TSX:0xba,INY:0xc8,DEX:0xca,CLD:0xd8,INX:0xe8,NOP:0xea,SED:0xf8};
for(const [m,o] of Object.entries(imp))add(m,"imp",o);
let n=0; for (const m of Object.keys(ref)) n+=Object.keys(ref[m]).length;
console.log("mnemonics",Object.keys(ref).length,"opcodes",n);
const fmt:Record<string,(m:string)=>string>={
 imp:m=>m, acc:m=>m+" A", imm:m=>m+" #$12", zp:m=>m+" $12", zpx:m=>m+" $12,X", zpy:m=>m+" $12,Y",
 abs:m=>m+" $1234", absx:m=>m+" $1234,X", absy:m=>m+" $1234,Y", ind:m=>m+" ($1234)", indx:m=>m+" ($12,X)", indy:m=>m+" ($12),Y",
 rel:m=>m+" $c010"};
const size:Record<string,number>={imp:1,acc:1,imm:2,zp:2,zpx:2,zpy:2,abs:3,absx:3,absy:3,ind:3,indx:2,indy:2,rel:2};
let bad=0, ok=0;
for(const m of Object.keys(ref)) for(const [mode,op] of Object.entries(ref[m])){
  const src=`* = $c000\n${fmt[mode](m)}\n`;
  try{ const r=assemblyToPrgDetailed(src); const b=r.prg;
   const exp=[0x00,0xc0,op,...(size[mode]==1?[]:mode==="rel"?[0x0e]:size[mode]==2?[0x12]:[0x34,0x12])];
   if(Buffer.compare(b,Buffer.from(exp))!==0){bad++;console.log("MISMATCH",m,mode,[...b].map(x=>x.toString(16)),exp.map(x=>x.toString(16)))} else ok++;
  }catch(e:any){bad++;console.log("ERR",m,mode,e.message)}
}
console.log({ok,bad});
// illegal combos must be rejected
const modes=Object.keys(fmt);
let accepted=0;const acc:string[]=[];
for(const m of Object.keys(ref)) for(const mode of modes){
  if(ref[m][mode]!==undefined)continue;
  // zp->abs fallback and implied/acc equivalents legit
  const src=`* = $c000\n${fmt[mode](m)}\n`;
  try{assemblyToPrgDetailed(src);acc.push(`${m} ${mode}: ${fmt[mode](m)}`)}catch(e:any){}
}
console.log("accepted-illegal-combos",acc.length);console.log(acc.join("\n"));
// message samples
for (const s of ["lda ($12)","sta #5","jmp $12,x","stx $1234,y","asl #1","inx 5","lda","bne","jsr ($1234)","ldx $12,x","sty $12,y","lda ($12,y)","lda ($12),x","lda ($1234),y","lda ($12,x),y","jmp (label)"]) {
  try{assemblyToPrgDetailed("* = $c000\n"+s+"\n");console.log("OK?",s)}catch(e:any){console.log(s.padEnd(16),"->",e.message)}
}
