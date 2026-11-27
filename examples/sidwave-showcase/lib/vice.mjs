// A private headless VICE instance with a minimal binary monitor client.
//
// x64sc runs under its own Xvfb display (default :120) with its binary monitor on 127.0.0.1 (default port 6520).
// Sound goes to a WAV file or to the dummy device, never to the host speakers. The processes are ended through
// their own handles.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import zlib from "node:zlib";

export const FPS = 985248 / (312 * 63); // PAL frames per second

class Monitor {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.stops = 0;
    this.stopWaiters = [];
    this.closed = false;
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("close", () => this.fail(new Error("the VICE monitor connection closed")));
    socket.on("error", (error) => this.fail(error));
  }

  fail(error) {
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    for (const { reject } of this.stopWaiters.splice(0)) reject(error);
  }

  receive(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 12) {
      const length = this.buffer.readUInt32LE(2);
      if (this.buffer.length < 12 + length) return;
      const type = this.buffer[6];
      const error = this.buffer[7];
      const id = this.buffer.readUInt32LE(8);
      const body = Buffer.from(this.buffer.subarray(12, 12 + length));
      this.buffer = this.buffer.subarray(12 + length);
      if (id === 0xffffffff) {
        if (type === 0x62) { // stopped
          const waiter = this.stopWaiters.shift();
          if (waiter) waiter.resolve();
          else this.stops += 1;
        }
        continue;
      }
      const request = this.pending.get(id);
      if (!request) continue;
      if (type !== request.expect && error === 0) continue;
      this.pending.delete(id);
      if (error) request.reject(new Error(`VICE monitor command $${request.command.toString(16)} failed with error $${error.toString(16)}`));
      else request.resolve(body);
    }
  }

  /** `expect` is the response type when it differs from the command (checkpoint commands answer with $11). */
  send(command, body = Buffer.alloc(0), expect = command) {
    const id = this.nextId++;
    const header = Buffer.alloc(11);
    header[0] = 2;
    header[1] = 2;
    header.writeUInt32LE(body.length, 2);
    header.writeUInt32LE(id, 6);
    header[10] = command;
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("the VICE monitor connection is closed"));
      this.pending.set(id, { command, expect, resolve, reject });
      this.socket.write(Buffer.concat([header, body]));
    });
  }

  waitForStop(timeoutMs = 30000) {
    if (this.stops > 0) {
      this.stops -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no stop from VICE within ${timeoutMs} ms`)), timeoutMs);
      this.stopWaiters.push({ resolve: () => { clearTimeout(timer); resolve(); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
  }

  async read(start, length) {
    const body = Buffer.alloc(8);
    body.writeUInt16LE(start, 1);
    body.writeUInt16LE(start + length - 1, 3);
    return (await this.send(0x01, body)).subarray(2);
  }

  /** A CPU register: 0 A, 1 X, 2 Y, 3 PC. */
  async register(id) {
    const body = await this.send(0x31, Buffer.from([0]));
    let offset = 2;
    for (let i = 0; i < body.readUInt16LE(0); i += 1) {
      if (body[offset + 1] === id) return body.readUInt16LE(offset + 2);
      offset += 1 + body[offset];
    }
    throw new Error(`VICE reported no register ${id}`);
  }

  /** Stops the CPU whenever it executes `address`. */
  async breakAt(address) {
    const body = Buffer.alloc(8);
    body.writeUInt16LE(address, 0);
    body.writeUInt16LE(address, 2);
    body[4] = 1; // stop
    body[5] = 1; // enabled
    body[6] = 4; // exec
    await this.send(0x12, body, 0x11);
  }

  resume() {
    this.stops = 0;
    return this.send(0xaa);
  }

  /**
   * Sets the joystick in control port 2: 1 up, 2 down, 4 left, 8 right, 16 fire. VICE must run with the
   * "joyport I/O simulation" device (37) in that port; its lines are active low.
   */
  async joystick(bits) {
    const body = Buffer.alloc(4);
    body.writeUInt16LE(1, 0);
    body.writeUInt16LE(~bits & 0x1f, 2);
    await this.send(0xa2, body);
  }

  async palette() {
    const body = await this.send(0x91, Buffer.from([1]));
    const colours = [];
    let offset = 2;
    for (let i = 0; i < body.readUInt16LE(0); i += 1) {
      colours.push([body[offset + 1], body[offset + 2], body[offset + 3]]);
      offset += 1 + body[offset];
    }
    return colours;
  }

  /** The visible picture with `border` pixels around the 320 x 200 window, as RGB bytes. */
  async picture(palette, { borderX = 32, borderY = 35 } = {}) {
    const body = await this.send(0x84, Buffer.from([1, 0]));
    const fields = body.readUInt32LE(0);
    const debugWidth = body.readUInt16LE(4);
    const offsetX = body.readUInt16LE(8);
    const offsetY = body.readUInt16LE(10);
    const pixels = body.subarray(4 + fields + 4);
    const width = 320 + 2 * borderX;
    const height = 200 + 2 * borderY;
    const rgb = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      let source = (offsetY - borderY + y) * debugWidth + offsetX - borderX;
      for (let x = 0; x < width; x += 1) {
        const colour = palette[pixels[source++] ?? 0] ?? [0, 0, 0];
        const at = (y * width + x) * 3;
        rgb[at] = colour[0];
        rgb[at + 1] = colour[1];
        rgb[at + 2] = colour[2];
      }
    }
    return { width, height, rgb };
  }
}

/** Writes RGB pixels as a PNG, scaled by an integer factor. */
export function writePng(file, { width, height, rgb }, scale = 3) {
  const w = width * scale;
  const h = height * scale;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y += 1) {
    let at = y * (1 + w * 3) + 1;
    const row = Math.floor(y / scale) * width;
    for (let x = 0; x < w; x += 1) {
      const from = (row + Math.floor(x / scale)) * 3;
      raw[at++] = rgb[from];
      raw[at++] = rgb[from + 1];
      raw[at++] = rgb[from + 2];
    }
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

function connect(port, attempts) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.removeAllListeners("error");
        resolve(socket);
      });
      socket.once("error", (error) => {
        socket.destroy();
        if (left <= 0) reject(error);
        else setTimeout(() => attempt(left - 1), 100);
      });
    };
    attempt(attempts);
  });
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function startXvfb(first = 120, last = 129) {
  for (let display = first; display <= last; display += 1) {
    if (fs.existsSync(`/tmp/.X${display}-lock`)) continue;
    // -displayfd makes Xvfb report readiness on file descriptor 3.
    const child = spawn("Xvfb", [`:${display}`, "-screen", "0", "1024x768x24", "-nolisten", "tcp", "-displayfd", "3"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    const ready = await new Promise((resolve) => {
      child.stdio[3].once("data", () => resolve(true));
      child.once("exit", () => resolve(false));
      child.once("error", () => resolve(false));
    });
    if (ready) return { child, display: `:${display}` };
  }
  throw new Error(`no free X display between :${first} and :${last}`);
}

/**
 * Starts VICE with a program and stops at `breakAddress` the first time it runs. `wav` names the sound recording;
 * without it the dummy sound device is used.
 */
export async function startVice(prg, { breakAddress, wav, warp = false, logFile } = {}) {
  let port = 6520;
  while (port <= 6529 && !(await portIsFree(port))) port += 1;
  if (port > 6529) throw new Error("no free monitor port between 6520 and 6529");
  const xvfb = await startXvfb();
  const args = [
    "-default",
    "-pal",
    "-sidenginemodel", "257", // reSID, 8580
    "-sound", "-soundrate", "44100",
    ...(wav ? ["-sounddev", "wav", "-soundarg", wav] : ["-sounddev", "dummy"]),
    ...(warp ? ["-warp", "-soundwarpmode", "1"] : []),
    "-controlport2device", "37",
    "-autostartprgmode", "1",
    "-binarymonitor", "-binarymonitoraddress", `ip4://127.0.0.1:${port}`,
    "-autostart", prg,
  ];
  const log = logFile ? fs.openSync(logFile, "w") : "ignore";
  const child = spawn("x64sc", args, { env: { ...process.env, DISPLAY: xvfb.display, SDL_AUDIODRIVER: "dummy", PULSE_SERVER: "none" }, stdio: ["ignore", log, log] });
  let monitor;
  // If this process is ended early, the emulator and its display end with it.
  const kill = () => {
    child.kill("SIGKILL");
    xvfb.child.kill("SIGTERM");
  };
  const onSignal = () => process.exit(1);
  process.once("exit", kill);
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  const stop = async () => {
    const exited = new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve)));
    if (monitor && !monitor.closed) monitor.send(0xbb).catch(() => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    await exited;
    clearTimeout(timer);
    monitor?.socket.destroy();
    xvfb.child.kill("SIGTERM");
    process.removeListener("exit", kill);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  };
  try {
    monitor = new Monitor(await connect(port, 150));
    await monitor.breakAt(breakAddress);
    await monitor.resume();
    await monitor.waitForStop(60000);
  } catch (error) {
    await stop();
    throw error;
  }
  return { monitor, stop, port, display: xvfb.display, args };
}
