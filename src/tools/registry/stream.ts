import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
} from "../types.js";
import { streamingModule } from "../streaming.js";
import {
  buildDescriptorIndex,
  ensureDescriptor,
  extendSchemaWithOp,
  createOperationHandlers,
  invokeModuleTool,
  type GroupedOperationConfig,
  type GenericOperationMap,
} from "./utils.js";

const streamingDescriptorIndex = buildDescriptorIndex(streamingModule);

const streamOperations: GroupedOperationConfig[] = [
  {
    op: "start",
    schema: extendSchemaWithOp(
      "start",
      ensureDescriptor(streamingDescriptorIndex, "stream_start").inputSchema,
      { description: "Start an Ultimate streaming session toward a host:port target." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(streamingModule, "stream_start", rawArgs, ctx),
  },
  {
    op: "stop",
    schema: extendSchemaWithOp(
      "stop",
      ensureDescriptor(streamingDescriptorIndex, "stream_stop").inputSchema,
      { description: "Stop an active Ultimate streaming session." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(streamingModule, "stream_stop", rawArgs, ctx),
  },
];

const streamOperationHandlers = createOperationHandlers(streamOperations);

export const streamModule = defineToolModule({
  domain: "stream",
  summary: "Grouped streaming helpers for starting and stopping Ultimate capture sessions.",
  resources: ["c64://guide/index", "c64://sound/sid/spec"],
  prompts: ["sid-music"],
  defaultTags: ["stream", "monitor"],
  workflowHints: [
    "Confirm stream targets for the user so they can connect their tooling.",
    "Remind users to stop streams when capture completes to free resources.",
  ],
  tools: [
    {
      name: "c64_stream",
      description: "Grouped entry point for starting and stopping Ultimate streaming sessions.",
      summary: "Start or stop audio/video/debug streaming in a single tool.",
      inputSchema: discriminatedUnionSchema({
        description: "Streaming operations available via the c64_stream tool.",
        variants: streamOperations.map((operation) => operation.schema),
      }),
      tags: ["stream", "monitor", "grouped"],
      examples: [
        {
          name: "Start audio stream",
          description: "Send audio to localhost",
          arguments: { op: "start", stream: "audio", target: "127.0.0.1:9000" },
        },
        {
          name: "Stop audio stream",
          description: "Stop streaming",
          arguments: { op: "stop", stream: "audio" },
        },
      ],
      execute: createOperationDispatcher<GenericOperationMap>(
        "c64_stream",
        streamOperationHandlers,
      ),
    },
  ],
});
