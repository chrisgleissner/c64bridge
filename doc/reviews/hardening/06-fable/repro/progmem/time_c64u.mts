import { C64Client } from "/home/claude/c64bridge/src/c64Client.ts";
import { toolRegistry } from "/home/claude/c64bridge/src/tools/registry/index.ts";
// @ts-ignore
import { startMockC64Server } from "/home/claude/c64bridge/scripts/mockC64Server.mjs";

const mock = await startMockC64Server();
const client = new C64Client(mock.baseUrl);
// count HTTP requests
let reqs: string[] = [];
const http: any = (client as any).http;
const facade: any = await (client as any).facadePromise;
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = { id: "c64u", features: [], limitedFeatures: [] } as any;
const ctx: any = { client, logger, platform, setPlatform: () => platform, rag: {} };
const origLog = mock.state.requestLog;
async function time(name: string, tool: string, args: any) {
  const before = (mock.state.requests ?? []).length;
  const t0 = performance.now();
  const r = await toolRegistry.invoke(tool, args, ctx);
  const ms = performance.now() - t0;
  const text = JSON.stringify(r);
  console.log(`${name}: ${ms.toFixed(0)} ms, result ${text.length} chars, isError=${r.isError ?? false}`);
  return r;
}
const which = process.argv[2] ?? "all";
await time("read_screen", "c64_memory", { op: "read_screen" });
await time("read 16", "c64_memory", { op: "read", address: "$0400", length: 16 });
await time("read 4096", "c64_memory", { op: "read", address: "$0400", length: 4096 });
await time("wait_for_text READY", "c64_memory", { op: "wait_for_text", pattern: "READY." });
const b = await time("upload_run_basic", "c64_program", { op: "upload_run_basic", program: '10 PRINT "HI"' });
const bv = await time("upload_run_basic verify", "c64_program", { op: "upload_run_basic", program: '10 PRINT "HI"', verify: true });
const a = await time("upload_run_asm (rts)", "c64_program", { op: "upload_run_asm", program: "*=$C000\nlda #1\nsta $0400\nrts\n" });
const a2 = await time("upload_run_asm (jmp *)", "c64_program", { op: "upload_run_asm", program: "*=$C000\nloop: inc $d020\njmp loop\n" });
if (which === "dump") { console.log(JSON.stringify(b, null, 1)); console.log(JSON.stringify(a2, null, 1)); }
await mock.close();
process.exit(0);
