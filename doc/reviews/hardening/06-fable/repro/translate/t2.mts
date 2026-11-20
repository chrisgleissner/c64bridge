import { assemblyToPrgDetailed } from "/home/claude/c64bridge/src/tools/translation/assembler.ts";
function t(label:string, src:string, o:any={}){
  try{const r=assemblyToPrgDetailed(src,o);console.log(label.padEnd(28),"OK  ",[...r.prg].map(x=>x.toString(16).padStart(2,"0")).join(" "));}
  catch(e:any){console.log(label.padEnd(28),"ERR ",e.message.replace(/\n/g," | "))}
}
const H="* = $c000\n";
const D=(s:string)=>t(s.replace(/\n/g,"\\n"),H+s+"\n");
// data directives
for (const s of [".byte 1,2",".BYTE 1,2","!byte 1,2","!by 1,2","!08 1","!8 1",".db 1,2","db 1,2","byte 1","!word $1234",".word $1234","!16 $1234",".dw $1234",".wo $1234","!le16 $1234",".addr $1234",".dword 1",".long 1",".sbyte 1",".bytes 1",
 ".text \"ab\"","!text \"ab\"","!tx \"ab\"","!pet \"ab\"","!scr \"ab\"",".scr \"ab\"",".screen \"ab\"",".ptext \"ab\"",".null \"ab\"",".shift \"ab\"",".petscii \"ab\"",".asc \"ab\"",".ascii \"ab\"",".fill 3,7","!fill 3,7","!fi 3,7",".fill 3","fill 3,7",".align 4",".align 4,$ea","!align 3,0","!align $ff,0",".res 3",".res 3,0","!res 3","res 3","ds 3",".ds 3","ds.b 3,0",".org $d000","org $d000","* = $d000","*=$d000",".include \"x.asm\"","!source \"x.asm\"",".incbin \"x.bin\"","!binary \"x.bin\"","!bin \"x.bin\"",".macro foo\n.endmacro",".if 1\n.endif","!if 1 {\n}","!macro foo {\n}",".proc foo\n.endproc",".segment \"CODE\"",".setcpu \"6502\"",".cpu 6502","!cpu 6502","!to \"a.prg\",cbm","!zone x",".end",".encoding \"petscii\"","!ct pet","!convtab pet",".repeat 3\nnop\n.endrepeat",".rept 3\nnop\n.endm","!for i,1,3 {\nnop\n}",".for i=0,i<3,i+=1\nnop\n.next",".assert 1==1",".error \"x\"",".warn \"x\"",".define x 1",".define x(a) a",".local",".export foo",".global foo",".code",".data",".bss",".zeropage",".rodata",".pc = $c000","* = $c000, 3",".lobytes 1,2",".hibytes 1,2",".bitmap",".cerror 1",".eor 1",".logical $1000"]) D(s);
