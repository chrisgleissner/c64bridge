import test from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import * as clientModule from "../src/c64Client.js";

const { C64Client } = clientModule;
const VIDEO_SESSION_MAX_PACKETS = clientModule.VIDEO_SESSION_MAX_PACKETS ?? 4096;

// HARD05-011: the reusable video capture session keeps only packets that frame assembly can still use.

function clientWithStubFacade() {
  const client = new C64Client("http://127.0.0.1:1");
  client.facadePromise = Promise.resolve({
    type: "c64u",
    async streamStart() { return { success: true }; },
    async streamStop() { return { success: true }; },
  });
  return client;
}

function videoPacket(frame, line, last) {
  const header = Buffer.alloc(12);
  header.writeUInt16LE(frame, 2);
  header.writeUInt16LE(line | (last ? 0x8000 : 0), 4);
  header.writeUInt16LE(384, 6);
  header.writeUInt8(4, 8);
  header.writeUInt8(4, 9);
  return Buffer.concat([header, Buffer.alloc(192 * 4)]);
}

const fromDevice = { address: "127.0.0.1", family: "IPv4", port: 11000, size: 0 };

// Packets of incomplete frames the session holds (HARD06 CLIENT-1 moved them into the frame assembler).
const retained = (session) => session.assembler?.retainedPackets ?? session.packets.length;

test("a long-open capture session holds a bounded number of packets and still assembles new frames", async () => {
  const client = clientWithStubFacade();
  try {
    await client.prepareVideoCapture({ keepAliveMs: 10_000 });
    const session = client.c64uVideoCaptureSession;
    const pending = client.collectFramesFromC64uVideoCaptureSession(session, 1, { fresh: true });
    // Frames that never complete (no last packet), far more than the bound.
    for (let index = 0; index < VIDEO_SESSION_MAX_PACKETS + 1000; index += 1) {
      session.socket.emit("message", videoPacket(index % 1000, (index % 60) * 4, false), fromDevice);
    }
    assert.ok(retained(session) <= VIDEO_SESSION_MAX_PACKETS, `retained ${retained(session)} packets`);
    for (let line = 0; line < 272; line += 4) {
      session.socket.emit("message", videoPacket(2000, line, line + 4 >= 272), fromDevice);
    }
    const frames = await pending;
    assert.equal(frames.length, 1);
    assert.equal(frames[0].frameNumber, 2000);
    assert.equal(frames[0].complete, true);
  } finally {
    await client.releaseVideoCapture();
  }
});

test("an idle capture session without waiters does not accumulate packets", async () => {
  const client = clientWithStubFacade();
  try {
    await client.prepareVideoCapture({ keepAliveMs: 10_000 });
    const session = client.c64uVideoCaptureSession;
    for (let index = 0; index < VIDEO_SESSION_MAX_PACKETS * 2; index += 1) {
      session.socket.emit("message", videoPacket(index % 1000, 0, false), fromDevice);
    }
    assert.ok(retained(session) <= VIDEO_SESSION_MAX_PACKETS, `retained ${retained(session)} packets`);
  } finally {
    await client.releaseVideoCapture();
  }
});
