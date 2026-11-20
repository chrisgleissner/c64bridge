import test from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import { createSocket } from "node:dgram";
import { C64Client } from "../src/c64Client.js";
import { collectCompleteVideoFrames, parseVideoPacket, VideoFrameAssembler } from "../src/streamCapture.js";

// HARD06 CLIENT-1: frames are assembled as packets arrive, so the cost per packet does not grow
// with the packets already received. DEVICE-8: a frame is complete only when every line below the
// height announced by its last packet arrived; lines beyond it do not count.

function videoPacket(frame, line, last) {
  const header = Buffer.alloc(12);
  header.writeUInt16LE(frame & 0xffff, 2);
  header.writeUInt16LE(line | (last ? 0x8000 : 0), 4);
  header.writeUInt16LE(384, 6);
  header.writeUInt8(4, 8);
  header.writeUInt8(4, 9);
  return Buffer.concat([header, Buffer.alloc(192 * 4, frame & 0xff)]);
}

function framePackets(frame) {
  const packets = [];
  for (let line = 0; line < 272; line += 4) packets.push(videoPacket(frame, line, line === 268));
  return packets;
}

const fromDevice = { address: "127.0.0.1", family: "IPv4", port: 11000, size: 0 };

test("a reusable session assembles 32 frames from 33 frames of packets quickly", async () => {
  const client = new C64Client("http://127.0.0.1:1");
  client.facadePromise = Promise.resolve({
    type: "c64u",
    async streamStart() { return { success: true }; },
    async streamStop() { return { success: true }; },
  });
  try {
    await client.prepareVideoCapture({ keepAliveMs: 10_000 });
    const session = client.c64uVideoCaptureSession;
    const pending = client.collectFramesFromC64uVideoCaptureSession(session, 32, { fresh: true });
    const started = performance.now();
    for (let frame = 0; frame < 33; frame += 1) {
      for (const packet of framePackets(frame)) session.socket.emit("message", packet, fromDevice);
    }
    const frames = await pending;
    const elapsed = performance.now() - started;
    assert.equal(frames.length, 32);
    assert.deepEqual(frames.map((frame) => frame.frameNumber), Array.from({ length: 32 }, (_, index) => index));
    assert.ok(frames.every((frame) => frame.complete && frame.width === 384 && frame.height === 272));
    assert.ok(elapsed < 1_000, `assembly took ${Math.round(elapsed)} ms`);
  } finally {
    await client.releaseVideoCapture();
  }
});

test("a one-shot capture of 8 frames keeps up with a stream sent at the firmware rate", async () => {
  const sender = createSocket("udp4");
  let interval;
  const client = new C64Client("http://127.0.0.1:1");
  client.facadePromise = Promise.resolve({
    type: "c64u",
    async streamStart(_stream, target) {
      const port = Number(target.split(":")[1]);
      let frame = 0;
      interval = setInterval(() => {
        for (const packet of framePackets(frame)) sender.send(packet, port, "127.0.0.1");
        frame += 1;
      }, 20);
      return { success: true };
    },
    async streamStop() { clearInterval(interval); return { success: true }; },
  });
  try {
    const result = await client.captureFrames({ count: 8 });
    assert.equal(result.frames.length, 8);
    assert.ok(result.frames.every((frame) => frame.complete && frame.height === 272));
  } finally {
    clearInterval(interval);
    sender.close();
  }
});

test("lines beyond the announced height do not complete a frame with missing lines", () => {
  const packets = framePackets(5)
    .filter((_, index) => index !== 25) // lines 100-103 missing
    .concat([videoPacket(5, 400, false)]); // a stray line far below the frame
  assert.equal(collectCompleteVideoFrames(packets.map((packet) => parseVideoPacket(packet)), 1).length, 0);
  const complete = framePackets(6).concat([videoPacket(6, 400, false)]).map((packet) => parseVideoPacket(packet));
  const frames = collectCompleteVideoFrames(complete, 1);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].height, 272);
  assert.equal(frames[0].complete, true);
});

test("the assembler does not count lines beyond the announced height, before or after the last packet", () => {
  const stray = videoPacket(0, 400, false);
  for (const strayFirst of [true, false]) {
    const assembler = new VideoFrameAssembler();
    const packets = framePackets(0).filter((_, index) => index !== 25); // lines 100-103 missing
    const ordered = strayFirst ? [stray, ...packets] : [...packets, stray];
    const done = ordered.map((packet) => assembler.add(parseVideoPacket(packet))).filter(Boolean);
    assert.equal(done.length, 0, `stray line ${strayFirst ? "before" : "after"} the last packet completed the frame`);
    const completed = assembler.add(parseVideoPacket(videoPacket(0, 100, false)));
    assert.equal(completed?.frame.height, 272);
    assert.equal(completed?.frame.complete, true);
  }
});
