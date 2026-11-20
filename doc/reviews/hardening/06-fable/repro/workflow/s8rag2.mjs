import { start } from "./lib.mjs";
const h = await start();
const qs = ["set up a raster interrupt at line 100","SID filter cutoff and resonance low pass","read joystick port 2 fire button","smooth horizontal scrolling with $D016","sprite to background collision detection","disable BASIC and KERNAL ROM to use RAM under ROM","read joystick in BASIC with PEEK(56320)","turbo mode register to enable 48 MHz CPU on Ultimate 64"];
for (const q of qs) {
  const r = await h.client.callTool({ name: "c64_rag", arguments: { op: "docs", q, k: 3 } });
  const t = r.content.map(c=>c.text).join("");
  console.log("\n## docs:", q); for (const l of t.split("\n").filter(l=>/^\d\. /.test(l))) console.log("  ", l.slice(0,170));
}
await h.stop(); process.exit(0);
