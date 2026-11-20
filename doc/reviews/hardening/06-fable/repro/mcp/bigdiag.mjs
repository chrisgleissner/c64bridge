import { writeFileSync, appendFileSync, mkdtempSync, statSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
const { summarizeDiagnosticsSession } = await import("/home/claude/c64bridge/dist/diagnostics.js");
const dir = mkdtempSync(join(tmpdir(), "h6diag-")); const f = join(dir, "x.ndjson");
const rec = (i, ev) => JSON.stringify({ ts: new Date(1795000000000 + i).toISOString(), pid: 1, sessionId: "s", component: "mcp-server", event: ev, details: { spanId: "a-" + i, category: "client", name: "read_screen", outcome: "ok", durationMs: 1.234, details: {} } });
const chunk = []; for (let i = 0; i < 10000; i++) chunk.push(rec(i, i % 2 ? "perf_span_end" : "perf_span_start"));
const block = chunk.join("\n") + "\n";
const MB = Number(process.argv[2] ?? 100);
while (statSync(f, { throwIfNoEntry: false })?.size ?? 0 < MB * 1024 * 1024) { appendFileSync(f, block); if (statSync(f).size >= MB * 1024 * 1024) break; }
const size = statSync(f).size;
const m0 = process.memoryUsage().rss; const s = performance.now();
const r = summarizeDiagnosticsSession(f, { includeTimeline: true, maxEntries: 25 });
console.log(`file ${(size/1048576).toFixed(0)} MiB, ${r.eventCount} records: summarize blocked ${(performance.now()-s).toFixed(0)} ms, rss +${((process.memoryUsage().rss-m0)/1048576).toFixed(0)} MiB`);
