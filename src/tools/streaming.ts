import { defineToolModule } from "./types.js";
import { objectSchema, stringSchema } from "./schema.js";
import { textResult } from "./responses.js";
import {
  ToolError,
  ToolExecutionError,
  toolErrorResult,
  unknownErrorResult,
} from "./errors.js";

type StreamKind = "video" | "audio" | "debug";

const streamIdentifierSchema = stringSchema({
  description: "Stream type to control (video/audio/debug).",
  enum: ["video", "audio", "debug"],
});

const streamStartArgsSchema = objectSchema({
  description: "Arguments for starting an Ultimate streaming session.",
  properties: {
    stream: streamIdentifierSchema,
    target: stringSchema({
      description: "Destination host:port or UDP target understood by the firmware.",
      minLength: 3,
    }),
  },
  required: ["stream", "target"],
  additionalProperties: false,
});

const streamStopArgsSchema = objectSchema({
  description: "Arguments for stopping an Ultimate streaming session.",
  properties: {
    stream: streamIdentifierSchema,
  },
  required: ["stream"],
  additionalProperties: false,
});

function toRecord(details: unknown): Record<string, unknown> | undefined {
  if (details && typeof details === "object") {
    return details as Record<string, unknown>;
  }
  return undefined;
}

export const streamingModule = defineToolModule({
  domain: "streaming",
  summary: "Long-running or streaming workflows such as audio capture or SID playback monitoring.",
  resources: [
    "c64://sound/sid/spec",
    "c64://guide/index",
  ],
  prompts: ["sid-music"],
  defaultLifecycle: "stream",
  defaultTags: ["stream", "monitoring"],
  supportedPlatforms: ["c64u"] as const,
  workflowHints: [
    "Use streaming tools for long-running capture or monitoring workflows such as audio verification.",
    "Clarify that streams keep running until stopped so the user can manage resources.",
  ],
  tools: [
    {
      name: "stream_start",
      description: "Start an Ultimate streaming session (video/audio/debug) targeting a host:port destination. See c64://guide/index for usage notes.",
      summary: "Validates stream arguments and forwards the request to firmware, returning status metadata.",
      inputSchema: streamStartArgsSchema.jsonSchema,
      tags: ["stream", "start"],
      prerequisites: [],
      examples: [
        { name: "Start audio", description: "Send audio to localhost:9000", arguments: { stream: "audio", target: "127.0.0.1:9000" } },
      ],
      workflowHints: [
        "Use when the user wants to begin audio/video capture; restate the destination target so they know where to listen.",
        "Remind them to stop the stream after gathering enough data.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = streamStartArgsSchema.parse(args ?? {});
          ctx.logger.info("Starting Ultimate stream", {
            stream: parsed.stream,
            target: parsed.target,
          });

          const result = await ctx.client.streamStart(parsed.stream as StreamKind, parsed.target);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while starting stream", {
              details: toRecord(result.details),
            });
          }

          return textResult(`Stream ${parsed.stream} started toward ${parsed.target}.`, {
            success: true,
            stream: parsed.stream,
            target: parsed.target,
            details: toRecord(result.details) ?? null,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "stream_stop",
      description: "Stop an Ultimate streaming session (video/audio/debug).",
      summary: "Requests the firmware to stop the specified stream and returns completion metadata.",
      inputSchema: streamStopArgsSchema.jsonSchema,
      tags: ["stream", "stop"],
      prerequisites: ["stream_start"],
      examples: [
        { name: "Stop audio", description: "Stop audio stream", arguments: { stream: "audio" } },
      ],
      workflowHints: [
        "Call after a monitoring session to release resources; confirm whether the firmware acknowledged the stop.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = streamStopArgsSchema.parse(args ?? {});
          ctx.logger.info("Stopping Ultimate stream", {
            stream: parsed.stream,
          });

          const result = await ctx.client.streamStop(parsed.stream as StreamKind);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while stopping stream", {
              details: toRecord(result.details),
            });
          }

          return textResult(`Stream ${parsed.stream} stop requested.`, {
            success: true,
            stream: parsed.stream,
            details: toRecord(result.details) ?? null,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
  ],
});
