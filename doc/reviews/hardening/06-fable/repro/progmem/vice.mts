import fs from "node:fs";
import { startViceMockServer } from "/home/claude/c64bridge/src/vice/mockServer.ts";
if (process.env.MOCKMODE) process.env.VICE_TEST_TARGET = "mock";
const vice = await startViceMockServer({ host: "127.0.0.1", port: 0, stepEventDelayMs: Number(process.env.STEPDELAY ?? 0) });
fs.writeFileSync("/tmp/h6/progmem/vicecfg.json", JSON.stringify({ vice: { host: "127.0.0.1", port: vice.port } }));
process.env.C64BRIDGE_CONFIG = "/tmp/h6/progmem/vicecfg.json";
process.env.C64_MODE = "vice";
const { C64Client } = await import("/home/claude/c64bridge/src/c64Client.ts");
const { toolRegistry } = await import("/home/claude/c64bridge/src/tools/registry/index.ts");
const client = new C64Client("http://unused.local", { forceC64uFacade: false });
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = { id: "vice", features: [], limitedFeatures: [] } as any;
const ctx: any = { client, logger, platform, setPlatform: () => platform, rag: {} };
const steps = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const [tool, args] of steps) {
  const t0 = performance.now();
  let r: any;
  try { r = await toolRegistry.invoke(tool, args, ctx); } catch (e) { r = { thrown: String(e) }; }
  const ms = performance.now() - t0;
  const s = JSON.stringify(r.structuredContent?.data ?? r);
  console.log(`--- ${JSON.stringify(args)} ${ms.toFixed(0)}ms err=${r.isError ?? false} size=${JSON.stringify(r).length}`);
  console.log("   " + (r.content?.[0]?.text ?? s).slice(0, Number(process.env.MAXC ?? 400)).replace(/\n/g, "\n   "));
}
await vice.stop?.();
process.exit(0);
