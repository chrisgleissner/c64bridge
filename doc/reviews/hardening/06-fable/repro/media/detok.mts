import { detokenizeLine } from "/home/claude/c64bridge/src/tools/translation/basicDetokenizer.ts";
import { basicToPrg } from "/home/claude/c64bridge/src/tools/translation/basicTokenizer.ts";
// 10 PRINT"<$C1 $61 $41>"   : $C1 = shifted A (graphic in default set), $61 = shifted-A graphic, $41 = letter A
const line = Uint8Array.from([0x99,0x22,0xC1,0x61,0x41,0x22]);
console.log(JSON.stringify(detokenizeLine(line)));
// round trip: detokenised text re-tokenised
const txt = detokenizeLine(line); const prg = basicToPrg("10 "+txt); console.log([...prg.subarray(4+2)].map(b=>b.toString(16)).join(" "));
