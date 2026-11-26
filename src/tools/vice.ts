import {
  createOperationDispatcher,
  defineToolModule,
  discriminatedUnionSchema,
  type OperationHandlerMap,
  type OperationMap,
} from "./types.js";
import { resolveHostPath } from "../hostPaths.js";
import {
  booleanSchema,
  literalSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
  type Schema,
} from "./schema.js";
import { jsonResult, textResult } from "./responses.js";
import {
  ToolError,
  ToolValidationError,
  toolErrorResult,
  unknownErrorResult,
} from "./errors.js";
import { RESOURCE_NAME_PATTERN, resourceNameProblem } from "../vice/resourcePolicy.js";

interface ViceOperationMap extends OperationMap {
  readonly resource_get: {
    readonly name: string;
  };
  readonly snapshot_save: { readonly path: string };
  readonly snapshot_restore: { readonly path: string };
  readonly version: Record<string, never>;
  readonly resource_set: {
    readonly name: string;
    readonly value: string | number;
  };
}

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
  description: "VICE resource name (example: SidEngine, SidModel).",
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

const snapshotSaveArgsSchema = objectSchema({
  description: "Save snapshot.",
  properties: {
    op: literalSchema("snapshot_save"),
    path: stringSchema({ description: "File path." }),
  },
  required: ["op", "path"],
  additionalProperties: false,
});

const snapshotRestoreArgsSchema = objectSchema({
  description: "Restore snapshot.",
  properties: {
    op: literalSchema("snapshot_restore"),
    path: stringSchema({ description: "File path." }),
  },
  required: ["op", "path"],
  additionalProperties: false,
});

const versionArgsSchema = objectSchema({
  description: "VICE version.",
  properties: { op: literalSchema("version") },
  required: ["op"],
  additionalProperties: false,
});

const viceOperationSchemas = [
  resourceGetArgsSchema,
  resourceSetArgsSchema,
  snapshotSaveArgsSchema,
  snapshotRestoreArgsSchema,
  versionArgsSchema,
] as const;

const viceOperationHandlers: OperationHandlerMap<ViceOperationMap> = {
  resource_get: async (args, ctx) => {
    try {
      const parsed = resourceGetArgsSchema.parse(args);
      ensureSafeResourceName(parsed.name, "$.name");
      ctx.logger.info("Reading VICE resource", { name: parsed.name });

      // VICE answers an unknown resource with an error; an empty string is a legitimate value
      // (for example an unset file name).
      const value = await ctx.client.viceResourceGet(parsed.name);

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
  snapshot_save: async (args, ctx) => {
    try {
      const parsed = snapshotSaveArgsSchema.parse(args);
      const path = resolveHostPath(parsed.path, { purpose: "write" });
      await ctx.client.viceSnapshotSave(path);
      return textResult(`Saved VICE snapshot to ${path}.`, { success: true, path });
    } catch (error) {
      return handleToolError(error);
    }
  },
  snapshot_restore: async (args, ctx) => {
    try {
      const parsed = snapshotRestoreArgsSchema.parse(args);
      const path = resolveHostPath(parsed.path, { purpose: "read" });
      const pc = await ctx.client.viceSnapshotRestore(path);
      const pcText = `$${pc.toString(16).toUpperCase().padStart(4, "0")}`;
      return textResult(`Restored VICE snapshot ${path}; program counter ${pcText}.`, { success: true, path, pc: pcText });
    } catch (error) {
      return handleToolError(error);
    }
  },
  version: async (_args, ctx) => {
    try {
      const info = await ctx.client.viceVersionInfo();
      return textResult(`VICE ${info.version} (SVN revision ${info.svnRevision}).`, { success: true, version: info.version, svnRevision: info.svnRevision });
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

      // VICE stores each resource as an integer or a string, and the set command must use that
      // type: read it first and convert the value, as c64_config does on VICE.
      const current = await ctx.client.viceResourceGet(parsed.name);
      const value = coerceResourceValue(parsed.value, current.type, parsed.name);
      await ctx.client.viceResourceSet(parsed.name, value);
      return textResult(`Updated VICE resource ${parsed.name} (${current.type}) to ${JSON.stringify(value)}.`, {
        success: true,
        name: parsed.name,
        type: current.type,
        value,
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
  resources: ["c64://memory/map"],
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
      description: "VICE resources, snapshots.",
      summary: "Reads or updates selected VICE resources that are safe to expose through MCP.",
      inputSchema: discriminatedUnionSchema({
        description: "VICE emulator operations.",
        variants: viceOperationSchemas.map((schema) => schema.jsonSchema),
      }),
      operationEffects: { resource_get: "read", resource_set: "write", snapshot_save: "write", snapshot_restore: "destructive", version: "read" },
      tags: ["vice", "resource", "grouped"],
      examples: [
        {
          name: "Read SID engine",
          description: "Read the SID engine (integer; 0 FastSID, 1 ReSID).",
          arguments: { op: "resource_get", name: "SidEngine" },
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

function coerceResourceValue(value: string | number, type: string, name: string): string | number {
  if (type !== "int") return String(value);
  const text = typeof value === "string" ? value.trim().toLowerCase() : value;
  const parsed = text === "true" ? 1 : text === "false" ? 0 : typeof text === "number" ? text : /^[+-]?\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < -0x80000000 || parsed > 0x7fffffff) {
    throw new ToolValidationError(`VICE resource ${name} is an integer resource; ${JSON.stringify(value)} is not a 32-bit integer`, { path: "$.value", details: { name, type } });
  }
  return parsed;
}

function ensureSafeResourceName(name: string, path: string): void {
  const problem = resourceNameProblem(name);
  if (problem) {
    throw new ToolValidationError(problem.message, { path, details: { name } });
  }
}
