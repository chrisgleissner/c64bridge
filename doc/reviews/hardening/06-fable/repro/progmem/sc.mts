import { screenCodesToAscii } from "/home/claude/c64bridge/src/petscii.ts";
const a = new Uint8Array(1000).fill(0x20); const b = new Uint8Array(1000).fill(0x20); b[40] = 0xA0;
const sa = screenCodesToAscii(a, { columns: 40, rows: 25, charset: "upper" } as any);
const sb = screenCodesToAscii(b, { columns: 40, rows: 25, charset: "upper" } as any);
console.log("equal:", sa === sb, JSON.stringify(sb.slice(0, 90)));
