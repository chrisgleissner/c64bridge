import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";

// Variants of a grouped tool schema: oneOf/anyOf entries, or the schema itself.
function variantsOf(schema) {
  const list = schema.oneOf ?? schema.anyOf;
  return Array.isArray(list) ? list : [schema];
}

function opMatches(variant, op) {
  const prop = variant.properties?.op;
  if (!prop) return false;
  return prop.const === op || (Array.isArray(prop.enum) && prop.enum.includes(op));
}

test("every published example names only parameters its operation accepts and supplies the required ones", () => {
  const problems = [];
  let checked = 0;
  for (const descriptor of toolRegistry.list()) {
    const examples = descriptor.metadata?.examples ?? [];
    for (const example of examples) {
      const args = example.arguments ?? {};
      const variants = variantsOf(descriptor.inputSchema);
      const variant = typeof args.op === "string" ? variants.find((entry) => opMatches(entry, args.op)) : variants.length === 1 ? variants[0] : undefined;
      const label = `${descriptor.name} example "${example.name}"`;
      if (!variant) {
        if (typeof args.op === "string") problems.push(`${label}: no schema for op ${args.op}`);
        continue;
      }
      checked += 1;
      const properties = variant.properties ?? {};
      for (const key of Object.keys(args)) {
        if (variant.additionalProperties === false && !(key in properties)) {
          problems.push(`${label}: unknown parameter ${key}`);
        }
      }
      for (const required of variant.required ?? []) {
        if (!(required in args)) problems.push(`${label}: missing required parameter ${required}`);
      }
    }
  }
  assert.ok(checked > 10, `expected to check many examples, checked ${checked}`);
  assert.deepEqual(problems, []);
});
