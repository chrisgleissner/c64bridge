import { LocalMiniHashEmbedding } from "/home/claude/wt/H/src/rag/embeddings.ts";
import { LocalRagRetriever } from "/home/claude/wt/H/src/rag/retriever.ts";
const model=new LocalMiniHashEmbedding(64);
async function rec(text:string,sp:string,o:string){return {name:sp,language:"other",vector:Array.from(await model.embed(text)),text,sourcePath:sp,sourceMtimeMs:0,origin:o} as any}
const focused=await rec("## 2. Sprite multiplexing\nSort sprites by Y, then reuse each hardware sprite.","a.md","a.md#2. Sprite multiplexing");
const table=await rec(`## Games\n${"| Cadaver | sprite multiplexer, multiplexer demo | MIT |\n".repeat(12)}`,"b.md","b.md#Games");
const filler=await Promise.all(["SID filter registers","CIA timer registers","KERNAL jump table","REU commands"].map((t)=>rec(`## ${t}\n${t} reference text`,"x.md",`x.md#${t}`)));
const r=new LocalRagRetriever(model,{other:{dim:64,model:"t",records:[table,focused,...filler]}});
for(const h of await r.retrieve("sprite multiplexer",3))console.log(h.score.toFixed(3),h.sourcePath);
