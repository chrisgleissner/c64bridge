import { start } from "./lib.mjs";
const h = await start();
const p = await h.client.getPrompt({ name: "game-development", arguments: {} });
for (const [k, v] of Object.entries(p._meta)) console.log(k, JSON.stringify(v).length);
console.log(JSON.stringify(p._meta.tools).slice(0, 600));
await h.stop(); process.exit(0);
