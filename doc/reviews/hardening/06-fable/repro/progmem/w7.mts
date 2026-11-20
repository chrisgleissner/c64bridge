import { C64Client } from "/home/claude/wt/C/src/c64Client.ts";
import { toolRegistry } from "/home/claude/wt/C/src/tools/registry/index.ts";
// @ts-ignore
import { startMockC64Server } from "/home/claude/wt/C/scripts/mockC64Server.mjs";
const mock = await startMockC64Server();
const client = new C64Client(mock.baseUrl);
const platform = { id: "c64u", features: [], limitedFeatures: [] } as any;
const ctx: any = { client, logger: { debug() {}, info() {}, warn() {}, error() {} }, platform, setPlatform: () => platform, rag: {} };
for (const op of ["run_prg", "load_prg"]) {
  const r: any = await toolRegistry.invoke("c64_program", { op, path: "/tmp/h6/progmem/host.prg" }, ctx);
  console.log(op, r.isError, r.content[0].text.slice(0, 400));
}
await mock.close(); process.exit(0);
