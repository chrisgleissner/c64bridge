import { startViceMockServer } from "/home/claude/c64bridge/src/vice/mockServer.ts";
import { ViceBackend } from "/home/claude/c64bridge/src/device.ts";
process.env.VICE_TEST_TARGET="mock";
const mock = await startViceMockServer();
const b = new ViceBackend({ host: "127.0.0.1", port: mock.port } as any);
const prg = Buffer.from([0x00,0xc0, 0xa9,0x01,0x8d,0x20,0xd0,0x60]); // code at $C000
await b.runPrg(prg);
const p = await b.readMemory(0x2b, 8);
console.log("ptrs", Buffer.from(p).toString("hex"), "keyboard feeds", mock.keyboardFeeds.map(x=>x.toString("latin1")));
await mock.stop(); process.exit(0);
