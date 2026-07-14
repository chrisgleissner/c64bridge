import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
} from "../types.js";
import { storageModule } from "../storage.js";
import {
  buildDescriptorIndex,
  ensureDescriptor,
  extendSchemaWithOp,
  createOperationHandlers,
  invokeModuleTool,
  type GroupedOperationConfig,
  type GenericOperationMap,
} from "./utils.js";

const storageDescriptorIndex = buildDescriptorIndex(storageModule);

const driveOperations: GroupedOperationConfig[] = [
  {
    op: "reset",
    schema: extendSchemaWithOp(
      "reset",
      ensureDescriptor(storageDescriptorIndex, "drive_reset").inputSchema,
      { description: "Issue an IEC reset for the selected drive slot." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(storageModule, "drive_reset", rawArgs, ctx),
  },
  {
    op: "power_on",
    schema: extendSchemaWithOp(
      "power_on",
      ensureDescriptor(storageDescriptorIndex, "drive_on").inputSchema,
      { description: "Power on a specific Ultimate drive slot." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(storageModule, "drive_on", rawArgs, ctx),
  },
  {
    op: "power_off",
    schema: extendSchemaWithOp(
      "power_off",
      ensureDescriptor(storageDescriptorIndex, "drive_off").inputSchema,
      { description: "Power off a specific Ultimate drive slot." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(storageModule, "drive_off", rawArgs, ctx),
  },
  {
    op: "load_rom",
    schema: extendSchemaWithOp(
      "load_rom",
      ensureDescriptor(storageDescriptorIndex, "drive_load_rom").inputSchema,
      { description: "Temporarily load a custom ROM into an Ultimate drive slot." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(storageModule, "drive_load_rom", rawArgs, ctx),
  },
  {
    op: "set_mode",
    schema: extendSchemaWithOp(
      "set_mode",
      ensureDescriptor(storageDescriptorIndex, "drive_mode").inputSchema,
      { description: "Set the emulation mode for a drive slot (1541/1571/1581)." },
    ),
    handler: async (rawArgs, ctx) => invokeModuleTool(storageModule, "drive_mode", rawArgs, ctx),
  },
];

const driveOperationHandlers = createOperationHandlers(driveOperations);

export const driveModuleGroup = defineToolModule({
  domain: "drive",
  summary: "Grouped drive power, reset, ROM, and mode helpers.",
  supportedPlatforms: ["c64u", "u2", "vice"],
  resources: ["c64://guide/bootstrap"],
  defaultTags: ["drive", "hardware"],
  workflowHints: [
    "State the resulting power/mode/ROM so the user can reconcile IEC behaviour.",
    "Suggest running c64_disk (op list_drives) to confirm status when appropriate.",
  ],
  tools: [
    {
      name: "c64_drive",
      description: "Grouped entry point for drive power, mode, reset, and ROM operations.",
      summary: "Power cycle drive slots, reset IEC state, switch emulation modes, or load custom ROMs.",
      inputSchema: discriminatedUnionSchema({
        description: "Drive operations available via the c64_drive tool.",
        variants: driveOperations.map((operation) => operation.schema),
      }),
      tags: ["drive", "hardware", "grouped"],
      operationPlatforms: { load_rom: ["c64u", "u2"] },
      operationToolNames: { load_rom: "drive_load_rom" },
      examples: [
        {
          name: "Power on drive",
          description: "Enable drive8",
          arguments: { op: "power_on", drive: "drive8" },
        },
        {
          name: "Set 1581 mode",
          description: "Switch emulation mode",
          arguments: { op: "set_mode", drive: "drive8", mode: "1581" },
        },
      ],
      execute: createOperationDispatcher<GenericOperationMap>(
        "c64_drive",
        driveOperationHandlers,
      ),
    },
  ],
});
