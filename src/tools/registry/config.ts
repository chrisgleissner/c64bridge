import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
  OPERATION_DISCRIMINATOR,
  type JsonSchema,
} from "../types.js";
import { developerModule } from "../developer.js";
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
import {
  booleanSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "../schema.js";

const developerDescriptorIndex = buildDescriptorIndex(developerModule);
const metaDescriptorIndex = buildDescriptorIndex(metaModule);

type ConfigSnapshotArgs = {
  readonly path: string;
};

type ConfigRestoreArgs = {
  readonly path: string;
  readonly applyToFlash?: boolean;
};

type ConfigDiffArgs = {
  readonly path: string;
};

const configSnapshotArgsSchema = objectSchema<ConfigSnapshotArgs>({
  description: "Snapshot all configuration categories to a JSON file.",
  properties: {
    path: stringSchema({
      description: "Absolute or workspace-relative path where the snapshot file will be written.",
      minLength: 1,
    }),
  },
  required: ["path"],
  additionalProperties: false,
});

const configRestoreArgsSchema = objectSchema<ConfigRestoreArgs>({
  description: "Restore configuration from a snapshot, optionally persisting to flash.",
  properties: {
    path: stringSchema({
      description: "Snapshot file to read (must contain categories payload).",
      minLength: 1,
    }),
    applyToFlash: optionalSchema(booleanSchema({
      description: "When true, save the restored configuration to flash immediately.",
      default: false,
    })),
  },
  required: ["path"],
  additionalProperties: false,
});

const configDiffArgsSchema = objectSchema<ConfigDiffArgs>({
  description: "Compare current configuration against a saved snapshot file.",
  properties: {
    path: stringSchema({
      description: "Snapshot file to compare with.",
      minLength: 1,
    }),
  },
  required: ["path"],
  additionalProperties: false,
});

const configOperations: GroupedOperationConfig[] = [
  {
    op: "list",
    schema: extendSchemaWithOp(
      "list",
      ensureDescriptor(developerDescriptorIndex, "config_list").inputSchema,
      { description: "List configuration categories reported by the firmware." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(developerModule, "config_list", rawArgs, ctx),
  },
  {
    op: "get",
    schema: extendSchemaWithOp(
      "get",
      ensureDescriptor(developerDescriptorIndex, "config_get").inputSchema,
      { description: "Read a configuration category or specific item." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(developerModule, "config_get", rawArgs, ctx),
  },
  {
    op: "set",
    schema: extendSchemaWithOp(
      "set",
      ensureDescriptor(developerDescriptorIndex, "config_set").inputSchema,
      { description: "Write a configuration value in the selected category." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(developerModule, "config_set", rawArgs, ctx),
  },
  {
    op: "batch_update",
    schema: extendSchemaWithOp(
      "batch_update",
      ensureDescriptor(developerDescriptorIndex, "config_batch_update").inputSchema,
      { description: "Apply multiple configuration updates in a single request." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(developerModule, "config_batch_update", rawArgs, ctx),
  },
  {
    op: "load_flash",
    schema: extendSchemaWithOp(
      "load_flash",
      ensureDescriptor(developerDescriptorIndex, "config_load_from_flash").inputSchema,
      { description: "Load configuration from flash storage." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(developerModule, "config_load_from_flash", rawArgs, ctx),
  },
  {
    op: "save_flash",
    schema: extendSchemaWithOp(
      "save_flash",
      ensureDescriptor(developerDescriptorIndex, "config_save_to_flash").inputSchema,
      { description: "Persist the current configuration to flash storage." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(developerModule, "config_save_to_flash", rawArgs, ctx),
  },
  {
    op: "reset_defaults",
    schema: extendSchemaWithOp(
      "reset_defaults",
      ensureDescriptor(developerDescriptorIndex, "config_reset_to_default").inputSchema,
      { description: "Reset firmware configuration to factory defaults." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(developerModule, "config_reset_to_default", rawArgs, ctx),
  },
  {
    op: "read_debugreg",
    schema: extendSchemaWithOp(
      "read_debugreg",
      ensureDescriptor(developerDescriptorIndex, "debugreg_read").inputSchema,
      { description: "Read the Ultimate debug register ($D7FF)." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(developerModule, "debugreg_read", rawArgs, ctx),
  },
  {
    op: "write_debugreg",
    schema: extendSchemaWithOp(
      "write_debugreg",
      ensureDescriptor(developerDescriptorIndex, "debugreg_write").inputSchema,
      { description: "Write a hex value to the Ultimate debug register ($D7FF)." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(developerModule, "debugreg_write", rawArgs, ctx),
  },
  {
    op: "info",
    schema: extendSchemaWithOp(
      "info",
      ensureDescriptor(developerDescriptorIndex, "info").inputSchema,
      { description: "Retrieve Ultimate hardware information and status." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(developerModule, "info", rawArgs, ctx),
  },
  {
    op: "version",
    schema: extendSchemaWithOp(
      "version",
      ensureDescriptor(developerDescriptorIndex, "version").inputSchema,
      { description: "Fetch firmware version details." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(developerModule, "version", rawArgs, ctx),
  },
  {
    op: "snapshot",
    schema: extendSchemaWithOp(
      "snapshot",
      configSnapshotArgsSchema.jsonSchema as JsonSchema,
      { description: "Snapshot configuration to disk for later restore or diff." },
    ),
    handler: async (rawArgs, ctx) => {
      const { [OPERATION_DISCRIMINATOR]: _ignored, ...rest } = rawArgs;
      const parsed = configSnapshotArgsSchema.parse(rest);
      return metaModule.invoke("config_snapshot_and_restore", {
        action: "snapshot",
        path: parsed.path,
      }, ctx);
    },
  },
  {
    op: "restore",
    schema: extendSchemaWithOp(
      "restore",
      configRestoreArgsSchema.jsonSchema as JsonSchema,
      { description: "Restore configuration from a snapshot file." },
    ),
    handler: async (rawArgs, ctx) => {
      const { [OPERATION_DISCRIMINATOR]: _ignored, ...rest } = rawArgs;
      const parsed = configRestoreArgsSchema.parse(rest);
      if (parsed.applyToFlash === undefined) {
        return metaModule.invoke("config_snapshot_and_restore", {
          action: "restore",
          path: parsed.path,
        }, ctx);
      }
      return metaModule.invoke("config_snapshot_and_restore", {
        action: "restore",
        path: parsed.path,
        applyToFlash: parsed.applyToFlash,
      }, ctx);
    },
  },
  {
    op: "diff",
    schema: extendSchemaWithOp(
      "diff",
      configDiffArgsSchema.jsonSchema as JsonSchema,
      { description: "Compare the current configuration with a snapshot." },
    ),
    handler: async (rawArgs, ctx) => {
      const { [OPERATION_DISCRIMINATOR]: _ignored, ...rest } = rawArgs;
      const parsed = configDiffArgsSchema.parse(rest);
      return metaModule.invoke("config_snapshot_and_restore", {
        action: "diff",
        path: parsed.path,
      }, ctx);
    },
  },
  {
    op: "shuffle",
    schema: extendSchemaWithOp(
      "shuffle",
      ensureDescriptor(metaDescriptorIndex, "program_shuffle").inputSchema,
      { description: "Discover PRG/CRT files and run each with optional screen capture." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(metaModule, "program_shuffle", rawArgs, ctx),
  },
];

const configOperationHandlers = createOperationHandlers(configOperations);

export const configModuleGroup = defineToolModule({
  domain: "config",
  summary: "Grouped configuration management, diagnostics, and snapshot workflows.",
  resources: ["c64://guide/bootstrap", "c64://guide/index"],
  prompts: ["memory-debug"],
  defaultTags: ["config", "diagnostics"],
  supportedPlatforms: ["c64u", "u2", "vice"],
  workflowHints: [
    "List categories before changing values so users can confirm firmware-provided names.",
    "Mention when operations persist to flash or modify debug registers to highlight impacts.",
    "Call out snapshot file paths so users can version-control or reuse them later.",
  ],
  tools: [
    {
      name: "c64_config",
      description: "Grouped entry point for configuration reads/writes, diagnostics, and snapshots.",
      summary: "List or update settings, access firmware info, take snapshots, and run program shuffle workflows.",
      inputSchema: discriminatedUnionSchema({
        description: "Configuration operations available via the c64_config tool.",
        variants: configOperations.map((operation) => operation.schema),
      }),
      tags: ["config", "diagnostics", "grouped"],
      operationPlatforms: {
        load_flash: ["c64u", "u2"],
        save_flash: ["c64u", "u2"],
        reset_defaults: ["c64u", "u2"],
        read_debugreg: ["c64u"],
        write_debugreg: ["c64u"],
        shuffle: ["c64u", "u2"],
      },
      operationToolNames: {
        load_flash: "config_load_from_flash",
        save_flash: "config_save_to_flash",
        reset_defaults: "config_reset_to_default",
        read_debugreg: "debugreg_read",
        write_debugreg: "debugreg_write",
        shuffle: "program_shuffle",
      },
      examples: [
        {
          name: "List categories",
          description: "Enumerate configuration categories",
          arguments: { op: "list" },
        },
        {
          name: "Set volume",
          description: "Adjust audio volume to 70",
          arguments: { op: "set", category: "Audio", item: "Volume", value: 70 },
        },
        {
          name: "Snapshot config",
          description: "Write configuration snapshot to disk",
          arguments: { op: "snapshot", path: "./snapshots/c64_json" },
        },
      ],
      execute: createOperationDispatcher<GenericOperationMap>(
        "c64_config",
        configOperationHandlers,
      ),
    },
  ],
});
