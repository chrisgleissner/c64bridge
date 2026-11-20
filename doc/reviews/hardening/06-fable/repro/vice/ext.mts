import { startViceMockServer } from "/home/claude/c64bridge/src/vice/mockServer.ts";
import { ViceBackend } from "/home/claude/c64bridge/src/device.ts";
const mock = await startViceMockServer();
process.env.VICE_TEST_TARGET="mock";
const b = new ViceBackend({ host: "127.0.0.1", port: mock.port } as any);
for (let i = 0; i < 3; i++) {
  const before = mock.connectionsOpened; const bc = mock.commands.length;
  const t = Date.now();
  await b.readMemory(0x0400, 4);
  console.log(`readMemory #${i}: connections=${mock.connectionsOpened - before} cmds=${JSON.stringify(mock.commands.slice(bc))} ms=${Date.now()-t}`);
}
await mock.stop();
process.exit(0);
