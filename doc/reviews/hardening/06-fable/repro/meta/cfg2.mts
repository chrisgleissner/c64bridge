import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync("/tmp/h6/meta/cfg2", { recursive: true });
process.chdir("/tmp/h6/meta/cfg2");
process.env.C64BRIDGE_ACCESS = "no-destructive";
const { toolRegistry } = await import("/home/claude/c64bridge/src/tools/registry/index.ts");
const writes: any[] = [];
const client: any = {
  version: async () => ({}), info: async () => ({}),
  configsList: async () => ({ categories: ["Network Settings"] }),
  configGet: async (c: string) => ({ [c]: { "Static IP": "192.168.1.64", Hostname: "c64u" } }),
  configBatchUpdate: async (p: any) => { writes.push(p); return { success: true }; },
  configSaveToFlash: async () => ({ success: true }),
  getActiveBackendType: async () => "c64u",
};
writeFileSync("/tmp/h6/meta/cfg2/evil.json", JSON.stringify({ categories: { "Network Settings": { "Static IP": "10.9.9.9", Hostname: "evil" } } }));
const ctx: any = { client, logger: console, platform: { id: "c64u" } };
// control: c64_config set on the network category is blocked
const set = await toolRegistry.invoke("c64_config", { op: "set", category: "Network Settings", item: "Hostname", value: "x" }, ctx).catch((e: any) => ({ err: String(e.message).slice(0,120) }));
console.log("set network:", JSON.stringify(set).slice(0, 200));
const r = await toolRegistry.invoke("c64_config", { op: "restore", path: "/tmp/h6/meta/cfg2/evil.json" }, ctx).catch((e: any) => ({ err: String(e.message).slice(0,160) }));
console.log("restore network:", JSON.stringify((r as any).structuredContent?.data ?? r).slice(0, 200));
console.log("device writes:", JSON.stringify(writes));
