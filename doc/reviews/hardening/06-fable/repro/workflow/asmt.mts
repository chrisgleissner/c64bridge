import { assemblyToPrgDetailed } from "/home/claude/c64bridge/src/tools/translation/assembler.ts";
for (const src of [".org $c000\n rts", "*=$c000\nx: .ascii \"AB\"", "*=$c000\nds 4", "*=$c000\n ds 4", "*=$c000\n .fill 4,0", "*=$c000\n jmp ($fffc)", "*=$c000\nscore: .byte 0\n lda score+1", "*=$c000\n lda #<msg\nmsg: rts", "*=$c000\n.text \"hi\"" ]) {
  try { const r = assemblyToPrgDetailed(src); console.log("OK ", JSON.stringify(src), r.prg.length); } catch (e) { console.log("ERR", JSON.stringify(src), e.message); }
}
