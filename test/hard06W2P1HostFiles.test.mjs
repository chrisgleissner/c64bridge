import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { C64Client } from "../src/c64Client.js";
import { programRunnersModule } from "../src/tools/programRunners.js";
import { storageModule, diskImageTypeFromPath } from "../src/tools/storage.js";
import { startMockC64Server } from "../scripts/mockC64Server.mjs";

// Wave 2 P1: host files for run_crt and disk mount (DEVICE-6), .include/.incbin through the allowed
// host roots, assembler warnings and replaced BASIC lines in results, SID cancel in run_prg/load_prg.

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = (id) => ({ id, features: [], limitedFeatures: [] });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "h6w2p1-"));

test("DEVICE-6 run_crt with location host uploads the file to the Ultimate", async () => {
  const mock = await startMockC64Server();
  const dir = tmp();
  try {
    const crt = Buffer.concat([Buffer.from("C64 CARTRIDGE   ", "latin1"), Buffer.from([0, 1, 2, 3, 0xff])]);
    const file = path.join(dir, "game.crt");
    fs.writeFileSync(file, crt);
    const client = new C64Client(mock.baseUrl);
    const result = await programRunnersModule.invoke("run_crt", { path: file, location: "host" }, { client, logger, platform: platform("c64u") });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(result.structuredContent.data.location, "host");
    assert.match(result.content[0].text, /^CRT .* \(21 bytes uploaded from the host\) started\./);
    assert.equal(mock.state.lastCrt.name, "upload.crt");
    assert.deepEqual([...mock.state.lastCrt.crt], [...crt]);
    // Without location the path is sent to the device as before.
    const device = await programRunnersModule.invoke("run_crt", { path: "//USB0/game.crt" }, { client, logger, platform: platform("c64u") });
    assert.equal(device.structuredContent.data.location, "device");
    assert.equal(mock.state.lastCrtFile, "//USB0/game.crt");
    // A host path outside the allowed roots is rejected before anything is sent.
    const before = mock.state.crtCount;
    const denied = await programRunnersModule.invoke("run_crt", { path: "/etc/hostname", location: "host" }, { client, logger, platform: platform("c64u") });
    assert.equal(denied.isError, true);
    assert.equal(mock.state.crtCount, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test("DEVICE-6 drive mount with location host uploads the image and takes the type from the extension", async () => {
  const mock = await startMockC64Server();
  const dir = tmp();
  try {
    const image = Buffer.alloc(174848, 0x01);
    const file = path.join(dir, "Demo.D64");
    fs.writeFileSync(file, image);
    const client = new C64Client(mock.baseUrl);
    const result = await storageModule.invoke("drive_mount", { drive: "a", image: file, location: "host", mode: "readonly" }, { client, logger, platform: platform("c64u") });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.equal(mock.state.lastMountUpload.name, "upload.d64");
    assert.equal(mock.state.lastMountUpload.type, "d64");
    assert.equal(mock.state.lastMountUpload.mode, "readonly");
    assert.equal(mock.state.lastMountUpload.bytes, 174848);
    assert.match(result.content[0].text, /174848 bytes uploaded from the host/);

    const unknown = path.join(dir, "disk.img");
    fs.writeFileSync(unknown, image);
    const bad = await storageModule.invoke("drive_mount", { drive: "a", image: unknown, location: "host" }, { client, logger, platform: platform("c64u") });
    assert.equal(bad.isError, true);
    const typed = await storageModule.invoke("drive_mount", { drive: "a", image: unknown, location: "host", type: "d81" }, { client, logger, platform: platform("c64u") });
    assert.equal(typed.isError, undefined, JSON.stringify(typed.content));
    assert.equal(mock.state.lastMountUpload.name, "upload.d81");
    assert.equal(diskImageTypeFromPath("x.G71"), "g71");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});