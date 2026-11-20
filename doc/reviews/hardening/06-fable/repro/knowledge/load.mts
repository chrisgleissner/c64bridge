import { initRag } from "/home/claude/wt/H/src/rag/init.ts";
const r0=process.memoryUsage().rss;
const t=performance.now();
const rag=await initRag();
const t1=performance.now();
console.log("init ms",(t1-t).toFixed(0),"rss delta MB",((process.memoryUsage().rss-r0)/1e6).toFixed(0),"heap MB",(process.memoryUsage().heapUsed/1e6).toFixed(0));
for (const q of ["x","raster interrupt","sprite multiplexer"]){const a=performance.now();const res=await rag.retrieve(q,3);console.log(q,(performance.now()-a).toFixed(0),"ms",res.length);}
const a=performance.now();await rag.retrieve("stable raster irq",3,"asm");console.log("asm",(performance.now()-a).toFixed(0));
const b=performance.now();await rag.retrieve("PRINT",12,"basic");console.log("basic",(performance.now()-b).toFixed(0));
const l=performance.now();await rag.retrieve("a ".repeat(240),12);console.log("long",(performance.now()-l).toFixed(0));
