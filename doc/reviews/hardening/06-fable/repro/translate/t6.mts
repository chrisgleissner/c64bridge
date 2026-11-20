import { assemblyToPrgDetailed } from "/home/claude/c64bridge/src/tools/translation/assembler.ts";
function time(label:string,src:string){const t=performance.now();try{const r=assemblyToPrgDetailed(src);console.log(label,"ok len",r.prg.length,"ms",(performance.now()-t).toFixed(0),"srcKB",(src.length/1024).toFixed(0))}catch(e:any){console.log(label,"ERR",e.message.slice(0,100),"ms",(performance.now()-t).toFixed(0))}}
// 5000-line realistic
let s="* = $c000\n";
for(let i=0;i<1000;i++){ s+=`l${i}: lda #$${(i%256).toString(16)}\n sta $0400+${i%900}\n ldx #<l${i}\n ldy #>l${(i+1)%1000}\n bne l${i}\n`;}
time("5000-line",s);
let s2="* = $c000\n"; for(let i=0;i<5000;i++) s2+=`  nop ; line ${i}\n`; time("5000 nop",s2);
// quadratic res
for (const n of [5000,10000,20000]) { let r="* = $8000\nnop\n"; for(let i=0;i<n;i++) r+=`* = $${(0x8000+n-i).toString(16)}\n.res 1\n`; time("res desc "+n,r);}
// deep parens
time("deep parens 50000","lda #"+"(".repeat(50000)+"1"+")".repeat(50000));
time("deep unary 50000","lda #"+"-".repeat(50000)+"1");
time("long line","* = $c000\n.byte "+"1,".repeat(30000)+"1");
let m="* = $c000\n"; for(let i=0;i<60000;i++) m+=`x${i} = ${i}\n`; time("60000 equates",m);
let m2="* = $c000\nbuf: .res 1\n"; for(let i=0;i<60000;i++) m2+=`.res 0\n`; time("60000 res 0",m2);
