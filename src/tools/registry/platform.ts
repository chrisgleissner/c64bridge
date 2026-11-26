import { backendSwitchGuard } from "../backendSwitch.js";
import { clearViceSymbols } from "../translation/symbolRegistry.js";
import { describePlatformCapabilities, type PlatformId } from "../../platform.js";
import { cancelGeneratedSidPlayback } from "../audio.js";
import { jsonResult } from "../responses.js";
import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
  type OperationHandlerMap,
  type OperationMap,
  operationSchema,
} from "../types.js";

interface PlatformOperations extends OperationMap {
  readonly select: {
    readonly backend: PlatformId;
  };
}

async function describeTargetPlatform(target: PlatformId) {
  // Every registered tool, including c64_input and c64_batch; imported lazily because the
  // registry index imports this module.
  const { toolRegistry } = await import("./index.js");
  const capabilities = describePlatformCapabilities(toolRegistry.list());
  const info = capabilities.platforms[target];
  return {
    availableTools: info.tools,
    unavailableTools: info.unsupported_tools,
    unavailableOperations: info.unsupported_operations,
  };
}

const selectBackendSchema = operationSchema("select", {
  description: "Switch the active runtime backend without restarting the MCP server.",
  properties: {
    backend: {
      type: "string",
      enum: ["c64u", "u2", "vice"],
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

    // Selecting the active backend again is not a switch: labels, SID playback and the
    // capture session stay (clients often select before every backend-specific step).
    const active = typeof ctx.client.getActiveBackendType === "function"
      ? await ctx.client.getActiveBackendType()
      : ctx.platform?.id;
    const guard = backendSwitchGuard(ctx);
    const checkSwitch = (backendId: PlatformId | undefined) => {
      if (backendId !== backend) guard(backendId);
    };
    let alreadyActive = (ctx.client.getSelectedBackendType?.() ?? active) === backend;
    if (!alreadyActive) {
      checkSwitch(ctx.client.getSelectedBackendType?.() ?? active);
      await cancelGeneratedSidPlayback(ctx.client);
      const current = ctx.client.getSelectedBackendType?.() ?? await ctx.client.getActiveBackendType?.() ?? ctx.platform?.id;
      alreadyActive = current === backend;
      if (!alreadyActive) {
        checkSwitch(current);
        await ctx.client.switchBackend(backend, checkSwitch);
        clearViceSymbols(); // labels belong to one program on one backend
      }
    }
    ctx.setPlatform(backend);

    const { availableTools, unavailableTools, unavailableOperations } = await describeTargetPlatform(backend);
    const switchBackTarget = availableBackends.find((candidate) => candidate !== backend);
    const data = {
      success: true,
      activeBackend: backend,
      ...(alreadyActive ? { alreadyActive: true } : {}),
      configuredBackends: availableBackends,
      availableTools,
      unavailableTools,
      unavailableOperations,
      usageHint: switchBackTarget
        ? `Use c64_select_backend again with backend: "${switchBackTarget}" to switch back.`
        : "No other backend is configured.",
    };
    return jsonResult(data, { success: true });
  },
};

export const platformModuleGroup = defineToolModule({
  domain: "platform",
  summary: "Runtime backend selection and platform-status coordination.",
  supportedPlatforms: ["c64u", "u2", "vice"],
  resources: ["c64://platform/status", "c64://guide/bootstrap"],
  prompts: [],
  defaultTags: ["platform", "backend", "grouped"],
  workflowHints: [
    "Switch backends before invoking backend-specific tools so platform gating stays accurate.",
  ],
  tools: [
    {
      name: "c64_select_backend",
      description: "Switch the active backend between C64U/U64 hardware, U2-family cartridges, and the VICE emulator at runtime.",
      summary: "Changes the active backend without restarting the MCP server and reports resulting tool availability.",
      inputSchema: discriminatedUnionSchema({
        description: "Runtime backend selection operations.",
        variants: [selectBackendSchema],
      }),
      // Selecting a backend is read-only except for releasing previously authorized playback.
      operationEffects: { select: "read" },
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
