import { startViceMockServer } from "/home/claude/c64bridge/src/vice/mockServer.ts";
import { ViceClient } from "/home/claude/c64bridge/src/vice/viceClient.ts";
const mock = await startViceMockServer();
const c = new ViceClient(); await c.connect(mock.port);
await c.resourceSet("SoundVolume", 4294967296 + 50);
console.log("set 2^32+50 ->", await c.resourceGet("SoundVolume"));
await c.resourceSet("SoundVolume", "77");
console.log("string '77' on int resource ->", await c.resourceGet("SoundVolume"));
try { await c.checkpointGet(999);} catch(e:any){ console.log("get unknown cp:", e.message); }
await c.checkpointDelete(999); console.log("delete unknown cp: ok (no error)");
await c.memSet(0xffff, Buffer.alloc(10,0xaa)); console.log("memSet 0xFFFF x10: ok; mem[0xffff]=", (await c.memGet(0xffff,0xffff))[0]);
c.close(); await mock.stop();
