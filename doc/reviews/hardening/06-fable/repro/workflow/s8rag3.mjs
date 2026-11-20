import { start } from "./lib.mjs";
const h = await start();
const r = await h.client.callTool({ name: "c64_rag", arguments: { op: "docs", q: "smooth horizontal scrolling with $D016", k: 3 } });
console.log("text bytes", r.content[0].text.length, "total", JSON.stringify(r).length);
console.log(JSON.stringify(r.structuredContent).slice(0, 2500));
console.log("metadata", JSON.stringify(r.metadata ?? null).slice(0, 500));
for (const uri of ["c64://gamedev/techniques#3. Smooth scrolling", "c64://gamedev/techniques"]) {
  try { const x = await h.client.readResource({ uri }); console.log("read OK", uri, x.contents[0].text.length); } catch (e) { console.log("read FAIL", uri, e.message); }
}
await h.stop(); process.exit(0);
