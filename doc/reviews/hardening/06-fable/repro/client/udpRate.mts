// Mirrors captureC64uVideoFramesOnce's message handler (c64Client.ts:1891-1908) against a loopback
// sender at the firmware rate: 50 frames/s x 68 packets of 4 lines (384 x 272, 4 bpp).
import { createSocket } from "node:dgram";
import { Buffer } from "node:buffer";
import { parseVideoPacket, collectCompleteVideoFrames } from "/home/claude/c64bridge/src/streamCapture.ts";
const count = Number(process.argv[2] ?? 8);
const rx = createSocket("udp4"); const tx = createSocket("udp4");
await new Promise<void>((r) => rx.bind(0, "127.0.0.1", () => r()));
const port = (rx.address() as any).port;
const packets: any[] = []; const t0 = performance.now(); let received = 0;
const timeoutMs = Math.max(1500, count * 750);
const result = await new Promise<string>((resolve) => {
  const timer = setTimeout(() => resolve(`TIMEOUT after ${timeoutMs}ms`), timeoutMs);
  rx.on("message", (msg) => {
    received++;
    const p = parseVideoPacket(Buffer.from(msg)); packets.push(p);
    const frames = collectCompleteVideoFrames(packets, count);
    if (frames.length >= count) { clearTimeout(timer); resolve(`OK ${frames.length} frames`); }
  });
  let seq = 0, frame = 0;
  const send = setInterval(() => { // one frame every 20 ms
    for (let l = 0; l < 272; l += 4) {
      const b = Buffer.alloc(12 + 768);
      b.writeUInt16LE(seq++ & 0xffff, 0); b.writeUInt16LE(frame & 0xffff, 2);
      b.writeUInt16LE(l | (l === 268 ? 0x8000 : 0), 4); b.writeUInt16LE(384, 6); b.writeUInt8(4, 8); b.writeUInt8(4, 9);
      tx.send(b, port, "127.0.0.1");
    }
    frame++;
  }, 20);
  setTimeout(() => clearInterval(send), timeoutMs + 100);
});
console.log(JSON.stringify({ count, result, elapsedMs: Math.round(performance.now() - t0), received, sentApprox: Math.round((performance.now() - t0) / 20) * 68 }));
process.exit(0);
