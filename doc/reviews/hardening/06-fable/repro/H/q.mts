import { LocalMiniHashEmbedding } from "/home/claude/wt/H/src/rag/embeddings.ts";
import { loadIndexes } from "/home/claude/wt/H/src/rag/indexer.ts";
import { LocalRagRetriever } from "/home/claude/wt/H/src/rag/retriever.ts";
const r=new LocalRagRetriever(new LocalMiniHashEmbedding(384), await loadIndexes());
const [scope,...q]=process.argv.slice(2);
const hits=await r.retrieve(q.join(" "),6,scope==="docs"?undefined:scope as any);
for(const h of hits)console.log(h.score.toFixed(3),(h.origin??"").slice(0,80),"|",(h.uri??"").slice(0,40),"|",h.snippet.replace(/\s+/g," ").slice(0,60));
