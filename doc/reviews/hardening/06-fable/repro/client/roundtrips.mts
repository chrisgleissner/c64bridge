import { C64Client } from "/home/claude/c64bridge/src/c64Client.ts";
const counts = { read: 0, write: 0, blocks: 0 };
const mem = new Uint8Array(65536);
const facade: any = { type: "c64u",
  readMemory: async (a: number, n: number) => { counts.read++; return mem.slice(a, a + n); },
  writeMemory: async (a: number, b: Uint8Array) => { counts.write++; mem.set(b, a); },
  writeMemoryBlocks: async (b: any[]) => { counts.blocks++; } };
const client: any = Object.create(C64Client.prototype);
client.facadePromise = Promise.resolve(facade);
const reset = () => { counts.read = counts.write = counts.blocks = 0; };
const run = async (name: string, fn: () => Promise<unknown>) => { reset(); const r: any = await fn(); console.log(name, JSON.stringify({ ...counts, success: r?.success })); };
await run("displaySprite", () => client.displaySprite({ spriteBytes: new Uint8Array(63) }));
await run("displayBitmap", () => client.displayBitmap({ mode: "hires", bitmapData: new Uint8Array(8000), screenRam: new Uint8Array(1000), colorRam: new Uint8Array(1000), backgroundColor: 0, borderColor: 0 }));
mem[0x0314] = 0x31; mem[0x0315] = 0xea;
await run("sidReset(soft)", () => client.sidReset(false));
mem[0x0314] = 0x00; mem[0x0315] = 0xc0;
await run("sidReset(soft, non-KERNAL IRQ)", () => client.sidReset(false));
await run("readScreenDetailed", () => client.readScreenDetailed().then(() => ({ success: true })));
