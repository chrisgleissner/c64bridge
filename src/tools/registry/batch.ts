import {
  defineToolModule,
  type ToolExecutionContext,
} from "../types.js";
import { getPlatformStatus } from "../../platform.js";
import {
  arraySchema,
  booleanSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "../schema.js";
import { jsonResult } from "../responses.js";
import { ToolValidationError, unknownErrorResult } from "../errors.js";

const commandSchema = objectSchema<Record<string, unknown>>({
  description: "A single batch command.",
  properties: {
    tool: stringSchema({ description: "MCP tool name (e.g. c64_memory, c64_debug).", minLength: 1 }),
    args: objectSchema<Record<string, unknown>>({
      description: "Arguments to pass to the tool (must include 'op' for grouped tools).",
      properties: {},
      additionalProperties: true,
    }),
    description: optionalSchema(stringSchema({ description: "Optional label for this command in the result.", maxLength: 128 })),
  },
  required: ["tool", "args"],
  additionalProperties: false,
});

const executeBatchArgsSchema = objectSchema({
  description: "Execute multiple tool calls in one request.",
  properties: {
    commands: arraySchema(commandSchema, {
      description: "Ordered list of commands to execute.",
      minItems: 1,
    }),
    stopOnError: optionalSchema(booleanSchema({
      description: "Halt the batch after the first failure. Default: true.",
      default: true,
    })),
  },
  required: ["commands"],
  additionalProperties: false,
});

interface BatchResult {
  index: number;
  tool: string;
  description?: string;
  success: boolean;
  result?: unknown;
  error?: string;
  elapsedMs: number;
}

export const batchModuleGroup = defineToolModule({
  domain: "batch",
  summary: "Execute multiple tool calls in a single MCP request for reduced round-trip overhead.",
  supportedPlatforms: ["c64u", "u2", "vice"],
  resources: [],
  prompts: [],
  defaultTags: ["batch", "orchestration"],
  workflowHints: [
    "Use execute_batch when you need to run 3 or more sequential operations — it eliminates per-call network overhead.",
    "Each command must include 'tool' and 'args'; grouped tools require 'op' inside args.",
  ],
  tools: [
    {
      name: "c64_batch",
      description: "Execute multiple c64bridge tool calls in a single request. Reduces latency for multi-step workflows.",
      summary: "Runs an ordered list of tool commands and returns all results with per-command timing.",
      inputSchema: executeBatchArgsSchema.jsonSchema,
      tags: ["batch", "orchestration", "grouped"],
      examples: [
        {
          name: "Read registers then step",
          description: "Get registers, step one instruction, get registers again",
          arguments: {
            commands: [
              { tool: "c64_debug", args: { op: "get_registers" }, description: "before" },
              { tool: "c64_debug", args: { op: "step", count: 1 }, description: "step" },
              { tool: "c64_debug", args: { op: "get_registers" }, description: "after" },
            ],
          },
        },
        {
          name: "Clear screen and type text",
          description: "Fill screen RAM then feed keyboard",
          arguments: {
            commands: [
              { tool: "c64_memory", args: { op: "fill_memory", address: "$0400", length: 1000, pattern: "20" } },
              { tool: "c64_input", args: { op: "write_text", text: "HELLO{RETURN}" } },
            ],
          },
        },
      ],
      execute: async (rawArgs: unknown, ctx: ToolExecutionContext) => {
        try {
          const parsed = executeBatchArgsSchema.parse(rawArgs);
          const stopOnError = parsed.stopOnError !== false;

          // Lazy import to avoid circular dependency at module-init time.
          const { toolRegistry } = await import("./index.js");

          const results: BatchResult[] = [];
          let succeeded = 0;
          let failed = 0;
          const batchStart = Date.now();

          for (let i = 0; i < parsed.commands.length; i++) {
            const cmd = parsed.commands[i]!;
            const toolName = typeof cmd.tool === "string" ? cmd.tool : "";
            const args = (typeof cmd.args === "object" && cmd.args !== null) ? cmd.args : {};
            const label = typeof cmd.description === "string" ? cmd.description : undefined;

            if (!toolName) {
              const err: BatchResult = { index: i, tool: String(cmd.tool), description: label, success: false, error: "tool name must be a non-empty string", elapsedMs: 0 };
              results.push(err);
              failed++;
              if (stopOnError) break;
              continue;
            }

            if (toolName === "c64_batch") {
              results.push({
                index: i,
                tool: toolName,
                description: label,
                success: false,
                error: "Nested c64_batch execution is not supported.",
                elapsedMs: 0,
              });
              failed++;
              if (stopOnError) break;
              continue;
            }

            const cmdStart = Date.now();
            try {
              const toolResult = await toolRegistry.invoke(toolName, args, {
                ...ctx,
                platform: getPlatformStatus(),
              });
              const elapsedMs = Date.now() - cmdStart;
              const isError = toolResult.isError === true;
              const text = toolResult.content.map((c) => c.text).join("\n");
              const resultPayload = toolResult.structuredContent?.data ?? text;
              if (isError) {
                results.push({ index: i, tool: toolName, description: label, success: false, error: text, elapsedMs });
                failed++;
                if (stopOnError) break;
              } else {
                results.push({ index: i, tool: toolName, description: label, success: true, result: resultPayload, elapsedMs });
                succeeded++;
              }
            } catch (err) {
              const elapsedMs = Date.now() - cmdStart;
              const message = err instanceof Error ? err.message : String(err);
              results.push({ index: i, tool: toolName, description: label, success: false, error: message, elapsedMs });
              failed++;
              if (stopOnError) break;
            }
          }

          const totalElapsedMs = Date.now() - batchStart;
          const summary = {
            total: parsed.commands.length,
            executed: results.length,
            succeeded,
            failed,
            elapsedMs: totalElapsedMs,
            results,
          };

          ctx.logger.info("Batch complete", { total: parsed.commands.length, succeeded, failed, elapsedMs: totalElapsedMs });
          return jsonResult(summary, { success: failed === 0, succeeded, failed, total: parsed.commands.length });
        } catch (error) {
          if (error instanceof ToolValidationError) {
            return {
              content: [{ type: "text" as const, text: error.message }],
              isError: true,
            };
          }
          return unknownErrorResult(error);
        }
      },
    },
  ],
});
