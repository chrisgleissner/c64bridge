import { analyzeStereoStream } from "/home/claude/c64bridge/src/audio/record_and_analyze_audio.ts";
function stereo(seconds, sr, fn){ const n=Math.floor(seconds*sr); const a=new Int16Array(n*2); for(let i=0;i<n;i++){ const v=fn(i/sr); a[2*i]=Math.round(v*16000)+26900; a[2*i+1]=20000;} return a;}
async function t(name, secs, sr, fn){ const s=Date.now(); const r=await analyzeStereoStream(stereo(secs,sr,fn), sr); const el=Date.now()-s; console.log(name, el+"ms", JSON.stringify(r.analysis.voices[0].detected_notes.slice(0,4)), JSON.stringify(r.analysis.global_metrics)); }
await t("sine440 3s 47983", 3, 47983, t=>Math.sin(2*Math.PI*440*t));
await t("sine 110 3s", 3, 47983, t=>Math.sin(2*Math.PI*110*t));
await t("sine 3000 3s", 3, 47983, t=>Math.sin(2*Math.PI*3000*t));
await t("pulse 440 25% 3s", 3, 47983, t=>((t*440)%1)<0.25?1:-1);
await t("saw 261.63 3s", 3, 47983, t=>2*((t*261.63)%1)-1);
await t("sine 55 (A1) 3s", 3, 47983, t=>Math.sin(2*Math.PI*55*t));
await t("sine440 30s", 30, 47983, t=>Math.sin(2*Math.PI*440*t));
await t("two-note 1s each", 2, 47983, t=>Math.sin(2*Math.PI*(t<1?440:660)*t));
