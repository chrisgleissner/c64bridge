import fs from "node:fs";
import { startViceMockServer } from "/home/claude/c64bridge/src/vice/mockServer.ts";
import { basicToPrg } from "/home/claude/c64bridge/src/tools/translation/basicTokenizer.ts";
process.env.VICE_TEST_TARGET = "mock";
const vice: any = await startViceMockServer({ host: "127.0.0.1", port: 0 });
fs.writeFileSync("/tmp/h6/progmem/vicecfg5.json", JSON.stringify({ vice: { host: "127.0.0.1", port: vice.port } }));
process.env.C64BRIDGE_CONFIG = "/tmp/h6/progmem/vicecfg5.json"; process.env.C64_MODE = "vice";
fs.writeFileSync("/tmp/h6/progmem/prog.prg", basicToPrg('10 A=1\n20 PRINT "HELLO";A\n30 GOTO 20'));
const { C64Client } = await import("/home/claude/c64bridge/src/c64Client.ts");
const { toolRegistry } = await import("/home/claude/c64bridge/src/tools/registry/index.ts");
const client = new C64Client("http://unused.local", { forceC64uFacade: false });
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = { id: "vice", features: [], limitedFeatures: [] } as any;
const ctx: any = { client, logger, platform, setPlatform: () => platform, rag: {} };
async function call(tool: string, args: any) {
  const r: any = await toolRegistry.invoke(tool, args, ctx);
  console.log(`--- ${JSON.stringify(args).slice(0, 90)} err=${r.isError ?? false}\n   ${String(r.content?.[0]?.text).slice(0, 400)}`);
}
await call("c64_program", { op: "upload_run_asm", program: "*=$C000\nmain: inc $d020\n jmp main\n" });
await call("c64_memory", { op: "write", address: "$C100", bytes: "AA" });
await call("c64_program", { op: "load_prg", path: "/tmp/h6/progmem/prog.prg" });
await call("c64_memory", { op: "read", address: "$C100", length: 1 });
await call("c64_memory", { op: "read", address: "$002B", length: 4 });
await call("c64_memory", { op: "list_basic" });
await call("c64_memory", { op: "disassemble", address: "main", instructionCount: 1 });
process.exit(0);
