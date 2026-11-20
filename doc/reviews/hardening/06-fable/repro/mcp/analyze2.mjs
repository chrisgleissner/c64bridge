import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync("/tmp/h6/mcp/results.json","utf8"));
const tools = r["tools/list"].result.tools;
let reqopt=0, opsLines=0, nullBytes=0, limits=0, defaults=0, whole=0;
for (const t of tools) {
  const d = t.inputSchema.description ?? "";
  for (const m of d.matchAll(/ Required inputs: [^.]*\.( Optional inputs: [^\n]*\.)?/g)) reqopt += Buffer.byteLength(m[0]);
  for (const p of Object.values(t.inputSchema.properties)) {
    if (Array.isArray(p.type) && p.type.includes("null")) nullBytes += Buffer.byteLength(',"null"') + 2; // brackets
    if ((p.description??"").includes(" Limits depend on op.")) limits += 21;
  }
}
const s = JSON.stringify(r["tools/list"].result);
console.log({reqopt, nullBytes, limits, total: Buffer.byteLength(s)});
// check duplicated descriptions: tool.description vs title
for (const t of tools.slice(0,3)) console.log(t.name, "|", t.title, "|", t.description);
console.log(tools.find(t=>t.name==="c64_memory").inputSchema.description.slice(0,900));
// resources list
const res = r["resources/list"].result.resources;
console.log("resources", res.length, Buffer.byteLength(JSON.stringify(res)), "meta bytes", res.reduce((a,x)=>a+Buffer.byteLength(JSON.stringify(x._meta??{})),0), "desc bytes", res.reduce((a,x)=>a+Buffer.byteLength(x.description??""),0));
console.log(JSON.stringify(res[0]));
const pr = r["prompts/list"].result.prompts;
console.log("prompts", pr.length, Buffer.byteLength(JSON.stringify(pr)), "meta bytes", pr.reduce((a,x)=>a+Buffer.byteLength(JSON.stringify(x._meta??{})),0));
console.log(JSON.stringify(pr[0]));
