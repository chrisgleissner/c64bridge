import fs from "node:fs";
import { startViceMockServer } from "/home/claude/c64bridge/src/vice/mockServer.ts";
import { ViceClient } from "/home/claude/c64bridge/src/vice/viceClient.ts";
process.env.VICE_TEST_TARGET = "mock";
const vice: any = await startViceMockServer({ host: "127.0.0.1", port: 0 });
let T0 = 0;
for (const name of Object.getOwnPropertyNames(ViceClient.prototype)) {
  if (["constructor", "send", "isOpen", "cpuRunning"].includes(name)) continue;
  const d = Object.getOwnPropertyDescriptor(ViceClient.prototype, name)!;
  if (typeof d.value !== "function") continue;
  const orig = d.value;
  (ViceClient.prototype as any)[name] = function (...a: any[]) {
    const t = performance.now(); const r = orig.apply(this, a);
    if (r && typeof r.then === "function" && T0) r.then(() => console.log(`  +${(t - T0).toFixed(0)} ${name}(${a.map((x: any) => typeof x === "number" ? "$" + x.toString(16) : typeof x).join(",")}) ${(performance.now() - t).toFixed(0)}ms`), () => {});
    return r;
  };
}
const origST = globalThis.setTimeout;
(globalThis as any).setTimeout = (fn: any, ms: any, ...rest: any[]) => { if (T0 && ms >= 20) console.log(`  +${(performance.now() - T0).toFixed(0)} sleep ${ms}ms`); return origST(fn, ms, ...rest); };
fs.writeFileSync("/tmp/h6/progmem/vicecfg4.json", JSON.stringify({ vice: { host: "127.0.0.1", port: vice.port } }));
process.env.C64BRIDGE_CONFIG = "/tmp/h6/progmem/vicecfg4.json"; process.env.C64_MODE = "vice";
const { C64Client } = await import("/home/claude/c64bridge/src/c64Client.ts");
const { toolRegistry } = await import("/home/claude/c64bridge/src/tools/registry/index.ts");
const client = new C64Client("http://unused.local", { forceC64uFacade: false });
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = { id: "vice", features: [], limitedFeatures: [] } as any;
const ctx: any = { client, logger, platform, setPlatform: () => platform, rag: {} };
await client.readMemoryRaw(0x400, 1);
T0 = performance.now();
const r: any = await toolRegistry.invoke("c64_program", JSON.parse(process.argv[2]), ctx);
console.log(`TOTAL ${(performance.now() - T0).toFixed(0)}ms err=${r.isError ?? false}: ${r.content[0].text.slice(0, 200)}`);
process.exit(0);
