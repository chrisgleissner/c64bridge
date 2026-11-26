// Usage: node probe-wasm.mjs [sidfile] ; run with cwd = the scratch project that has libsidplayfp-wasm installed
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const proj = process.env.PROBE_PROJ;
const entry = pathToFileURL(proj + "/node_modules/libsidplayfp-wasm/dist/index.js").href;
const mod = await import(entry);
const sid = process.argv[2] ?? "/home/chris/dev/c64/C64Music/MUSICIANS/H/Hubbard_Rob/Commando.sid";
const data = new Uint8Array(readFileSync(sid));
const RATE = 48000, SECONDS = 2;
console.log("exports:", Object.keys(mod).sort().join(", "));
console.log("versions:", mod.LIBSIDPLAYFP_VERSION, mod.LIBRESIDFP_VERSION, mod.PACKAGE_VERSION);

async function run(trace, engine = "residfp") {
  const m = await mod.loadLibsidplayfp({ engine });
  const ctx = new m.SidPlayerContext();
  const out = { engineName: m.getSidEngineName(), hasSetSystemROMs: typeof ctx.setSystemROMs === "function" };
  if (!ctx.configure(RATE, false)) throw new Error(ctx.getLastError());
  if (!ctx.loadSidBuffer(data)) throw new Error("load: " + ctx.getLastError());
  if (!ctx.selectSong(0) && ctx.hasError()) throw new Error("select: " + ctx.getLastError());
  out.tune = (({ format, songs, startSong, compatibility, sidChips }) => ({ format, songs, startSong, compatibility, sidChips }))(ctx.getTuneInfo());
  ctx.setSidWriteTraceEnabled(trace);
  const want = RATE * SECONDS, chunks = []; let n = 0, traces = [], dropped = 0;
  while (n < want) {
    const c = ctx.render(20000);
    if (!c) throw new Error("render null: " + ctx.getLastError());
    const cp = c.slice(); chunks.push(cp); n += cp.length;
    if (trace) { traces.push(...ctx.getAndClearSidWriteTraces()); dropped += ctx.getDroppedSidWriteTraceCount(); }
  }
  const pcm = new Int16Array(want); let o = 0;
  for (const c of chunks) { const k = Math.min(c.length, want - o); pcm.set(c.subarray(0, k), o); o += k; }
  out.sha = createHash("sha256").update(Buffer.from(pcm.buffer)).digest("hex");
  out.nonzero = pcm.some(v => v !== 0); out.timeMs = ctx.getTimeMs(); out.samplesRendered = n;
  if (trace) { out.records = traces.length; out.sample = traces.slice(0, 3); out.keys = traces[0] ? Object.keys(traces[0]) : []; out.dropped = dropped; out.lastCycle = traces.at(-1)?.cyclePhi1; }
  ctx.delete();
  return out;
}
const off = await run(false), off2 = await run(false), on = await run(true), on2 = await run(true);
console.log("off vs off2 equal:", off.sha === off2.sha, " on vs on2 equal:", on.sha === on2.sha);
console.log("trace off:", JSON.stringify(off));
console.log("trace on :", JSON.stringify(on));
console.log("PCM identical with trace on/off:", off.sha === on.sha);
