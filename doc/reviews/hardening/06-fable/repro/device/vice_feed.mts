// A running program that does not consume keys: how long write_text holds the VICE monitor.
import { startViceMockServer } from "/home/claude/c64bridge/src/vice/mockServer.ts";
const mock: any = await startViceMockServer();
process.env.VICE_TEST_TARGET = "mock"; process.env.VICE_HOST = "127.0.0.1"; process.env.VICE_PORT = String(mock.port);
const { ViceBackend } = await import("/home/claude/c64bridge/src/device.ts");
const b = new ViceBackend({});
mock.memory[0xc6] = 3; // KERNAL queue not being consumed (keyboard scan off, as in many games)
const t0 = performance.now();
const feed = b.feedKeyboard(new Uint8Array(40).fill(0x41)).then((r: any) => ({ r, ms: Math.round(performance.now() - t0) }));
await new Promise((r) => setTimeout(r, 50));
const t1 = performance.now();
const read = b.readMemory(0x0400, 1).then(() => Math.round(performance.now() - t1));
const [f, readMs] = await Promise.all([feed, read]);
console.log(JSON.stringify({ bytes: 40, feedStatus: f.r.status, feedMs: f.ms, concurrentReadWaitedMs: readMs, projectedFor512Bytes: 512 * 150 }));
process.exit(0);
