// Diagnostics meta tools
import type { ToolDefinition } from "../types.js";
import { objectSchema, stringSchema, booleanSchema, numberSchema, optionalSchema } from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolError, ToolExecutionError, toolErrorResult, unknownErrorResult } from "../errors.js";
import { resolveDiagnosticSessionFile, summarizeDiagnosticsSession } from "../../diagnostics.js";

const noArgsSchema = objectSchema<Record<string, never>>({ description: "No arguments", properties: {}, additionalProperties: false });
const performanceReportSchema = objectSchema({
  description: "Summarize timing and diagnostic data from the current or latest MCP session.",
  properties: {
    scope: optionalSchema(stringSchema({ description: "Which diagnostics session to summarize.", enum: ["current", "latest"] }), "current"),
    includeTimeline: optionalSchema(booleanSchema({ description: "Include the tail of the event timeline.", default: true }), true),
    maxEntries: optionalSchema(numberSchema({ description: "Maximum number of span and timeline entries to return.", integer: true, minimum: 1, maximum: 200, default: 25 }), 25),
  },
  required: [],
  additionalProperties: false,
});

export const tools: ToolDefinition[] = [
  {
    name: "firmware_info_and_healthcheck",
    description: "Fetch firmware version and info, probe zero-page read, and return readiness with latencies.",
    summary: "Returns a structured readiness report and endpoint latencies.",
    inputSchema: noArgsSchema.jsonSchema,
    tags: ["diagnostics"],
    examples: [{ name: "Healthcheck", description: "Basic firmware readiness", arguments: {} }],
    async execute(args, ctx) {
      try {
        noArgsSchema.parse(args ?? {});
        const started = Date.now();
        // The three probes are independent: send them together and time each one.
        const probe = async (name: string, call: () => Promise<unknown>, accept: (value: unknown) => boolean = () => true) => {
          const begin = Date.now();
          try {
            const value = await call();
            return { name, started: begin, ended: Date.now(), ok: accept(value), value, error: undefined as unknown };
          } catch (error) {
            return { name, started: begin, ended: Date.now(), ok: false, value: null as unknown, error };
          }
        };
        const client = ctx.client as any;
        const steps = await Promise.all([
          probe("version", () => client.version()),
          probe("info", () => client.info()),
          probe("readmem", () => client.readMemory("$0000", "1"), (value) => (value as any)?.success !== false),
        ]);
        const version = steps[0].ok ? steps[0].value : null;
        const info = steps[1].ok ? steps[1].value : null;

        const ended = Date.now();
        const report = {
          isHealthy: steps.every((s) => s.ok),
          totalLatencyMs: ended - started,
          steps: steps.map((s) => ({ name: s.name, latencyMs: s.ended - s.started, ok: s.ok, error: s.ok ? undefined : (s.error instanceof Error ? s.error.message : s.error === undefined ? "the probe reported failure" : String(s.error)) })),
          version,
          info,
        };
        const result = jsonResult(report, { success: report.isHealthy });
        return report.isHealthy ? result : { ...result, isError: true };
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
  {
    name: "performance_report",
    description: "Summarize MCP session timings, span hot spots, and tool latencies from diagnostics logs.",
    summary: "Returns a structured performance report for the current or latest diagnostics session.",
    inputSchema: performanceReportSchema.jsonSchema,
    tags: ["diagnostics", "performance", "profiling"],
    examples: [{ name: "Current session", description: "Inspect the active MCP session trace", arguments: {} }],
    async execute(args) {
      try {
        const parsed = performanceReportSchema.parse(args ?? {});
        const scope = (parsed.scope as "current" | "latest" | undefined) ?? "current";
        const filePath = resolveDiagnosticSessionFile(scope) ?? resolveDiagnosticSessionFile("latest");
        if (!filePath) {
          throw new ToolExecutionError("No diagnostics session file is available yet");
        }

        const report = summarizeDiagnosticsSession(filePath, {
          includeTimeline: parsed.includeTimeline !== false,
          maxEntries: Number(parsed.maxEntries ?? 25),
        });

        return jsonResult(report, {
          success: true,
          filePath,
          sessionId: report.sessionId,
        });
      } catch (error) {
        if (error instanceof ToolError) return toolErrorResult(error);
        return unknownErrorResult(error);
      }
    },
  },
];
