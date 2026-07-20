import net from "node:net";
import { asciiToScreenCodes } from "./readiness.js";

const SCREEN_BASE = 0x0400;
const SCREEN_SIZE = 40 * 25;

interface MockCheckpoint {
  id: number;
  start: number;
  end: number;
  stopOnHit: boolean;
  enabled: boolean;
  temporary: boolean;
  load: boolean;
  store: boolean;
  execute: boolean;
  hitCount: number;
  ignoreCount: number;
  hasCondition: boolean;
  memspace: number;
}

interface MockRegisterMetadata {
  id: number;
  name: string;
  bits: number;
}

function buildDefaultRegisterMetadata(): readonly MockRegisterMetadata[] {
  return Object.freeze([
    { id: 0, name: "PC", bits: 16 },
    { id: 1, name: "A", bits: 8 },
    { id: 2, name: "X", bits: 8 },
    { id: 3, name: "Y", bits: 8 },
    { id: 4, name: "SP", bits: 8 },
    { id: 5, name: "SR", bits: 8 },
  ] satisfies MockRegisterMetadata[]);
}

export interface ViceMockServerOptions {
  host?: string;
  port?: number;
}

function buildResponse(cmd: number, reqId: number, body: Buffer = Buffer.alloc(0), err = 0): Buffer {
  const header = Buffer.alloc(12 + body.length);
  header[0] = 0x02;
  header[1] = 0x02;
  header.writeUInt32LE(body.length, 2);
  header[6] = cmd;
  header[7] = err;
  header.writeUInt32LE(reqId >>> 0, 8);
  if (body.length > 0) {
    body.copy(header, 12);
  }
  return header;
}

export class ViceMockServer {
  private readonly host: string;
  private readonly requestedPort: number | undefined;
  private server: net.Server | null = null;
  private memory = new Uint8Array(0x10000);
  private helloReady = false;
  private checkpoints = new Map<number, MockCheckpoint>();
  private nextCheckpointId = 1;
  private readonly registerMetadata = buildDefaultRegisterMetadata();
  private registerValues = new Map<number, number>();
  private resources = new Map<string, number | string>();
  private readonly sockets = new Set<net.Socket>();

  constructor(options?: ViceMockServerOptions) {
    this.host = options?.host ?? "127.0.0.1";
    this.requestedPort = options?.port;
    this.resetState();
  }

  async start(): Promise<{ port: number }> {
    if (this.server) throw new Error("ViceMockServer already started");
    await new Promise<void>((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleSocket(socket));
      const onError = (error: Error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.listen(this.requestedPort ?? 0, this.host, () => resolve());
    });
    const address = this.server!.address();
    if (!address || typeof address === "string") throw new Error("Failed to determine mock server port");
    return { port: address.port };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private handleSocket(socket: net.Socket): void {
    this.sockets.add(socket);
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.once("close", () => {
      this.sockets.delete(socket);
      buffer = Buffer.alloc(0);
    });
    socket.on("data", (chunk: string | Uint8Array<ArrayBufferLike>) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = Buffer.concat([buffer, data]);
      buffer = this.processBuffer(buffer, socket);
    });
  }

  private processBuffer(buffer: Buffer<ArrayBufferLike>, socket: net.Socket): Buffer<ArrayBufferLike> {
    while (buffer.length >= 11) {
      if (buffer[0] !== 0x02 || buffer[1] !== 0x02) {
        buffer = buffer.slice(1);
        continue;
      }
      const bodyLen = buffer.readUInt32LE(2);
      const frameLen = 11 + bodyLen;
      if (buffer.length < frameLen) break;

      const reqId = buffer.readUInt32LE(6);
      const cmd = buffer[10];
      const body = buffer.slice(11, frameLen);
      buffer = buffer.slice(frameLen);

      const response = this.handleCommand(cmd, reqId, body, socket);
      if (response) {
        socket.write(response);
      }
    }
    return buffer;
  }

  private handleCommand(cmd: number, reqId: number, body: Buffer, socket: net.Socket): Buffer | null {
    switch (cmd) {
      case 0x85: // info
        return buildResponse(cmd, reqId);
      case 0xCC: // reset
        this.resetState();
        return buildResponse(cmd, reqId);
      case 0x11: { // checkpoint get
        const id = body.readUInt32LE(0);
        const checkpoint = this.checkpoints.get(id);
        if (!checkpoint) {
          return buildResponse(cmd, reqId, Buffer.alloc(0), 0x83);
        }
        return buildResponse(cmd, reqId, this.encodeCheckpoint(checkpoint));
      }
      case 0x12: { // checkpoint create
        const start = body.readUInt16LE(0);
        const end = body.readUInt16LE(2);
        const stopOnHit = body[4] === 1;
        const enabled = body[5] === 1;
        const mask = body[6] ?? 0x04;
        const temporary = body[7] === 1;
        const memspace = (body[8] ?? 0) & 0xff;
        const id = this.nextCheckpointId++;
        const checkpoint: MockCheckpoint = {
          id,
          start,
          end,
          stopOnHit,
          enabled,
          temporary,
          load: (mask & 0x01) !== 0,
          store: (mask & 0x02) !== 0,
          execute: (mask & 0x04) !== 0,
          hitCount: 0,
          ignoreCount: 0,
          hasCondition: false,
          memspace,
        };
        this.checkpoints.set(id, checkpoint);
        return buildResponse(0x11, reqId, this.encodeCheckpoint(checkpoint));
      }
      case 0x13: { // checkpoint delete
        const id = body.readUInt32LE(0);
        this.checkpoints.delete(id);
        return buildResponse(cmd, reqId);
      }
      case 0x14: { // checkpoint list
        for (const checkpoint of this.checkpoints.values()) {
          socket.write(buildResponse(0x11, reqId, this.encodeCheckpoint(checkpoint)));
        }
        return buildResponse(cmd, reqId);
      }
      case 0x15: { // checkpoint toggle
        const id = body.readUInt32LE(0);
        const enabled = body[4] === 1;
        const checkpoint = this.checkpoints.get(id);
        if (!checkpoint) {
          return buildResponse(cmd, reqId, Buffer.alloc(0), 0x83);
        }
        checkpoint.enabled = enabled;
        return buildResponse(cmd, reqId);
      }
      case 0x22: { // checkpoint condition
        const id = body.readUInt32LE(0);
        const checkpoint = this.checkpoints.get(id);
        if (!checkpoint) {
          return buildResponse(cmd, reqId, Buffer.alloc(0), 0x83);
        }
        checkpoint.hasCondition = (body[4] ?? 0) > 0;
        return buildResponse(cmd, reqId);
      }
      case 0x01: { // mem get
        const start = body.readUInt16LE(1);
        const end = body.readUInt16LE(3);
        const length = Math.max(0, end - start + 1);
        const payload = Buffer.alloc(2 + length);
        payload.writeUInt16LE(length, 0);
        for (let i = 0; i < length; i += 1) {
          payload[2 + i] = this.memory[(start + i) & 0xffff];
        }
        return buildResponse(cmd, reqId, payload);
      }
      case 0x02: { // mem set
        const start = body.readUInt16LE(1);
        const end = body.readUInt16LE(3);
        const payload = body.subarray(8);
        for (let i = 0; i < payload.length && start + i <= 0xffff; i += 1) {
          this.memory[start + i] = payload[i];
        }
        if (start <= SCREEN_BASE && end >= SCREEN_BASE) {
          this.helloReady = false;
        }
        // This mock does not run real 6502 code, so nothing else drains the
        // KERNAL keyboard buffer's pending-count byte ($00C6/NDX). Simulate
        // the KERNAL IRQ consuming it shortly after each write, mirroring
        // real VICE/hardware behaviour closely enough for deterministic tests.
        const KEYBOARD_NDX = 0x00c6;
        if (start <= KEYBOARD_NDX && end >= KEYBOARD_NDX) {
          setTimeout(() => { this.memory[KEYBOARD_NDX] = 0; }, 5);
        }
        return buildResponse(cmd, reqId);
      }
      case 0x72: { // keyboard feed
        const len = body[0] ?? 0;
        const text = body.subarray(1, 1 + len).toString("ascii").toUpperCase();
        if (text.includes("RUN")) {
          this.renderHello();
        }
        return buildResponse(cmd, reqId);
      }
      case 0x31: { // registers get
        const payload = this.encodeRegisterValues();
        return buildResponse(cmd, reqId, payload);
      }
      case 0x32: { // registers set
        this.applyRegisterWrites(body);
        const payload = this.encodeRegisterValues();
        return buildResponse(0x31, reqId, payload);
      }
      case 0x71: // step instructions
        return buildResponse(cmd, reqId);
      case 0x73: // step return
        return buildResponse(cmd, reqId);
      case 0x83: { // registers metadata
        const payload = this.encodeRegisterMetadata();
        return buildResponse(cmd, reqId, payload);
      }
      case 0x84: { // display get
        const payload = this.encodeDisplay();
        return buildResponse(cmd, reqId, payload);
      }
      case 0x51: { // resource get
        const nameLen = body[0] ?? 0;
        const name = body.subarray(1, 1 + nameLen).toString("utf8");
        const value = this.resources.get(name);
        if (value === undefined) {
          return buildResponse(cmd, reqId, Buffer.from([0, 0]));
        }
        if (typeof value === "number") {
          const buffer = Buffer.alloc(2 + 4);
          buffer[0] = 1;
          buffer[1] = 4;
          buffer.writeInt32LE(value, 2);
          return buildResponse(cmd, reqId, buffer);
        }
        const strBytes = Buffer.from(value, "utf8");
        const buffer = Buffer.alloc(2 + strBytes.length);
        buffer[0] = 0;
        buffer[1] = strBytes.length & 0xff;
        strBytes.copy(buffer, 2);
        return buildResponse(cmd, reqId, buffer);
      }
      case 0x52: { // resource set
        const isNumber = body[0] === 1;
        const nameLen = body[1] ?? 0;
        const name = body.subarray(2, 2 + nameLen).toString("utf8");
        if (isNumber) {
          const valueLen = body[2 + nameLen] ?? 0;
          const valueBytes = body.subarray(3 + nameLen, 3 + nameLen + valueLen);
          const padded = Buffer.alloc(4);
          valueBytes.copy(padded, 0, 0, Math.min(4, valueBytes.length));
          const value = padded.readInt32LE(0);
          this.resources.set(name, value);
        } else {
          const valueLen = body[2 + nameLen] ?? 0;
          const value = body.subarray(3 + nameLen, 3 + nameLen + valueLen).toString("utf8");
          this.resources.set(name, value);
        }
        return buildResponse(cmd, reqId);
      }
      case 0xAA: // exit monitor
        return buildResponse(cmd, reqId);
      case 0xBB: // quit
        queueMicrotask(() => socket.destroy());
        return buildResponse(cmd, reqId);
      default:
        return buildResponse(cmd, reqId, Buffer.alloc(0), 0x83);
    }
  }

  private encodeCheckpoint(checkpoint: MockCheckpoint): Buffer {
    const buffer = Buffer.alloc(23);
    buffer.writeUInt32LE(checkpoint.id, 0);
    buffer[4] = checkpoint.hitCount > 0 ? 1 : 0;
    buffer.writeUInt16LE(checkpoint.start & 0xffff, 5);
    buffer.writeUInt16LE(checkpoint.end & 0xffff, 7);
    buffer[9] = checkpoint.stopOnHit ? 1 : 0;
    buffer[10] = checkpoint.enabled ? 1 : 0;
    let mask = 0;
    if (checkpoint.load) mask |= 0x01;
    if (checkpoint.store) mask |= 0x02;
    if (checkpoint.execute) mask |= 0x04;
    buffer[11] = mask;
    buffer[12] = checkpoint.temporary ? 1 : 0;
    buffer.writeUInt32LE(checkpoint.hitCount >>> 0, 13);
    buffer.writeUInt32LE(checkpoint.ignoreCount >>> 0, 17);
    buffer[21] = checkpoint.hasCondition ? 1 : 0;
    buffer[22] = checkpoint.memspace & 0xff;
    return buffer;
  }

  private encodeRegisterValues(): Buffer {
    const entries: Buffer[] = [];
    for (const meta of this.registerMetadata) {
      const size = Math.max(1, Math.ceil(Math.min(meta.bits, 16) / 8));
      const value = this.registerValues.get(meta.id) ?? 0;
      const entryLength = 2 + size;
      const entry = Buffer.alloc(entryLength);
      entry[0] = size + 1;
      entry[1] = meta.id & 0xff;
      entry.writeUIntLE(value >>> 0, 2, size);
      entries.push(entry);
    }

    const payloadLength = 2 + entries.reduce((sum, entry) => sum + entry.length, 0);
    const payload = Buffer.alloc(payloadLength);
    payload.writeUInt16LE(entries.length, 0);
    let offset = 2;
    for (const entry of entries) {
      entry.copy(payload, offset);
      offset += entry.length;
    }
    return payload;
  }

  private encodeRegisterMetadata(): Buffer {
    const entries: Buffer[] = [];
    for (const meta of this.registerMetadata) {
      const nameBytes = Buffer.from(meta.name, "utf8");
      const entryLength = 4 + nameBytes.length;
      const entry = Buffer.alloc(entryLength);
      entry[0] = 3 + nameBytes.length;
      entry[1] = meta.id & 0xff;
      entry[2] = meta.bits & 0xff;
      entry[3] = nameBytes.length & 0xff;
      nameBytes.copy(entry, 4);
      entries.push(entry);
    }

    const payloadLength = 2 + entries.reduce((sum, entry) => sum + entry.length, 0);
    const payload = Buffer.alloc(payloadLength);
    payload.writeUInt16LE(entries.length, 0);
    let offset = 2;
    for (const entry of entries) {
      entry.copy(payload, offset);
      offset += entry.length;
    }
    return payload;
  }

  private encodeDisplay(): Buffer {
    const pixels = Buffer.alloc(64, 0);
    const header = Buffer.alloc(17);
    const pixelLength = Buffer.alloc(4);
    header.writeUInt32LE(13, 0);
    header.writeUInt16LE(320, 4);
    header.writeUInt16LE(200, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(320, 12);
    header.writeUInt16LE(200, 14);
    header[16] = 8;
    pixelLength.writeUInt32LE(pixels.length, 0);
    return Buffer.concat([header, pixelLength, pixels]);
  }

  private applyRegisterWrites(body: Buffer): void {
    if (body.length < 3) {
      return;
    }
    const count = body.readUInt16LE(1);
    let offset = 3;
    for (let index = 0; index < count && offset < body.length; index += 1) {
      const entrySize = body[offset] ?? 0;
      const entryLength = entrySize + 1;
      if (entryLength < 3 || offset + entryLength > body.length) {
        break;
      }
      const id = body[offset + 1] ?? 0;
      const valueBytes = Math.max(0, entryLength - 2);
      let value = 0;
      if (valueBytes > 0) {
        value = body.readUIntLE(offset + 2, Math.min(valueBytes, 4));
      }
      const meta = this.registerMetadata.find((m) => m.id === id);
      if (meta) {
        const mask = meta.bits >= 31 ? 0xffffffff : (1 << meta.bits) - 1;
        this.registerValues.set(id, value & mask);
      } else {
        this.registerValues.set(id, value);
      }
      offset += entryLength;
    }
  }

  private resetState(): void {
    this.memory.fill(0);
    // Fill screen with spaces and READY.
    this.memory.fill(0x20, SCREEN_BASE, SCREEN_BASE + SCREEN_SIZE);
    const ready = asciiToScreenCodes("READY.");
    ready.copy(Buffer.from(this.memory.buffer, SCREEN_BASE, ready.length));
    // Initialise BASIC zero-page pointers so waitForBasicReady() succeeds
    // immediately instead of spinning for 20 s on all-zero memory.
    //   $002B-$002C  TXTTAB  = $0801  (start of BASIC text)
    //   $002D-$002E  VARTAB  = $0803  (start of variables)
    //   $002F-$0030  ARYTAB  = $0803  (start of arrays)
    //   $0031-$0032  STREND  = $0803  (end of BASIC storage)
    this.memory[0x2B] = 0x01; this.memory[0x2C] = 0x08;
    this.memory[0x2D] = 0x03; this.memory[0x2E] = 0x08;
    this.memory[0x2F] = 0x03; this.memory[0x30] = 0x08;
    this.memory[0x31] = 0x03; this.memory[0x32] = 0x08;
    this.helloReady = false;
    this.checkpoints.clear();
    this.nextCheckpointId = 1;
    this.registerValues.clear();
    for (const meta of this.registerMetadata) {
      this.registerValues.set(meta.id, 0);
    }
    this.resources = new Map<string, number | string>([
      ["C64Model", 2],
      ["SidEngine", 1],
    ]);
  }

  private renderHello(): void {
    if (this.helloReady) return;
    const row = 10;
    const offset = SCREEN_BASE + row * 40;
    const hello = asciiToScreenCodes("HELLO");
    hello.copy(Buffer.from(this.memory.buffer, offset, hello.length));
    this.helloReady = true;
  }
}

export async function startViceMockServer(options?: ViceMockServerOptions): Promise<ViceMockServer & { port: number }> {
  const server = new ViceMockServer(options);
  const { port } = await server.start();
  return Object.assign(server, { port });
}
