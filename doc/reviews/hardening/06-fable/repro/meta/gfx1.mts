const g = (await import("/home/claude/c64bridge/src/tools/meta/graphics.ts")).tools;
const G = Object.fromEntries(g.map(t => [t.name, t]));
const mem = Buffer.alloc(65536);
for (let s = 0; s < 16; s++) for (let i = 0; i < 63; i++) mem[0x2000 + s*64 + i] = (i*37 + s) & 0xFF || 1;
const client: any = { pinFacade: async () => ({}), acquirePause: async () => ({ success: true }), releasePause: async () => ({ success: true }),
  readMemory: async (a: string, l: string) => { const addr = parseInt(a.slice(1), 16), len = Number(l); return { success: true, data: "$" + mem.subarray(addr, addr+len).toString("hex").toUpperCase() }; } };
const ctx: any = { client, logger: { warn(){}, info(){}, debug(){} }, platform: { id: "c64u" } };
const r = await G.extract_sprites_from_ram.execute({ address: "$2000", length: 1024 }, ctx);
const text = (r.content[0] as any).text; 
console.log("16 sprites -> response chars:", text.length, "per sprite:", Math.round(text.length/16));
const r2 = await G.extract_sprites_from_ram.execute({ address: "$2000", length: 1024, includeBase64: false }, ctx);
console.log("without base64:", (r2.content[0] as any).text.length);
// unaligned start
const r3 = await G.extract_sprites_from_ram.execute({ address: "$2010", length: 1024 }, ctx);
console.log("unaligned $2010 sprites found:", JSON.parse((r3.content[0] as any).text).sprites.map((s:any)=>s.address).slice(0,3), "(real sprite blocks are at $2000,$2040,...)");
// full charset scan round trips
let reads = 0; const c2: any = { ...client, readMemory: async (...a: any[]) => { reads++; return (client as any).readMemory(...a); } };
await G.rip_charset_from_ram.execute({ scanRange: "full" }, { ...ctx, client: c2 });
console.log("charset full scan reads:", reads);
