import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
  type OperationHandlerMap,
  type OperationMap,
} from "./types.js";
import {
  literalSchema,
  objectSchema,
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

interface ViceOperationMap extends OperationMap {
  readonly resource_get: {
    readonly name: string;
  };
  readonly resource_set: {
    readonly name: string;
    readonly value: string | number;
  };
}

const RESOURCE_NAME_PATTERN = /^[A-Z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_RESOURCE_PREFIXES = [
  "C64",
  "Machine",
  "Sid",
  "VIC",
  "VICII",
  "CIA",
  "Joy",
  "Sound",
] as const;

const resourceValueSchema: Schema<string | number> = {
  jsonSchema: {
    type: ["string", "integer"],
    description: "VICE resource value (string or integer).",
  },
  parse(value: unknown, path?: string): string | number {
    const resolvedPath = path ?? "$.value";
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" && Number.isInteger(value)) {
      return value;
    }
    throw new ToolValidationError("Resource value must be a string or integer", {
      path: resolvedPath,
      details: { receivedType: typeof value },
    });
  },
};

const resourceNameSchema = stringSchema({
  description: "VICE resource name (example: SidEngine, C64Model).",
  minLength: 1,
  maxLength: 64,
  pattern: RESOURCE_NAME_PATTERN,
});

const resourceGetArgsSchema = objectSchema({
  description: "Read a VICE configuration resource (safe prefixes only).",
  properties: {
    op: literalSchema("resource_get"),
    name: resourceNameSchema,
  },
  required: ["op", "name"],
  additionalProperties: false,
});

const resourceSetArgsSchema = objectSchema({
  description: "Write a VICE configuration resource (safe prefixes only).",
  properties: {
    op: literalSchema("resource_set"),
    name: resourceNameSchema,
    value: resourceValueSchema,
  },
  required: ["op", "name", "value"],
  additionalProperties: false,
});

const viceOperationSchemas = [
  resourceGetArgsSchema,
  resourceSetArgsSchema,
] as const;

const viceOperationHandlers: OperationHandlerMap<ViceOperationMap> = {
  resource_get: async (args, ctx) => {
    try {
      const parsed = resourceGetArgsSchema.parse(args);
      ensureSafeResourceName(parsed.name, "$.name");
      ctx.logger.info("Reading VICE resource", { name: parsed.name });

      const value = await ctx.client.viceResourceGet(parsed.name);

      if (value.type === "string" && value.value.length === 0) {
        throw new ToolExecutionError(`VICE resource ${parsed.name} is not available or returned an empty value`, {
          details: { name: parsed.name },
        });
      }

      return jsonResult(
        {
          name: parsed.name,
          type: value.type,
          value: value.value,
        },
        { success: true, name: parsed.name, type: value.type },
      );
    } catch (error) {
      return handleToolError(error);
    }
  },
  resource_set: async (args, ctx) => {
    try {
      const parsed = resourceSetArgsSchema.parse(args);
      ensureSafeResourceName(parsed.name, "$.name");
      ctx.logger.info("Writing VICE resource", {
        name: parsed.name,
        valueType: typeof parsed.value,
      });

      await ctx.client.viceResourceSet(parsed.name, parsed.value);
      return textResult(`Updated VICE resource ${parsed.name}.`, {
        success: true,
        name: parsed.name,
        value: parsed.value,
      });
    } catch (error) {
      return handleToolError(error);
    }
  },
};

const viceOperationDispatcher = createOperationDispatcher<ViceOperationMap>(
  "c64_vice",
  viceOperationHandlers,
);

export const viceModuleGroup = defineToolModule({
  domain: "vice",
  summary: "VICE emulator helpers for safe runtime resource access.",
  resources: ["c64://specs/memory-map"],
  prompts: ["assembly-program", "memory-debug"],
  defaultTags: ["vice", "emulator"],
  workflowHints: [
    "Use emulator helpers when running on VICE to inspect or tweak safe runtime resources.",
    "Explain that resource changes only persist for the current emulator session unless saved in VICE manually.",
  ],
  supportedPlatforms: ["vice"],
  tools: [
    {
      name: "c64_vice",
      description: "Grouped entry point for reading and updating selected VICE resources.",
      summary: "Reads or updates selected VICE resources that are safe to expose through MCP.",
      inputSchema: discriminatedUnionSchema({
        description: "VICE emulator operations available via the c64_vice tool.",
        variants: viceOperationSchemas.map((schema) => schema.jsonSchema),
      }),
      tags: ["vice", "resource", "grouped"],
      examples: [
        {
          name: "Read SID engine",
          description: "Inspect the active SID emulation mode.",
          arguments: { op: "resource_get", name: "SidEngine" },
        },
        {
          name: "Set SID engine",
          description: "Switch SID emulation to resid-fp (value 2).",
          arguments: { op: "resource_set", name: "SidEngine", value: 2 },
        },
      ],
      execute: viceOperationDispatcher,
    },
  ],
});

function handleToolError(error: unknown) {
  if (error instanceof ToolError) {
    return toolErrorResult(error);
  }
  return unknownErrorResult(error);
}

function ensureSafeResourceName(name: string, path: string): void {
  if (!RESOURCE_NAME_PATTERN.test(name)) {
    throw new ToolValidationError(
      "Resource names must start with an uppercase letter and use letters, numbers, dashes, underscores, or periods.",
      { path, details: { name } },
    );
  }
  if (!SAFE_RESOURCE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    throw new ToolValidationError(
      `Resource name must start with one of: ${SAFE_RESOURCE_PREFIXES.join(", ")}`,
      { path, details: { name } },
    );
  }
}
