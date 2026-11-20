import { initRag } from "/home/claude/c64bridge/src/rag/init.ts";
import fs from "node:fs";
const rag=await initRag();
for (const f of ["asm","basic","mixed","hardware","other"]) { const j=JSON.parse(fs.readFileSync(`/home/claude/c64bridge/data/embeddings_${f}.json`,"utf8")); const bySrc:Record<string,number>={}; for(const r of j.records){const k=(r.sourcePath??r.origin??"?").split("#")[0].split("/").slice(0,2).join("/");bySrc[k]=(bySrc[k]??0)+1;} console.log(f,j.records.length,JSON.stringify(Object.entries(bySrc).sort((a,b)=>b[1]-a[1]).slice(0,6))); }
const run=async(q:string,k:number,l?:any)=>{const r=await rag.retrieve(q,k,l);console.log("\n## ["+(l??"docs")+"] "+JSON.stringify(q));for(const x of r)console.log(" -",x.score.toFixed(2),(x.origin??x.sourcePath??"").slice(0,70),"|",x.snippet.replace(/\s+/g," ").slice(0,80));};
await run("stable raster irq",3,"asm");
await run("sprite multiplexer",3,"asm");
await run("scroll screen left one column",3,"asm");
await run("read joystick",3,"asm");
await run("play sid note",3,"basic");
await run("   ",3);
await run("   ",3,"asm");
await run("__proto__ constructor toString",3);
await run("$d012 $d011 raster compare",3);
await run("sprite multiplexer",12);
const r=await rag.retrieve("sprite multiplexer",12); console.log("bytes",JSON.stringify(r).length);
