import { initRag } from "/home/claude/wt/H/src/rag/init.ts";
const rag=await initRag();
const qs=[
"stable raster interrupt double IRQ","sprite multiplexer","how many cycles per raster line PAL","bad line cycle stealing","badline FLD",
"open top and bottom border","smooth scrolling horizontal d016","KERNAL SETLFS SETNAM LOAD calling convention","cc65 zero page usage","cc65 linker config c64 memory layout",
"Oscar64 compile prg","llvm-mos c64","fast loader turbo disk","read joystick port 2 dc00","SID play routine IRQ music player",
"CIA timer 1 interrupt","PETSCII screen code conversion","charset custom character memory d018","collision detection sprite d01e","REU DMA transfer",
"8-bit multiplication routine","NMI disable restore key","self-modifying code zero page indirect","VIC bank select dd00","color RAM d800",
"x65 acme kick assembler syntax","load from Ultimate flash","scroll screen with sprites in border","hardware sprite priority multicolor","decrunch exomizer"];
for (const q of qs){const r=await rag.retrieve(q,3);console.log("\n## "+q);for(const x of r)console.log(" -",x.score.toFixed(2),x.origin??x.sourcePath??x.uri,"|",x.snippet.replace(/\s+/g," ").slice(0,90));}
