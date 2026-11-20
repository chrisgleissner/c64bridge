import { Jimp } from "/home/claude/c64bridge/node_modules/jimp/dist/esm/index.js";
import { importImageAsVicBitmap } from "/home/claude/c64bridge/src/vicBitmap.ts";
import { statSync } from "node:fs";
const big = new Jimp({width:5000,height:5000,color:0x000000ff});
await big.write("/tmp/h6/media/big5000.gif" as any);
console.log("gif bytes", statSync("/tmp/h6/media/big5000.gif").size);
const before = process.memoryUsage().rss;
try { await importImageAsVicBitmap({imagePath:"/tmp/h6/media/big5000.gif",mode:"hires"}); console.log("accepted"); } catch(e:any){ console.log("rejected:", e.message.slice(0,90)); }
console.log("rss delta MB", Math.round((process.memoryUsage().rss-before)/1e6));
