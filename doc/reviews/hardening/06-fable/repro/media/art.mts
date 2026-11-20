import { createPetsciiArt } from "/home/claude/c64bridge/src/petsciiArt.ts";
import { basicToPrg } from "/home/claude/c64bridge/src/tools/translation/basicTokenizer.ts";
const w=320,h=200; const pixels=new Uint8Array(w*h); for(let y=0;y<h;y++)for(let x=0;x<w;x++) pixels[y*w+x]=((x>>3)+(y>>3))%3===0?1:((x*7+y*13)%5<2?1:0);
const t0=Date.now();
const a = createPetsciiArt({bitmap:{width:w,height:h,pixels}});
console.log("ms",Date.now()-t0,"program chars",a.program.length,"bitmapHex",a.bitmapHex.length,"rowHex",a.rowHex.join("").length,"codes",a.petsciiCodes.length);
console.log("json bytes", JSON.stringify({program:a.program,bitmapHex:a.bitmapHex,rowHex:a.rowHex,petsciiCodes:a.petsciiCodes}).length);
const lines=a.program.split("\n"); console.log("max line len",Math.max(...lines.map(l=>l.length)), "lines", lines.length, "last", lines[lines.length-1]);
console.log(lines.slice(0,6).join("\n"));
const prg = basicToPrg(a.program); console.log("prg bytes", prg.length);
// quote glyph / control codes in data?
const bad = a.petsciiCodes.filter(c=>c<32&&c!==18&&c!==146||c===34||(c>=128&&c<160&&c!==146)); console.log("control/quote codes in stream", [...new Set(bad)]);
