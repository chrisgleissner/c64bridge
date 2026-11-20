import { C64Client } from "/home/claude/c64bridge/src/c64Client.ts";
// One REST request at a time (as RequestQueue does), each taking 5 ms; the KERNAL consumes the queue every 2 ms.
const mem = new Uint8Array(65536); const typed: number[] = [];
setInterval(() => { if (mem[0xc6] > 0) { typed.push(mem[0x277]); mem.copyWithin(0x277, 0x278, 0x281); mem[0xc6]--; } }, 2).unref();
let chain = Promise.resolve();
const serial = <T,>(fn: () => T) => { const p = chain.then(() => new Promise<T>((r) => setTimeout(() => r(fn()), 5))); chain = p.then(() => {}, () => {}); return p; };
const c64u = { type: "c64u",
  readMemory: (a: number, n: number) => serial(() => mem.slice(a, a + n)),
  writeMemory: (a: number, b: Uint8Array) => serial(() => { mem.set(b, a); }) };
const client: any = Object.create(C64Client.prototype);
client.facadePromise = Promise.resolve(c64u);
const [a, b] = await Promise.all([
  client.injectKeyboardQueue(Buffer.from("PRINT 1\r")),
  client.injectKeyboardQueue(Buffer.from("LIST\r")),
]);
await new Promise((r) => setTimeout(r, 100));
console.log(JSON.stringify({ a, b, typed: Buffer.from(typed).toString("latin1") }));
process.exit(0);
