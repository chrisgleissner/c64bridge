import { start } from "./lib.mjs";
const h = await start();
const qs = [
 ["asm","sprite multiplexing with more than 8 sprites"],
 ["asm","set up a raster interrupt at line 100"],
 ["docs","REU DMA transfer from C64 RAM to REU"],
 ["docs","UCI command to load a file from the Ultimate filesystem"],
 ["docs","turbo mode register to enable 48 MHz CPU on Ultimate 64"],
 ["asm","SID filter cutoff and resonance low pass"],
 ["asm","read joystick port 2 fire button"],
 ["docs","bad lines VIC-II cycles stolen"],
 ["asm","smooth horizontal scrolling with $D016"],
 ["asm","sprite to background collision detection"],
 ["docs","detect whether running on Ultimate 64 or stock C64"],
 ["asm","play music with IRQ every frame using a SID player at $1000"],
 ["docs","multiple SID chips address configuration"],
 ["asm","disable BASIC and KERNAL ROM to use RAM under ROM"],
 ["basic","read joystick in BASIC with PEEK(56320)"],
 ["asm","open a stable raster split stable raster double IRQ"],
];
const out = [];
for (const [op, q] of qs) {
  const s = performance.now();
  const r = await h.client.callTool({ name: "c64_rag", arguments: { op, q, k: 3 } });
  const ms = Math.round(performance.now() - s);
  const t = r.content.map(c=>c.text).join("");
  out.push({ op, q, ms, bytes: JSON.stringify(r).length, text: t });
}
for (const o of out) { console.log(`\n######## [${o.op}] ${o.q}  (${o.ms}ms, ${o.bytes}B)`); console.log(o.text.slice(0, 2200)); }
await h.stop(); process.exit(0);
