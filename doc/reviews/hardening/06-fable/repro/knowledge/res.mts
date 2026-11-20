import { listKnowledgeResources } from "/home/claude/c64bridge/src/rag/knowledgeIndex.ts";
const t=performance.now();
const r=listKnowledgeResources();
console.log((performance.now()-t).toFixed(0),"ms",r.length);
for (const x of r) console.log(x.uri);
