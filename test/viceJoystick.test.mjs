import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";
import { ViceBackend } from "../src/device.js";
import { startViceMockServer } from "../src/vice/mockServer.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

test("VICE drive operations use Drive<n>Type, drive CPU resets and autostart on the mock", async (t) => {
  const server = await startViceMockServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await server.stop(); });
  const backend = new ViceBackend({ host: "127.0.0.1", port: server.port });
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-vice-drive-"));
  t.after(() => fs.rmSync(imageDir, { recursive: true, force: true }));
  const image = path.join(imageDir, "demo.d64");
  fs.writeFileSync(image, Buffer.alloc(174848));

  // Drive 8 is a 1571 before it is switched off, so switching it on must restore 1571, not the 1541 fallback.
  assert.equal((await backend.driveSetMode("drive8", "1571")).success, true);
  assert.equal((await backend.driveOff("drive8")).details.power, "off");
  assert.equal((await backend.drivesList())[0].power, "off");
  // Mount switches drive 8 back on with its previous type and attaches through autoload.
  const mounted = await backend.driveMount("drive8", image);
  assert.equal(mounted.success, true);
  assert.match(mounted.details.note, /resets the machine/);
  assert.deepEqual(server.autostarts, [{ run: false, fileIndex: 0, filename: image }]);
  assert.deepEqual((await backend.drivesList())[0], { id: "drive8", power: "on", image, type: 1571 });

  assert.equal((await backend.driveReset("drive9")).success, true);
  assert.deepEqual(server.driveResets, [9]);
  assert.equal((await backend.driveSetMode("drive8", "1581")).success, true);
  assert.equal((await backend.drivesList())[0].type, 1581);
});

test("VICE joystick press re-attaches the device when VICE no longer has it (for example after a restart)", async (t) => {
  const { client } = await createViceClient(t);
  await client.viceJoystickPress(2, 0xfe);
  // A restarted VICE (or a manual change) puts the default joystick device back.
  await client.viceResourceSet("JoyPort2Device", 1);
  assert.equal((await client.viceMemGet(0xdc00, 1))[0], 0xff);

  await client.viceJoystickPress(2, 0xfe);
  assert.equal((await client.viceMemGet(0xdc00, 1))[0], 0x1e);
  await client.viceJoystickRelease(2);
  assert.deepEqual(await client.viceResourceGet("JoyPort2Device"), { type: "int", value: 1 });
});
