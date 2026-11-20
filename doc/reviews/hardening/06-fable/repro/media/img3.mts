import { importImageAsVicBitmap } from "/home/claude/c64bridge/src/vicBitmap.ts";
const p = await importImageAsVicBitmap({imagePath:"/tmp/h6/media/sq.png",mode:"multicolor",backgroundColor:0});
const cols=new Set<number>(), rows=new Set<number>();
for (let c=0;c<1000;c++) if (p.screenRam[c]!==0){cols.add(c%40);rows.add(Math.floor(c/40));}
console.log("multicolor square 200x200 -> cells",cols.size,"x",rows.size, "(each cell 8px wide x 8px tall on screen)");
