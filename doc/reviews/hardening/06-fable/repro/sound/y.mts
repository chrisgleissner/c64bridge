import Pitchfinder from "/home/claude/wt/G2/node_modules/pitchfinder/lib/index.js";
const sr=47983; const tri=(f:number)=>(i:number)=>{const p=(i/sr*f)%1; return 4*Math.abs(p-0.5)-1;};
for (const N of [2048,3072,4096,8192]) { const yin=Pitchfinder.YIN({sampleRate:sr}); const row:any[]=[];
 for (const f of [32.7,41.2,55,65.4,82.4,98]) { const b=new Float32Array(N); for(let i=0;i<N;i++) b[i]=tri(f)(i+1000); const t=performance.now(); const r=yin(b); row.push([f,r&&+r.toFixed(1),+(performance.now()-t).toFixed(1)]); }
 console.log(N, JSON.stringify(row)); }
