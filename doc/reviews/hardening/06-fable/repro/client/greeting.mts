import { C64Client } from "/home/claude/c64bridge/src/c64Client.ts";
import { screenCodesToAscii } from "/home/claude/c64bridge/src/petscii.ts";
const writes: Array<{address:number;bytes:Uint8Array}> = [];
const facade = { type: "c64u", readMemory: async () => Uint8Array.of(0x97), writeMemoryBlocks: async (b: any) => { writes.push(...b); } };
const client: any = Object.create(C64Client.prototype);
client.facadePromise = Promise.resolve(facade);
client.greetingDd00Cache = new Map(); client.greetingDd00Warmups = new Map();
for (const message of ["HELLO (C64U) #1 + 2 = 3 @HOME", "A".repeat(38) + " {PLATFORM} C64U"]) {
  writes.length = 0;
  const r = await client.renderGreetingScreen({ message });
  const screen = writes.find((w) => w.address === 0x0400)!.bytes;
  const row1 = screenCodesToAscii(screen.subarray(40, 80), { columns: 40, rows: 1 });
  console.log(JSON.stringify({ success: r.success, message, row1: row1.trimEnd() }));
}
