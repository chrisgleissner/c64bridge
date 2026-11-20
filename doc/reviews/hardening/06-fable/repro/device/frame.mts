import { parseVideoPacket, collectCompleteVideoFrames } from "/home/claude/c64bridge/src/streamCapture.ts";
const pkt = (line: number, last = false) => { const b = Buffer.alloc(12 + 192 * 4); b.writeUInt16LE(7, 2); b.writeUInt16LE(line | (last ? 0x8000 : 0), 4); b.writeUInt16LE(384, 6); b[8] = 4; b[9] = 4; return parseVideoPacket(b); };
const packets = [];
for (let line = 4; line < 268; line += 4) packets.push(pkt(line));   // lines 0-3 missing
packets.push(pkt(268, true));                                        // last packet: expected height 272
packets.push(pkt(400));                                              // stray lines 400-403
const frames = collectCompleteVideoFrames(packets, 1);
console.log(JSON.stringify(frames.map((f) => ({ width: f.width, height: f.height, complete: f.complete }))));
