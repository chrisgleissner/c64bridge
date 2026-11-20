import { buildEpsonBitmapBasicProgram, buildCommodoreBitmapBasicProgram } from "/home/claude/c64bridge/src/c64Client.ts";
import { basicToPrg } from "/home/claude/c64bridge/src/tools/translation/basicTokenizer.ts";
const e = buildEpsonBitmapBasicProgram({columns:Array(480).fill(170)});
console.log(e.split("\n").slice(0,7).join("\n")); basicToPrg(e); console.log("tokenizes OK, accepted; 4 header + 480 columns = 484 chars in A$ (BASIC limit 255)");
const c = buildCommodoreBitmapBasicProgram({columns:Array(480).fill(170)}); basicToPrg(c); console.log("cbm 480 cols accepted too");
