import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { setPlatform } from "../src/platform.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeCtx(calls) {
  return {
    client: {
      async configBatchUpdate(payload) {
        calls.push(payload);
        return { success: true, details: {} };
      },
    },
    rag: {},
    logger,
    platform: { id: "c64u", features: [], limitedFeatures: [] },
    setPlatform,
  };
}

test("batch_update accepts the documented updates form", async () => {
  const calls = [];
  const result = await toolRegistry.invoke(
    "c64_config",
    { op: "batch_update", updates: { Audio: { Volume: 80 }, Video: { Mode: "PAL" } } },
    makeCtx(calls),
  );
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.metadata.categoryCount, 2);
  assert.deepEqual(calls, [{ Audio: { Volume: "80" }, Video: { Mode: "PAL" } }]);
});

test("batch_update still accepts categories as top-level keys", async () => {
  const calls = [];
  const result = await toolRegistry.invoke(
    "c64_config",
    { op: "batch_update", Audio: { Volume: 80 } },
    makeCtx(calls),
  );
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(calls, [{ Audio: { Volume: "80" } }]);
});

test("batch_update merges updates with top-level categories", async () => {
  const calls = [];
  await toolRegistry.invoke(
    "c64_config",
    { op: "batch_update", updates: { Audio: { Volume: 80 } }, Video: { Mode: "PAL" } },
    makeCtx(calls),
  );
  assert.deepEqual(calls, [{ Audio: { Volume: "80" }, Video: { Mode: "PAL" } }]);
});

test("batch_update treats a legacy category named updates as a category", async () => {
  const calls = [];
  await toolRegistry.invoke("c64_config", { op: "batch_update", updates: { Flag: true } }, makeCtx(calls));
  assert.deepEqual(calls, [{ updates: { Flag: "true" } }]);
});

test("batch_update with no categories is a validation error", async () => {
  const result = await toolRegistry.invoke("c64_config", { op: "batch_update", updates: {} }, makeCtx([]));
  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "validation");
});

test("published schema documents updates and keeps additionalProperties false", () => {
  const tool = toolRegistry.list().find((entry) => entry.name === "c64_config");
  const updates = tool.inputSchema.properties.updates;
  assert.ok(updates, "updates must be published");
  assert.equal(updates.type, "object");
  assert.equal(tool.inputSchema.additionalProperties, false);
  const operation = tool.inputSchema["x-c64bridge-operations"].find((entry) => entry.op === "batch_update");
  assert.ok(operation.optional.includes("updates"));
  assert.match(tool.inputSchema.description, /batch_update \[write\]: .*`updates`/);
});
