import { analyzeStereoStream } from "/home/claude/c64bridge/src/audio/record_and_analyze_audio.ts";
function stereo(seconds, sr, fn){ const n=Math.floor(seconds*sr); const a=new Int16Array(n*2); for(let i=0;i<n;i++){ const v=fn(i/sr); a[2*i]=Math.round(v*16000); a[2*i+1]=0;} return a;}
const exp = {sidwave:"1.0",voices:[{id:1,patterns:{A:{groove:["C4"]},B:{motif:"E4 G4"}}}],timeline:[{bars:1,layers:{v1:"A"}}]};
// measured G4 (392 Hz) which is in motif B (valid) but expected set only has C4
const r = await analyzeStereoStream(stereo(1,47983,t=>Math.sin(2*Math.PI*392*t)),47983,exp);
console.log(JSON.stringify(r.analysis.voices[0].detected_notes), r.analysis.global_metrics.average_pitch_deviation);
// layer transposed octave: A4 expected, tone A5
const exp2 = {sidwave:"1.0",voices:[{id:1,patterns:{A:{groove:["A4"]}}}],timeline:[{bars:1,layers:{v1:"A^"}}]};
const r2 = await analyzeStereoStream(stereo(1,47983,t=>Math.sin(2*Math.PI*880*t)),47983,exp2);
console.log(JSON.stringify(r2.analysis.voices[0].detected_notes), r2.analysis.global_metrics.average_pitch_deviation);
