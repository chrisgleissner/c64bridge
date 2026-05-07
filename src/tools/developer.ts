import { defineToolModule } from "./types.js";
import {
  objectSchema,
  optionalSchema,
  stringSchema,
  type Schema,
} from "./schema.js";
import { jsonResult, textResult } from "./responses.js";
import {
  ToolError,
  ToolExecutionError,
  ToolValidationError,
  toolErrorResult,
  unknownErrorResult,
} from "./errors.js";

type PrimitiveValue = string | number | boolean;

function toRecord(details: unknown): Record<string, unknown> | undefined {
  if (details === undefined || details === null) {
    return undefined;
  }
  if (typeof details === "object") {
    return details as Record<string, unknown>;
  }
  return { value: details };
}

function withStructuredJson(
  payload: Record<string, unknown>,
  metadata?: Record<string, unknown>,
) {
  return jsonResult(payload, metadata ? { ...metadata, details: payload, raw: payload } : { details: payload, raw: payload });
}

const noArgsSchema = objectSchema<Record<string, never>>({
  description: "This tool does not require any arguments.",
  properties: {},
  additionalProperties: false,
});

const categorySchema = stringSchema({
  description: "Configuration category reported by the Ultimate firmware (e.g. 'Audio').",
  minLength: 1,
});

const itemSchema = optionalSchema(
  stringSchema({
    description: "Specific configuration item inside the selected category (e.g. 'Volume').",
    minLength: 1,
  }),
);

const primitiveValueSchema: Schema<PrimitiveValue> = {
  jsonSchema: {
    description: "Primitive configuration value (string, number, or boolean).",
    type: ["string", "number", "boolean"],
  },
  parse(value: unknown, path?: string): PrimitiveValue {
    const resolvedPath = path ?? "$";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    throw new ToolValidationError("Configuration value must be a string, number, or boolean", {
      path: resolvedPath,
      details: { receivedType: typeof value },
    });
  },
};

const configSetArgsSchema = objectSchema({
  description: "Arguments for updating a single configuration value.",
  properties: {
    category: categorySchema,
    item: stringSchema({
      description: "Configuration item name inside the category.",
      minLength: 1,
    }),
    value: primitiveValueSchema,
  },
  required: ["category", "item", "value"],
  additionalProperties: false,
});

const configGetArgsSchema = objectSchema({
  description: "Arguments for reading configuration information.",
  properties: {
    category: categorySchema,
    item: itemSchema,
  },
  required: ["category"],
  additionalProperties: false,
});

const configBatchSchema: Schema<Record<string, Record<string, PrimitiveValue>>> = {
  jsonSchema: {
    description: "Nested object mapping categories to item/value pairs (primitive values only).",
    type: "object",
    additionalProperties: {
      type: "object",
      additionalProperties: {
        type: ["string", "number", "boolean"],
      },
    },
  },
  parse(value: unknown, path?: string) {
    const resolvedPath = path ?? "$";
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ToolValidationError("Batch payload must be an object of categories", {
        path: resolvedPath,
      });
    }

    const input = value as Record<string, unknown>;
    const categories: Record<string, Record<string, PrimitiveValue>> = {};
    for (const [category, items] of Object.entries(input)) {
      if (typeof items !== "object" || items === null || Array.isArray(items)) {
        throw new ToolValidationError("Each category must map to an object of item values", {
          path: `${resolvedPath}.${category}`,
        });
      }
      const parsedItems: Record<string, PrimitiveValue> = {};
      for (const [item, rawValue] of Object.entries(items as Record<string, unknown>)) {
        const parsedValue = primitiveValueSchema.parse(rawValue, `${resolvedPath}.${category}.${item}`);
        parsedItems[item] = parsedValue;
      }
      categories[category] = parsedItems;
    }

    if (Object.keys(categories).length === 0) {
      throw new ToolValidationError("Batch payload must contain at least one category", {
        path: resolvedPath,
      });
    }

    return categories;
  },
};

const debugWriteArgsSchema = objectSchema({
  description: "Write a hex byte into the Ultimate debug register ($D7FF).",
  properties: {
    value: stringSchema({
      description: "Hex value (00-FF) to write to the debug register.",
      minLength: 1,
      maxLength: 2,
      pattern: /^[0-9A-Fa-f]{1,2}$/,
    }),
  },
  required: ["value"],
  additionalProperties: false,
});

export const developerModule = defineToolModule({
  domain: "developer",
  summary: "Configuration management, diagnostics, and helper utilities for advanced workflows.",
  resources: [
    "c64://guide/bootstrap",
    "c64://guide/index",
  ],
  prompts: ["memory-debug"],
  defaultTags: ["developer", "config", "debug"],
  workflowHints: [
    "Use developer tools for firmware configuration, diagnostics, or advanced register tweaks.",
    "Call out any risky operations (like flash writes) so the user understands the impact.",
  ],
  tools: [
    {
      name: "config_list",
      description: "List configuration categories available on the Ultimate firmware.",
      summary: "Fetches the configuration tree and returns firmware-reported categories.",
      inputSchema: noArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["config", "list"],
      examples: [
        { name: "List configs", description: "Enumerate configuration categories", arguments: {} },
      ],
      workflowHints: [
        "Run first to enumerate categories before reading or writing specific settings; summarise the top-level sections for the user.",
      ],
      supportedPlatforms: ["c64u", "vice"] as const,
      async execute(args, ctx) {
        try {
          noArgsSchema.parse(args ?? {});
          ctx.logger.info("Listing configuration categories");

          const details = await ctx.client.configsList();
          const payload = normalizeCategoryListing(details);

          return withStructuredJson(payload, {
            success: true,
            categoryCount: Array.isArray(payload.categories)
              ? payload.categories.length
              : undefined,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "config_get",
      description: "Read a configuration category or specific item.",
      summary: "Returns firmware configuration data for the selected category (and item).",
      inputSchema: configGetArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["config", "read"],
      examples: [
        { name: "Get audio config", description: "Read audio category", arguments: { category: "Audio" } },
        { name: "Get volume", description: "Read specific setting", arguments: { category: "Audio", item: "Volume" } },
      ],
      workflowHints: [
        "Use after config_list to fetch details; restate category/item so the user can cross-check values before changes.",
      ],
      supportedPlatforms: ["c64u", "vice"] as const,
      async execute(args, ctx) {
        try {
          const parsed = configGetArgsSchema.parse(args ?? {});
          ctx.logger.info("Reading configuration", {
            category: parsed.category,
            item: parsed.item ?? null,
          });

          const details = await ctx.client.configGet(parsed.category, parsed.item);
          return withStructuredJson({ value: details }, {
            success: true,
            category: parsed.category,
            item: parsed.item ?? null,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "config_set",
      description: "Set a configuration value within a category.",
      summary: "Writes a primitive value to a specific configuration item via firmware APIs.",
      inputSchema: configSetArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["config", "write"],
      examples: [
        { name: "Set volume", description: "Adjust audio volume", arguments: { category: "Audio", item: "Volume", value: 75 } },
      ],
      workflowHints: [
        "Confirm the user-supplied value before writing; mention whether a reboot is required for the change to take effect.",
      ],
      supportedPlatforms: ["c64u", "vice"] as const,
      async execute(args, ctx) {
        try {
          const parsed = configSetArgsSchema.parse(args ?? {});
          ctx.logger.info("Setting configuration", {
            category: parsed.category,
            item: parsed.item,
            valueType: typeof parsed.value,
          });

          const result = await ctx.client.configSet(
            parsed.category,
            parsed.item,
            String(parsed.value),
          );
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while updating configuration", {
              details: toRecord(result.details),
            });
          }

          return textResult(`Configuration ${parsed.category}/${parsed.item} updated.`, {
            success: true,
            category: parsed.category,
            item: parsed.item,
            value: parsed.value,
            details: toRecord(result.details) ?? null,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "config_batch_update",
      description: "Apply multiple configuration changes in a single request.",
      summary: "Sends a nested object of category/item values to the firmware batch endpoint.",
      inputSchema: configBatchSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["config", "write"],
      examples: [
        { name: "Batch update", description: "Update multiple settings", arguments: { Audio: { Volume: 80, DACMode: "stereo" } } },
      ],
      workflowHints: [
        "Use when multiple categories must be updated together; remind the user to review validation errors closely.",
      ],
      supportedPlatforms: ["c64u", "vice"] as const,
      async execute(args, ctx) {
        try {
          const payload = configBatchSchema.parse(args ?? {});
          ctx.logger.info("Batch updating configuration", {
            categoryCount: Object.keys(payload).length,
          });

          const requestPayload = Object.fromEntries(
            Object.entries(payload).map(([category, entries]) => [
              category,
              Object.fromEntries(
                Object.entries(entries).map(([key, value]) => [key, String(value)]),
              ),
            ]),
          );

          const result = await ctx.client.configBatchUpdate(requestPayload);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure during batch configuration update", {
              details: toRecord(result.details),
            });
          }

          return textResult("Configuration batch update applied.", {
            success: true,
            categoryCount: Object.keys(payload).length,
            details: toRecord(result.details) ?? null,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "config_load_from_flash",
      description: "Load configuration settings from flash storage.",
      summary: "Restores the firmware configuration by reading the persisted flash snapshot.",
      inputSchema: noArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["config", "flash"],
      examples: [
        { name: "Load from flash", description: "Restore saved configuration", arguments: {} },
      ],
      workflowHints: [
        "Use when the user wants to revert to saved flash configuration; warn that unsaved RAM changes are discarded.",
      ],
      async execute(args, ctx) {
        try {
          noArgsSchema.parse(args ?? {});
          ctx.logger.info("Loading configuration from flash");

          const result = await ctx.client.configLoadFromFlash();
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while loading from flash", {
              details: toRecord(result.details),
            });
          }

          return textResult("Configuration loaded from flash.", {
            success: true,
            details: toRecord(result.details) ?? null,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "config_save_to_flash",
      description: "Persist current configuration settings to flash storage.",
      summary: "Saves the active configuration snapshot so it survives power cycles.",
      inputSchema: noArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["config", "flash"],
      examples: [
        { name: "Save to flash", description: "Persist current config", arguments: {} },
      ],
      workflowHints: [
        "Run after configuration changes the user wants to persist; mention that flash writes take a moment.",
      ],
      async execute(args, ctx) {
        try {
          noArgsSchema.parse(args ?? {});
          ctx.logger.info("Saving configuration to flash");

          const result = await ctx.client.configSaveToFlash();
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while saving to flash", {
              details: toRecord(result.details),
            });
          }

          return textResult("Configuration saved to flash.", {
            success: true,
            details: toRecord(result.details) ?? null,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "config_reset_to_default",
      description: "Reset configuration categories to their factory defaults.",
      summary: "Instructs the firmware to discard overrides and restore default configuration values.",
      inputSchema: noArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["config", "reset"],
      examples: [
        { name: "Reset config", description: "Restore factory defaults", arguments: {} },
      ],
      workflowHints: [
        "Confirm with the user before wiping settings; note that the firmware must restart to apply defaults fully.",
      ],
      async execute(args, ctx) {
        try {
          noArgsSchema.parse(args ?? {});
          ctx.logger.info("Resetting configuration to defaults");

          const result = await ctx.client.configResetToDefault();
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while resetting configuration", {
              details: toRecord(result.details),
            });
          }

          return textResult("Configuration reset to defaults.", {
            success: true,
            details: toRecord(result.details) ?? null,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "version",
      description: "Retrieve firmware or emulator version information.",
      summary: "Calls the firmware version endpoint (Ultimate) or returns emulator info (VICE).",
      supportedPlatforms: ["c64u", "vice"] as const,
      inputSchema: noArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["diagnostics", "version"],
      examples: [
        { name: "Get version", description: "Check firmware version", arguments: {} },
      ],
      workflowHints: [
        "Run when the user wonders which firmware build is active; include API and FPGA versions if available.",
      ],
      async execute(args, ctx) {
        try {
          noArgsSchema.parse(args ?? {});
          ctx.logger.info("Fetching firmware version");

          const details = await ctx.client.version();
          return withStructuredJson(toRecord(details) ?? {}, {
            success: true,
            details: toRecord(details) ?? {},
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "info",
      description: "Retrieve hardware or emulator information and status.",
      summary: "Returns the diagnostics payload reported by the firmware (Ultimate) or emulator (VICE).",
      supportedPlatforms: ["c64u", "vice"] as const,
      inputSchema: noArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["diagnostics", "info"],
      examples: [
        { name: "Get hardware info", description: "Query hardware status", arguments: {} },
      ],
      workflowHints: [
        "Use to answer hardware capability questions; highlight serials, board revisions, or temperature if present.",
      ],
      async execute(args, ctx) {
        try {
          noArgsSchema.parse(args ?? {});
          ctx.logger.info("Fetching hardware info");

          const details = await ctx.client.info();
          return withStructuredJson(toRecord(details) ?? {}, {
            success: true,
            details: toRecord(details) ?? {},
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "debugreg_read",
      description: "Read the Ultimate debug register ($D7FF).",
      summary: "Returns the current hex value stored in the debug register.",
      inputSchema: noArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["debug"],
      examples: [
        { name: "Read debug register", description: "Check $D7FF value", arguments: {} },
      ],
      workflowHints: [
        "Read the register when debugging DMA or cartridge interactions; translate the hex value into context for the user.",
      ],
      async execute(args, ctx) {
        try {
          noArgsSchema.parse(args ?? {});
          ctx.logger.info("Reading debug register");

          const result = await ctx.client.debugregRead();
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while reading debug register", {
              details: toRecord(result.details),
            });
          }

          const details = toRecord(result.details) ?? {};
          const value = typeof result.value === "string" ? result.value.toUpperCase() : null;

          return textResult(`Debug register value: ${value ?? "(unknown)"}.`, {
            success: true,
            value,
            details,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "debugreg_write",
      description: "Write a value into the Ultimate debug register ($D7FF).",
      summary: "Validates the hex input and forwards it to the firmware.",
      inputSchema: debugWriteArgsSchema.jsonSchema,
      relatedResources: ["c64://guide/bootstrap"],
      tags: ["debug"],
      examples: [
        { name: "Write debug register", description: "Set $D7FF to $42", arguments: { value: "42" } },
      ],
      workflowHints: [
        "Confirm with the user before writing arbitrary values; mention side effects on cartridge or DMA behaviour.",
      ],
      async execute(args, ctx) {
        try {
          const parsed = debugWriteArgsSchema.parse(args ?? {});
          const value = parsed.value.toUpperCase();
          ctx.logger.info("Writing debug register", { value });

          const result = await ctx.client.debugregWrite(value);
          if (!result.success) {
            throw new ToolExecutionError("C64 firmware reported failure while writing debug register", {
              details: toRecord(result.details),
            });
          }

          return textResult(`Debug register written with ${value}.`, {
            success: true,
            value,
            details: toRecord(result.details) ?? null,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
  ],
});

function normalizeCategoryListing(details: unknown): { categories: unknown } {
  if (
    details &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    Object.prototype.hasOwnProperty.call(details, "categories")
  ) {
    return details as { categories: unknown };
  }
  return { categories: details };
}
