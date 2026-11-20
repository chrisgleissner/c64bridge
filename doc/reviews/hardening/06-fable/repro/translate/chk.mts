import { getChargenGlyphs } from "/home/claude/wt/F/src/chargen.ts";
const rule=(p:number)=>p<0x20?undefined: p<0x40?p: p<0x60?p-0x40: p<0x80?p-0x20: p<0xa0?undefined: p<0xc0?p-0x40: p<0xff?p-0x80: 0x5e;
let ok=0,bad=0; const g=getChargenGlyphs(); console.log(g.length);
for(const x of g){ const r=rule(x.petsciiCode); const base=x.screenCode&0x7f; if(r===base) ok++; else {bad++; if(bad<12) console.log("diff",x.screenCode.toString(16),x.petsciiCode.toString(16),r?.toString(16))}}
console.log({ok,bad});
