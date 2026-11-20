import { parseSidwave } from "/home/claude/c64bridge/src/sidwave.ts";
import { compileSidwaveToPrg } from "/home/claude/c64bridge/src/sidwaveCompiler.ts";
function run(name, obj){ const t=Date.now(); try{ const d=parseSidwave(obj); const r=compileSidwaveToPrg(d); console.log(name,"OK",r.prg.length,Date.now()-t,"ms");}catch(e){console.log(name,"ERR",String(e.message).slice(0,160),Date.now()-t,"ms")} }
const base = (len, tempo, bars, extra={}) => ({sidwave:"1.0",tempo,voices:[1,2,3].map(id=>({id,patterns:{A:{groove:["C4"],length:len,...extra}}})),timeline:[{bars,layers:{v1:"A",v2:"A",v3:"A"}}]});
run("dense len .03 tempo30 4096 bars", base(0.03,30,4096));
run("dense len .05 tempo30 4096 bars", base(0.05,30,4096));
run("len 1 tempo 220 4096 bars", base(1,220,4096));
// big yaml nesting
let y = "a: ".repeat(1); 
const t=Date.now(); try{ parseSidwave("["+"[".repeat(5000)+"]".repeat(5000)+"]"); }catch(e){console.log("deep",String(e.message).slice(0,100),Date.now()-t)}
// many patterns / many instruments
const pats={}; for(let i=0;i<20000;i++) pats["p"+i]={groove:["C4"]};
run("20000 patterns", {sidwave:"1.0",voices:[{id:1,patterns:pats}],timeline:[{bars:1,layers:{v1:"p1"}}]});
// huge groove
run("groove 200000 entries", {sidwave:"1.0",voices:[{id:1,patterns:{A:{groove:Array(200000).fill("C4")}}}],timeline:[{bars:1,layers:{v1:"A"}}]});
// timeline 100000 sections 
run("timeline 100000 sections", {sidwave:"1.0",voices:[{id:1,patterns:{A:{groove:["C4"]}}}],timeline:Array(100000).fill({bars:1,layers:{v1:"A"}})});
