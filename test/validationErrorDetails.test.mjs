import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { unknownErrorResult, toolErrorResult, ToolValidationError } from "../src/tools/errors.js";
import { stringSchema, numberSchema, arraySchema } from "../src/tools/schema.js";
import { setPlatform } from "../src/platform.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const ctx = {
  client: {},
  rag: {},
  logger,
  platform: { id: "c64u", features: [], limitedFeatures: [] },
  setPlatform,
};

async function textOf(name, args) {
  try {
    const result = await toolRegistry.invoke(name, args, ctx);
    return result.content[0].text;
  } catch (error) {
    const result = unknownErrorResult(error);
    assert.equal(result.isError, true);
    return result.content[0].text;
  }
}

test("unknown op error lists the allowed ops and the received value", async () => {
  const text = await textOf("c64_memory", { op: "nope" });
  assert.match(text, /does not support op "nope"/);
  assert.match(text, /allowed: .*read/);
  assert.match(text, /write/);
  assert.match(text, /received: "nope"/);
});

test("missing op error lists the allowed ops", async () => {
  const text = await textOf("c64_memory", {});
  assert.match(text, /allowed: .*read/);
});

test("above-maximum error states the maximum and the received value", async () => {
  const text = await textOf("c64_memory", { op: "read", address: "$0400", length: 99999 });
  assert.match(text, /above maximum/);
  assert.match(text, /maximum: 4096/);
  assert.match(text, /received: 99999/);
});

test("enum error lists the allowed values", () => {
  let error;
  try {
    stringSchema({ enum: ["a", "b"] }).parse("z", "$.mode");
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof ToolValidationError);
  const text = toolErrorResult(error).content[0].text;
  assert.match(text, /allowed: a, b/);
  assert.match(text, /received: "z"/);
  assert.match(text, /at \$\.mode/);
});

test("below-minimum and array bounds are reported", () => {
  const catchText = (fn) => {
    try {
      fn();
    } catch (e) {
      return toolErrorResult(e).content[0].text;
    }
    return "";
  };
  assert.match(catchText(() => numberSchema({ minimum: 5 }).parse(1, "$.n")), /minimum: 5; received: 1/);
  assert.match(
    catchText(() => arraySchema(numberSchema(), { maxItems: 2 }).parse([1, 2, 3], "$.a")),
    /maxItems: 2; received: 3/,
  );
  assert.match(catchText(() => stringSchema({ maxLength: 2 }).parse("abc", "$.s")), /maxLength: 2; received: 3/);
});

test("long allowed lists are capped", () => {
  const values = Array.from({ length: 60 }, (_, i) => `v${i}`);
  const text = toolErrorResult(new ToolValidationError("bad", { details: { allowed: values } })).content[0].text;
  assert.match(text, /v39/);
  assert.ok(!/v40/.test(text));
  assert.match(text, /60 total/);
});

test("unknown tool is a validation error listing the valid tool names", async () => {
  await assert.rejects(
    () => toolRegistry.invoke("nonexistent_tool_xyz", {}, ctx),
    (error) => {
      assert.ok(error instanceof ToolValidationError);
      assert.match(error.message, /Unknown tool: nonexistent_tool_xyz/);
      assert.ok(error.details.allowed.includes("c64_memory"));
      const text = unknownErrorResult(error).content[0].text;
      assert.match(text, /allowed: .*c64_memory/);
      assert.equal(unknownErrorResult(error).metadata.error.kind, "validation");
      return true;
    },
  );
});

test("unknown prompt is a validation error listing the valid prompt names", async () => {
  const { createPromptRegistry } = await import("../src/prompts/registry.js");
  const registry = createPromptRegistry();
  assert.throws(
    () => registry.resolve("nonexistent-prompt-xyz", {}),
    (error) => {
      assert.ok(error instanceof ToolValidationError);
      assert.match(error.message, /Unknown prompt: nonexistent-prompt-xyz\. Valid prompts: .*basic-program/);
      return true;
    },
  );
});
