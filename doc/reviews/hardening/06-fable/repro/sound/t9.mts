import { parseSidwave } from "/home/claude/c64bridge/src/sidwave.ts";
import { compileSidwaveToPrg } from "/home/claude/c64bridge/src/sidwaveCompiler.ts";
const d = parseSidwave({sidwave:"1.0",tempo:120,voices:[{id:1,patterns:{A:{groove:["C4","E4"]}}}],timeline:[{bars:8,layers:{v1:"A"}}]});
for (let i=0;i<3;i++){ const t=performance.now(); const r=compileSidwaveToPrg(d); console.log((performance.now()-t).toFixed(1),"ms", r.prg.length); }
