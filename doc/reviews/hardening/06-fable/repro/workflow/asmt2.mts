import { assemblyToPrgDetailed } from "/home/claude/c64bridge/src/tools/translation/assembler.ts";
for (const src of ["*=$c000\n lda #1\n ds 4\n rts", "*=$c000\n lda #1\n ds 4,$ea\n rts", "*=$c000\n lda #1\n .ds 4\n rts", "*=$c000\n lda #1\nbuf: ds 4\n rts", "*=$c000\n lda #1\n foo 4\n rts"]) {
  try { const r = assemblyToPrgDetailed(src); console.log("OK ", JSON.stringify(src), r.prg.toString("hex"), JSON.stringify([...r.symbols])); } catch (e) { console.log("ERR", JSON.stringify(src), e.message); }
}
