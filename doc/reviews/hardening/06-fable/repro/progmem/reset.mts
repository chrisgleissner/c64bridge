import { C64Client } from "/home/claude/c64bridge/src/c64Client.ts";
import { toolRegistry } from "/home/claude/c64bridge/src/tools/registry/index.ts";
// @ts-ignore
import { startMockC64Server } from "/home/claude/c64bridge/scripts/mockC64Server.mjs";
const mock = await startMockC64Server();
const client = new C64Client(mock.baseUrl);
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = { id: "c64u", features: [], limitedFeatures: [] } as any;
const ctx: any = { client, logger, platform, setPlatform: () => platform, rag: {} };
for (let i = 0; i < 2; i++) {
  const t0 = performance.now();
  const r: any = await toolRegistry.invoke("c64_system", { op: "reset", waitForReady: true }, ctx);
  console.log(`reset waitForReady #${i + 1}: ${(performance.now() - t0).toFixed(0)}ms: ${r.content[0].text}`);
}
await mock.close(); process.exit(0);
