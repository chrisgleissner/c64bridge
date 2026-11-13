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
import { annotationsForEffects, type ToolAnnotationsHint, type ToolEffect } from "./access.js";

export type { ToolEffect } from "./access.js";

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
  readonly anyOf?: readonly JsonSchema[];
  readonly discriminator?: {
    readonly propertyName: string;
  };
  readonly "x-c64bridge-operations"?: readonly OperationInputMetadata[];
};

export interface OperationInputMetadata {
  readonly op: string;
  readonly description?: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly inputSchema: JsonSchema;
}

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

export interface ToolResponseContentImage {
  readonly type: "image";
  /** Base64-encoded image bytes. */
  readonly data: string;
  readonly mimeType: string;
}

export type ToolResponseContent = ToolResponseContentText | ToolResponseContentImage;

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
  const propertyVariants: Record<string, JsonSchema[]> = {};
  const opDescriptions: string[] = [];
  const operationMetadata: OperationInputMetadata[] = [];

  for (const variant of variants) {
    const variantProps = variant.properties ?? {};
    const discProp = variantProps[discriminator];
    const opValue = discProp?.const as string | undefined;
    const variantDesc = variant.description ?? discProp?.description ?? "";
    const requiredInputs = (variant.required ?? []).filter((name) => name !== discriminator);
    const optionalInputs = Object.keys(variantProps).filter((name) =>
      name !== discriminator && !requiredInputs.includes(name),
    );

    if (opValue) {
      opValues.push(opValue);
      const requiredSummary = requiredInputs.length > 0
        ? ` Required inputs: ${requiredInputs.join(", ")}.`
        : " Required inputs: none.";
      const optionalSummary = optionalInputs.length > 0
        ? ` Optional inputs: ${optionalInputs.join(", ")}.`
        : "";
      opDescriptions.push(`${opValue}: ${variantDesc || `Operation ${opValue}`}${requiredSummary}${optionalSummary}`);
      operationMetadata.push({
        op: opValue,
        ...(variantDesc ? { description: variantDesc } : {}),
        required: requiredInputs,
        optional: optionalInputs,
        inputSchema: variant,
      });
    }

    for (const [key, propSchema] of Object.entries(variantProps)) {
      if (key === discriminator) continue;
      (propertyVariants[key] ??= []).push(propSchema);
    }
  }

  // Variants may declare the same property with different limits. The flattened
  // property must accept every variant's values; per-op validation stays strict.
  for (const [key, schemas] of Object.entries(propertyVariants)) {
    mergedProperties[key] = combinePropertySchemas(schemas);
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
    additionalProperties: false,
    ...(operationMetadata.length > 0 ? { "x-c64bridge-operations": operationMetadata } : {}),
  };

  return schema;
}

/**
 * Returns the input schema as published on the wire. The per-operation schemas in
 * "x-c64bridge-operations" duplicate the property information of the flattened
 * schema and roughly halve its size, so they are omitted unless a client opts in
 * with C64BRIDGE_VERBOSE_SCHEMA=1. The registry keeps them for documentation generators.
 */
export function publishedInputSchema(
  schema: JsonSchema | undefined,
  options: { verbose?: boolean } = {},
): JsonSchema | undefined {
  const verbose = options.verbose ?? process.env.C64BRIDGE_VERBOSE_SCHEMA === "1";
  if (!schema || verbose || !("x-c64bridge-operations" in schema)) {
    return schema;
  }
  const { "x-c64bridge-operations": _operations, ...published } = schema;
  return published;
}

const PUBLISHED_TOOL_META_KEYS = [
  "domain", "lifecycle", "platforms", "operationPlatforms", "effect", "operationEffects",
] as const;

/**
 * Returns the tool _meta published in tools/list. Clients need the platforms and
 * effects; the descriptive fields (summary, examples, workflowHints, resources,
 * prompts, tags, prerequisites) cost about 20 KB per listing and are published only with
 * C64BRIDGE_VERBOSE_SCHEMA=1. The registry keeps them for documentation generators.
 */
export function publishedToolMeta<T extends object>(
  metadata: T,
  options: { verbose?: boolean } = {},
): Partial<T> {
  const verbose = options.verbose ?? process.env.C64BRIDGE_VERBOSE_SCHEMA === "1";
  if (verbose) return metadata;
  const source = metadata as Record<string, unknown>;
  const published: Record<string, unknown> = {};
  for (const key of PUBLISHED_TOOL_META_KEYS) {
    if (source[key] !== undefined) published[key] = source[key];
  }
  return published as Partial<T>;
}

const OP_LIMITS_NOTE = "Limits depend on op.";

const WIDENABLE_KEYS = new Set([
  "type", "description", "enum", "const", "default", "minimum", "maximum", "minLength", "maxLength",
  "minItems", "maxItems", "pattern", "format", "items", "examples",
]);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function withoutDescription(schema: JsonSchema): JsonSchema {
  const { description: _description, ...rest } = schema;
  return rest;
}

function typeSet(schema: JsonSchema): string[] | undefined {
  if (schema.type === undefined) {
    return undefined;
  }
  const types = Array.isArray(schema.type) ? [...schema.type] : [schema.type as string];
  return types;
}

function enumValues(schema: JsonSchema): readonly unknown[] | undefined {
  if (schema.enum) return schema.enum;
  if ("const" in schema) return [schema.const];
  return undefined;
}

function smallest(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : Math.min(a, b);
}

function largest(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : Math.max(a, b);
}

/** Returns a schema accepting everything either input accepts, or undefined when that cannot be expressed safely. */
function widenPair(a: JsonSchema, b: JsonSchema): JsonSchema | undefined {
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(aRecord), ...Object.keys(bRecord)])) {
    if (!WIDENABLE_KEYS.has(key) && !deepEqual(aRecord[key], bRecord[key])) {
      return undefined;
    }
  }

  const aTypes = typeSet(a);
  const bTypes = typeSet(b);
  let types: string[] | undefined;
  if (aTypes && bTypes) {
    types = Array.from(new Set([...aTypes, ...bTypes]));
    if (types.includes("number")) {
      types = types.filter((type) => type !== "integer");
    }
  }

  // Structured types only widen when their element schema widens.
  let items: JsonSchema | undefined;
  if (a.items !== undefined || b.items !== undefined) {
    if (!a.items || !b.items || Array.isArray(a.items) || Array.isArray(b.items)) {
      if (!deepEqual(a.items, b.items)) return undefined;
      items = a.items as JsonSchema | undefined;
    } else {
      items = combinePropertySchemas([a.items as JsonSchema, b.items as JsonSchema], false);
    }
  }

  const aEnum = enumValues(a);
  const bEnum = enumValues(b);
  const enumUnion = aEnum && bEnum
    ? [...aEnum, ...bEnum.filter((value) => !aEnum.includes(value))]
    : undefined;

  const minimum = smallest(a.minimum, b.minimum);
  const maximum = largest(a.maximum, b.maximum);
  const minLength = smallest(a.minLength, b.minLength);
  const maxLength = largest(a.maxLength, b.maxLength);
  const minItems = smallest(a.minItems, b.minItems);
  const maxItems = largest(a.maxItems, b.maxItems);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(a)) {
    if (!WIDENABLE_KEYS.has(key)) result[key] = value;
  }
  if (types) result.type = types.length === 1 ? types[0] : types;
  if (a.description !== undefined || b.description !== undefined) result.description = a.description ?? b.description;
  if (enumUnion) result.enum = enumUnion;
  if (minimum !== undefined) result.minimum = minimum;
  if (maximum !== undefined) result.maximum = maximum;
  if (minLength !== undefined) result.minLength = minLength;
  if (maxLength !== undefined) result.maxLength = maxLength;
  if (minItems !== undefined) result.minItems = minItems;
  if (maxItems !== undefined) result.maxItems = maxItems;
  if (items) result.items = items;
  if (a.pattern !== undefined && a.pattern === b.pattern) result.pattern = a.pattern;
  if (a.format !== undefined && a.format === b.format) result.format = a.format;
  if (deepEqual(a.default, b.default) && a.default !== undefined) result.default = a.default;
  if (deepEqual(a.examples, b.examples) && a.examples !== undefined) result.examples = a.examples;
  return result as JsonSchema;
}

/**
 * Combines the schemas that different operations declare for one property into a
 * single schema accepting all of their values. Identical schemas are returned untouched.
 */
export function combinePropertySchemas(schemas: readonly JsonSchema[], annotate = true): JsonSchema {
  const first = schemas[0]!;
  const distinct: JsonSchema[] = [];
  for (const schema of schemas) {
    if (!distinct.some((existing) => deepEqual(withoutDescription(existing), withoutDescription(schema)))) {
      distinct.push(schema);
    }
  }
  if (distinct.length === 1) {
    return first;
  }

  let merged: JsonSchema | undefined = distinct[0];
  for (const schema of distinct.slice(1)) {
    merged = merged ? widenPair(merged, schema) : undefined;
  }

  const result: JsonSchema = merged ?? {
    anyOf: distinct.map(withoutDescription),
    ...(first.description ? { description: first.description } : {}),
  };
  if (!annotate) {
    return result;
  }
  const description = result.description;
  if (description?.includes(OP_LIMITS_NOTE)) {
    return result;
  }
  return { ...result, description: description ? `${description} ${OP_LIMITS_NOTE}` : OP_LIMITS_NOTE };
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
    // Own properties only: "constructor", "toString", etc. must not resolve to Object.prototype members.
    const handler = hasOwnKey(handlers, opKey) ? handlers[opKey] : undefined;

    if (!handler) {
      throw new ToolValidationError(
        `${toolName} does not support ${OPERATION_DISCRIMINATOR} "${opValue}"`,
        { path: `$.${OPERATION_DISCRIMINATOR}`, details: { allowed, received: opValue } },
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
  /** Effect of every operation of a grouped tool; every operation must be listed. */
  readonly operationEffects?: Record<string, ToolEffect>;
  /** Effect of a tool without operations (also its annotation effect). */
  readonly effect?: ToolEffect;
  /**
   * Overrides the effect of one call, for example by an argument. Returns undefined to use the
   * declared effect of the operation.
   */
  readonly effectOf?: (op: string | undefined, args: unknown) => ToolEffect | undefined;
  readonly execute: (args: unknown, ctx: ToolExecutionContext) => Promise<ToolRunResult>;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonSchema;
  readonly annotations?: ToolAnnotationsHint;
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
    readonly operationEffects?: Record<string, ToolEffect>;
    readonly effect?: ToolEffect;
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
  /**
   * Effect of one call to a tool of this module, or undefined when the call selects no known
   * operation (the dispatcher then reports the validation error).
   */
  effectOf?(name: string, args: unknown): ToolEffect | undefined;
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
          ...(tool.operationEffects ? { operationEffects: tool.operationEffects } : {}),
          ...(tool.effect ? { effect: tool.effect } : {}),
        };
        const declaredEffects = tool.operationEffects ? Object.values(tool.operationEffects) : tool.effect ? [tool.effect] : [];

        return {
          name: tool.name,
          description: tool.description,
          inputSchema: tagOperations(tool.inputSchema, tool.operationPlatforms, tool.operationEffects),
          annotations: annotationsForEffects(declaredEffects),
          metadata,
        } satisfies ToolDescriptor;
      });
    },
    effectOf(name, args) {
      const tool = toolMap.get(name);
      return tool ? resolveToolEffect(tool, args) : undefined;
    },
    async invoke(name, args, ctx) {
      const tool = toolMap.get(name);
      if (!tool) {
        throw new ToolValidationError(`Unknown tool: ${name}`, {
          path: "$.name",
          details: { allowed: Array.from(toolMap.keys()).sort(), received: name },
        });
      }

      const platforms = resolveSupportedPlatforms(tool, args, defaultPlatforms);
      const status = ctx.platform ?? getPlatformStatus();
      const setter = ctx.setPlatform ?? setPlatform;
      if (!isPlatformSupported(status.id, platforms)) {
        throw new ToolUnsupportedPlatformError(
          resolveUnsupportedToolName(name, tool, args),
          status.id,
          platforms,
          {
            toolName: name,
            op: getSelectedOperation(args),
            configured: configuredBackends(ctx),
          },
        );
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

const ALL_PLATFORMS: readonly PlatformId[] = ["c64u", "u2", "vice"];

/**
 * Marks operations in the operation list of a grouped tool description: operations that are not
 * available on every backend get their backend list and operations that are not read-only get
 * their effect, for example "- unmount [c64u, u2] [write]: ...".
 */
export function tagOperations(
  schema: JsonSchema | undefined,
  operationPlatforms: Record<string, readonly PlatformId[]> | undefined,
  operationEffects?: Record<string, ToolEffect>,
): JsonSchema | undefined {
  if (!schema?.description || (!operationPlatforms && !operationEffects)) {
    return schema;
  }
  let description = schema.description;
  const ops = new Set([...Object.keys(operationPlatforms ?? {}), ...Object.keys(operationEffects ?? {})]);
  for (const op of ops) {
    const platforms = ownValue(operationPlatforms, op);
    const effect = ownValue(operationEffects, op);
    let tags = "";
    if (platforms && platforms.length > 0 && !ALL_PLATFORMS.every((id) => platforms.includes(id))) {
      tags += ` [${platforms.join(", ")}]`;
    }
    if (effect && effect !== "read") {
      tags += ` [${effect}]`;
    }
    if (!tags) {
      continue;
    }
    const marker = `\n- ${op}: `;
    if (description.includes(marker)) {
      description = description.replace(marker, `\n- ${op}${tags}: `);
    }
  }
  return description === schema.description ? schema : { ...schema, description };
}

function resolveToolEffect(tool: ToolDefinition, args: unknown): ToolEffect | undefined {
  const op = getSelectedOperation(args);
  const overridden = tool.effectOf?.(op, args);
  if (overridden) {
    return overridden;
  }
  if (!tool.operationEffects) {
    // Tools without operations; an undeclared effect fails closed.
    return tool.effect ?? "destructive";
  }
  if (!op) {
    return undefined;
  }
  const declared = ownValue(tool.operationEffects, op);
  if (declared) {
    return declared;
  }
  const opSchema = tool.inputSchema?.properties?.[OPERATION_DISCRIMINATOR];
  const known = opSchema?.enum?.includes(op) === true;
  // An operation of the schema without a declared effect fails closed; an unknown name is left
  // to the dispatcher, which reports the validation error.
  return known ? "destructive" : undefined;
}

function configuredBackends(ctx: ToolExecutionContext): readonly PlatformId[] | undefined {
  const client = ctx.client as { getAvailableBackends?: () => readonly PlatformId[] } | undefined;
  if (typeof client?.getAvailableBackends !== "function") {
    return undefined;
  }
  try {
    return client.getAvailableBackends();
  } catch {
    return undefined;
  }
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

  const operationPlatforms = ownValue(tool.operationPlatforms, operation);
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

  const mappedName = ownValue(tool.operationToolNames, operation);
  if (mappedName) {
    return mappedName;
  }

  return ownValue(tool.operationPlatforms, operation) ? operation : toolName;
}

function hasOwnKey(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function ownValue<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && hasOwnKey(record, key) ? record[key] : undefined;
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
