import { basicToPrg } from "/home/claude/c64bridge/src/tools/translation/basicTokenizer.ts";
import { listBasicProgram, detokenizeLine } from "/home/claude/c64bridge/src/tools/translation/basicDetokenizer.ts";
import { encodeStringWithNames } from "/home/claude/c64bridge/src/petscii.ts";
const hex=(b:Uint8Array|number[])=>[...b].map(x=>x.toString(16).padStart(2,"0")).join(" ");
// color names
for (const n of ["clr","clear","home","red","blue","white","wht","blk","black","cyn","cyan","pur","purple","grn","green","yel","yellow","org","orange","brn","brown","lred","lightred","dgry","gry1","lgrn","lblu","lgry","rvs on","rvs off","rvon","rvoff","reverse on","down","up","left","right","cursor down","cursor up","cursor left","cursor right","crsr down","inst","del","delete","insert","return","cr","space","shift return","f1","f2","f3","f4","f5","f6","f7","f8","lowercase","uppercase","pi","heart","spade","club","diamond","cursor home","clear screen","upper case","lower case","swlc","swuc","stop","run/stop"]) {
  const b=encodeStringWithNames(`{${n}}`,{foldLowercase:true});
  console.log(n.padEnd(14), b.length===1? "OK "+hex(b): "LITERAL (not recognised)");
}
// NUL / control chars
for (const s of [`10 PRINT "A\u0000B"`,`10 REM A\u0000B`,`10 A=1\u0000:B=2`]) {
  const p=basicToPrg(s); console.log(JSON.stringify(s), hex(p));
  try{console.log(JSON.stringify(listBasicProgram(p.subarray(2),0x801)))}catch(e:any){console.log("detok ERR",e.message)}
}
// long line
const long="10 PRINT "+Array.from({length:60},(_,i)=>`"ABCDEFGHIJ";`).join("");
const pl=basicToPrg(long); console.log("long line bytes",pl.length-2-5);
const veryLong="10 REM "+"X".repeat(300); const pv=basicToPrg(veryLong); console.log("REM 300",pv.length);
// startAddress
for (const a of [-1,0x10000,NaN,1.5,0x0400,0xa000,0x9fff, 0xc000]) { try{const p=basicToPrg(`10 PRINT`,{startAddress:a});console.log("start",a,hex(p.subarray(0,6)))}catch(e:any){console.log("start",a,"ERR",e.constructor.name,e.message.slice(0,100))}}
// size limit
let big=""; for(let i=0;i<6000;i++) big+=`${i*10} PRINT "HELLO WORLD ${i}"\n`;
try{const p=basicToPrg(big);console.log("big ok",p.length)}catch(e:any){console.log("big ERR",e.message)}
// perf
let prog=""; for(let i=0;i<500;i++) prog+=`${(i+1)*10} IF A${i%26}>=${i} THEN PRINT "LINE ${i}";CHR$(${i%256});:GOTO ${(i+2)*10}:REM SOME COMMENT ${i}\n`;
let t=performance.now(); const pp=basicToPrg(prog); console.log("500 lines ms",(performance.now()-t).toFixed(1),"bytes",pp.length);
t=performance.now(); const L=listBasicProgram(pp.subarray(2),0x801); console.log("detok ms",(performance.now()-t).toFixed(1),L.lines.length);
// roundtrip all tokens
import { basicTokenText } from "/home/claude/c64bridge/src/tools/translation/basicTokenizer.ts";
let miss:string[]=[]; for(let b=0x80;b<=0xff;b++) if(!basicTokenText(b)) miss.push(b.toString(16));
console.log("tokens without text:",miss.join(","));
// detok of control/shifted chars
console.log(detokenizeLine(Uint8Array.from([0x22,0x93,0x41,0xc1,0x61,0x22,0xff,0x5e,0x5f,0x5c,0x7b,0x7d])));
// roundtrip of detok output
const rt=basicToPrg(`10 PRINT "{$93}HI{$C1}"`); console.log(hex(rt));
// quotes in DATA / REM before line numbers
console.log(hex(basicToPrg(`10 DATA "A,B:C",D:PRINT "E":REM "F`)));
// Statement: GOTO inside strings after REM etc and IF...THEN with GO TO
console.log(hex(basicToPrg(`10 IF A THEN GO TO 20`)));
console.log(hex(basicToPrg(`10 PRINT"A"AND"B"`)));
