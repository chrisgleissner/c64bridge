import { writeFileSync } from "node:fs";
process.env.C64_TASK_STATE_FILE = "/tmp/h6/meta/state3/tasks.json";
const now = new Date().toISOString();
// A task left behind by a previous server process that had the SAME pid (container restart: pid is typically identical).
writeFileSync("/tmp/h6/meta/state3/tasks.json", JSON.stringify({ tasks: [{
  ownerPid: process.pid, ownerSession: "previous-session", id: "previous-session_1_poll", name: "poll", type: "background",
  operation: "read", args: {}, intervalMs: 1000, iterations: 5, status: "running", startedAt: now, updatedAt: now,
  stoppedAt: null, lastError: null, lastResult: null, nextRunAt: null, folder: "tasks/background/previous-session_1_poll", backendId: null }] }));
const { tools } = await import("/home/claude/c64bridge/src/tools/meta/background.ts");
const by = Object.fromEntries(tools.map(t => [t.name, t]));
const ctx: any = { client: { readMemory: async () => ({ success: true, data: "$00" }) }, logger: console };
const l = await by.list_background_tasks.execute({}, ctx);
console.log("list:", JSON.stringify((l.structuredContent as any).data.tasks.map((t:any)=>({n:t.name,s:t.status,e:t.lastError}))));
const s = await by.stop_background_task.execute({ name: "poll" }, ctx);
console.log("stop:", s.isError, (s.content[0] as any).text.slice(0, 120));
const st = await by.start_background_task.execute({ name: "poll", operation: "read", intervalMs: 1000 }, ctx);
console.log("start:", st.isError, (st.content[0] as any).text.slice(0, 140));
const d = await by.delete_background_task.execute({ name: "poll" }, ctx);
console.log("delete:", d.isError, (d.content[0] as any).text.slice(0, 120));
process.exit(0);
