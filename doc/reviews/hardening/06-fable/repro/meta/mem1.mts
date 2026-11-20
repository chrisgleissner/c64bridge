import { mkdirSync } from "node:fs";
mkdirSync("/tmp/h6/meta/m", { recursive: true }); process.chdir("/tmp/h6/meta/m");
const m = (await import("/home/claude/c64bridge/src/tools/meta/memory.ts")).tools;
const M = Object.fromEntries(m.map(t => [t.name, t]));
let reads = 0;
const client: any = { pinFacade: async () => ({}), acquirePause: async () => ({ success: true }), releasePause: async () => ({ success: true }),
  readMemory: async (a: string, l: string) => { reads++; return { success: true, data: "$" + "00".repeat(Number(l)) }; } };
const r = await M.memory_dump_to_file.execute({ address: "$0000", length: 65536, outputPath: "/tmp/h6/meta/m/d.hex" }, { client, logger: { warn(){} }, platform: { id: "c64u" } } as any);
console.log("64 KiB dump default: reads =", reads, r.isError);
reads = 0;
const r2 = await M.memory_dump_to_file.execute({ address: "$0000", length: 65536, outputPath: "/tmp/h6/meta/m/d2.hex", chunkSize: 4096 }, { client, logger: { warn(){} }, platform: { id: "c64u" } } as any);
console.log("chunkSize 4096: reads =", reads);
