import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { graphicsModule } from "../src/tools/graphics.js";

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

test("every published example passes the runtime argument parser of its operation", async () => {
  const noop = () => {};
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  const harmless = async () => ({ success: true, details: {} });
  const client = new Proxy({}, { get: (_target, prop) => (prop === "then" ? undefined : harmless) });
  const problems = [];
  for (const descriptor of toolRegistry.list()) {
    for (const example of descriptor.metadata?.examples ?? []) {
      const args = example.arguments ?? {};
      if (typeof args.op !== "string") continue;
      const ctx = {
        client,
        rag: {},
        logger,
        platform: { id: "c64u", features: [], limitedFeatures: [] },
        setPlatform: noop,
      };
      let result;
      try {
        result = await toolRegistry.invoke(descriptor.name, args, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/validation|must|invalid/i.test(message)) problems.push(`${descriptor.name} ${example.name}: ${message}`);
        continue;
      }
      const error = result?.metadata?.error ?? result?.structuredContent?.data?.error;
      if (result?.isError && error?.kind === "validation") {
        problems.push(`${descriptor.name} ${example.name}: ${result.content?.[0]?.text}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("every example of the legacy graphics module passes its runtime parser", async () => {
  const noop = () => {};
  const harmless = async () => ({ success: true, details: {} });
  const client = new Proxy({}, { get: (_target, prop) => (prop === "then" ? undefined : harmless) });
  const ctx = { client, rag: {}, logger: { debug: noop, info: noop, warn: noop, error: noop }, platform: { id: "c64u", features: [], limitedFeatures: [] }, setPlatform: noop };
  const problems = [];
  for (const tool of graphicsModule.describeTools()) {
    for (const example of tool.metadata?.examples ?? []) {
      const result = await graphicsModule.invoke(tool.name, example.arguments ?? {}, ctx);
      if (result?.isError && result.metadata?.error?.kind === "validation") {
        problems.push(`${tool.name} ${example.name}: ${result.content?.[0]?.text}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
