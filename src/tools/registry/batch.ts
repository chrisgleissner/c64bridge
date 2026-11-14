import {
  cancelledResult,
  defineToolModule,
  type ToolExecutionContext,
  type ToolResponseContent,
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
import { unknownErrorResult } from "../errors.js";

export const MAX_BATCH_COMMANDS = 64;

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
      maxItems: MAX_BATCH_COMMANDS,
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
  /** Number of image blocks this command returned; they follow the JSON summary in the batch content. */
  images?: number;
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
      // Annotated as the worst case; the access check runs per command when it is dispatched.
      effect: "destructive",
      effectOf: () => "read",
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
          const { MAX_CAPTURE_PAYLOAD_BYTES, MAX_PNG_FRAMES } = await import("./graphics.js");

          const results: BatchResult[] = [];
          const imageBlocks: ToolResponseContent[] = [];
          let resultBytes = 0;
          let succeeded = 0;
          let failed = 0;
          const batchStart = Date.now();

          let cancelled = false;
          for (let i = 0; i < parsed.commands.length; i++) {
            // A cancelled call must not start the next command.
            if (ctx.signal?.aborted) {
              cancelled = true;
              break;
            }
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
                platform: typeof ctx.client.getActiveBackendType === "function"
                  ? { ...(ctx.platform ?? getPlatformStatus()), id: await ctx.client.getActiveBackendType() }
                  : ctx.platform ?? getPlatformStatus(),
              });
              const elapsedMs = Date.now() - cmdStart;
              const isError = toolResult.isError === true || toolResult.metadata?.success === false;
              const text = toolResult.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
              const resultPayload = toolResult.structuredContent?.data ?? text;
              // Image blocks (capture_frame format "png") have no text form, so they are passed through after the summary.
              const images = toolResult.content.filter((c) => c.type === "image");
              // The per-call caps of capture_frame also hold for the batch as a whole.
              const payloadBytes = isError ? 0 : Buffer.byteLength(JSON.stringify(resultPayload) ?? "");
              const overBytes = resultBytes + payloadBytes > MAX_CAPTURE_PAYLOAD_BYTES;
              const overImages = imageBlocks.length + images.length > MAX_PNG_FRAMES;
              if (!isError && (overBytes || overImages)) {
                const error = overBytes
                  ? `Batch results would be ${resultBytes + payloadBytes} bytes, above the ${MAX_CAPTURE_PAYLOAD_BYTES} byte limit; split the batch, lower count or use format png`
                  : `Batch results would hold ${imageBlocks.length + images.length} images, above the limit of ${MAX_PNG_FRAMES}; count must be at most ${MAX_PNG_FRAMES} frames per batch when format is png`;
                results.push({ index: i, tool: toolName, description: label, success: false, error, elapsedMs });
                failed++;
                if (stopOnError) break;
                continue;
              }
              resultBytes += payloadBytes;
              imageBlocks.push(...images);
              if (isError) {
                results.push({ index: i, tool: toolName, description: label, success: false, error: text, elapsedMs });
                failed++;
                if (stopOnError) break;
              } else {
                results.push({ index: i, tool: toolName, description: label, success: true, result: resultPayload, elapsedMs, ...(images.length > 0 ? { images: images.length } : {}) });
                succeeded++;
              }
            } catch (err) {
              const elapsedMs = Date.now() - cmdStart;
              // Keep the validation detail (allowed values, bounds) that the CallTool error path would show.
              const message = unknownErrorResult(err).content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
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

          if (cancelled) {
            const message = `c64_batch was cancelled by the client after ${results.length} of ${parsed.commands.length} commands`;
            const base = cancelledResult(message);
            return { ...base, structuredContent: { type: "json", data: { ...summary, cancelled: true, message } }, metadata: { ...base.metadata, succeeded, failed, total: parsed.commands.length } };
          }
          ctx.logger.info("Batch complete", { total: parsed.commands.length, succeeded, failed, elapsedMs: totalElapsedMs });
          const summaryResult = jsonResult(summary, { success: failed === 0, succeeded, failed, total: parsed.commands.length });
          const outcome = imageBlocks.length > 0 ? { ...summaryResult, content: [...summaryResult.content, ...imageBlocks] } : summaryResult;
          return failed > 0 ? { ...outcome, isError: true } : outcome;
        } catch (error) {
          return unknownErrorResult(error);
        }
      },
    },
  ],
});
