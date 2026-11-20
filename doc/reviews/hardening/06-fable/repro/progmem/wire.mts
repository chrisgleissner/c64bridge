import { C64Client } from "/home/claude/c64bridge/src/c64Client.ts";
import { toolRegistry } from "/home/claude/c64bridge/src/tools/registry/index.ts";
import { toCallToolResult } from "/home/claude/c64bridge/src/mcp/callToolResult.ts";
// @ts-ignore
import { startMockC64Server } from "/home/claude/c64bridge/scripts/mockC64Server.mjs";
const mock = await startMockC64Server();
const client = new C64Client(mock.baseUrl);
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = { id: "c64u", features: [], limitedFeatures: [] } as any;
const ctx: any = { client, logger, platform, setPlatform: () => platform, rag: {} };
// fill screen with text so read_screen is realistic
const line = "THE QUICK BROWN FOX JUMPS OVER THE LAZY ";
await client.writeMemoryRaw(0x0400, Uint8Array.from(Buffer.from(line.repeat(25)).map((c) => c === 32 ? 32 : c >= 65 && c <= 90 ? c - 64 : c)));
for (const args of [{ op: "read", address: "$C000", length: 4096 }, { op: "read", address: "$C000", length: 4096, format: "dump" }, { op: "read", address: "$C000", length: 16 }, { op: "read_screen" }]) {
  const w = toCallToolResult(await toolRegistry.invoke("c64_memory", args, ctx));
  const textLen = w.content.map((c: any) => c.text?.length ?? 0).reduce((a: number, b: number) => a + b, 0);
  console.log(JSON.stringify(args), "wire", JSON.stringify(w).length, "content.text", textLen, "structured", JSON.stringify(w.structuredContent ?? null).length, "metadata", JSON.stringify(w.metadata ?? null).length);
}
await mock.close(); process.exit(0);
