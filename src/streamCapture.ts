import { Buffer } from "node:buffer";

export const VIDEO_STREAM_HEADER_BYTES = 12;
export const AUDIO_STREAM_HEADER_BYTES = 2;
export const DEFAULT_VIDEO_STREAM_PORT = 11000;
export const DEFAULT_AUDIO_STREAM_PORT = 11001;
export const C64U_PAL_AUDIO_SAMPLE_RATE = 47_982.8869047619;
export const C64U_NTSC_AUDIO_SAMPLE_RATE = 47_940.3408482143;
/**
 * Largest audio capture in one request, in stereo sample pairs: about 1.37 s at the PAL rate
 * (65536 / 47983 Hz) and 1.37 s at the NTSC rate. Longer captures are refused, not shortened.
 */
export const MAX_AUDIO_CAPTURE_PAIRS = 65_536;

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
    const height = completeVideoFrameHeight(group.packets);
    if (height === null) {
      continue;
    }
    completed.push(reconstructVideoFrame(group.packets, height));
    if (completed.length >= count) {
      break;
    }
  }
  return completed;
}

/**
 * Rebuilds the pixels of one frame. `height` is the frame height announced by its last packet;
 * lines at or below it are ignored. Without it the height is the highest line received.
 */
export function reconstructVideoFrame(packets: readonly ParsedVideoPacket[], height?: number): CapturedFrame {
  if (packets.length === 0) {
    throw new Error("No video packets available");
  }

  const reference = packets[0]!;
  const width = reference.pixelsPerLine;
  const linesPerPacket = Math.max(1, reference.linesPerPacket);
  const bytesPerLine = Math.ceil((width * reference.bitsPerPixel) / 8);
  const frameHeight = height ?? Math.max(...packets.map((packet) => packet.lineNumber + packet.linesPerPacket));
  if (width < 1 || width > VIDEO_MAX_WIDTH || frameHeight > VIDEO_MAX_HEIGHT || reference.bitsPerPixel !== 4) {
    throw new Error(`Video frame geometry ${width} x ${frameHeight} at ${reference.bitsPerPixel} bits per pixel is not supported`);
  }
  const pixels = new Uint8Array(width * frameHeight);
  const filledLines = new Set<number>();

  for (const packet of packets) {
    const expectedPayloadBytes = bytesPerLine * linesPerPacket;
    const packetPayload = packet.payload.subarray(0, expectedPayloadBytes);
    for (let lineOffset = 0; lineOffset < linesPerPacket; lineOffset += 1) {
      const lineIndex = packet.lineNumber + lineOffset;
      if (lineIndex >= frameHeight) {
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
    height: frameHeight,
    bitsPerPixel: 4,
    pixels,
    complete: frameHeight > 0 && filledLines.size === frameHeight,
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

/** Lines of `packet` whose payload arrived, given the frame's line width in bytes. */
function arrivedLines(packet: ParsedVideoPacket, bytesPerLine: number): number[] {
  const lines: number[] = [];
  for (let offset = 0; offset < packet.linesPerPacket; offset += 1) {
    if (packet.payload.length < (offset + 1) * bytesPerLine) {
      continue; // a line counts only when its payload arrived
    }
    lines.push(packet.lineNumber + offset);
  }
  return lines;
}

/**
 * The height of a complete frame, or null. The last packet announces the height; the frame is
 * complete when every line below it arrived. Lines at or beyond the height do not count.
 */
function completeVideoFrameHeight(packets: readonly ParsedVideoPacket[]): number | null {
  const lastPacket = packets.find((packet) => packet.isLastPacket);
  if (!lastPacket) {
    return null;
  }

  const expectedHeight = lastPacket.lineNumber + lastPacket.linesPerPacket;
  if (expectedHeight <= 0 || expectedHeight > VIDEO_MAX_HEIGHT) {
    return null;
  }

  const coveredLines = new Set<number>();
  for (const packet of packets) {
    const bytesPerLine = Math.ceil((packet.pixelsPerLine * packet.bitsPerPixel) / 8);
    for (const line of arrivedLines(packet, bytesPerLine)) {
      if (line < expectedHeight) coveredLines.add(line);
    }
  }

  return coveredLines.size === expectedHeight ? expectedHeight : null;
}

interface PendingVideoFrame {
  readonly packets: ParsedVideoPacket[];
  readonly lines: Set<number>;
  readonly bytesPerLine: number;
  readonly firstPacketIndex: number;
  expectedHeight: number | null;
  /** Lines below expectedHeight that arrived; counted once expectedHeight is known. */
  covered: number;
}

export interface AssembledVideoFrame {
  readonly frame: CapturedFrame;
  /** Index (counted from the first packet given to the assembler) of the frame's first packet. */
  readonly firstPacketIndex: number;
}

/**
 * Assembles frames from video packets as they arrive. Each packet costs work proportional to its
 * own lines, and a frame's pixels are rebuilt once, when its last missing line arrives. Frames that
 * never complete are dropped oldest first once more than `maxRetainedPackets` packets are held.
 */
export class VideoFrameAssembler {
  private readonly pending = new Map<number, PendingVideoFrame>();
  private retained = 0;
  private seen = 0;

  constructor(private readonly maxRetainedPackets = 4096) {}

  /** Packets held in frames that are not complete yet. */
  get retainedPackets(): number { return this.retained; }

  /** Packets given to the assembler so far. */
  get packetsSeen(): number { return this.seen; }

  /** Adds one packet. Returns the frame it completed, or null. Throws when a completed frame's geometry is not supported. */
  add(packet: ParsedVideoPacket): AssembledVideoFrame | null {
    const index = this.seen;
    this.seen += 1;
    let frame = this.pending.get(packet.frameNumber);
    if (!frame) {
      frame = {
        packets: [],
        lines: new Set<number>(),
        bytesPerLine: Math.ceil((packet.pixelsPerLine * packet.bitsPerPixel) / 8),
        firstPacketIndex: index,
        expectedHeight: null,
        covered: 0,
      };
      this.pending.set(packet.frameNumber, frame);
    } else if (Math.ceil((packet.pixelsPerLine * packet.bitsPerPixel) / 8) !== frame.bytesPerLine) {
      return null; // a packet with another line width cannot fill this frame
    }
    frame.packets.push(packet);
    this.retained += 1;
    for (const line of arrivedLines(packet, frame.bytesPerLine)) {
      if (frame.lines.has(line)) continue;
      frame.lines.add(line);
      if (frame.expectedHeight !== null && line < frame.expectedHeight) frame.covered += 1;
    }
    if (packet.isLastPacket && frame.expectedHeight === null) {
      const height = packet.lineNumber + packet.linesPerPacket;
      if (height > 0 && height <= VIDEO_MAX_HEIGHT) {
        frame.expectedHeight = height;
        let covered = 0;
        for (const line of frame.lines) if (line < height) covered += 1;
        frame.covered = covered;
      }
    }
    if (frame.expectedHeight !== null && frame.covered === frame.expectedHeight) {
      this.pending.delete(packet.frameNumber);
      this.retained -= frame.packets.length;
      return { frame: reconstructVideoFrame(frame.packets, frame.expectedHeight), firstPacketIndex: frame.firstPacketIndex };
    }
    this.evict();
    return null;
  }

  private evict(): void {
    for (const [frameNumber, frame] of this.pending) {
      if (this.retained <= this.maxRetainedPackets) return;
      this.pending.delete(frameNumber);
      this.retained -= frame.packets.length;
    }
  }
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
