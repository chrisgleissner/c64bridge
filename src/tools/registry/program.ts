import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
} from "../types.js";
import { programRunnersModule } from "../programRunners.js";
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

const programDescriptorIndex = buildDescriptorIndex(programRunnersModule);
const metaDescriptorIndex = buildDescriptorIndex(metaModule);

const programOperations: GroupedOperationConfig[] = [
  {
    op: "load_prg",
    schema: extendSchemaWithOp(
      "load_prg",
      ensureDescriptor(programDescriptorIndex, "load_prg").inputSchema,
      { description: "Load a PRG from Ultimate storage without executing it." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(programRunnersModule, "load_prg", rawArgs, ctx),
  },
  {
    op: "run_prg",
    schema: extendSchemaWithOp(
      "run_prg",
      ensureDescriptor(programDescriptorIndex, "run_prg").inputSchema,
      { description: "Load and execute a PRG from Ultimate-visible storage on c64u or a host-local path on VICE." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(programRunnersModule, "run_prg", rawArgs, ctx),
  },
  {
    op: "run_crt",
    schema: extendSchemaWithOp(
      "run_crt",
      ensureDescriptor(programDescriptorIndex, "run_crt").inputSchema,
      { description: "Mount and run a CRT cartridge image." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(programRunnersModule, "run_crt", rawArgs, ctx),
  },
  {
    op: "upload_run_basic",
    schema: extendSchemaWithOp(
      "upload_run_basic",
      ensureDescriptor(programDescriptorIndex, "upload_run_basic").inputSchema,
      { description: "Upload Commodore BASIC v2 source and execute it immediately." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(programRunnersModule, "upload_run_basic", rawArgs, ctx),
  },
  {
    op: "upload_run_asm",
    schema: extendSchemaWithOp(
      "upload_run_asm",
      ensureDescriptor(programDescriptorIndex, "upload_run_asm").inputSchema,
      { description: "Assemble 6502/6510 source, upload the PRG, and execute it." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(programRunnersModule, "upload_run_asm", rawArgs, ctx),
  },
  {
    op: "batch_run",
    schema: extendSchemaWithOp(
      "batch_run",
      ensureDescriptor(metaDescriptorIndex, "batch_run_with_assertions").inputSchema,
      { description: "Run multiple PRG/CRT programs with post-run assertions." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(metaModule, "batch_run_with_assertions", rawArgs, ctx),
  },
  {
    op: "bundle_run",
    schema: extendSchemaWithOp(
      "bundle_run",
      ensureDescriptor(metaDescriptorIndex, "bundle_run_artifacts").inputSchema,
      { description: "Capture screen, memory, and debug registers into an artifact bundle." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(metaModule, "bundle_run_artifacts", rawArgs, ctx),
  },
  {
    op: "cross_platform_greeting",
    schema: extendSchemaWithOp(
      "cross_platform_greeting",
      ensureDescriptor(metaDescriptorIndex, "cross_platform_greeting").inputSchema,
      { description: "Show a platform-customized greeting on one or more configured backends, capture screenshots, and verify the results." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(metaModule, "cross_platform_greeting", rawArgs, ctx),
  },
];

const programOperationHandlers = createOperationHandlers(programOperations);

export const programModule = defineToolModule({
  domain: "programs",
  summary: "Grouped program upload, run, and orchestration workflows.",
  resources: ["c64://guide/bootstrap", "c64://basic/spec", "c64://assembly/6510-spec"],
  prompts: ["basic-program", "assembly-program"],
  defaultTags: ["programs", "execution"],
  workflowHints: [
    "Choose BASIC or assembly uploaders based on the language you just generated for the user.",
    "Prefer PRG or CRT runners when the user supplies a file path instead of source text; PRG paths are host-local on VICE and Ultimate-visible on c64u.",
    "For a quick visible confirmation on VICE and/or C64U, prefer cross_platform_greeting instead of composing manual backend switches and BASIC upload steps.",
  ],
  supportedPlatforms: ["c64u", "u2", "vice"],
  tools: [
    {
      name: "c64_program",
      description: "Grouped entry point for program upload, execution, and batch workflows.",
      summary: "Runs PRG/CRT files, uploads BASIC or ASM, and coordinates batch test flows.",
      inputSchema: discriminatedUnionSchema({
        description: "Program operations available via the c64_program tool.",
        variants: programOperations.map((operation) => operation.schema),
      }),
      tags: ["programs", "execution", "grouped"],
      operationPlatforms: { load_prg: ["c64u", "u2"], run_crt: ["c64u", "u2"], bundle_run: ["c64u", "u2"] },
      operationToolNames: {
        load_prg: "load_prg",
        run_crt: "run_crt",
        bundle_run: "bundle_run_artifacts",
        cross_platform_greeting: "cross_platform_greeting",
      },
      examples: [
        {
          name: "Run PRG from storage",
          description: "Load and execute a PRG in one call",
          arguments: { op: "run_prg", path: "//USB0/demo.prg" },
        },
        {
          name: "Upload BASIC source",
          description: "Send inline BASIC to the C64 and run it",
          arguments: { op: "upload_run_basic", program: "10 PRINT \"HELLO\"\n20 GOTO 10" },
        },
        {
          name: "Show greeting on both backends",
          description: "Render a platform-specific greeting on VICE and C64U with screenshot verification",
          arguments: { op: "cross_platform_greeting" },
        },
      ],
      execute: createOperationDispatcher<GenericOperationMap>(
        "c64_program",
        programOperationHandlers,
      ),
    },
  ],
});
