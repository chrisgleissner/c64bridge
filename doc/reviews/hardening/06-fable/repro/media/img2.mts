import { importImageAsVicBitmap } from "/home/claude/c64bridge/src/vicBitmap.ts";
for (const bg of [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]) {
  try { await importImageAsVicBitmap({imagePath:"/tmp/h6/media/sq.png",mode:"hires",backgroundColor:bg}); console.log(bg,"ok"); } catch(e:any){ console.log(bg,"FAIL",e.message.slice(0,60)); }
}
