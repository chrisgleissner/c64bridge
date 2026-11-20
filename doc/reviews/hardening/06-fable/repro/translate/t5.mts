import { assemblyToPrgDetailed, prgEntryAddress } from "/home/claude/c64bridge/src/tools/translation/assembler.ts";
function t(label:string, src:string, o:any={}){
  try{const r=assemblyToPrgDetailed(src,o);console.log(label.padEnd(34),"OK  ",[...r.prg].slice(0,40).map(x=>x.toString(16).padStart(2,"0")).join(" "),"len",r.prg.length,"entry",r.entryAddress.toString(16));}
  catch(e:any){console.log(label.padEnd(34),"ERR ",e.message.replace(/\n/g," | "))}
}
t("no org",`lda #1\nrts`);
t("no org label first",`start: lda #1\n jmp start`);
t("data first no org",`.byte 1,2\nlda #1`);
t("org 0801 explicit",`* = $0801\nlda #1\nrts`);
t("org 0801 basic line",`* = $0801\n.word next\n.word 10\n.byte $9e\n.text "2061"\n.byte 0\nnext: .word 0\n lda #1\n rts`);
t("org 0801 sys then code",`* = $0801\n.byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$31,$00,$00,$00\n lda #1`);
t("loadAddress c000",`lda #1`,{loadAddress:0xc000});
t("loadAddress 0801 opt",`* = $c000\nlda #1`,{loadAddress:0x0801});
t("res only",`* = $c000\n.res 10`);
t("res after code",`* = $c000\nnop\nbuf: .res 4\n`);
t("res between",`* = $c000\nnop\n.res 2\nnop\n`);
t("zp res then code",`* = $fb\nz: .res 2\n* = $c000\nlda z`);
t("overlap",`* = $c000\nnop\n* = $c000\nnop`);
t("backward org (lower after)",`* = $c010\nnop\n* = $c000\nnop`);
t("gap",`* = $c000\nnop\n* = $c010\nnop`);
t("gap IO",`* = $cff0\nnop\n* = $d010\nnop`);
t("end of mem",`* = $ffff\nnop`);
t("past end",`* = $ffff\nnop\nnop`);
t("jsr $ffff",`* = $fffe\njsr $1000`);
t("org lowercase hex",`* = $C000\nnop`);
t("org 0",`* = 0\nnop`);
t("org neg",`* = -1\nnop`);
t("empty",``);
t("only comments",`; hi\n`);
t("tab/crlf",`* = $c000\r\n\tlda\t#1\r\n`);
t("utf8 bom",`﻿* = $c000\nnop`);
t("nbsp",`* = $c000\n nop`);
t("align mid",`* = $c001\nnop\n.align 256\nnop`);
t("fill 65536",`* = $0000\n.fill 65536,0`);
t("fill 65537",`* = $0000\n.fill 65537,0`);
t("fill neg val",`* = $c000\n.fill 2,-1`);
t("fill big",`* = $c000\n.fill $20000`);
t("dup assign diff",`a = 1\na = 2`);
t("dup assign same",`a = 1\na = 1`);
t("prgEntry stub",`* = $c000\nrts`);
console.log(prgEntryAddress(Buffer.from([1,8,12,8,10,0,0x9e,0x32,0x30,0x36,0x31,0,0,0])));
