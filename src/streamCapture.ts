import { Buffer } from "node:buffer";

export const VIDEO_STREAM_HEADER_BYTES = 12;
export const AUDIO_STREAM_HEADER_BYTES = 2;
export const DEFAULT_VIDEO_STREAM_PORT = 11000;
export const DEFAULT_AUDIO_STREAM_PORT = 11001;
export const C64U_PAL_AUDIO_SAMPLE_RATE = 47_982.8869047619;
export const C64U_NTSC_AUDIO_SAMPLE_RATE = 47_940.3408482143;

export interface ParsedVideoPacket {
  readonly sequence: number;
  readonly frameNumber: number;
  readonly lineNumber: number;
  readonly isLastPacket: boolean;
  readonly pixelsPerLine: number;
  readonly linesPerPacket: number;
  readonly bitsPerPixel: number;
  readonly encodingType: number;
  readonly payload: Buffer;
}

export interface ParsedAudioPacket {
  readonly sequence: number;
  readonly samples: Int16Array;
}

export interface CapturedFrame {
  readonly frameNumber: number | null;
  readonly width: number;
  readonly height: number;
  readonly bitsPerPixel: number;
  readonly pixels: Uint8Array;
  readonly complete: boolean;
}

interface VideoFrameGroup {
  readonly frameNumber: number;
  readonly packets: readonly ParsedVideoPacket[];
}

/** Largest frame the firmware sends is 384 x 272; the packet encoding field 0 carries 4 bit video lines. */
export const VIDEO_MAX_WIDTH = 512;
export const VIDEO_MAX_HEIGHT = 512;
const VIDEO_ENCODING_PIXELS = 0;

export function parseVideoPacket(payload: Buffer): ParsedVideoPacket {
  if (payload.length < VIDEO_STREAM_HEADER_BYTES) {
    throw new Error(`Video packet too small: ${payload.length}`);
  }

  const sequence = payload.readUInt16LE(0);
  const frameNumber = payload.readUInt16LE(2);
  const lineField = payload.readUInt16LE(4);
  const lineNumber = lineField & 0x7fff;
  const isLastPacket = (lineField & 0x8000) !== 0;
  const pixelsPerLine = payload.readUInt16LE(6);
  const linesPerPacket = payload.readUInt8(8);
  const bitsPerPixel = payload.readUInt8(9);
  const encodingType = payload.readUInt16LE(10);

  // The device is untrusted input: bound the geometry before anything is allocated from it.
  if (encodingType !== VIDEO_ENCODING_PIXELS) {
    throw new Error(`Video packet encoding ${encodingType} is not a pixel packet`);
  }
  if (bitsPerPixel !== 4) {
    throw new Error(`Video packet uses ${bitsPerPixel} bits per pixel; only 4 is supported`);
  }
  if (pixelsPerLine < 1 || pixelsPerLine > VIDEO_MAX_WIDTH) {
    throw new Error(`Video packet width ${pixelsPerLine} is outside 1..${VIDEO_MAX_WIDTH}`);
  }
  if (linesPerPacket < 1 || lineNumber + linesPerPacket > VIDEO_MAX_HEIGHT) {
    throw new Error(`Video packet lines ${lineNumber}+${linesPerPacket} exceed ${VIDEO_MAX_HEIGHT}`);
  }
  const expectedPayloadBytes = Math.ceil((pixelsPerLine * bitsPerPixel) / 8) * linesPerPacket;
  if (payload.length - VIDEO_STREAM_HEADER_BYTES < expectedPayloadBytes) {
    throw new Error(`Video packet payload ${payload.length - VIDEO_STREAM_HEADER_BYTES} is shorter than the ${expectedPayloadBytes} bytes its header claims`);
  }

  return {
    sequence,
    frameNumber,
    lineNumber,
    isLastPacket,
    pixelsPerLine,
    linesPerPacket,
    bitsPerPixel,
    encodingType,
    payload: payload.subarray(VIDEO_STREAM_HEADER_BYTES),
  };
}

export function parseAudioPacket(payload: Buffer): ParsedAudioPacket {
  if (payload.length < AUDIO_STREAM_HEADER_BYTES) {
    throw new Error(`Audio packet too small: ${payload.length}`);
  }

  const sequence = payload.readUInt16LE(0);
  const audioBytes = payload.subarray(AUDIO_STREAM_HEADER_BYTES);
  if (audioBytes.length % 2 !== 0) {
    throw new Error(`Audio payload has odd byte count: ${audioBytes.length}`);
  }

  const samples = new Int16Array(audioBytes.length / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = audioBytes.readInt16LE(index * 2);
  }

  return { sequence, samples };
}

export function collectCompleteVideoFrames(
  packets: readonly ParsedVideoPacket[],
  count: number,
): readonly CapturedFrame[] {
  const completed: CapturedFrame[] = [];
  for (const group of groupVideoPackets(packets)) {
    if (!isVideoFrameGroupComplete(group)) {
      continue;
    }
    completed.push(reconstructVideoFrame(group.packets));
    if (completed.length >= count) {
      break;
    }
  }
  return completed;
}

export function reconstructVideoFrame(packets: readonly ParsedVideoPacket[]): CapturedFrame {
  if (packets.length === 0) {
    throw new Error("No video packets available");
  }

  const reference = packets[0]!;
  const width = reference.pixelsPerLine;
  const linesPerPacket = Math.max(1, reference.linesPerPacket);
  const bytesPerLine = Math.ceil((width * reference.bitsPerPixel) / 8);
  const maxLine = Math.max(...packets.map((packet) => packet.lineNumber + packet.linesPerPacket));
  const height = maxLine;
  if (width < 1 || width > VIDEO_MAX_WIDTH || height > VIDEO_MAX_HEIGHT || reference.bitsPerPixel !== 4) {
    throw new Error(`Video frame geometry ${width} x ${height} at ${reference.bitsPerPixel} bits per pixel is not supported`);
  }
  const pixels = new Uint8Array(width * height);
  const filledLines = new Set<number>();

  for (const packet of packets) {
    const expectedPayloadBytes = bytesPerLine * linesPerPacket;
    const packetPayload = packet.payload.subarray(0, expectedPayloadBytes);
    for (let lineOffset = 0; lineOffset < linesPerPacket; lineOffset += 1) {
      const lineIndex = packet.lineNumber + lineOffset;
      if (lineIndex >= height) {
        continue;
      }
      const srcStart = lineOffset * bytesPerLine;
      if (packetPayload.length < srcStart + bytesPerLine) {
        continue; // the line's bytes did not arrive
      }
      const srcLine = packetPayload.subarray(srcStart, srcStart + bytesPerLine);
      unpack4BitPixelsToRow(srcLine, pixels, lineIndex * width, width);
      filledLines.add(lineIndex);
    }
  }

  return {
    frameNumber: reference.frameNumber,
    width,
    height,
    bitsPerPixel: 4,
    pixels,
    complete: height > 0 && filledLines.size === height,
  };
}

function groupVideoPackets(packets: readonly ParsedVideoPacket[]): readonly VideoFrameGroup[] {
  const byFrame = new Map<number, ParsedVideoPacket[]>();
  for (const packet of packets) {
    const framePackets = byFrame.get(packet.frameNumber) ?? [];
    framePackets.push(packet);
    byFrame.set(packet.frameNumber, framePackets);
  }

  return Array.from(byFrame.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([frameNumber, framePackets]) => ({
      frameNumber,
      packets: framePackets.slice().sort((left, right) => left.lineNumber - right.lineNumber),
    }));
}

function isVideoFrameGroupComplete(group: VideoFrameGroup): boolean {
  const lastPacket = group.packets.find((packet) => packet.isLastPacket);
  if (!lastPacket) {
    return false;
  }

  const expectedHeight = lastPacket.lineNumber + lastPacket.linesPerPacket;
  if (expectedHeight <= 0 || expectedHeight > VIDEO_MAX_HEIGHT) {
    return false;
  }

  const coveredLines = new Set<number>();
  for (const packet of group.packets) {
    const bytesPerLine = Math.ceil((packet.pixelsPerLine * packet.bitsPerPixel) / 8);
    for (let offset = 0; offset < packet.linesPerPacket; offset += 1) {
      if (packet.payload.length < (offset + 1) * bytesPerLine) {
        continue; // a line counts only when its payload arrived
      }
      coveredLines.add(packet.lineNumber + offset);
    }
  }

  return coveredLines.size >= expectedHeight;
}

function unpack4BitPixelsToRow(
  srcLine: Uint8Array,
  dstPixels: Uint8Array,
  dstOffset: number,
  width: number,
): void {
  let cursor = dstOffset;
  for (let index = 0; index < srcLine.length && cursor < dstOffset + width; index += 1) {
    const packed = srcLine[index]!;
    dstPixels[cursor++] = packed & 0x0f;
    if (cursor < dstOffset + width) {
      dstPixels[cursor++] = (packed >> 4) & 0x0f;
    }
  }
}
