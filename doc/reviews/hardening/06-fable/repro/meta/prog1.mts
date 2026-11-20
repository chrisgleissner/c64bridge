import { mkdirSync } from "node:fs";
mkdirSync("/tmp/h6/meta/p", { recursive: true });
process.chdir("/tmp/h6/meta/p");
const prog = (await import("/home/claude/c64bridge/src/tools/meta/program.ts")).tools;
const fsx = (await import("/home/claude/c64bridge/src/tools/meta/filesystem.ts")).tools;
const P = Object.fromEntries(prog.map(t => [t.name, t])), F = Object.fromEntries(fsx.map(t => [t.name, t]));
const client: any = {
  runPrgFile: async () => ({ success: true }), runCrtFile: async () => ({ success: true }),
  readScreen: async () => "SOMETHING ELSE ENTIRELY", reset: async () => ({ success: true }),
  readMemory: async () => ({ success: true, data: "$FF" }),
};
const ctx: any = { client, logger: console, platform: { id: "c64u" } };
const r = await P.batch_run_with_assertions.execute({ programs: [{ path: "/x/a.prg", assertions: [{ type: "screen_contains" }, { type: "memory_equals", address: "$0400" }] }], durationMs: 1, resetDelayMs: 0, outputPath: "/tmp/h6/meta/p/out" }, ctx);
console.log("assert no pattern:", r.isError, JSON.stringify((r as any).structuredContent?.data));
// failing case: what does the client see?
const client2: any = { ...client };
const r2 = await P.batch_run_with_assertions.execute({ programs: [{ path: "/x/a.prg", assertions: [{ type: "screen_contains", pattern: "NOPE" }] }], durationMs: 1, resetDelayMs: 0, outputPath: "/tmp/h6/meta/p/out2" }, { ...ctx, client: client2 });
console.log("failing result visible to client:", r2.isError, JSON.stringify((r2 as any).structuredContent?.data), "| text:", (r2.content[0] as any).text.slice(0,200));
// unbounded extensions
let n = 0;
const c3: any = { filesInfo: async () => { n++; const e: any = new Error("nf"); e.response = { status: 404 }; throw e; } };
const ac = new AbortController(); ac.abort();
const exts = Array.from({ length: 3000 }, (_, i) => "e" + i);
const t0 = Date.now();
const r3 = await F.find_paths_by_name.execute({ nameContains: "x", extensions: exts }, { client: c3, logger: console, signal: ac.signal } as any);
console.log("find_paths with aborted signal, 3000 exts: filesInfo calls =", n, "ms", Date.now() - t0, "isError", r3.isError);
