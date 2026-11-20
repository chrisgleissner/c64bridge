import { parseSidwave } from "/home/claude/c64bridge/src/sidwave.ts";
for (const y of ['voices:\n  - id: 1\n    patterns:\n      A: { groove: [C4, ~, E4] }\ntimeline:\n  - { bars: 1, layers: { v1: A } }\n',
 'voices:\n  - id: 1\n    patterns:\n      A: { groove: [C4, "~", E4, ".", n] }\ntimeline:\n  - { bars: 1, layers: { v1: A } }\n']) {
 try { parseSidwave(y); console.log("OK"); } catch(e:any){ console.log(e.message); } }
