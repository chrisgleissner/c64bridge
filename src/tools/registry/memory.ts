import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
} from "../types.js";
import { memoryModule, memoryOperationHandlers as groupedMemoryHandlers } from "../memory.js";
import { metaModule } from "../meta/index.js";
import {
  buildDescriptorIndex,
  ensureDescriptor,
  extendSchemaWithOp,
  createOperationHandlers,
  invokeModuleTool,
  type GroupedOperationConfig,
  type GenericOperationMap,
} from "./utils.js";

const memoryDescriptorIndex = buildDescriptorIndex(memoryModule);
const metaDescriptorIndex = buildDescriptorIndex(metaModule);

const memoryOperations: GroupedOperationConfig[] = [
  {
    op: "read",
    schema: extendSchemaWithOp(
      "read",
      ensureDescriptor(memoryDescriptorIndex, "read").inputSchema,
      { description: "Read a range of bytes and return a hex dump with address metadata." },
    ),
    handler: groupedMemoryHandlers.read,
  },
  {
    op: "write",
    schema: extendSchemaWithOp(
      "write",
      ensureDescriptor(memoryDescriptorIndex, "write").inputSchema,
      { description: "Write a hexadecimal byte sequence into RAM." },
    ),
    handler: groupedMemoryHandlers.write,
  },
  {
    op: "read_screen",
    schema: extendSchemaWithOp(
      "read_screen",
      ensureDescriptor(memoryDescriptorIndex, "read_screen").inputSchema,
      { description: "Return the current 40x25 text screen converted to ASCII." },
    ),
    handler: groupedMemoryHandlers.read_screen,
  },
  {
    op: "wait_for_text",
    schema: extendSchemaWithOp(
      "wait_for_text",
      ensureDescriptor(metaDescriptorIndex, "wait_for_screen_text").inputSchema,
      { description: "Poll the screen until a substring or regex appears, or timeout elapses." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(metaModule, "wait_for_screen_text", rawArgs, ctx),
  },
];

const memoryOperationHandlers = createOperationHandlers(memoryOperations);

export const memoryModuleGroup = defineToolModule({
  domain: "memory",
  summary: "Grouped memory, screen, and polling operations.",
  supportedPlatforms: ["c64u", "vice"],
  resources: ["c64://guide/bootstrap", "c64://basic/spec", "c64://assembly/6510-spec"],
  prompts: ["memory-debug", "basic-program", "assembly-program"],
  defaultTags: ["memory", "debug"],
  workflowHints: [
    "Pair memory operations with documentation snippets so addresses and symbols stay meaningful to the user.",
    "Confirm intent before mutating RAM and explain how the change affects the running program.",
  ],
  tools: [
    {
      name: "c64_memory",
      description: "Grouped entry point for memory I/O, screen reads, and screen polling.",
      summary: "Reads or writes RAM, captures the screen, or waits for text matches in one tool.",
      inputSchema: discriminatedUnionSchema({
        description: "Memory operations available via the c64_memory tool.",
        variants: memoryOperations.map((operation) => operation.schema),
      }),
      tags: ["memory", "screen", "grouped"],
      examples: [
        {
          name: "Read colour RAM",
          description: "Read 16 bytes starting at $D800",
          arguments: { op: "read", address: "$D800", length: 16 },
        },
        {
          name: "Wait for READY prompt",
          description: "Poll until the READY. prompt appears",
          arguments: { op: "wait_for_text", pattern: "READY." },
        },
      ],
      execute: createOperationDispatcher<GenericOperationMap>(
        "c64_memory",
        memoryOperationHandlers,
      ),
    },
  ],
});
