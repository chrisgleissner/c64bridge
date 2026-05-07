import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
} from "../types.js";
import { ragModule } from "../rag.js";
import {
  buildDescriptorIndex,
  ensureDescriptor,
  extendSchemaWithOp,
  createOperationHandlers,
  invokeModuleTool,
  type GroupedOperationConfig,
  type GenericOperationMap,
} from "./utils.js";

const ragDescriptorIndex = buildDescriptorIndex(ragModule);

const ragOperations: GroupedOperationConfig[] = [
  {
    op: "basic",
    schema: extendSchemaWithOp(
      "basic",
      ensureDescriptor(ragDescriptorIndex, "rag_retrieve_basic").inputSchema,
      { description: "Retrieve BASIC references and snippets from the local knowledge base." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(ragModule, "rag_retrieve_basic", rawArgs, ctx),
  },
  {
    op: "asm",
    schema: extendSchemaWithOp(
      "asm",
      ensureDescriptor(ragDescriptorIndex, "rag_retrieve_asm").inputSchema,
      { description: "Retrieve 6502/6510 assembly references from the local knowledge base." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(ragModule, "rag_retrieve_asm", rawArgs, ctx),
  },
];

const ragOperationHandlers = createOperationHandlers(ragOperations);

export const ragModuleGroup = defineToolModule({
  domain: "rag",
  summary: "Grouped retrieval helpers for BASIC and assembly references.",
  resources: ["c64://basic/spec", "c64://assembly/6510-spec", "c64://guide/bootstrap"],
  prompts: ["basic-program", "assembly-program"],
  defaultTags: ["rag", "search"],
  workflowHints: [
    "Use BASIC retrieval before synthesising new BASIC code and mention primary resources in responses.",
    "For assembly, note registers or addresses surfaced so the user can inspect them further.",
  ],
  supportedPlatforms: ["c64u", "vice"],
  tools: [
    {
      name: "c64_rag",
      description: "Grouped entry point for BASIC and assembly RAG lookups.",
      summary: "Returns curated knowledge references for BASIC or 6502/6510 assembly queries.",
      inputSchema: discriminatedUnionSchema({
        description: "RAG operations available via the c64_rag tool.",
        variants: ragOperations.map((operation) => operation.schema),
      }),
      tags: ["rag", "reference", "grouped"],
      examples: [
        {
          name: "Retrieve BASIC snippet",
          description: "Search for device 4 printing guidance",
          arguments: { op: "basic", q: "basic print device 4" },
        },
        {
          name: "Retrieve assembly snippet",
          description: "Search for raster IRQ examples",
          arguments: { op: "asm", q: "stable raster irq" },
        },
      ],
      execute: createOperationDispatcher<GenericOperationMap>(
        "c64_rag",
        ragOperationHandlers,
      ),
    },
  ],
});
