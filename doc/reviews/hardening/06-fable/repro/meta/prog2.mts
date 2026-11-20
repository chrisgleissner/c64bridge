import { mkdirSync, readFileSync } from "node:fs";
mkdirSync("/tmp/h6/meta/p", { recursive: true });
process.chdir("/tmp/h6/meta/p");
const prog = (await import("/home/claude/c64bridge/src/tools/meta/program.ts")).tools;
const P = Object.fromEntries(prog.map(t => [t.name, t]));
const client: any = { runPrgFile: async () => ({ success: true }), readScreen: async () => "GURU MEDITATION", reset: async () => ({ success: true }) };
const r = await P.batch_run_with_assertions.execute({ programs: [{ path: "/x/a.prg", assertions: [{ type: "screen_contains" }] }], durationMs: 1, resetDelayMs: 0, outputPath: "/tmp/h6/meta/p/out3" }, { client, logger: console, platform: { id: "c64u" } } as any);
console.log(JSON.stringify((r as any).structuredContent?.data), JSON.stringify((r as any).metadata));
console.log(readFileSync("/tmp/h6/meta/p/out3/results.json","utf8").replace(/\s+/g," "));
