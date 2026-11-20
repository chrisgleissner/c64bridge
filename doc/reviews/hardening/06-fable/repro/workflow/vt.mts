import { startViceMockServer } from "/home/claude/c64bridge/src/vice/mockServer.ts";
import { ViceClient } from "/home/claude/c64bridge/src/vice/viceClient.ts";
const vm = await startViceMockServer({ host: "127.0.0.1" });
for (let i = 0; i < 3; i++) {
  const t0 = performance.now();
  const c = new ViceClient(); await c.connect(vm.port, "127.0.0.1");
  const t1 = performance.now();
  await c.memGet(0xc000, 0xc001);
  const t2 = performance.now();
  await c.memGet(0xc000, 0xc001);
  const t3 = performance.now();
  await c.exitMonitor();
  const t4 = performance.now();
  c.close();
  console.log({ connect: (t1-t0).toFixed(1), memGet1: (t2-t1).toFixed(1), memGet2: (t3-t2).toFixed(1), exit: (t4-t3).toFixed(1) });
}
await vm.stop(); process.exit(0);
