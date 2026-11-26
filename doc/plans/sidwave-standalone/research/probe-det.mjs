import { readFileSync } from "node:fs"; import { createHash } from "node:crypto"; import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.PROBE_PROJ + "/node_modules/libsidplayfp-wasm/dist/index.js").href);
const data = new Uint8Array(readFileSync("/home/chris/dev/c64/C64Music/MUSICIANS/H/Hubbard_Rob/Commando.sid"));
async function run(engine, trace, shared) {
  const m = shared ?? await mod.loadLibsidplayfp({ engine });
  const ctx = new m.SidPlayerContext(); ctx.configure(48000, false); ctx.setEmulationConfig({ powerOnDelay: 0 });
  ctx.loadSidBuffer(data); ctx.selectSong(1); ctx.setSidWriteTraceEnabled(trace);
  const a = []; let n = 0; while (n < 96000) { const c = ctx.render(20000).slice(); a.push(c); n += c.length; if (trace) ctx.getAndClearSidWriteTraces(); }
  const p = new Int16Array(96000); let o = 0; for (const c of a) { const k = Math.min(c.length, 96000 - o); p.set(c.subarray(0, k), o); o += k; }
  ctx.delete(); return p;
}
const h = p => createHash("sha256").update(Buffer.from(p.buffer)).digest("hex").slice(0, 12);
for (const eng of ["residfp", "sidlite"]) {
  const a = await run(eng, false), b = await run(eng, false), c = await run(eng, true);
  let d = a.findIndex((v, i) => v !== b[i]), d2 = a.findIndex((v, i) => v !== c[i]);
  console.log(eng, "fresh-module off/off", h(a), h(b), "firstdiff", d, "| off/on", h(c), "firstdiff", d2);
  const m = await mod.loadLibsidplayfp({ engine: eng });
  const e = await run(eng, false, m), f = await run(eng, false, m), g = await run(eng, true, m);
  console.log(eng, "shared-module off/off/on", h(e), h(f), h(g));
}
