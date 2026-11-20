import { assemblyToPrgDetailed } from "/home/claude/c64bridge/src/tools/translation/assembler.ts";
function t(label:string, src:string, o:any={}){
  try{const r=assemblyToPrgDetailed(src,o);console.log(label.padEnd(34),"OK  ",[...r.prg].map(x=>x.toString(16).padStart(2,"0")).join(" "));}
  catch(e:any){console.log(label.padEnd(34),"ERR ",e.message.replace(/\n/g," | "))}
}
const H="* = $c000\n";
const D=(s:string)=>t(s.replace(/\n/g,"\\n"),H+s+"\n");
console.log("--- strings/escapes");
for (const s of [`.byte "abc\\0"`,`.byte "a\\x41"`,`.text "Hello World"`,`.byte "Hello"`,`.text "a\\\\b"`,`.byte 'A'+1`,`.byte "A"+1`,`.byte "A"-64`,`.byte 'A'`,`.byte "a",0`,`.text "{clr}hi"`,`.text "é"`,`.byte "é"`,`.text "x" ; c;`,`.byte "a;b" ; comment`,`.byte ';'`, `.text "\\n"`,`.byte 1,`,`.byte`,`lda #'a'`,`lda #'A'-64`,`lda #"A"`,`lda #'\\''`,`.text "it's"`, `.text 'it''s'`,`.byte "q\\"q"`,`.text "C:\\"`]) D(s);
console.log("--- expressions");
for (const s of [`lda #1+2*3`,`lda #(1+2)*3`,`lda #<$1234`,`lda #>$1234`,`lda #<$1234+1`,`lda #>$12ff+1`,`lda #<label\nlabel:`,`.byte <$1234,>$1234`,`.byte 1<<2+1`,`.byte 6&3==2`,`.byte 2|1^3`,`.byte -1`,`.byte 256`,`.byte 10/3,10%3`,`.byte %1010,%11 % 5`,`.byte 5%3`,`.byte 5 % 3`,`lda #%1010`,`.byte $ff & ~$0f`,`.byte !0, !5`,`.byte 1 == 1`,`.byte 3 > 2`,`.byte 10 >> 1`,`lda #0x1f`,`lda #0b101`,`lda #$FF`,`lda #-129`,`lda #255+1`,`lda #<label+1\nlabel=$1234`,`.word *`,`.word * + 3`,`lda *+1`,`jmp *`,`.byte (1+2)*3`,`lda (1+2)*3`,`lda (4)+1`,`lda $10+(2)`,`lda ($10)+1,x`,`jmp ($1234)`,`jmp (label)\nlabel = $1234`,`lda ($10),y`,`lda ($10,x)`,`lda ( $10 ) , y`,`lda $1234 , x`,`lda  #  5`,`lda #$1234 >> 8`,`lda #(label>>8)\nlabel=$1234`,`lda label>>8\nlabel=$1234`,`.byte 2**3`,`.byte 7 div 2`,`.byte 1 xor 3`,`.byte 1 and 3`,`.byte $10 + 'A'`,`.byte "1"`,`.word $1234, $5678`,`.word -1`,`.word 65536`]) D(s);
