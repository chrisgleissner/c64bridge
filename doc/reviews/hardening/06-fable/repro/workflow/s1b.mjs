import { start } from "./lib.mjs";
const h = await start();
const res = await h.client.listResources();
let total = 0;
for (const r of res.resources) { const s = performance.now(); const x = await h.client.readResource({ uri: r.uri }); const t = x.contents.map(c=>c.text??"").join(""); total += t.length; console.log(r.uri, t.length, Math.round(performance.now()-s)+"ms"); }
console.log("total", total);
await h.read("c64://guide/fast-paths", 20000);
await h.read("c64://guide/bootstrap", 20000);
const p = await h.client.getPrompt({ name: "assembly-program", arguments: {} }); console.log("PROMPT", JSON.stringify(p).length, JSON.stringify(p).slice(0, 3000));
await h.stop(); process.exit(0);
