import type { C64Client } from "../c64Client.js";
import type { RagRetriever } from "../rag/types.js";
import {
  getPlatformStatus,
  isPlatformSupported,
  setPlatform,
  type PlatformId,
  type PlatformStatus,
} from "../platform.js";
import { withDiagnosticSpan } from "../diagnostics.js";
import { ToolUnsupportedPlatformError, ToolValidationError } from "./errors.js";

export type JsonSchema = {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly enum?: readonly (string | number | boolean)[];
  readonly items?: JsonSchema | readonly JsonSchema[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly format?: string;
  readonly default?: unknown;
  readonly examples?: readonly unknown[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly const?: unknown;
  readonly allOf?: readonly JsonSchema[];
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly oneOf?: readonly JsonSchema[];
  readonly discriminator?: {
    readonly propertyName: string;
  };
};

export type ToolLifecycle = "request-response" | "stream" | "fire-and-forget";

export interface ToolExample {
  readonly name: string;
  readonly description: string;
  readonly arguments: Record<string, unknown>;
}

export interface ToolLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface ToolExecutionContext {
  readonly client: C64Client;
  readonly rag: RagRetriever;
  readonly logger: ToolLogger;
  readonly platform: PlatformStatus;
  readonly setPlatform: (target: PlatformId) => PlatformStatus;
}

export interface ToolResponseContentText {
  readonly type: "text";
  readonly text: string;
}

export type ToolResponseContent = ToolResponseContentText;

export interface ToolRunResult {
  readonly content: readonly ToolResponseContent[];
  readonly structuredContent?: {
    readonly type: "json";
    readonly data: unknown;
  };
  readonly metadata?: Record<string, unknown>;
  readonly isError?: boolean;
}

export const OPERATION_DISCRIMINATOR = "op" as const;

export const VERIFY_PROPERTY_NAME = "verify" as const;

export interface VerifyOption {
  readonly verify?: boolean;
}

export const VERIFY_PROPERTY_SCHEMA: JsonSchema = Object.freeze({
  type: "boolean",
  description: "When true, perform a verification step after completing the operation.",
  default: false,
});

export interface OperationSchemaOptions {
  readonly description?: string;
  readonly opDescription?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export function operationSchema(op: string, options: OperationSchemaOptions = {}): JsonSchema {
  const {
    description,
    opDescription,
    properties = {},
    required = [],
    additionalProperties = false,
  } = options;

  const schema: JsonSchema = {
    type: "object",
    ...(description ? { description } : {}),
    properties: {
      [OPERATION_DISCRIMINATOR]: {
        const: op,
        description: opDescription ?? `Selects the ${op} operation.`,
      },
      ...properties,
    },
    required: [OPERATION_DISCRIMINATOR, ...required],
    additionalProperties,
  };

  return schema;
}

export interface DiscriminatedUnionSchemaOptions {
  readonly description?: string;
  readonly discriminator?: string;
  readonly variants: readonly JsonSchema[];
}

export function discriminatedUnionSchema(options: DiscriminatedUnionSchemaOptions): JsonSchema {
  const { description, discriminator = OPERATION_DISCRIMINATOR, variants } = options;

  if (!variants || variants.length === 0) {
    throw new Error("Discriminated union schemas require at least one variant.");
  }

  // Flatten the discriminated union into a single object schema.
  // Claude's API does not support oneOf/allOf/anyOf at the top level,
  // so we merge all variant properties and use an enum for the discriminator.
  const opValues: string[] = [];
  const mergedProperties: Record<string, JsonSchema> = {};
  const opDescriptions: string[] = [];

  for (const variant of variants) {
    const variantProps = variant.properties ?? {};
    const discProp = variantProps[discriminator];
    const opValue = discProp?.const as string | undefined;

    if (opValue) {
      opValues.push(opValue);
      const variantDesc = variant.description ?? discProp?.description ?? "";
      if (variantDesc) {
        opDescriptions.push(`${opValue}: ${variantDesc}`);
      }
    }

    for (const [key, propSchema] of Object.entries(variantProps)) {
      if (key === discriminator) continue;
      if (!mergedProperties[key]) {
        mergedProperties[key] = propSchema;
      }
    }
  }

  const opPropertySchema: JsonSchema = opValues.length > 0
    ? { type: "string", enum: opValues, description: `Selects the operation.` }
    : { type: "string", description: `Selects the operation.` };

  const fullDescription = description
    ? (opDescriptions.length > 0
        ? `${description}\n\nOperations:\n${opDescriptions.map((d) => `- ${d}`).join("\n")}`
        : description)
    : (opDescriptions.length > 0
        ? `Operations:\n${opDescriptions.map((d) => `- ${d}`).join("\n")}`
        : undefined);

  const schema: JsonSchema = {
    type: "object",
    ...(fullDescription ? { description: fullDescription } : {}),
    properties: {
      [discriminator]: opPropertySchema,
      ...mergedProperties,
    },
    required: [discriminator],
  };

  return schema;
}

export type OperationMap = Record<string, Record<string, unknown>>;

export type OperationArgs<
  TMap extends OperationMap,
  TKey extends keyof TMap & string,
> = Readonly<TMap[TKey]> & { readonly [OPERATION_DISCRIMINATOR]: TKey };

export type OperationHandlerMap<TMap extends OperationMap> = {
  readonly [K in keyof TMap & string]: (
    args: OperationArgs<TMap, K>,
    ctx: ToolExecutionContext,
  ) => Promise<ToolRunResult>;
};

export function createOperationDispatcher<TMap extends OperationMap>(
  toolName: string,
  handlers: OperationHandlerMap<TMap>,
): (args: unknown, ctx: ToolExecutionContext) => Promise<ToolRunResult> {
  const allowed = Object.keys(handlers).sort();

  return async (args, ctx) => {
    if (typeof args !== "object" || args === null) {
      throw new ToolValidationError(
        `${toolName} requires an object argument with an ${OPERATION_DISCRIMINATOR} property`,
        { path: "$" },
      );
    }

    const record = args as Record<string, unknown>;
    const opValue = record[OPERATION_DISCRIMINATOR];

    if (typeof opValue !== "string" || opValue.length === 0) {
      throw new ToolValidationError(
        `${toolName} is a grouped tool and requires an ${OPERATION_DISCRIMINATOR} string to select an operation`,
        { path: `$.${OPERATION_DISCRIMINATOR}`, details: { allowed } },
      );
    }

    const opKey = opValue as keyof TMap & string;
    const handler = handlers[opKey];

    if (!handler) {
      throw new ToolValidationError(
        `${toolName} does not support ${OPERATION_DISCRIMINATOR} "${opValue}"`,
        { path: `$.${OPERATION_DISCRIMINATOR}`, details: { allowed } },
      );
    }

    return handler(record as OperationArgs<TMap, typeof opKey>, ctx);
  };
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly summary?: string;
  readonly lifecycle?: ToolLifecycle;
  readonly inputSchema?: JsonSchema;
  readonly examples?: readonly ToolExample[];
  readonly relatedResources?: readonly string[];
  readonly relatedPrompts?: readonly string[];
  readonly tags?: readonly string[];
  readonly workflowHints?: readonly string[];
  readonly prerequisites?: readonly string[];
  readonly supportedPlatforms?: readonly PlatformId[];
  readonly operationPlatforms?: Record<string, readonly PlatformId[]>;
  readonly operationToolNames?: Record<string, string>;
  readonly execute: (args: unknown, ctx: ToolExecutionContext) => Promise<ToolRunResult>;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonSchema;
  readonly metadata: {
    readonly domain: string;
    readonly summary: string;
    readonly lifecycle: ToolLifecycle;
    readonly resources: readonly string[];
    readonly prompts: readonly string[];
    readonly examples?: readonly ToolExample[];
    readonly tags: readonly string[];
    readonly workflowHints?: readonly string[];
    readonly prerequisites?: readonly string[];
    readonly platforms?: readonly PlatformId[];
    readonly operationPlatforms?: Record<string, readonly PlatformId[]>;
  };
}

export interface ToolModuleConfig {
  readonly domain: string;
  readonly summary: string;
  readonly resources?: readonly string[];
  readonly prompts?: readonly string[];
  readonly defaultLifecycle?: ToolLifecycle;
  readonly defaultTags?: readonly string[];
  readonly workflowHints?: readonly string[];
  readonly prerequisites?: readonly string[];
  readonly supportedPlatforms?: readonly PlatformId[];
  readonly tools: readonly ToolDefinition[];
}

export interface ToolModule {
  readonly domain: string;
  readonly summary: string;
  readonly defaultTags: readonly string[];
  readonly workflowHints?: readonly string[];
  describeTools(): readonly ToolDescriptor[];
  invoke(name: string, args: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult>;
}

export function defineToolModule(config: ToolModuleConfig): ToolModule {
  const defaultLifecycle = config.defaultLifecycle ?? "request-response";
  const defaultTags = Object.freeze([...(config.defaultTags ?? [])]) as readonly string[];
  const defaultResources = Object.freeze([...(config.resources ?? [])]) as readonly string[];
  const defaultPrompts = Object.freeze([...(config.prompts ?? [])]) as readonly string[];
  const defaultWorkflowHints = Object.freeze([...(config.workflowHints ?? [])]) as readonly string[];
  const defaultPrerequisites = Object.freeze([...(config.prerequisites ?? [])]) as readonly string[];
  const defaultPlatforms = config.supportedPlatforms
    ? Object.freeze([...(config.supportedPlatforms)]) as readonly PlatformId[]
    : (Object.freeze(["c64u"] as const) as readonly PlatformId[]);

  const toolMap = new Map(config.tools.map((tool) => [tool.name, tool]));

  return {
    domain: config.domain,
    summary: config.summary,
    defaultTags,
    workflowHints: defaultWorkflowHints.length > 0 ? defaultWorkflowHints : undefined,
    describeTools(): readonly ToolDescriptor[] {
      return config.tools.map((tool) => {
        const workflowHints = mergeOptionalStrings(defaultWorkflowHints, tool.workflowHints);
        const prerequisites = mergeOptionalStrings(defaultPrerequisites, tool.prerequisites);
        const platforms = mergePlatforms(defaultPlatforms, tool.supportedPlatforms);

        const metadata: ToolDescriptor["metadata"] = {
          domain: config.domain,
          summary: tool.summary ?? tool.description,
          lifecycle: tool.lifecycle ?? defaultLifecycle,
          resources: mergeUnique(defaultResources, tool.relatedResources),
          prompts: mergeUnique(defaultPrompts, tool.relatedPrompts),
          examples: tool.examples,
          tags: mergeUnique(defaultTags, tool.tags),
          ...(workflowHints ? { workflowHints } : {}),
          ...(prerequisites ? { prerequisites } : {}),
          ...(platforms ? { platforms } : {}),
          ...(tool.operationPlatforms ? { operationPlatforms: tool.operationPlatforms } : {}),
        };

        return {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          metadata,
        } satisfies ToolDescriptor;
      });
    },
    async invoke(name, args, ctx) {
      const tool = toolMap.get(name);
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }

      const platforms = resolveSupportedPlatforms(tool, args, defaultPlatforms);
      const status = ctx.platform ?? getPlatformStatus();
      const setter = ctx.setPlatform ?? setPlatform;
      if (!isPlatformSupported(status.id, platforms)) {
        throw new ToolUnsupportedPlatformError(resolveUnsupportedToolName(name, tool, args), status.id, platforms);
      }

      const enrichedCtx: ToolExecutionContext = {
        ...ctx,
        platform: status,
        setPlatform: setter,
      };

      return withDiagnosticSpan(
        "tool",
        `${config.domain}.${name}`,
        {
          domain: config.domain,
          tool: name,
          operation: getSelectedOperation(args) ?? null,
          platform: status.id,
        },
        () => tool.execute(args, enrichedCtx),
      );
    },
  };
}

function resolveSupportedPlatforms(
  tool: ToolDefinition,
  args: unknown,
  defaultPlatforms: readonly PlatformId[],
): readonly PlatformId[] {
  const basePlatforms = mergePlatforms(defaultPlatforms, tool.supportedPlatforms) ?? defaultPlatforms;
  const operation = getSelectedOperation(args);
  if (!operation) {
    return basePlatforms;
  }

  const operationPlatforms = tool.operationPlatforms?.[operation];
  return operationPlatforms && operationPlatforms.length > 0 ? operationPlatforms : basePlatforms;
}

function resolveUnsupportedToolName(
  toolName: string,
  tool: ToolDefinition,
  args: unknown,
): string {
  const operation = getSelectedOperation(args);
  if (!operation) {
    return toolName;
  }

  const mappedName = tool.operationToolNames?.[operation];
  if (mappedName) {
    return mappedName;
  }

  return tool.operationPlatforms?.[operation] ? operation : toolName;
}

function getSelectedOperation(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) {
    return undefined;
  }

  const op = (args as Record<string, unknown>)[OPERATION_DISCRIMINATOR];
  return typeof op === "string" && op.length > 0 ? op : undefined;
}

function mergeUnique(
  base: readonly string[],
  extra?: readonly string[],
): readonly string[] {
  if (!extra || extra.length === 0) {
    return base;
  }

  const set = new Set(base);
  for (const item of extra) {
    set.add(item);
  }

  return Array.from(set);
}

function mergeOptionalStrings(
  base: readonly string[],
  extra?: readonly string[],
): readonly string[] | undefined {
  if ((!base || base.length === 0) && (!extra || extra.length === 0)) {
    return base && base.length > 0 ? base : undefined;
  }

  const set = new Set(base ?? []);
  if (extra) {
    for (const item of extra) {
      set.add(item);
    }
  }

  const merged = Array.from(set);
  return merged.length > 0 ? merged : undefined;
}

function mergePlatforms(
  base: readonly PlatformId[],
  extra?: readonly PlatformId[],
): readonly PlatformId[] | undefined {
  if ((!base || base.length === 0) && (!extra || extra.length === 0)) {
    return base && base.length > 0 ? base : undefined;
  }

  const set = new Set(base ?? []);
  if (extra) {
    for (const item of extra) {
      set.add(item);
    }
  }

  const merged = Array.from(set);
  return merged.length > 0 ? merged : undefined;
}
