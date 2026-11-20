import { buildPrinterBasicProgram, buildCommodoreBitmapBasicProgram, buildPetsciiScreenBasic, buildEpsonBitmapBasicProgram, buildCommodoreDllBasicProgram } from "/home/claude/c64bridge/src/c64Client.ts";
import { basicToPrg } from "/home/claude/c64bridge/src/tools/translation/basicTokenizer.ts";
function t(name:string, f:()=>string){ const t0=Date.now(); try{ const p=f(); const prg=basicToPrg(p); console.log(name,"OK prg",prg.length,"lines",p.split("\n").length,"ms",Date.now()-t0);}catch(e:any){console.log(name,"ERR",String(e.message).slice(0,100),"ms",Date.now()-t0);} }
t("print_text 20KB", ()=>buildPrinterBasicProgram({text:"abc def ".repeat(2500)}));
t("print_text 200KB", ()=>buildPrinterBasicProgram({text:"abc def ".repeat(25000)}));
t("petscii_text 200KB", ()=>buildPetsciiScreenBasic({text:"abc def ".repeat(25000)}));
t("cbm bitmap 4000 cols", ()=>buildCommodoreBitmapBasicProgram({columns:Array(4000).fill(5)}));
t("cbm bitmap 100000 cols", ()=>buildCommodoreBitmapBasicProgram({columns:Array(100000).fill(5)}));
t("epson 100000 cols", ()=>buildEpsonBitmapBasicProgram({columns:Array(100000).fill(5)}));
t("epson 70000 cols", ()=>buildEpsonBitmapBasicProgram({columns:Array(70000).fill(5)}));
