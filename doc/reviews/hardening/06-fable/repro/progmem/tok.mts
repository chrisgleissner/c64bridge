import { basicToPrg } from "/home/claude/c64bridge/src/tools/translation/basicTokenizer.ts";
for (const p of ["20 PRINT 2\n10 PRINT 1", "10 PRINT 1\n10 PRINT 2"]) {
  const prg = basicToPrg(p); const out: number[] = []; let i = 2;
  while (i + 3 < prg.length) { const link = prg.readUInt16LE(i); if (!link) break; out.push(prg.readUInt16LE(i + 2)); i = link - 0x0801 + 2; }
  console.log(JSON.stringify(p), "-> line order", out);
}
