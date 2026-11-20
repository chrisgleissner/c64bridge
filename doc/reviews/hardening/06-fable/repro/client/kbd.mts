import { C64Client, KeyboardQueueDrainTimeoutError } from "/home/claude/c64bridge/src/c64Client.ts";
// Generic (C64U) path: a memory model where the KERNAL consumes the queue only while `running`.
const mem = new Uint8Array(65536); let running = false; const typed: number[] = [];
setInterval(() => { if (running && mem[0xc6] > 0) { typed.push(mem[0x277]); mem.copyWithin(0x277, 0x278, 0x281); mem[0xc6]--; } }, 2).unref();
const c64u = { type: "c64u",
  readMemory: async (a: number, n: number) => mem.slice(a, a + n),
  writeMemory: async (a: number, b: Uint8Array) => { mem.set(b, a); } };
const client: any = Object.create(C64Client.prototype);
client.facadePromise = Promise.resolve(c64u);
const text = Buffer.from("LOAD\"GAME\",8,1\r", "ascii"); // 15 bytes
try { await client.injectKeyboardQueue(text, { drainTimeoutMs: 100 }); }
catch (e) { console.log("1st call:", (e as Error).message); const d = (e as KeyboardQueueDrainTimeoutError).delivered;
  running = true;                       // machine resumes; client retries "the remaining input" as told
  await client.injectKeyboardQueue(text.subarray(d), { drainTimeoutMs: 500 });
  await new Promise((r) => setTimeout(r, 100));
  console.log("typed on C64:", JSON.stringify(Buffer.from(typed).toString("latin1")), "expected:", JSON.stringify(text.toString("latin1")));
}
// VICE path: the device waits max(2000, n*150) ms but the error names the client default.
const vice = { type: "vice", feedKeyboard: async (b: Uint8Array) => ({ delivered: b.length, status: "timeout", pending: 7 }) };
client.facadePromise = Promise.resolve(vice);
try { await client.injectKeyboardQueue(Buffer.alloc(40, 0x41)); } catch (e) { console.log("VICE 40 bytes:", (e as Error).message, "(device timeout would be", Math.max(2000, 40 * 150), "ms)"); }
process.exit(0);
