/*
 * VICE Binary Monitor client with debugger, resource, and display helpers.
 */
import net from "node:net";

type ViceDataChunk = string | Uint8Array<ArrayBufferLike>;

export type ViceMemspace = 0 | 1 | 2 | 3 | 4;

export interface ViceCheckpoint {
  readonly id: number;
  readonly hit: boolean;
  readonly start: number;
  readonly end: number;
  readonly stopOnHit: boolean;
  readonly enabled: boolean;
  readonly temporary: boolean;
  readonly operations: {
    readonly execute: boolean;
    readonly load: boolean;
    readonly store: boolean;
  };
  readonly hitCount: number;
  readonly ignoreCount: number;
  readonly hasCondition: boolean;
  readonly memspace: ViceMemspace;
}

export interface ViceCheckpointCreateOptions {
  readonly start: number;
  readonly end?: number;
  readonly stopOnHit?: boolean;
  readonly enabled?: boolean;
  readonly operations?: {
    readonly execute?: boolean;
    readonly load?: boolean;
    readonly store?: boolean;
  };
  readonly temporary?: boolean;
  readonly memspace?: ViceMemspace;
}

export interface ViceRegisterValue {
  readonly id: number;
  readonly size: number;
  readonly value: number;
}

export interface ViceRegisterMetadata {
  readonly id: number;
  readonly name: string;
  readonly bits: number;
  readonly size: number;
}

export interface ViceRegisterWrite {
  readonly id?: number;
  readonly name?: string;
  readonly value: number;
}

export type ViceResourceValue =
  | { readonly type: "int"; readonly value: number }
  | { readonly type: "string"; readonly value: string };

export interface ViceDisplaySnapshot {
  readonly debugWidth: number;
  readonly debugHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly bitsPerPixel: number;
  readonly pixels: Buffer;
}

interface PendingRequest {
  cmd: number;
  resolve: (frame: Buffer) => void;
  reject: (err: unknown) => void;
  onFrame?: (type: number, frame: Buffer) => void;
}

interface SendOptions {
  readonly responseType?: number;
  readonly onFrame?: (type: number, frame: Buffer) => void;
}

export class ViceClient {
  private socket!: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private nextReqId = 1;
  private pending: Map<number, PendingRequest> = new Map();
  private closing = false;
  private onUnsolicitedHandler?: (type: number, frame: Buffer) => void;

  setUnsolicitedHandler(handler: (type: number, frame: Buffer) => void): void {
    this.onUnsolicitedHandler = handler;
  }

  async connect(port: number, host = "127.0.0.1"): Promise<void> {
    this.socket = net.connect({ host, port });
    this.closing = false;
    this.socket.setNoDelay(true);
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => {
        this.socket.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        this.socket.off("connect", onConnect);
        reject(error);
      };
      this.socket.once("connect", onConnect);
      this.socket.once("error", onError);
    });
    this.socket.on("data", (chunk: ViceDataChunk) => this.onData(chunk));
    this.socket.on("error", (err) => {
      this.rejectAllPending(err);
    });
    this.socket.on("close", (hadError) => {
      if (this.pending.size === 0 || this.closing) {
        return;
      }
      const reason = hadError ? new Error("VICE monitor connection closed due to error") : new Error("VICE monitor connection closed");
      this.rejectAllPending(reason);
    });
  }

  close(): void {
    const reason = new Error("VICE monitor connection closed");
    try {
      this.closing = true;
      this.rejectAllPending(reason);
      this.buffer = Buffer.alloc(0);
      this.socket?.removeAllListeners();
      this.socket?.destroy();
    } catch {}
  }

  private rejectAllPending(reason: unknown): void {
    for (const [, pending] of this.pending) {
      try {
        pending.reject(reason);
      } catch {}
    }
    this.pending.clear();
  }

  private onData(chunk: ViceDataChunk): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, data]);
    // Frame: [0]=0x02, [1]=0x02, [2..5]=len, [6]=respType, [7]=err, [8..11]=reqId, [12..]=body
    while (this.buffer.length >= 12) {
      if (this.buffer[0] !== 0x02 || this.buffer[1] !== 0x02) {
        const idx = this.buffer.indexOf(0x02, 1);
        this.buffer = idx === -1 ? Buffer.alloc(0) : this.buffer.subarray(idx);
        continue;
      }

      const bodyLen = this.buffer.readUInt32LE(2);
      const total = 12 + bodyLen;
      if (this.buffer.length < total) return;

      const frame = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);

      const responseType = frame[6];
      const err = frame[7];
      const reqId = frame.readUInt32LE(8);
      if (reqId === 0xffffffff) {
        this.onUnsolicitedHandler?.(responseType, frame);
        continue;
      }

      const pending = this.pending.get(reqId);
      if (!pending) {
        continue;
      }

      if (err !== 0x00) {
        pending.reject(new Error(`BM error 0x${err.toString(16)}`));
        this.pending.delete(reqId);
        continue;
      }

      if (pending.cmd !== responseType) {
        if (pending.onFrame) {
          try {
            pending.onFrame(responseType, frame);
          } catch (error) {
            pending.reject(error);
            this.pending.delete(reqId);
          }
          continue;
        }

        pending.reject(new Error(`BM mismatched response: expected 0x${pending.cmd.toString(16)} got 0x${responseType.toString(16)}`));
        this.pending.delete(reqId);
        continue;
      }

      pending.resolve(frame);
      this.pending.delete(reqId);
    }
  }

  private send(cmd: number, body?: Buffer, options?: SendOptions): Promise<Buffer> {
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error("VICE monitor socket is not connected"));
    }
    const reqId = this.nextReqId++;
    const payload = body ?? Buffer.alloc(0);
    const header = Buffer.alloc(11);
    header[0] = 0x02; // STX
    header[1] = 0x02; // API v2
    header.writeUInt32LE(payload.length, 2);
    header.writeUInt32LE(reqId, 6);
    header[10] = cmd;
    const packet = Buffer.concat([header, payload]);
    const expectedCmd = options?.responseType ?? cmd;

    const promise = new Promise<Buffer>((resolve, reject) => {
      this.pending.set(reqId, {
        cmd: expectedCmd,
        resolve,
        reject,
        onFrame: options?.onFrame,
      });
    });

    this.socket.write(packet);
    return promise;
  }

  async info(): Promise<void> { await this.send(0x85); }
  async resetSoft(): Promise<void> { await this.send(0xCC, Buffer.from([0x00])); }
  async resetHard(): Promise<void> { await this.send(0xCC, Buffer.from([0x01])); }
  async reset(type: 0 | 1 = 0): Promise<void> { await this.send(0xCC, Buffer.from([type])); }
  /**
   * Exit the emulator process (BM 0xBB Quit). The socket will be closed by VICE.
   * Consumers should still call close() to dispose any local resources.
   */
  async quit(): Promise<void> { await this.send(0xBB); }
  /**
   * Exit the monitor and resume emulation (BM 0xAA Exit). Not strictly needed for BM requests
   * but useful when the caller wants to ensure the CPU is running afterwards.
   */
  async exitMonitor(): Promise<void> { await this.send(0xAA); }
  async memGet(start: number, end: number): Promise<Buffer> {
    const body = Buffer.alloc(1 + 2 + 2 + 1 + 2);
    body[0] = 0; // sidefx=0 (peek)
    body.writeUInt16LE(start & 0xffff, 1);
    body.writeUInt16LE(end & 0xffff, 3);
    body[5] = 0; // comp space
    body.writeUInt16LE(0, 6); // bank
    const frame = await this.send(0x01, body);
    const len = frame.readUInt16LE(12);
    return frame.subarray(14, 14 + len);
  }

  async memSet(start: number, payload: Buffer): Promise<void> {
    const end = start + payload.length - 1;
    const header = Buffer.alloc(1 + 2 + 2 + 1 + 2);
    header[0] = 1; // sidefx=1 (write)
    header.writeUInt16LE(start & 0xffff, 1);
    header.writeUInt16LE(end & 0xffff, 3);
    header[5] = 0; // comp space
    header.writeUInt16LE(0, 6); // bank
    await this.send(0x02, Buffer.concat([header, payload]));
  }

  async keyboardFeed(text: string): Promise<void> {
    if (!text) return;
    const bytes = Buffer.from(text, "ascii");
    const body = Buffer.concat([Buffer.from([bytes.length & 0xff]), bytes]);
    await this.send(0x72, body);
  }

  async checkpointGet(id: number): Promise<ViceCheckpoint> {
    const body = Buffer.alloc(4);
    body.writeUInt32LE(id >>> 0, 0);
    const frame = await this.send(0x11, body, { responseType: 0x11 });
    return this.parseCheckpoint(frame);
  }

  async checkpointCreate(options: ViceCheckpointCreateOptions): Promise<ViceCheckpoint> {
    const start = options.start & 0xffff;
    const end = (options.end ?? options.start) & 0xffff;
    const stop = options.stopOnHit !== false;
    const enabled = options.enabled !== false;
    const ops = options.operations ?? { execute: true };
    const mask = (ops.load ? 0x01 : 0) | (ops.store ? 0x02 : 0) | (ops.execute === false ? 0 : 0x04);
    const temporary = options.temporary === true;
    const memspace = options.memspace ?? 0;
    const hasMemspace = options.memspace !== undefined;
    const body = Buffer.alloc(hasMemspace ? 9 : 8);
    body.writeUInt16LE(start, 0);
    body.writeUInt16LE(end, 2);
    body[4] = stop ? 1 : 0;
    body[5] = enabled ? 1 : 0;
    body[6] = mask;
    body[7] = temporary ? 1 : 0;
    if (hasMemspace) {
      body[8] = memspace & 0xff;
    }
    const frame = await this.send(0x12, body, { responseType: 0x11 });
    return this.parseCheckpoint(frame);
  }

  async checkpointDelete(id: number): Promise<void> {
    const body = Buffer.alloc(4);
    body.writeUInt32LE(id >>> 0, 0);
    await this.send(0x13, body);
  }

  async checkpointToggle(id: number, enabled: boolean): Promise<void> {
    const body = Buffer.alloc(5);
    body.writeUInt32LE(id >>> 0, 0);
    body[4] = enabled ? 1 : 0;
    await this.send(0x15, body);
  }

  async checkpointSetCondition(id: number, expression: string): Promise<void> {
    const expr = Buffer.from(expression ?? "", "utf8");
    if (expr.length > 255) {
      throw new Error("Condition expressions are limited to 255 bytes");
    }
    const body = Buffer.alloc(5 + expr.length);
    body.writeUInt32LE(id >>> 0, 0);
    body[4] = expr.length & 0xff;
    expr.copy(body, 5);
    await this.send(0x22, body);
  }

  async checkpointList(): Promise<ViceCheckpoint[]> {
    const checkpoints: ViceCheckpoint[] = [];
    await this.send(0x14, undefined, {
      responseType: 0x14,
      onFrame: (type, frame) => {
        if (type === 0x11) {
          checkpoints.push(this.parseCheckpoint(frame));
        }
      },
    });
    return checkpoints;
  }

  async registersAvailable(memspace: ViceMemspace = 0): Promise<ViceRegisterMetadata[]> {
    const frame = await this.send(0x83, Buffer.from([memspace & 0xff]), { responseType: 0x83 });
    return this.parseRegisterInfo(frame);
  }

  async registersGet(memspace: ViceMemspace = 0): Promise<ViceRegisterValue[]> {
    const frame = await this.send(0x31, Buffer.from([memspace & 0xff]), { responseType: 0x31 });
    return this.parseRegisterValues(frame);
  }

  async registersSet(
    writes: readonly ViceRegisterWrite[],
    options?: { readonly memspace?: ViceMemspace; readonly metadata?: readonly ViceRegisterMetadata[] },
  ): Promise<ViceRegisterValue[]> {
    if (!writes || writes.length === 0) {
      throw new Error("At least one register write must be provided");
    }
    const memspace = options?.memspace ?? 0;
    const metadata = options?.metadata ?? (await this.registersAvailable(memspace));
    const entries: Buffer[] = [];
    for (const write of writes) {
      const target = this.resolveRegisterTarget(write, metadata);
      const value = write.value & 0xffff;
      const entry = Buffer.alloc(4);
      entry[0] = 3;
      entry[1] = target.id & 0xff;
      entry.writeUInt16LE(value, 2);
      entries.push(entry);
    }
    const header = Buffer.alloc(3);
    header[0] = memspace & 0xff;
    header.writeUInt16LE(entries.length & 0xffff, 1);
    const frame = await this.send(0x32, Buffer.concat([header, ...entries]), { responseType: 0x31 });
    return this.parseRegisterValues(frame);
  }

  async stepInstructions(count = 1, options?: { readonly stepOver?: boolean }): Promise<void> {
    const body = Buffer.alloc(3);
    body[0] = options?.stepOver ? 1 : 0;
    body.writeUInt16LE(Math.max(1, Math.min(count, 0xffff)), 1);
    await this.send(0x71, body);
  }

  async stepReturn(): Promise<void> {
    await this.send(0x73);
  }

  async displayGet(options?: { readonly alternateCanvas?: boolean; readonly format?: number }): Promise<ViceDisplaySnapshot> {
    const alt = options?.alternateCanvas ? 1 : 0;
    const format = options?.format ?? 0;
    const frame = await this.send(0x84, Buffer.from([alt & 0xff, format & 0xff]), { responseType: 0x84 });
    return this.parseDisplay(frame);
  }

  async resourceGet(name: string): Promise<ViceResourceValue> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Resource name must not be empty");
    }
    const nameBytes = Buffer.from(trimmed, "utf8");
    if (nameBytes.length === 0 || nameBytes.length > 255) {
      throw new Error("Resource names must be 1-255 bytes");
    }
    const body = Buffer.concat([Buffer.from([nameBytes.length & 0xff]), nameBytes]);
    const frame = await this.send(0x51, body, { responseType: 0x51 });
    return this.parseResource(frame);
  }

  async resourceSet(name: string, value: string | number): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Resource name must not be empty");
    }
    const nameBytes = Buffer.from(trimmed, "utf8");
    if (nameBytes.length === 0 || nameBytes.length > 255) {
      throw new Error("Resource names must be 1-255 bytes");
    }

    let body: Buffer;
    if (typeof value === "number") {
      const header = Buffer.from([1, nameBytes.length & 0xff]);
      const intPayload = Buffer.alloc(4);
      intPayload.writeInt32LE(value | 0, 0);
      body = Buffer.concat([header, nameBytes, Buffer.from([4]), intPayload]);
    } else {
      const valueBytes = Buffer.from(value, "utf8");
      if (valueBytes.length > 255) {
        throw new Error("String resource values are limited to 255 bytes");
      }
      const header = Buffer.from([0, nameBytes.length & 0xff]);
      body = Buffer.concat([header, nameBytes, Buffer.from([valueBytes.length & 0xff]), valueBytes]);
    }

    await this.send(0x52, body);
  }

  private parseCheckpoint(frame: Buffer): ViceCheckpoint {
    const body = frame.subarray(12);
    if (body.length < 23) {
      throw new Error("Checkpoint response too short");
    }
    const id = body.readUInt32LE(0);
    const hit = body[4] === 1;
    const start = body.readUInt16LE(5);
    const end = body.readUInt16LE(7);
    const stopOnHit = body[9] === 1;
    const enabled = body[10] === 1;
    const mask = body[11] ?? 0;
    const temporary = body[12] === 1;
    const hitCount = body.readUInt32LE(13);
    const ignoreCount = body.readUInt32LE(17);
    const hasCondition = body[21] === 1;
    const memspace = (body[22] ?? 0) & 0xff;
    return {
      id,
      hit,
      start,
      end,
      stopOnHit,
      enabled,
      temporary,
      operations: {
        load: (mask & 0x01) !== 0,
        store: (mask & 0x02) !== 0,
        execute: (mask & 0x04) !== 0,
      },
      hitCount,
      ignoreCount,
      hasCondition,
      memspace: memspace as ViceMemspace,
    } satisfies ViceCheckpoint;
  }

  private parseRegisterValues(frame: Buffer): ViceRegisterValue[] {
    const body = frame.subarray(12);
    if (body.length < 2) return [];
    const count = body.readUInt16LE(0);
    const values: ViceRegisterValue[] = [];
    let offset = 2;
    for (let i = 0; i < count && offset < body.length; i += 1) {
      const entrySize = body[offset] ?? 0;
      const entryLength = entrySize + 1;
      if (entryLength < 3 || offset + entryLength > body.length) {
        break;
      }
      const id = body[offset + 1] ?? 0;
      const valueBytes = Math.max(0, entryLength - 2);
      let value = 0;
      if (valueBytes >= 2) {
        value = body.readUInt16LE(offset + 2);
      } else if (valueBytes === 1) {
        value = body[offset + 2] ?? 0;
      }
      values.push({ id, size: Math.max(1, valueBytes), value });
      offset += entryLength;
    }
    return values;
  }

  private parseRegisterInfo(frame: Buffer): ViceRegisterMetadata[] {
    const body = frame.subarray(12);
    if (body.length < 2) return [];
    const count = body.readUInt16LE(0);
    const info: ViceRegisterMetadata[] = [];
    let offset = 2;
    for (let i = 0; i < count && offset < body.length; i += 1) {
      const entrySize = body[offset] ?? 0;
      const entryLength = entrySize + 1;
      if (entryLength < 4 || offset + entryLength > body.length) {
        break;
      }
      const id = body[offset + 1] ?? 0;
      const bits = body[offset + 2] ?? 0;
      const nameLen = body[offset + 3] ?? 0;
      const nameStart = offset + 4;
      const nameEnd = Math.min(nameStart + nameLen, offset + entryLength);
      const name = body.toString("utf8", nameStart, nameEnd);
      const size = Math.max(1, Math.ceil(Math.min(bits || 8, 16) / 8));
      info.push({ id, name, bits, size });
      offset += entryLength;
    }
    return info;
  }

  private parseDisplay(frame: Buffer): ViceDisplaySnapshot {
    const body = frame.subarray(12);
    if (body.length < 17) {
      throw new Error("Display response too short");
    }
    const infoLength = body.readUInt32LE(0);
    if (body.length < 4 + infoLength) {
      throw new Error("Display response length mismatch");
    }
    const debugWidth = body.readUInt16LE(4);
    const debugHeight = body.readUInt16LE(6);
    const offsetX = body.readUInt16LE(8);
    const offsetY = body.readUInt16LE(10);
    const innerWidth = body.readUInt16LE(12);
    const innerHeight = body.readUInt16LE(14);
    const bitsPerPixel = body[16] ?? 8;
    const pixelLength = body.readUInt32LE(17);
    const pixelStart = 4 + infoLength;
    if (pixelStart + pixelLength > body.length) {
      throw new Error("Display pixel buffer truncated");
    }
    const pixels = Buffer.from(body.subarray(pixelStart, pixelStart + pixelLength));
    return {
      debugWidth,
      debugHeight,
      offsetX,
      offsetY,
      innerWidth,
      innerHeight,
      bitsPerPixel,
      pixels,
    } satisfies ViceDisplaySnapshot;
  }

  private parseResource(frame: Buffer): ViceResourceValue {
    const body = frame.subarray(12);
    if (body.length < 2) {
      throw new Error("Resource response too short");
    }
    const type = body[0] ?? 0;
    const length = body[1] ?? 0;
    if (type === 0) {
      const value = body.subarray(2, 2 + length).toString("utf8");
      return { type: "string", value };
    }
    if (type === 1) {
      if (length < 1 || length > 4) {
        throw new Error("Unsupported integer resource width");
      }
      const temp = Buffer.alloc(4);
      body.subarray(2, 2 + length).copy(temp, 0);
      return { type: "int", value: temp.readInt32LE(0) };
    }
    throw new Error(`Unsupported resource type 0x${type.toString(16)}`);
  }

  private resolveRegisterTarget(
    write: ViceRegisterWrite,
    metadata: readonly ViceRegisterMetadata[],
  ): ViceRegisterMetadata {
    if (write.id !== undefined) {
      const entry = metadata.find((meta) => meta.id === write.id);
      if (!entry) {
        throw new Error(`Unknown register id ${write.id}`);
      }
      return entry;
    }
    if (write.name) {
      const entry = metadata.find((meta) => meta.name.toLowerCase() === write.name!.toLowerCase());
      if (!entry) {
        throw new Error(`Unknown register name ${write.name}`);
      }
      return entry;
    }
    throw new Error("Register write requires id or name");
  }
}
