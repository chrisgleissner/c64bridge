import { start } from "./lib.mjs";
const h = await start();
for (const name of ["assembly-program","basic-program","game-development"]) {
const p = await h.client.getPrompt({ name, arguments: {} });
console.log("PROMPT", name, JSON.stringify(p).length, "meta", JSON.stringify(p._meta??{}).length);
for (const m of p.messages) console.log(m.role, m.content.type, (m.content.text ?? JSON.stringify(m.content)).slice(0, 2500));
}
await h.stop(); process.exit(0);
