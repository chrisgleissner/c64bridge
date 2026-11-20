import { assemblyToPrgDetailed } from "/home/claude/c64bridge/src/tools/translation/assembler.ts";
function t(label:string, src:string, o:any={}){
  try{const r=assemblyToPrgDetailed(src,o);console.log(label.padEnd(34),"OK  len",r.prg.length,"load",(r.prg.readUInt16LE(0)).toString(16),"entry",r.entryAddress.toString(16));}
  catch(e:any){console.log(label.padEnd(34),"ERR ",e.message.replace(/\n/g," | "))}
}
t("code c000 then stub 0801",`* = $c000\nstart: lda #1\n rts\n* = $0801\n.byte $0b,$08,$0a,$00,$9e,$34,$39,$31,$35,$32,0,0,0`);
for (const s of ["start lda #1","loop dex\n bne loop","msg .text \"hi\"","loop","loop\n nop","value = 5\n lda #value","lda #1 ; ok","buf .res 4","SCREEN=$0400\nSTA SCREEN","lda value\nvalue: .byte 1","  .byte 1,2 ; x","label: .word label","jmp label2\nlabel2 nop"]) t(s.replace(/\n/g,"\\n"),"* = $c000\n"+s+"\n");
// error text content
try{assemblyToPrgDetailed("* = $c000\n  lda #1\n  foo bar baz\n");}catch(e:any){console.log(JSON.stringify(e.message), e.location)}
// anonymous / cheap local
