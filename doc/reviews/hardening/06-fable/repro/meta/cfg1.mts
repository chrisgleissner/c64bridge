import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
mkdirSync("/tmp/h6/meta/cfg", { recursive: true });
process.chdir("/tmp/h6/meta/cfg");
const { tools } = await import("/home/claude/c64bridge/src/tools/meta/config.ts");
const t = tools[0]!;
let failB = true;
const writes: any[] = [];
const dev: any = { Audio: { Volume: 5 }, "Network Settings": { Hostname: "c64u", "Network Password": "pw" } };
const client: any = {
  version: async () => ({ version: "1" }),
  info: async () => ({ product: "x" }),
  configsList: async () => ({ categories: ["Audio", "Network Settings", "Flaky"] }),
  configGet: async (c: string) => { if (c === "Flaky" && failBFlag.v) throw new Error("timeout reading Flaky"); if (c==="Flaky") return {Flaky:{Item1: 1}}; return { [c]: dev[c] }; },
  configBatchUpdate: async (p: any) => { writes.push(JSON.parse(JSON.stringify(p))); if (p.Flaky && p.Flaky._error !== undefined) return { success:false, details:{ message: "unknown item _error"} }; return { success: true }; },
  configSaveToFlash: async () => ({ success: true }),
};
const failBFlag = { v: true };
const ctx: any = { client, logger: console, platform: { id: "c64u" } };
const snap = await t.execute({ action: "snapshot", path: "/tmp/h6/meta/cfg/snap.json" }, ctx);
console.log("snapshot result:", snap.isError, JSON.stringify((snap as any).structuredContent?.data));
console.log("snapshot Flaky entry:", JSON.stringify(JSON.parse(readFileSync("/tmp/h6/meta/cfg/snap.json","utf8")).categories.Flaky));
failBFlag.v = false;
const r = await t.execute({ action: "restore", path: "/tmp/h6/meta/cfg/snap.json" }, ctx);
console.log("restore:", r.isError, JSON.stringify((r as any).structuredContent?.data ?? r.content).slice(0,400));
console.log("writes:", JSON.stringify(writes));
// diff: how much does it print for one changed item?
dev.Audio.Volume = 7;
const d = await t.execute({ action: "diff", path: "/tmp/h6/meta/cfg/snap.json" }, ctx);
console.log("diff:", JSON.stringify((d as any).structuredContent?.data));
