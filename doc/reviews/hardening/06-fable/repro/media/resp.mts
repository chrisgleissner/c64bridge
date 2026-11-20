import { toCallToolResult } from "/home/claude/c64bridge/src/mcp/callToolResult.ts";
import { jsonResult } from "/home/claude/c64bridge/src/tools/responses.ts";
const payload = { value: { Audio: { Volume: "1", Mixer: "x".repeat(1000) } } };
const r = toCallToolResult(jsonResult(payload, { success: true, category:"Audio", item:null, details: payload, raw: payload }));
console.log(JSON.stringify(r).length, JSON.stringify(payload).length, Object.keys(r));
