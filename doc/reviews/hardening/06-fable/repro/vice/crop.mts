import { C64Client } from "/home/claude/c64bridge/src/c64Client.ts";
const c: any = Object.create(C64Client.prototype);
const W=384,H=272, ox=32, oy=35, iw=320, ih=200;
function frame(border:number, bg:number, textRows:number[]) {
  const p = new Uint8Array(W*H).fill(border);
  for (let y=0;y<ih;y++) for (let x=0;x<iw;x++) p[(oy+y)*W+ox+x]=bg;
  for (const r of textRows) for (let y=r*8;y<r*8+8;y++) for (let x=0;x<160;x++) if (x%2==0) p[(oy+y)*W+ox+x]=1;
  return { debugWidth:W, debugHeight:H, offsetX:ox, offsetY:oy, innerWidth:iw, innerHeight:ih, bitsPerPixel:8, pixels:p };
}
for (const [name,f] of [["black border/black bg, 5 text rows", frame(0,0,[0,1,2,3,4])],["black border/black bg, text on rows 10-14", frame(0,0,[10,11,12,13,14])],["blue border/bg (default look)", frame(14,6,[0,1,2,3,4])]] as const) {
  const r = c.normaliseViceDisplaySnapshot(f);
  console.log(name, "->", r.width+"x"+r.height, "(documented inner area 320x200 at 32,35)");
}
