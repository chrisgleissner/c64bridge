import { toolRegistry } from "/home/claude/c64bridge/src/tools/registry/index.ts";
const client: any = { getAvailableBackends: () => ["c64u", "vice"], switchBackend() {} };
const ctx: any = { client, logger: { debug() {}, info() {}, warn() {}, error() {} }, rag: {}, platform: { id: "c64u", features: [], limitedFeatures: [] }, setPlatform: () => ({}) };
const r: any = await toolRegistry.invoke("c64_select_backend", { op: "select", backend: "vice" }, ctx);
const s = JSON.stringify(r);
const d = r.structuredContent?.data ?? JSON.parse(r.content[0].text);
console.log(JSON.stringify({ bytes: s.length, textBytes: r.content.map((c: any) => c.text.length), unavailableOperations: d.unavailableOperations?.length, availableTools: d.availableTools?.length }));
process.exit(0);
