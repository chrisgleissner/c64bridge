import { start } from "./lib.mjs";
const h = await start();
console.log("init ms", h.initMs);
const sv = h.client.getServerVersion(); const instr = h.client.getInstructions();
console.log("server", JSON.stringify(sv)); console.log("instructions bytes", instr?.length); console.log(instr);
let s = performance.now();
const tools = await h.client.listTools(); console.log("tools/list ms", Math.round(performance.now()-s), "bytes", JSON.stringify(tools).length, "count", tools.tools.length);
for (const t of tools.tools) console.log(" -", t.name, JSON.stringify(t).length, "|", (t.description||"").slice(0,160).replace(/\n/g," "));
s = performance.now();
const res = await h.client.listResources(); console.log("resources/list ms", Math.round(performance.now()-s), "bytes", JSON.stringify(res).length, "count", res.resources.length);
for (const r of res.resources) console.log(" -", r.uri, "|", r.name, "|", (r.description||"").slice(0,100));
try { const rt = await h.client.listResourceTemplates(); console.log("templates", JSON.stringify(rt).slice(0,500)); } catch(e){console.log("templates err", e.message)}
s = performance.now();
const pr = await h.client.listPrompts(); console.log("prompts/list ms", Math.round(performance.now()-s), "bytes", JSON.stringify(pr).length, "count", pr.prompts.length);
for (const p of pr.prompts) console.log(" -", p.name, "|", (p.description||"").slice(0,100), JSON.stringify(p.arguments||[]).slice(0,150));
const fs = await import("node:fs"); fs.writeFileSync("/tmp/h6/workflow/tools.json", JSON.stringify(tools, null, 1));
fs.writeFileSync("/tmp/h6/workflow/resources.json", JSON.stringify(res, null, 1));
await h.stop(); process.exit(0);
