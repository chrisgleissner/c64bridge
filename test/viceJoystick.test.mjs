import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";
import { ViceBackend } from "../src/device.js";
import { startViceMockServer } from "../src/vice/mockServer.js";

// VICE Binary Monitor command 0xA2 drives only the "I/O simulation" joyport
// device (id 37). The mock server models that device and CIA1's view of it at
// $DC00 (port 2) and $DC01 (port 1), following joyport_io_sim.c in VICE 3.10.

async function createViceClient(t) {
  const server = await startViceMockServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await server.stop(); });
  const client = new C64Client("http://127.0.0.1:1");
  Reflect.set(client, "facadePromise", Promise.resolve(new ViceBackend({ host: "127.0.0.1", port: server.port })));
  return { client, server };
}

test("VICE joystick press attaches the I/O simulation device and release restores the previous device", async (t) => {
  const { client, server } = await createViceClient(t);

  // Without the I/O simulation device, a bare 0xA2 write does not reach the CIA.
  await client.viceJoyportSet(2, 0xfe);
  assert.equal((await client.viceMemGet(0xdc00, 1))[0], 0xff);

  await client.viceJoystickPress(2, 0xfe); // up
  assert.equal(server.joyportLines(2), 0x1e);
  assert.equal((await client.viceMemGet(0xdc00, 1))[0], 0x1e);

  await client.viceJoystickPress(2, 0xee); // up + fire, while still pressed
  assert.equal((await client.viceMemGet(0xdc00, 1))[0], 0x0e);

  await client.viceJoystickRelease(2);
  // The joystick device (id 1) is back, so the port reads as idle again.
  assert.equal((await client.viceMemGet(0xdc00, 1))[0], 0xff);
  assert.equal(server.joyportLines(2), 0xff);

  await client.viceJoystickPress(1, 0xf7); // right on port 1 reads at $DC01
  assert.equal((await client.viceMemGet(0xdc01, 1))[0], 0x17);
  await client.viceJoystickRelease(1);
  assert.equal((await client.viceMemGet(0xdc01, 1))[0], 0xff);
});

test("VICE mock rejects a memory read whose start is past its end, as VICE does", async (t) => {
  const { client } = await createViceClient(t);
  await assert.rejects(() => client.viceMemGet(0xfff0, 0x20));
});
