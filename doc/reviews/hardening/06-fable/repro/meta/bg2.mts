import { rmSync } from "node:fs";
process.env.C64BRIDGE_ENABLE_TEST_DIAGNOSTICS="1"; process.env.C64BRIDGE_DIAGNOSTICS_DIR="/tmp/h6/meta/diag";
process.env.C64_TASK_STATE_FILE = "/tmp/h6/meta/state2/tasks.json";
const { tools } = await import("/home/claude/c64bridge/src/tools/meta/background.ts");
const by = Object.fromEntries(tools.map(t => [t.name, t]));
const client: any = { readMemory: async () => ({ success: true, data: "$00" }) };
const ctx: any = { client, logger: console };
const r = await by.start_background_task.execute({ name: "t", operation: "read", intervalMs: 100 }, ctx);
const folder = (r.structuredContent as any).data.task.folder;
console.log("started", folder.slice(0, 40));
rmSync("/tmp/h6/meta/state2/" + folder, { recursive: true, force: true });  // e.g. tmp cleaner / user rm
await new Promise(r => setTimeout(r, 1500));
const l = await by.list_background_tasks.execute({}, ctx);
console.log(JSON.stringify((l.structuredContent as any).data.tasks.map((t:any)=>({s:t.status,e:t.lastError,i:t.iterations}))));
process.exit(0);
