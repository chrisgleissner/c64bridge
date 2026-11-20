import { Buffer } from "node:buffer";
import { parseVideoPacket, collectCompleteVideoFrames } from "/home/claude/c64bridge/src/streamCapture.ts";
function pkt(seq:number, frame:number, line:number, last:boolean){
  const b = Buffer.alloc(12 + 192*4);
  b.writeUInt16LE(seq&0xffff,0); b.writeUInt16LE(frame&0xffff,2);
  b.writeUInt16LE(line | (last?0x8000:0),4); b.writeUInt16LE(384,6); b.writeUInt8(4,8); b.writeUInt8(4,9); b.writeUInt16LE(0,10);
  return parseVideoPacket(b);
}
function run(count:number, frames:number, dropOne:boolean){
  const packets:any[] = []; let seq=0; const t=performance.now(); let maxStep=0; let done=false;
  outer: for (let f=0; f<frames; f++) for (let l=0; l<272; l+=4){
    if (dropOne && l===100) continue;
    packets.push(pkt(seq++, f, l, l===268));
    const s=performance.now();
    const got = collectCompleteVideoFrames(packets, count);
    maxStep=Math.max(maxStep, performance.now()-s);
    if (got.length>=count){ done=true; break outer; }
  }
  console.log(JSON.stringify({count, frames, dropOne, packets: packets.length, done, totalMs: Math.round(performance.now()-t), maxPerPacketMs: +maxStep.toFixed(1)}));
}
run(1, 2, false);
run(8, 9, false);
run(32, 33, false);
// frames never complete: 5 s of stream at 50 fps
run(1, 250, true);
