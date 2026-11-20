import { Jimp } from "/home/claude/c64bridge/node_modules/jimp/dist/esm/index.js";
import { importImageAsVicBitmap } from "/home/claude/c64bridge/src/vicBitmap.ts";
const img = new Jimp({width:200,height:200,color:0x00ff00ff}); // green square
await img.write("/tmp/h6/media/sq.png");
for (const mode of ["multicolor","hires"] as const) {
 const p = await importImageAsVicBitmap({imagePath:"/tmp/h6/media/sq.png",mode,backgroundColor:0});
 // measure coloured extent: count columns of cells where bitmap non-zero
 let cols=new Set<number>(), rows=new Set<number>();
 for (let c=0;c<1000;c++){ let nz=false; for(let r=0;r<8;r++) if(p.bitmapData[c*8+r]) nz=true; if(nz){cols.add(c%40);rows.add(Math.floor(c/40));}}
 console.log(mode,"cells wide",cols.size,"cells tall",rows.size, "screen0",p.screenRam[0].toString(16),"col0",p.colorRam[0]);
}
