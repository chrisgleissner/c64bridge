import fs from "node:fs";
import { startViceMockServer } from "/home/claude/c64bridge/src/vice/mockServer.ts";
import { ViceClient } from "/home/claude/c64bridge/src/vice/viceClient.ts";
const vice = await startViceMockServer({ host: "127.0.0.1", port: 0 });
for (const name of ["connect", "memGet", "exitMonitor", "registersGet", "send"]) {
  const orig = (ViceClient.prototype as any)[name];
  (ViceClient.prototype as any)[name] = async function (...a: any[]) { const t = performance.now(); try { return await orig.apply(this, a); } finally { if (name !== "send") console.log(`  ${name} ${(performance.now() - t).toFixed(1)}ms`); if (name === "connect" && process.env.STACK) console.log(new Error().stack?.split("\n").slice(2,9).join("\n")); } };
}
fs.writeFileSync("/tmp/h6/progmem/vicecfg.json", JSON.stringify({ vice: { host: "127.0.0.1", port: vice.port } }));
process.env.C64BRIDGE_CONFIG = "/tmp/h6/progmem/vicecfg.json"; process.env.C64_MODE = "vice";
const { C64Client } = await import("/home/claude/c64bridge/src/c64Client.ts");
const client = new C64Client("http://unused.local", { forceC64uFacade: false });
await client.readMemoryRaw(0x400, 1);
for (let i = 0; i < 2; i++) { const t = performance.now(); await client.readMemoryRaw(0x400, 16); console.log(`readMemoryRaw total ${(performance.now() - t).toFixed(1)}ms`); }
process.exit(0);
