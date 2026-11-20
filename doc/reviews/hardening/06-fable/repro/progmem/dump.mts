import { C64Client } from "/home/claude/c64bridge/src/c64Client.ts";
import { toolRegistry } from "/home/claude/c64bridge/src/tools/registry/index.ts";
// @ts-ignore
import { startMockC64Server } from "/home/claude/c64bridge/scripts/mockC64Server.mjs";
const mock = await startMockC64Server();
const client = new C64Client(mock.baseUrl);
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = { id: "c64u", features: [], limitedFeatures: [] } as any;
const ctx: any = { client, logger, platform, setPlatform: () => platform, rag: {} };
const calls = JSON.parse(process.argv[2]);
for (const [tool, args] of calls) {
  const r = await toolRegistry.invoke(tool, args, ctx);
  console.log("=== " + JSON.stringify(args));
  console.log(JSON.stringify(r, null, 1).slice(0, Number(process.env.MAXC ?? 4000)));
}
await mock.close(); process.exit(0);
