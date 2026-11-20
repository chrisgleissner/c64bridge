import { startViceMockServer } from "/home/claude/c64bridge/src/vice/mockServer.ts";
import { ViceClient } from "/home/claude/c64bridge/src/vice/viceClient.ts";
const mock = await startViceMockServer();
for (let i=0;i<3;i++){
const c = new ViceClient();
let t=process.hrtime.bigint(); const lap=(l:string)=>{const n=process.hrtime.bigint();console.log(l,Number(n-t)/1e6);t=n;};
await c.connect(mock.port); lap("connect");
await c.memGet(0x400,0x403); lap("memGet");
await c.exitMonitor(); lap("exit");
c.close(); lap("close");
}
await mock.stop();
