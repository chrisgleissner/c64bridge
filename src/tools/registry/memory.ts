import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
} from "../types.js";
import {
  memoryModule,
  memoryOperationHandlers as groupedMemoryHandlers,
  disassembleArgsSchema,
  copyMemoryArgsSchema,
  fillMemoryArgsSchema,
  searchMemoryArgsSchema,
  compareMemoryArgsSchema,
  saveMemoryArgsSchema,
} from "../memory.js";
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
  {
    op: "disassemble",
    schema: extendSchemaWithOp(
      "disassemble",
      disassembleArgsSchema.jsonSchema,
      { description: "Disassemble a memory region into annotated 6502/6510 instructions, including undocumented opcodes with canonical names. Symbol annotations from `.vs` files are applied when available. Works on both C64U and VICE." },
    ),
    handler: groupedMemoryHandlers.disassemble,
  },
  {
    op: "copy_memory",
    schema: extendSchemaWithOp(
      "copy_memory",
      copyMemoryArgsSchema.jsonSchema,
      { description: "Copy a RAM region to another address." },
    ),
    handler: groupedMemoryHandlers.copy_memory,
  },
  {
    op: "fill_memory",
    schema: extendSchemaWithOp(
      "fill_memory",
      fillMemoryArgsSchema.jsonSchema,
      { description: "Fill a memory range with a repeating byte pattern." },
    ),
    handler: groupedMemoryHandlers.fill_memory,
  },
  {
    op: "search_memory",
    schema: extendSchemaWithOp(
      "search_memory",
      searchMemoryArgsSchema.jsonSchema,
      { description: "Search for a byte pattern within a memory range and return matching addresses." },
    ),
    handler: groupedMemoryHandlers.search_memory,
  },
  {
    op: "compare_memory",
    schema: extendSchemaWithOp(
      "compare_memory",
      compareMemoryArgsSchema.jsonSchema,
      { description: "Compare two memory regions byte-by-byte and report differences." },
    ),
    handler: groupedMemoryHandlers.compare_memory,
  },
  {
    op: "save_memory",
    schema: extendSchemaWithOp(
      "save_memory",
      saveMemoryArgsSchema.jsonSchema,
      { description: "Dump a memory range to a local file, with an optional PRG load-address header." },
    ),
    handler: groupedMemoryHandlers.save_memory,
  },
];

const memoryOperationHandlers = createOperationHandlers(memoryOperations);

export const memoryModuleGroup = defineToolModule({
  domain: "memory",
  summary: "Grouped memory, screen, and polling operations.",
  supportedPlatforms: ["c64u", "u2", "vice"],
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
        {
          name: "Disassemble entry point",
          description: "Disassemble 20 instructions starting at $0810",
          arguments: { op: "disassemble", address: "$0810", instructionCount: 20 },
        },
        {
          name: "Copy screen RAM",
          description: "Copy 1000 bytes of screen RAM to a scratch area",
          arguments: { op: "copy_memory", source: "$0400", dest: "$C000", length: 1000 },
        },
        {
          name: "Clear screen RAM",
          description: "Fill screen RAM with space character ($20)",
          arguments: { op: "fill_memory", address: "$0400", length: 1000, pattern: "20" },
        },
        {
          name: "Search for RTS",
          description: "Find RTS ($60) instructions in BASIC ROM",
          arguments: { op: "search_memory", startAddress: "$A000", endAddress: "$BFFF", pattern: "60" },
        },
        {
          name: "Compare two buffers",
          description: "Check whether two 256-byte regions differ",
          arguments: { op: "compare_memory", address1: "$C000", address2: "$C100", length: 256 },
        },
        {
          name: "Save PRG dump",
          description: "Save $0801-$CFFF as a PRG file",
          arguments: { op: "save_memory", startAddress: "$0801", endAddress: "$CFFF", filePath: "/tmp/dump.prg" },
        },
      ],
      execute: createOperationDispatcher<GenericOperationMap>(
        "c64_memory",
        memoryOperationHandlers,
      ),
    },
  ],
});
