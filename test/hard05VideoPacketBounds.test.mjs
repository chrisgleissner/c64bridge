import test from "#test/runner";
import assert from "#test/assert";
import { Buffer } from "node:buffer";
import { collectCompleteVideoFrames, parseVideoPacket } from "../src/streamCapture.js";

// HARD05-001: video packet headers come from an untrusted peer.

function header({ frame = 1, line = 0, last = false, width = 384, lines = 4, bpp = 4, encoding = 0 }) {
  const b = Buffer.alloc(12);
  b.writeUInt16LE(0, 0);
  b.writeUInt16LE(frame, 2);
  b.writeUInt16LE((line & 0x7fff) | (last ? 0x8000 : 0), 4);
  b.writeUInt16LE(width, 6);
  b.writeUInt8(lines, 8);
  b.writeUInt8(bpp, 9);
  b.writeUInt16LE(encoding, 10);
  return b;
}

const fullPacket = (fields) => Buffer.concat([header(fields), Buffer.alloc((Math.ceil(((fields.width ?? 384) * (fields.bpp ?? 4)) / 8)) * (fields.lines ?? 4))]);

// parseVideoPacket result with the bounds taken away, as a hand-built packet list would carry it.
function rawPacket(fields, payloadBytes = 0) {
  return {
    sequence: 0,
    frameNumber: fields.frame ?? 1,
    lineNumber: fields.line ?? 0,
    isLastPacket: fields.last ?? false,
    pixelsPerLine: fields.width ?? 384,
    linesPerPacket: fields.lines ?? 4,
    bitsPerPixel: fields.bpp ?? 4,
    encodingType: fields.encoding ?? 0,
    payload: Buffer.alloc(payloadBytes),
  };
}

test("parseVideoPacket accepts the firmware geometry and rejects unbounded headers", () => {
  const ok = parseVideoPacket(fullPacket({ width: 384, lines: 4, line: 268, last: true }));
  assert.equal(ok.pixelsPerLine, 384);
  assert.throws(() => parseVideoPacket(header({ width: 24000, lines: 255, line: 32767 })), /width|lines/);
  assert.throws(() => parseVideoPacket(header({ width: 513 })), /width/);
  assert.throws(() => parseVideoPacket(header({ width: 0 })), /width/);
  assert.throws(() => parseVideoPacket(header({ lines: 0 })), /lines/);
  assert.throws(() => parseVideoPacket(fullPacket({ line: 510, lines: 4 })), /lines/);
  assert.throws(() => parseVideoPacket(fullPacket({ bpp: 8 })), /bits per pixel/);
});

test("parseVideoPacket rejects a packet shorter than its header claims and palette packets", () => {
  assert.throws(() => parseVideoPacket(header({ width: 384, lines: 4 })), /shorter/);
  const short = fullPacket({ width: 384, lines: 4 }).subarray(0, 12 + 767);
  assert.throws(() => parseVideoPacket(short), /shorter/);
  assert.throws(() => parseVideoPacket(fullPacket({ encoding: 1, line: 239, last: true })), /encoding/);
});

test("header-only packets never complete a frame and never allocate from claimed geometry", () => {
  const headerOnly = [];
  for (let line = 0; line < 240; line += 4) {
    headerOnly.push(rawPacket({ line, last: line + 4 >= 240 }, 0));
  }
  assert.equal(collectCompleteVideoFrames(headerOnly, 1).length, 0);

  const huge = [rawPacket({ width: 4000, lines: 255, line: 0, last: true }, 2000 * 255)];
  assert.throws(() => collectCompleteVideoFrames(huge, 1), /geometry|not supported/);
  assert.equal(collectCompleteVideoFrames([rawPacket({ width: 4000, lines: 255, line: 20000, last: true }, 0)], 1).length, 0);
});

test("a frame with every line payload still completes", () => {
  const packets = [];
  for (let line = 0; line < 240; line += 4) {
    packets.push(parseVideoPacket(fullPacket({ line, last: line + 4 >= 240 })));
  }
  const frames = collectCompleteVideoFrames(packets, 1);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].width, 384);
  assert.equal(frames[0].height, 240);
  assert.equal(frames[0].complete, true);
});
