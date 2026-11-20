import { analyzeStereoStream } from "/home/claude/c64bridge/src/audio/record_and_analyze_audio.ts";
function stereo(seconds, sr, fn){ const n=Math.floor(seconds*sr); const a=new Int16Array(n*2); for(let i=0;i<n;i++){ const v=fn(i/sr); a[2*i]=Math.round(v*16000); a[2*i+1]=0;} return a;}
const tri=(f)=>t=>{const p=(t*f)%1; return 4*Math.abs(p-0.5)-1;};
for (const f of [32.7,41.2,49,55,61.7,65.4,73.4,82.4,98,110]) {
  const r = await analyzeStereoStream(stereo(1, 47983, tri(f)), 47983);
  const d=r.analysis.voices[0].detected_notes;
  console.log(f, "tri ->", JSON.stringify(d.map(x=>[x.note,x.frequency])).slice(0,100));
}
