import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
} from "../types.js";
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

const metaDescriptorIndex = buildDescriptorIndex(metaModule);

const extractOperations: GroupedOperationConfig[] = [
  {
    op: "sprites",
    schema: extendSchemaWithOp(
      "sprites",
      ensureDescriptor(metaDescriptorIndex, "extract_sprites_from_ram").inputSchema,
      { description: "Scan RAM for sprites and optionally export .spr files." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(metaModule, "extract_sprites_from_ram", rawArgs, ctx),
  },
  {
    op: "charset",
    schema: extendSchemaWithOp(
      "charset",
      ensureDescriptor(metaDescriptorIndex, "rip_charset_from_ram").inputSchema,
      { description: "Locate and extract 2KB character sets from RAM." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(metaModule, "rip_charset_from_ram", rawArgs, ctx),
  },
  {
    op: "memory_dump",
    schema: extendSchemaWithOp(
      "memory_dump",
      ensureDescriptor(metaDescriptorIndex, "memory_dump_to_file").inputSchema,
      { description: "Dump a RAM range to hex or binary files with manifest metadata." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(metaModule, "memory_dump_to_file", rawArgs, ctx),
  },
  {
    op: "fs_stats",
    schema: extendSchemaWithOp(
      "fs_stats",
      ensureDescriptor(metaDescriptorIndex, "filesystem_stats_by_extension").inputSchema,
      { description: "Walk the filesystem and aggregate counts/bytes by extension." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(metaModule, "filesystem_stats_by_extension", rawArgs, ctx),
  },
  {
    op: "firmware_health",
    schema: extendSchemaWithOp(
      "firmware_health",
      ensureDescriptor(metaDescriptorIndex, "firmware_info_and_healthcheck").inputSchema,
      { description: "Run firmware readiness checks and report status metrics." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(metaModule, "firmware_info_and_healthcheck", rawArgs, ctx),
  },
];

const extractOperationHandlers = createOperationHandlers(extractOperations);

export const extractModule = defineToolModule({
  domain: "extract",
  summary: "Grouped extraction helpers for sprites, charsets, memory dumps, and diagnostics.",
  resources: ["c64://guide/bootstrap", "c64://basic/spec", "c64://assembly/6510-spec"],
  defaultTags: ["extract", "diagnostics"],
  workflowHints: [
    "Pause the machine when advised so dumps and sprite scans remain stable.",
    "Summarise output file paths or sample counts so users can inspect artifacts quickly.",
  ],
  tools: [
    {
      name: "c64_extract",
      description: "Grouped entry point for sprite/charset extraction, memory dumps, filesystem stats, and firmware health checks.",
      summary: "Export sprites or charsets, dump RAM, compute filesystem stats, or run firmware health checks.",
      inputSchema: discriminatedUnionSchema({
        description: "Extraction operations available via the c64_extract tool.",
        variants: extractOperations.map((operation) => operation.schema),
      }),
      tags: ["extract", "diagnostics", "grouped"],
      examples: [
        {
          name: "Dump RAM to file",
          description: "Write $0400-$07FF to hex file",
          arguments: { op: "memory_dump", address: "$0400", length: 1024, outputPath: "./dumps/screen.hex" },
        },
        {
          name: "Scan sprites",
          description: "Scan $2000 for sprites",
          arguments: { op: "sprites", address: "$2000", length: 2048 },
        },
      ],
      execute: createOperationDispatcher<GenericOperationMap>(
        "c64_extract",
        extractOperationHandlers,
      ),
    },
  ],
});
