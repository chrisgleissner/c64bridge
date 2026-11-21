import test from "#test/runner";
import assert from "#test/assert";
import { audioModule } from "../src/tools/audio.js";
import { C64Client } from "../src/c64Client.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = (id) => ({ id, features: [], limitedFeatures: [] });

test("HIL F2b note_on reports restoring muted master volume", async () => {
  const writes = [];
  const facade = {
    type: "c64u",
    async readMemory(address, length) { return Uint8Array.from({ length }, (_, i) => address + i === 0x02a6 ? 1 : 0); },
    async writeMemory(address, bytes) { writes.push({ address, bytes: Uint8Array.from(bytes) }); },
  };
  const client = Object.create(C64Client.prototype);
  client.facadePromise = Promise.resolve(facade);
  client.sidControl = new WeakMap();
  client.sidVolume = new WeakMap();
  client.sidwaveSessions = new Map();
  client.sidwaveQueue = new WeakMap();
  client.pendingSidwave = 0;
  const result = await audioModule.invoke("sid_note_on", { voice: 1, note: "A4" }, {
    client, logger, platform: platform("c64u"),
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /volume was set to 15/i);
  assert.equal(result.structuredContent.data.details.volumeSet, 15);
  const volumeWrite = writes.find(({ address }) => address === 0xd418);
  assert.equal(volumeWrite?.bytes[0], 15);
  await client.sidSetVolume(8, facade);
  const next = await client.sidNoteOn({ voice: 1, note: "A4", system: "PAL" });
  assert.equal(next.details, undefined);
  assert.equal(writes.filter(({ address }) => address === 0xd418).length, 2);
});
