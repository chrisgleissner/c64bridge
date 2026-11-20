import type { JsonSchema } from "./types.js";
import { ToolValidationError } from "./errors.js";

export interface Schema<T> {
  readonly jsonSchema: JsonSchema;
  parse(value: unknown, path?: string): T;
}

type Parser<T> = (value: unknown, path: string) => T;

const hasOwn = Object.prototype.hasOwnProperty;

function withDefaultPath(path?: string): string {
  return path ?? "$";
}

function createSchema<T>(jsonSchema: JsonSchema, parser: Parser<T>): Schema<T> {
  return {
    jsonSchema,
    parse(value: unknown, path?: string): T {
      return parser(value, withDefaultPath(path));
    },
  };
}

function ensureType(
  condition: boolean,
  message: string,
  path: string,
  details?: Record<string, unknown>,
): void {
  if (!condition) {
    throw new ToolValidationError(message, { path, details });
  }
}

function schemaHasDefault(schema: Schema<unknown>): boolean {
  return hasOwn.call(schema.jsonSchema, "default");
}

/** Valid example values for the string patterns the tools use, quoted in format errors. */
const PATTERN_EXAMPLES = new Map<string, string>([
  ["^[\\s_0-9A-Fa-f$]+$", "$A9 00 8D 20 D0"],
  ["^[\\s0-9A-Fa-f$]+$", "$A9 00"],
  ["^[0-9A-Fa-f]{1,2}$", "1F"],
  ["^[A-Za-z0-9_][A-Za-z0-9_. -]*$", "screen_poll"],
  ["^([A-Ga-g])([#b]?)(-?\\d+)$", "C#4"],
]);

/** The property name closest to a misspelt one: same letters ignoring case, or at most two edits. */
function nearestName(received: string, names: readonly string[]): string | undefined {
  const lower = received.toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const name of names) {
    const distance = name.toLowerCase() === lower ? 0 : editDistance(lower, name.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

export interface StringSchemaOptions {
  readonly description?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  /** A valid value, quoted in the error when the pattern does not match (not published in the schema). */
  readonly example?: string;
  readonly enum?: readonly string[];
  readonly default?: string;
}

export function stringSchema(options: StringSchemaOptions = {}): Schema<string> {
  const jsonSchema: JsonSchema = {
    type: "string",
    ...(options.description ? { description: options.description } : {}),
    ...(options.minLength !== undefined ? { minLength: options.minLength } : {}),
    ...(options.maxLength !== undefined ? { maxLength: options.maxLength } : {}),
    ...(options.pattern ? { pattern: options.pattern.source } : {}),
    ...(options.enum ? { enum: options.enum } : {}),
    ...(options.default !== undefined ? { default: options.default } : {}),
  };

  return createSchema<string>(jsonSchema, (value, path) => {
    if (value === undefined || value === null) {
      if (options.default !== undefined) {
        return options.default;
      }
      throw new ToolValidationError("Value is required", { path });
    }

    ensureType(typeof value === "string", "Expected a string", path, {
      receivedType: typeof value,
    });

    const stringValue = value as string;

    if (options.minLength !== undefined && stringValue.length < options.minLength) {
      throw new ToolValidationError(
        `String must have length ≥ ${options.minLength}`,
        { path, details: { minLength: options.minLength, received: stringValue.length } },
      );
    }

    if (options.maxLength !== undefined && stringValue.length > options.maxLength) {
      throw new ToolValidationError(
        `String must have length ≤ ${options.maxLength}`,
        { path, details: { maxLength: options.maxLength, received: stringValue.length } },
      );
    }

    if (options.pattern && !options.pattern.test(stringValue)) {
      const example = options.example ?? PATTERN_EXAMPLES.get(options.pattern.source);
      throw new ToolValidationError(
        options.description
          ? `String does not match the required pattern; expected ${options.description}`
          : "String does not match the required pattern",
        {
          path,
          details: {
            pattern: options.pattern.source,
            ...(example !== undefined ? { example } : {}),
            received: stringValue.length > 60 ? `${stringValue.slice(0, 60)}...` : stringValue,
          },
        },
      );
    }

    if (options.enum && !options.enum.includes(stringValue)) {
      throw new ToolValidationError("Value must be one of the allowed options", {
        path,
        details: { allowed: options.enum, received: stringValue },
      });
    }

    return stringValue;
  });
}

export interface NumberSchemaOptions {
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly integer?: boolean;
  readonly default?: number;
}

export function numberSchema(options: NumberSchemaOptions = {}): Schema<number> {
  const jsonSchema: JsonSchema = {
    type: options.integer ? "integer" : "number",
    ...(options.description ? { description: options.description } : {}),
    ...(options.minimum !== undefined ? { minimum: options.minimum } : {}),
    ...(options.maximum !== undefined ? { maximum: options.maximum } : {}),
    ...(options.default !== undefined ? { default: options.default } : {}),
  };

  return createSchema<number>(jsonSchema, (value, path) => {
    if (value === undefined || value === null) {
      if (options.default !== undefined) {
        return options.default;
      }
      throw new ToolValidationError("Value is required", { path });
    }

    ensureType(typeof value === "number" && Number.isFinite(value), "Expected a number", path, {
      receivedType: typeof value,
    });

    const numberValue = value as number;

    if (options.integer && !Number.isInteger(numberValue)) {
      throw new ToolValidationError("Expected an integer", { path });
    }

    if (options.minimum !== undefined && numberValue < options.minimum) {
      throw new ToolValidationError("Value is below minimum", {
        path,
        details: { minimum: options.minimum, received: numberValue },
      });
    }

    if (options.maximum !== undefined && numberValue > options.maximum) {
      throw new ToolValidationError("Value is above maximum", {
        path,
        details: { maximum: options.maximum, received: numberValue },
      });
    }

    return numberValue;
  });
}

export function integerSchema(options: Omit<NumberSchemaOptions, "integer"> = {}): Schema<number> {
  return numberSchema({ ...options, integer: true });
}

export function booleanSchema(options: { description?: string; default?: boolean } = {}): Schema<boolean> {
  const jsonSchema: JsonSchema = {
    type: "boolean",
    ...(options.description ? { description: options.description } : {}),
    ...(options.default !== undefined ? { default: options.default } : {}),
  };

  return createSchema<boolean>(jsonSchema, (value, path) => {
    if (value === undefined || value === null) {
      if (options.default !== undefined) {
        return options.default;
      }
      throw new ToolValidationError("Value is required", { path });
    }

    ensureType(typeof value === "boolean", "Expected a boolean", path, {
      receivedType: typeof value,
    });

    return value as boolean;
  });
}

export function literalSchema<T extends string | number | boolean>(
  literal: T,
  description?: string,
): Schema<T> {
  const jsonSchema: JsonSchema = {
    const: literal,
    description,
  } as JsonSchema;

  return createSchema<T>(jsonSchema, (value, path) => {
    if (value === literal) {
      return literal;
    }
    throw new ToolValidationError(`Expected literal value ${literal}`, { path });
  });
}

export function arraySchema<T>(
  itemSchema: Schema<T>,
  options: { description?: string; minItems?: number; maxItems?: number } = {},
): Schema<readonly T[]> {
  const jsonSchema: JsonSchema = {
    type: "array",
    ...(options.description ? { description: options.description } : {}),
    items: itemSchema.jsonSchema,
    ...(options.minItems !== undefined ? { minItems: options.minItems } : {}),
    ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
  };

  return createSchema<readonly T[]>(jsonSchema, (value, path) => {
    ensureType(Array.isArray(value), "Expected an array", path, {
      receivedType: typeof value,
    });

    const arrayValue = value as unknown[];
    const result: T[] = [];
    for (let index = 0; index < arrayValue.length; index += 1) {
      const itemPath = `${path}[${index}]`;
      const parsed = itemSchema.parse(arrayValue[index], itemPath);
      result.push(parsed);
    }

    if (options.minItems !== undefined && result.length < options.minItems) {
      throw new ToolValidationError("Array has too few items", {
        path,
        details: { minItems: options.minItems, received: result.length },
      });
    }

    if (options.maxItems !== undefined && result.length > options.maxItems) {
      throw new ToolValidationError("Array has too many items", {
        path,
        details: { maxItems: options.maxItems, received: result.length },
      });
    }

    return result;
  });
}

export function optionalSchema<T>(schema: Schema<T>, defaultValue?: T): Schema<T | undefined> {
  const baseSchema = schema.jsonSchema;
  const baseType = baseSchema.type;
  const optionalType = Array.isArray(baseType)
    ? baseType.includes("null")
      ? baseType
      : [...baseType, "null"]
    : baseType
      ? [baseType, "null"]
      : undefined;

  const baseDefault = baseSchema.default as T | undefined;
  const resolvedDefault = defaultValue !== undefined ? defaultValue : baseDefault;

  const jsonSchema: JsonSchema = {
    ...baseSchema,
    ...(optionalType ? { type: optionalType } : {}),
    ...(resolvedDefault !== undefined ? { default: resolvedDefault } : {}),
  };

  return createSchema<T | undefined>(jsonSchema, (value, path) => {
    if (value === undefined || value === null) {
      return resolvedDefault;
    }
    return schema.parse(value, path);
  });
}

export interface ObjectSchemaOptions<T extends Record<string, unknown>> {
  readonly description?: string;
  readonly properties: { [K in keyof T]: Schema<T[K]> };
  readonly required?: readonly (keyof T)[];
  readonly additionalProperties?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectSchema<T extends Record<string, unknown>>(
  options: ObjectSchemaOptions<T>,
): Schema<T> {
  const required = options.required ?? [];
  const additionalProperties = options.additionalProperties ?? false;
  const propertyEntries = Object.entries(options.properties).map(([key, schema]) => [key, schema.jsonSchema] as const);
  const jsonSchema: JsonSchema = {
    type: "object",
    ...(options.description ? { description: options.description } : {}),
    properties: Object.fromEntries(propertyEntries),
    ...(required.length > 0 ? { required: required.map((key) => key as string) } : {}),
    additionalProperties,
  };

  return createSchema<T>(jsonSchema, (value, path) => {
    ensureType(isPlainObject(value), "Expected an object", path, {
      receivedType: typeof value,
    });

    const result: Record<string, unknown> = {};
    const input = value as Record<string, unknown>;

    if (!additionalProperties) {
      for (const key of Object.keys(input)) {
        if (!hasOwn.call(options.properties, key)) {
          const allowed = Object.keys(options.properties);
          const suggestion = nearestName(key, allowed);
          throw new ToolValidationError(
            suggestion ? `Unexpected property "${key}"; did you mean "${suggestion}"?` : `Unexpected property "${key}"`,
            { path: `${path}.${key}`, details: { allowed, received: key } },
          );
        }
      }
    }

    for (const key of required) {
      if (!hasOwn.call(input, key as string)) {
        throw new ToolValidationError("Missing required property", {
          path: `${path}.${String(key)}`,
        });
      }
    }

    for (const [key, schema] of Object.entries(options.properties)) {
      const propertyPath = `${path}.${key}`;
      if (hasOwn.call(input, key)) {
        const parsed = schema.parse(input[key], propertyPath);
        if (parsed !== undefined) {
          result[key] = parsed;
        }
        continue;
      }

      if (schemaHasDefault(schema)) {
        const parsed = schema.parse(undefined, propertyPath);
        if (parsed !== undefined) {
          result[key] = parsed;
        }
      }
    }

    // Unknown properties of a closed object were rejected before the required check, so a
    // misspelt name is reported with its suggestion rather than as a missing property.
    if (additionalProperties) {
      for (const key of Object.keys(input)) {
        if (!hasOwn.call(options.properties, key)) {
          result[key] = input[key];
        }
      }
    }

    return result as T;
  });
}

export function mergeSchemas<T extends Record<string, unknown>, U extends Record<string, unknown>>(
  a: Schema<T>,
  b: Schema<U>,
): Schema<T & U> {
  const jsonSchema: JsonSchema = {
    allOf: [a.jsonSchema, b.jsonSchema],
  };

  return createSchema<T & U>(jsonSchema, (value, path) => {
    const first = a.parse(prepareValueForMerge(value, a), path);
    const second = b.parse(prepareValueForMerge(value, b), path);

    if (isPlainObject(value)) {
      const strictA = a.jsonSchema.additionalProperties === false;
      const strictB = b.jsonSchema.additionalProperties === false;

      if (strictA && strictB) {
        const allowedKeys = new Set<string>();
        if (a.jsonSchema.properties) {
          for (const key of Object.keys(a.jsonSchema.properties)) {
            allowedKeys.add(key);
          }
        }
        if (b.jsonSchema.properties) {
          for (const key of Object.keys(b.jsonSchema.properties)) {
            allowedKeys.add(key);
          }
        }

        for (const key of Object.keys(value)) {
          if (!allowedKeys.has(key)) {
            throw new ToolValidationError("Unexpected property", {
              path: `${path}.${key}`,
            });
          }
        }
      }
    }

    return { ...first, ...second };
  });
}

function prepareValueForMerge(value: unknown, schema: Schema<unknown>): unknown {
  if (!isPlainObject(value)) {
    return value;
  }

  if (schema.jsonSchema.additionalProperties === false && schema.jsonSchema.properties) {
    const subset: Record<string, unknown> = {};
    for (const key of Object.keys(schema.jsonSchema.properties)) {
      if (hasOwn.call(value, key)) {
        subset[key] = (value as Record<string, unknown>)[key];
      }
    }
    return subset;
  }

  return value;
}