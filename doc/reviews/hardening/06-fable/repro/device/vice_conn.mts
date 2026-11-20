// Counts monitor TCP connections per backend operation when VICE runs on localhost but was not started by this server.
import net from "node:net";
import { startViceMockServer } from "/home/claude/c64bridge/src/vice/mockServer.ts";

const mock = await startViceMockServer();
let connections = 0;
const proxy = net.createServer((client) => {
  connections += 1;
  const upstream = net.connect({ host: "127.0.0.1", port: mock.port });
  client.pipe(upstream).pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
const port = (proxy.address() as net.AddressInfo).port;

delete process.env.VICE_TEST_TARGET;
process.env.VICE_HOST = "127.0.0.1";
process.env.VICE_PORT = String(port);
process.env.VICE_BINARY = "/bin/false"; // never start a real emulator

const { ViceBackend } = await import("/home/claude/c64bridge/src/device.ts");
const backend = new ViceBackend({});
const ops = 10;
const t0 = performance.now();
for (let i = 0; i < ops; i++) await backend.readMemory(0x0400, 16);
const ms = performance.now() - t0;
console.log(JSON.stringify({ ops, connections, perOp: connections / ops, totalMs: Math.round(ms) }));
proxy.close();
await mock.stop?.();
process.exit(0);
