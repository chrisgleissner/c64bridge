import { parseSidwave } from "/home/claude/c64bridge/src/sidwave.ts";
import { compileSidwaveToPrg, compileSidwaveToSid, hzToSidFrequency, arrangeSidwave } from "/home/claude/c64bridge/src/sidwaveCompiler.ts";
const doc = parseSidwave({sidwave:"1.0",tempo:120,voices:[{id:1,waveform:"pulse",pulse_width:0.5,patterns:{A:{groove:["A4","C5"],length:"2"}}}],timeline:[{bars:2,layers:{v1:"A"}}]});
const arr = arrangeSidwave(doc);
console.log(JSON.stringify(arr.voices[0].notes));
const doc2 = parseSidwave({sidwave:"1.0",tempo:120,voices:[{id:1,patterns:{A:{groove:["A4","C5"],transpositions:["5"]}}}],timeline:[{bars:2,layers:{v1:"A"}}]});
try { console.log(JSON.stringify(arrangeSidwave(doc2).voices[0].notes)); } catch(e){console.log("ERR",e.message)}
const doc3 = parseSidwave({sidwave:"1.0",tempo:120,voices:[{id:1,patterns:{A:{groove:["A4","C5"],length:1}}}],timeline:[{bars:2,layers:{v1:"A"}}]});
console.log(JSON.stringify(arrangeSidwave(doc3).voices[0].notes));
console.log(hzToSidFrequency(440,"PAL"),hzToSidFrequency(440,"NTSC"));
