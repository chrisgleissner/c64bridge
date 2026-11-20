import { importImageAsVicBitmap } from "/home/claude/c64bridge/src/vicBitmap.ts";
const b = process.resourceUsage().maxRSS;
try { await importImageAsVicBitmap({imagePath:"/tmp/h6/media/big5000.gif",mode:"hires"}); } catch(e:any){ console.log("rejected", e.message.slice(0,60)); }
console.log("maxRSS before MB", Math.round(b/1024), "after MB", Math.round(process.resourceUsage().maxRSS/1024));
