import test from "#test/runner";
import assert from "#test/assert";
import {
  stringSchema,
  numberSchema,
  integerSchema,
  booleanSchema,
  literalSchema,
  arraySchema,
  optionalSchema,
  objectSchema,
  mergeSchemas,
} from "../src/tools/schema.ts";
import {
  ToolValidationError,
  ToolExecutionError,
  toolErrorResult,
  unknownErrorResult,
} from "../src/tools/errors.ts";
import { textResult } from "../src/tools/responses.ts";

const assertThrowsValidation = async (fn, messageIncludes) => {
  try {
    await fn();
    assert.fail("Expected ToolValidationError");
  } catch (error) {
    assert.ok(error instanceof ToolValidationError, "Expected validation error instance");
    if (messageIncludes) {
      assert.match(error.message, messageIncludes);
    }
  }
};

test("string schema validation", async (t) => {
  const schema = stringSchema({ minLength: 3, maxLength: 5, pattern: /^[A-Z]+$/ });

  assert.equal(schema.parse("ABC"), "ABC");
  assert.equal(schema.parse("Z".repeat(5)), "ZZZZZ");

  await assertThrowsValidation(() => schema.parse("AB"), /length/);
  await assertThrowsValidation(() => schema.parse("TOOLONG"), /length/);
  await assertThrowsValidation(() => schema.parse("abc"), /pattern/);

  const defaultSchema = stringSchema({ default: "HELLO" });
  assert.equal(defaultSchema.parse(undefined), "HELLO");

  const enumSchema = stringSchema({ enum: ["PAL", "NTSC"] });
  assert.equal(enumSchema.parse("PAL", "$.video.mode"), "PAL");
  await assertThrowsValidation(() => enumSchema.parse("SECAM"), /allowed options/);
  await assertThrowsValidation(() => schema.parse(42, "$.value"), /Expected a string/);
});

test("schema builders expose rich json schema metadata", () => {
  const str = stringSchema({
    description: "Video mode",
    minLength: 1,
    maxLength: 4,
    pattern: /^[A-Z]+$/,
    enum: ["PAL", "NTSC"],
    default: "PAL",
  });
  const num = numberSchema({ description: "Count", minimum: 1, maximum: 10, default: 2 });
  const int = integerSchema({ description: "Index", minimum: 0, maximum: 3, default: 1 });
  const bool = booleanSchema({ description: "Enabled", default: true });

  assert.deepEqual(str.jsonSchema, {
    type: "string",
    description: "Video mode",
    minLength: 1,
    maxLength: 4,
    pattern: "^[A-Z]+$",
    enum: ["PAL", "NTSC"],
    default: "PAL",
  });
  assert.deepEqual(num.jsonSchema, {
    type: "number",
    description: "Count",
    minimum: 1,
    maximum: 10,
    default: 2,
  });
  assert.deepEqual(int.jsonSchema, {
    type: "integer",
    description: "Index",
    minimum: 0,
    maximum: 3,
    default: 1,
  });
  assert.deepEqual(bool.jsonSchema, {
    type: "boolean",
    description: "Enabled",
    default: true,
  });
});

test("number schema validation", async () => {
  const schema = numberSchema({ minimum: 0, maximum: 10 });
  assert.equal(schema.parse(3), 3);

  await assertThrowsValidation(() => schema.parse(-1), /minimum/);
  await assertThrowsValidation(() => schema.parse(20), /maximum/);

  const intSchema = integerSchema();
  assert.equal(intSchema.parse(42), 42);
  await assertThrowsValidation(() => intSchema.parse(1.5), /integer/);

  const defaultSchema = numberSchema({ default: 7 });
  assert.equal(defaultSchema.parse(undefined), 7);
  await assertThrowsValidation(() => schema.parse("3"), /Expected a number/);
  await assertThrowsValidation(() => schema.parse(Number.NaN), /Expected a number/);
  await assertThrowsValidation(() => schema.parse(Number.POSITIVE_INFINITY), /Expected a number/);
});

test("boolean and literal schemas", async () => {
  const boolSchema = booleanSchema();
  assert.equal(boolSchema.parse(true), true);
  await assertThrowsValidation(() => boolSchema.parse("yes"), /boolean/);

  const defaultBool = booleanSchema({ default: false });
  assert.equal(defaultBool.parse(undefined), false);

  const literal = literalSchema("RUN");
  assert.equal(literal.parse("RUN"), "RUN");
  await assertThrowsValidation(() => literal.parse("STOP"), /literal/);

  const describedLiteral = literalSchema(true, "Toggle");
  assert.deepEqual(describedLiteral.jsonSchema, { const: true, description: "Toggle" });
  assert.equal(describedLiteral.parse(true), true);
});

test("array schema validation", async () => {
  const schema = arraySchema(integerSchema({ minimum: 0 }), { minItems: 1, maxItems: 3 });
  assert.deepEqual(schema.parse([1, 2]), [1, 2]);

  await assertThrowsValidation(() => schema.parse("not-array"), /Expected an array/);
  await assertThrowsValidation(() => schema.parse([]), /few/);
  await assertThrowsValidation(() => schema.parse([1, 2, 3, 4]), /many/);
});

test("optional schema defaults", () => {
  const base = integerSchema({ minimum: 0 });
  const optional = optionalSchema(base, 5);

  assert.equal(optional.parse(2), 2);
  assert.equal(optional.parse(undefined), 5);
  assert.equal(optional.parse(null), 5);
});

test("primitive schemas report required-value errors with explicit paths", async () => {
  await assertThrowsValidation(() => stringSchema().parse(undefined, "$.name"), /Value is required/);
  await assertThrowsValidation(() => numberSchema().parse(null, "$.count"), /Value is required/);
  await assertThrowsValidation(() => booleanSchema().parse(undefined, "$.enabled"), /Value is required/);
});

test("optional schema exposes null-aware json schema and inherits defaults", () => {
  const base = stringSchema({ default: "READY" });
  const optional = optionalSchema(base);

  assert.deepEqual(optional.jsonSchema.type, ["string", "null"]);
  assert.equal(optional.jsonSchema.default, "READY");
  assert.equal(optional.parse(undefined), "READY");
  assert.equal(optional.parse(null), "READY");
});

test("optional schema preserves existing null unions and explicit defaults", () => {
  const custom = {
    jsonSchema: { type: ["string", "null"], default: "A" },
    parse(value) {
      return value === undefined || value === null ? "A" : String(value);
    },
  };

  const optional = optionalSchema(custom, "B");
  assert.deepEqual(optional.jsonSchema.type, ["string", "null"]);
  assert.equal(optional.jsonSchema.default, "B");
  assert.equal(optional.parse(undefined), "B");
});

test("object schema validation", async () => {
  const schema = objectSchema({
    description: "Example payload",
    properties: {
      name: stringSchema({ minLength: 1 }),
      retries: optionalSchema(integerSchema({ minimum: 0 }), 0),
    },
    required: ["name"],
    additionalProperties: false,
  });

  const parsed = schema.parse({ name: "C64", retries: 3 });
  assert.deepEqual(parsed, { name: "C64", retries: 3 });

  await assertThrowsValidation(() => schema.parse(null), /Expected an object/);
  await assertThrowsValidation(() => schema.parse({ retries: 1 }), /Missing required property/);
  await assertThrowsValidation(() => schema.parse({ name: "C64", extra: true }), /Unexpected property/);
});

test("object schema can preserve additional properties", () => {
  const schema = objectSchema({
    properties: {
      name: stringSchema(),
    },
    additionalProperties: true,
  });

  const parsed = schema.parse({ name: "tool", extra: { ok: true }, count: 2 });
  assert.deepEqual(parsed, { name: "tool", extra: { ok: true }, count: 2 });
});

test("object schema defaults additionalProperties to false", async () => {
  const schema = objectSchema({
    properties: { name: stringSchema() },
  });

  assert.equal(schema.jsonSchema.additionalProperties, false);
  await assertThrowsValidation(() => schema.parse({ name: "tool", extra: true }), /Unexpected property/);
});

test("object schema applies defaults when optional provided", () => {
  const schema = objectSchema({
    properties: {
      title: optionalSchema(stringSchema({ default: "Untitled" }), "Untitled"),
    },
    additionalProperties: false,
  });

  const parsed = schema.parse({});
  assert.deepEqual(parsed, { title: "Untitled" });
});

test("object schema preserves explicit undefined-returning optional properties", () => {
  const schema = objectSchema({
    properties: {
      maybe: optionalSchema(stringSchema()),
    },
    additionalProperties: false,
  });

  const parsed = schema.parse({});
  assert.deepEqual(parsed, {});
});

test("merge schemas combines structures", () => {
  const a = objectSchema({
    properties: {
      name: stringSchema(),
    },
    additionalProperties: false,
  });

  const b = objectSchema({
    properties: {
      enabled: booleanSchema({ default: true }),
    },
    additionalProperties: false,
  });

  const merged = mergeSchemas(a, b);
  assert.deepEqual(merged.parse({ name: "tool", enabled: false }), { name: "tool", enabled: false });
});

test("merge schemas rejects unexpected keys when both are strict", async () => {
  const a = objectSchema({
    properties: { name: stringSchema() },
    additionalProperties: false,
  });
  const b = objectSchema({
    properties: { enabled: booleanSchema() },
    additionalProperties: false,
  });

  const merged = mergeSchemas(a, b);
  await assertThrowsValidation(() => merged.parse({ name: "tool", enabled: true, extra: 1 }), /Unexpected property/);
});

test("merge schemas respects permissive additional properties on one side", () => {
  const a = objectSchema({
    properties: { name: stringSchema() },
    additionalProperties: false,
  });
  const b = objectSchema({
    properties: { enabled: booleanSchema({ default: true }) },
    additionalProperties: true,
  });

  const merged = mergeSchemas(a, b);
  assert.deepEqual(merged.parse({ name: "tool", extra: "ok" }), { name: "tool", enabled: true, extra: "ok" });
});

test("tool error helpers produce consistent metadata", () => {
  const error = new ToolExecutionError("Failed", { code: "E_FAIL", details: { endpoint: "/rest" } });
  const result = toolErrorResult(error);
  assert.equal(result.isError, true);
  assert.deepEqual(result.metadata?.error, {
    kind: "execution",
    code: "E_FAIL",
    details: { endpoint: "/rest" },
  });
  assert.equal(result.structuredContent?.type, "json");
  assert.equal(result.structuredContent?.data?.error?.kind, "execution");
});

test("unknown errors wrap safely", () => {
  const result = unknownErrorResult(new Error("Oops"));
  assert.equal(result.isError, true);
  assert.equal(result.metadata?.error.kind, "unknown");
  assert.equal(result.structuredContent?.data?.error?.kind, "unknown");
});

test("text results expose metadata through structured content", () => {
  const result = textResult("Wrote bytes.", { success: true, address: "$0400" });

  assert.deepEqual(result.metadata, { success: true, address: "$0400" });
  assert.deepEqual(result.structuredContent, {
    type: "json",
    data: {
      message: "Wrote bytes.",
      success: true,
      address: "$0400",
    },
  });
});
