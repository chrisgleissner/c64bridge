import { audioModule } from "/home/claude/c64bridge/src/tools/audio.ts";
const logger={info(){},warn(){},debug(){},error(){}};
const ctx:any={client:{},logger,platform:{id:"vice"},setPlatform(){}};
const src = "sidwave: 1.0\ntempo: 120\nvoices:\n  - id: 1\n    patterns: { A: { groove: [C4, E4] } }\ntimeline:\n  - { bars: 1, layers: { v1: A } }\n";
const r:any = await audioModule.invoke("music_compile_and_play",{sidwave:src,output:"sid",dryRun:true},ctx);
console.log(JSON.stringify(r.metadata), Object.keys(r.structuredContent.data));
