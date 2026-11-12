import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { combinePropertySchemas, discriminatedUnionSchema, operationSchema } from "../src/tools/types.js";

// Every published example must validate; none are exempt.
const KNOWN_INVALID_EXAMPLES = new Set([]);

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(type, value) {
  const actual = jsonType(value);
  return type === actual || (type === "number" && actual === "integer");
}

/** Small validator for the keywords used by the published schemas. Returns a list of problems. */
function validate(schema, value, path = "$") {
  const problems = [];
  if (schema.anyOf) {
    if (!schema.anyOf.some((member) => validate(member, value, path).length === 0)) {
      problems.push(`${path}: matches none of anyOf`);
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value))) {
      problems.push(`${path}: expected type ${types.join("|")}, got ${jsonType(value)}`);
      return problems;
    }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    problems.push(`${path}: expected const ${schema.const}`);
  }
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    problems.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) problems.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items && !Array.isArray(schema.items)) {
      value.forEach((item, index) => problems.push(...validate(schema.items, item, `${path}[${index}]`)));
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const name of schema.required ?? []) {
      if (!(name in value)) problems.push(`${path}.${name}: required`);
    }
    for (const [name, member] of Object.entries(value)) {
      const property = schema.properties?.[name];
      if (property) {
        problems.push(...validate(property, member, `${path}.${name}`));
      } else if (schema.additionalProperties === false) {
        problems.push(`${path}.${name}: unexpected property`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        problems.push(...validate(schema.additionalProperties, member, `${path}.${name}`));
      }
    }
  }
  return problems;
}

function boundaryValues(property) {
  const values = [];
  const types = property.type === undefined ? [] : Array.isArray(property.type) ? property.type : [property.type];
  if (property.enum) values.push(...property.enum);
  if (property.const !== undefined) values.push(property.const);
  if (typeof property.default === "string" || typeof property.default === "number" || typeof property.default === "boolean") {
    values.push(property.default);
  }
  if (types.includes("integer") || types.includes("number")) {
    if (property.minimum !== undefined) values.push(property.minimum);
    if (property.maximum !== undefined) values.push(property.maximum);
  }
  if (types.includes("string") && !property.enum && !property.pattern) {
    if (property.minLength !== undefined) values.push("a".repeat(property.minLength));
    if (property.maxLength !== undefined) values.push("a".repeat(property.maxLength));
  }
  return values;
}

const groupedTools = toolRegistry.list().filter((tool) => tool.inputSchema?.["x-c64bridge-operations"]);

test("every grouped tool is covered", () => {
  assert.ok(groupedTools.length >= 15, `found ${groupedTools.length} grouped tools`);
});

for (const tool of groupedTools) {
  test(`${tool.name}: merged schema accepts every per-op enum value and bound`, () => {
    const merged = tool.inputSchema.properties;
    const failures = [];
    for (const operation of tool.inputSchema["x-c64bridge-operations"]) {
      for (const [name, property] of Object.entries(operation.inputSchema.properties ?? {})) {
        if (name === "op") continue;
        for (const value of boundaryValues(property)) {
          const problems = validate(merged[name], value, `${tool.name}.${operation.op}.${name}`);
          failures.push(...problems);
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  test(`${tool.name}: published examples validate against the merged schema`, () => {
    const failures = [];
    for (const example of tool.metadata.examples ?? []) {
      const op = example.arguments?.op;
      if (KNOWN_INVALID_EXAMPLES.has(`${tool.name}:${example.name}`)) continue;
      const problems = validate(tool.inputSchema, example.arguments);
      if (problems.length > 0) failures.push(`${tool.name}/${op}/${example.name}: ${problems.join("; ")}`);
    }
    assert.deepEqual(failures, []);
  });

  test(`${tool.name}: per-op required properties exist in the merged schema`, () => {
    for (const operation of tool.inputSchema["x-c64bridge-operations"]) {
      for (const name of [...operation.required, ...operation.optional]) {
        assert.ok(tool.inputSchema.properties[name], `${tool.name}.${operation.op} property ${name} missing from merged schema`);
      }
    }
  });
}

test("known disagreements are widened, not first-wins", () => {
  const byName = (name) => groupedTools.find((tool) => tool.name === name).inputSchema.properties;
  assert.ok(validate(byName("c64_sound").preset, "fuer_elise").length === 0);
  assert.ok(validate(byName("c64_memory").length, 16384).length === 0);
  assert.match(byName("c64_memory").length.description, /Limits depend on op\./);
  assert.ok(validate(byName("c64_printer").secondaryAddress, 3).length === 0);
});

test("combinePropertySchemas widens limits, unions enums and drops defaults", () => {
  const widened = combinePropertySchemas([
    { type: "integer", minimum: 1, maximum: 10, default: 5, description: "n" },
    { type: "integer", minimum: 0, maximum: 100, default: 7 },
  ]);
  assert.equal(widened.minimum, 0);
  assert.equal(widened.maximum, 100);
  assert.equal("default" in widened, false);
  assert.equal(widened.description, "n Limits depend on op.");

  const union = combinePropertySchemas([
    { type: "string", enum: ["a", "b"] },
    { type: "string", enum: ["b", "c"] },
  ]);
  assert.deepEqual(union.enum, ["a", "b", "c"]);

  const unconstrained = combinePropertySchemas([{ type: "string", enum: ["a"] }, { type: "string" }]);
  assert.equal("enum" in unconstrained, false);

  const different = combinePropertySchemas([
    { type: "string" },
    { type: "object", properties: { x: { type: "number" } } },
  ]);
  assert.equal(different.anyOf.length, 2);
});

test("identical property schemas stay untouched", () => {
  const prop = { type: "string", description: "same" };
  const schema = discriminatedUnionSchema({
    variants: [
      operationSchema("a", { properties: { value: prop } }),
      operationSchema("b", { properties: { value: { ...prop } } }),
    ],
  });
  assert.deepEqual(schema.properties.value, prop);
});

test("publishedInputSchema strips x-c64bridge-operations unless verbose", async () => {
  const { publishedInputSchema } = await import("../src/tools/types.js");
  const tool = groupedTools[0];
  const published = publishedInputSchema(tool.inputSchema, { verbose: false });
  assert.equal("x-c64bridge-operations" in published, false);
  assert.deepEqual(published.properties, tool.inputSchema.properties);
  assert.ok(tool.inputSchema["x-c64bridge-operations"], "registry keeps the per-op data");
  assert.equal(publishedInputSchema(tool.inputSchema, { verbose: true }), tool.inputSchema);
  assert.equal(publishedInputSchema(undefined), undefined);
});
