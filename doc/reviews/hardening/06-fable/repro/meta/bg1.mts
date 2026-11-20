process.env.C64_TASK_STATE_FILE = "/tmp/h6/meta/state1/tasks.json";
const { tools } = await import("/home/claude/c64bridge/src/tools/meta/background.ts");
const by = Object.fromEntries(tools.map(t => [t.name, t]));
let calls = 0;
const client: any = { readMemory: async () => { calls++; return { success: true, data: "$00" }; } };
const ctx: any = { client, logger: console };
const r = await by.start_background_task.execute({ name: "big", operation: "read", arguments: { address: "$0400", length: "1" }, intervalMs: 3_000_000_000 }, ctx);
console.log(JSON.stringify(r.structuredContent ?? r.content).slice(0, 300));
await new Promise(r => setTimeout(r, 1500));
console.log("calls after 1.5s with intervalMs=3e9:", calls);
await by.stop_all_background_tasks.execute({}, ctx);
// bad-address task
calls = 0;
const r2 = await by.start_background_task.execute({ name: "bad", operation: "read", arguments: { address: "zzz" }, intervalMs: 100 }, ctx);
console.log("start bad:", JSON.stringify(r2.structuredContent?.data ?? r2.content).slice(0,200));
await new Promise(r => setTimeout(r, 400));
const l = await by.list_background_tasks.execute({}, ctx);
console.log(JSON.stringify((l.structuredContent as any).data.tasks.map((t:any)=>({n:t.name,s:t.status,e:t.lastError,i:t.iterations}))));
process.exit(0);
