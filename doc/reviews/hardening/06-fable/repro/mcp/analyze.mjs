import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync("/tmp/h6/mcp/results.json","utf8"));
const tools = r["tools/list"].result.tools;
const B = (x) => Buffer.byteLength(JSON.stringify(x ?? ""));
let tot = {desc:0, title:0, schemaDesc:0, props:0, annotations:0, meta:0, all:0};
const rows=[];
let propDescBytes=0, opLimitsNotes=0, nullTypes=0;
for (const t of tools) {
  const s = t.inputSchema;
  const row = {name:t.name, all:B(t), desc:B(t.description), schemaDesc:B(s.description), props:B(s.properties), meta:B(t._meta), ann:B(t.annotations), nprops:Object.keys(s.properties).length};
  rows.push(row);
  tot.desc+=row.desc; tot.schemaDesc+=row.schemaDesc; tot.props+=row.props; tot.meta+=row.meta; tot.annotations+=row.ann; tot.all+=row.all; tot.title+=B(t.title);
  for (const [k,p] of Object.entries(s.properties)) { propDescBytes += B(p.description); if ((p.description??"").includes("Limits depend on op.")) opLimitsNotes++; if (Array.isArray(p.type)&&p.type.includes("null")) nullTypes++; }
}
console.table(rows.sort((a,b)=>b.all-a.all));
console.log(tot, {propDescBytes, opLimitsNotes, nullTypes});
// _meta content example
console.log(JSON.stringify(tools.find(t=>t.name==="c64_memory")._meta).slice(0,600));
console.log(JSON.stringify(tools.map(t=>[t.name,t.annotations])));
