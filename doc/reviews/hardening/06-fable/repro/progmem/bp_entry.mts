import fs from "node:fs";
import { startViceMockServer } from "/home/claude/c64bridge/src/vice/mockServer.ts";
const vice: any = await startViceMockServer({ host: "127.0.0.1", port: 0 });
fs.writeFileSync("/tmp/h6/progmem/vicecfg3.json", JSON.stringify({ vice: { host: "127.0.0.1", port: vice.port } }));
process.env.C64BRIDGE_CONFIG = "/tmp/h6/progmem/vicecfg3.json"; process.env.C64_MODE = "vice";
process.env.VICE_TEST_TARGET = "mock"; process.env.C64BRIDGE_POLL_MAX_MS = "300";
const { C64Client } = await import("/home/claude/c64bridge/src/c64Client.ts");
const { toolRegistry } = await import("/home/claude/c64bridge/src/tools/registry/index.ts");
const client = new C64Client("http://unused.local", { forceC64uFacade: false });
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = { id: "vice", features: [], limitedFeatures: [] } as any;
const ctx: any = { client, logger, platform, setPlatform: () => platform, rag: {} };
async function call(tool: string, args: any) {
  const r: any = await toolRegistry.invoke(tool, args, ctx);
  console.log(`--- ${tool} ${JSON.stringify(args).slice(0,80)} err=${r.isError ?? false}\n   ${String(r.content?.[0]?.text).slice(0, 700)}`);
  return r;
}
await call("c64_debug", { op: "create_checkpoint", address: "$C000" });
const timer = setInterval(() => {
  if (vice.keyboardFeeds?.length > 0 && vice.running) { vice.registerValues.set(0, 0xC000); console.log("   [mock] CPU reaches $C000: hit=", vice.hitCheckpoint(1)); clearInterval(timer); }
}, 5);
await call("c64_program", { op: "upload_run_asm", program: "*=$C000\nstart: lda #1\n sta $d020\nloop: jmp loop\n" });
await call("c64_debug", { op: "create_checkpoint", address: "loop" });
await call("c64_debug", { op: "get_monitor_state" });
process.exit(0);
