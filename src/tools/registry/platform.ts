import { describePlatformCapabilities, type PlatformId } from "../../platform.js";
import { debugModuleGroup as debugModule } from "../debug.js";
import { viceModuleGroup as viceModule } from "../vice.js";
import { jsonResult } from "../responses.js";
import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
  type OperationHandlerMap,
  type OperationMap,
  operationSchema,
  type ToolDescriptor,
  type ToolModule,
} from "../types.js";
import { configModuleGroup as configModule } from "./config.js";
import { diskModuleGroup as diskModule } from "./disk.js";
import { driveModuleGroup as driveModule } from "./drive.js";
import { extractModule } from "./extract.js";
import { graphicsModuleGroup as graphicsModule } from "./graphics.js";
import { memoryModuleGroup as memoryModule } from "./memory.js";
import { printerModuleGroup as printerModule } from "./printer.js";
import { programModule } from "./program.js";
import { ragModuleGroup as ragModule } from "./rag.js";
import { soundModuleGroup as soundModule } from "./sound.js";
import { streamModule } from "./stream.js";
import { systemModuleGroup as systemModule } from "./system.js";

interface PlatformOperations extends OperationMap {
  readonly select: {
    readonly backend: PlatformId;
  };
}

const registryModules: readonly ToolModule[] = [
  programModule,
  memoryModule,
  soundModule,
  systemModule,
  graphicsModule,
  ragModule,
  diskModule,
  driveModule,
  printerModule,
  configModule,
  extractModule,
  streamModule,
  debugModule,
  viceModule,
];

function listRegisteredDescriptors(): readonly ToolDescriptor[] {
  return [
    ...registryModules.flatMap((module) => module.describeTools()),
    ...platformModuleGroup.describeTools(),
  ];
}

function describeTargetPlatform(target: PlatformId) {
  const capabilities = describePlatformCapabilities(listRegisteredDescriptors());
  const info = capabilities.platforms[target];
  return {
    availableTools: info.tools,
    unavailableTools: info.unsupported_tools,
  };
}

const selectBackendSchema = operationSchema("select", {
  description: "Switch the active runtime backend without restarting the MCP server.",
  properties: {
    backend: {
      type: "string",
      enum: ["c64u", "vice"],
      description: "Backend to activate for subsequent tool calls.",
    },
  },
  required: ["backend"],
});

const platformOperationHandlers: OperationHandlerMap<PlatformOperations> = {
  async select(args, ctx) {
    const backend = args.backend as PlatformId;
    const availableBackends = ctx.client.getAvailableBackends().slice().sort();
    if (!availableBackends.includes(backend)) {
      const data = {
        success: false,
        requestedBackend: backend,
        configuredBackends: availableBackends,
        message: `Backend '${backend}' is not configured. Available backends: ${availableBackends.join(", ") || "none"}.`,
        usageHint: "Use c64_select_backend with one of the configured backends when you want to switch later.",
      };
      return {
        ...jsonResult(data, { success: false }),
        isError: true,
      };
    }

    ctx.client.switchBackend(backend);
    ctx.setPlatform(backend);

    const { availableTools, unavailableTools } = describeTargetPlatform(backend);
    const switchBackTarget = backend === "c64u" ? "vice" : "c64u";
    const data = {
      success: true,
      activeBackend: backend,
      configuredBackends: availableBackends,
      availableTools,
      unavailableTools,
      usageHint: `Use c64_select_backend again with backend: "${switchBackTarget}" to switch back.`,
    };
    return jsonResult(data, { success: true });
  },
};

export const platformModuleGroup = defineToolModule({
  domain: "platform",
  summary: "Runtime backend selection and platform-status coordination.",
  supportedPlatforms: ["c64u", "vice"],
  resources: ["c64://platform/status", "c64://guide/bootstrap"],
  prompts: [],
  defaultTags: ["platform", "backend", "grouped"],
  workflowHints: [
    "Switch backends before invoking backend-specific tools so platform gating stays accurate.",
  ],
  tools: [
    {
      name: "c64_select_backend",
      description: "Switch the active backend between C64U hardware and the VICE emulator at runtime.",
      summary: "Changes the active backend without restarting the MCP server and reports resulting tool availability.",
      inputSchema: discriminatedUnionSchema({
        description: "Runtime backend selection operations.",
        variants: [selectBackendSchema],
      }),
      tags: ["platform", "backend", "switch"],
      execute: createOperationDispatcher<PlatformOperations>(
        "c64_select_backend",
        platformOperationHandlers,
      ),
      examples: [
        {
          name: "Switch to VICE",
          description: "Move subsequent tool calls to the emulator backend",
          arguments: { op: "select", backend: "vice" },
        },
      ],
    },
  ],
});
