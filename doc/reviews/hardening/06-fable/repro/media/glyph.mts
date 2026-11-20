import { getChargenGlyphs } from "/home/claude/c64bridge/src/chargen.ts";
import { screenCodesToAscii } from "/home/claude/c64bridge/src/petscii.ts";
const g = getChargenGlyphs();
console.log(g.length);
const sc = new Map<number,number>();
for (const x of g) sc.set(x.screenCode,(sc.get(x.screenCode)??0)+1);
console.log("dups", [...sc].filter(([k,v])=>v>1).slice(0,10), "missing", Array.from({length:256},(_,i)=>i).filter(i=>!sc.has(i)).length);
// expected petscii for screen code (PETSCII->screen rules)
function petToScr(p:number){ if(p<0x20)return -1; if(p<0x40)return p; if(p<0x60)return p-0x40; if(p<0x80)return p-0x20; if(p<0xa0)return -1; if(p<0xc0)return p-0x40; if(p<0xff)return p-0x80; return 0x5e;}
let bad=0;
for (const x of g){ const e = petToScr(x.petsciiCode); if (e!==x.screenCode && bad++<40) console.log("mismatch screen",x.screenCode.toString(16),"petscii",x.petsciiCode.toString(16),"expected scr",e.toString(16), x.basic, x.name);}
console.log("bad",bad);
const all=new Uint8Array(256).map((_,i)=>i);
console.log(screenCodesToAscii(all,{columns:32,trimTrailingSpaces:false}));
console.log(screenCodesToAscii(all,{columns:32,trimTrailingSpaces:false,charset:"lower"}));
