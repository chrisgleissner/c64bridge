import test from "#test/runner";
import assert from "#test/assert";
import {
  OPERATION_DISCRIMINATOR,
  VERIFY_PROPERTY_NAME,
  VERIFY_PROPERTY_SCHEMA,
  operationSchema,
  discriminatedUnionSchema,
  createOperationDispatcher,
  defineToolModule,
} from "../src/tools/types.ts";
import { getPlatformStatus, setPlatform } from "../src/platform.ts";
import { ToolUnsupportedPlatformError, ToolValidationError } from "../src/tools/errors.ts";

const stubStatus = Object.freeze({ id: "c64u", features: [], limitedFeatures: [] });

const stubCtx = Object.freeze({
  client: {},
  rag: {},
  logger: {
    debug() {},
    info() {},
    warn() {},
    error() {},
  },
  platform: stubStatus,
  setPlatform() {
    return stubStatus;
  },
});

test("operationSchema builds op-discriminated schema", () => {
  const schema = operationSchema("read", {
    description: "Read a range of memory.",
    properties: {
      address: { type: "integer", minimum: 0 },
      length: { type: "integer", minimum: 1, default: 256 },
      [VERIFY_PROPERTY_NAME]: VERIFY_PROPERTY_SCHEMA,
    },
    required: ["address"],
  });

  assert.deepEqual(schema, {
    type: "object",
    description: "Read a range of memory.",
    properties: {
      [OPERATION_DISCRIMINATOR]: {
        const: "read",
        description: "Selects the read operation.",
      },
      address: { type: "integer", minimum: 0 },
      length: { type: "integer", minimum: 1, default: 256 },
      [VERIFY_PROPERTY_NAME]: VERIFY_PROPERTY_SCHEMA,
    },
    required: [OPERATION_DISCRIMINATOR, "address"],
    additionalProperties: false,
  });
});

test("operationSchema supports explicit op descriptions and extra properties", () => {
  const schema = operationSchema("write", {
    opDescription: "Choose write mode.",
    properties: {
      address: { type: "integer" },
    },
    additionalProperties: true,
  });

  assert.equal(schema.properties.op.description, "Choose write mode.");
  assert.equal(schema.additionalProperties, true);
});

test("discriminatedUnionSchema flattens variants into a single object schema", () => {
  const readSchema = operationSchema("read", {
    description: "Read memory",
    properties: {
      address: { type: "integer" },
      length: { type: "integer" },
    },
    required: ["address"],
  });

  const writeSchema = operationSchema("write", {
    description: "Write memory",
    properties: {
      address: { type: "integer" },
      data: { type: "string" },
    },
    required: ["address", "data"],
  });

  const union = discriminatedUnionSchema({
    description: "Memory operations",
    variants: [readSchema, writeSchema],
  });

  assert.equal(union.type, "object");
  assert.ok(union.description.includes("Memory operations"));
  assert.ok(union.description.includes("read:"));
  assert.ok(union.description.includes("write:"));
  assert.deepEqual(union.properties[OPERATION_DISCRIMINATOR].enum, ["read", "write"]);
  assert.deepEqual(union.required, [OPERATION_DISCRIMINATOR]);
  // All variant properties merged
  assert.ok(union.properties.address);
  assert.ok(union.properties.length);
  assert.ok(union.properties.data);
  // No oneOf at top level
  assert.equal(union.oneOf, undefined);
  assert.equal(union.discriminator, undefined);
});

test("discriminatedUnionSchema requires at least one variant", () => {
  assert.throws(
    () => discriminatedUnionSchema({ variants: [] }),
    /at least one variant/,
  );
});

test("discriminatedUnionSchema supports custom discriminator names", () => {
  const union = discriminatedUnionSchema({
    discriminator: "mode",
    variants: [{ type: "object", properties: { mode: { const: "x" } } }],
  });

  assert.deepEqual(union.properties.mode.enum, ["x"]);
  assert.deepEqual(union.required, ["mode"]);
});

test("createOperationDispatcher routes to matching handlers", async () => {
  const calls = [];

  const dispatcher = createOperationDispatcher(
    "c64_memory",
    {
      read: async (args) => {
        calls.push({ type: "read", args });
        return {
          content: [
            {
              type: "text",
              text: "read",
            },
          ],
        };
      },
      write: async (args) => {
        calls.push({ type: "write", args });
        return {
          content: [
            {
              type: "text",
              text: "write",
            },
          ],
        };
      },
    },
  );

  const readResult = await dispatcher({ op: "read", address: 4096 }, stubCtx);
  assert.equal(readResult.content[0].text, "read");
  assert.equal(calls[0].type, "read");
  assert.equal(calls[0].args.address, 4096);
  assert.equal(calls[0].args.op, "read");

  const writeResult = await dispatcher({ op: "write", address: 12288, data: "A", verify: true }, stubCtx);
  assert.equal(writeResult.content[0].text, "write");
  assert.equal(calls[1].type, "write");
  assert.equal(calls[1].args.address, 12288);
  assert.equal(calls[1].args.data, "A");
  assert.equal(calls[1].args.verify, true);
});

test("createOperationDispatcher validates op presence", async () => {
  const dispatcher = createOperationDispatcher(
    "c64_memory",
    {
      read: async () => ({ content: [] }),
    },
  );

  await assert.rejects(
    () => dispatcher({}, stubCtx),
    (error) => {
      assert.ok(error instanceof ToolValidationError);
      assert.equal(error.path, "$.op");
      return true;
    },
  );
});

test("createOperationDispatcher rejects non-object args", async () => {
  const dispatcher = createOperationDispatcher(
    "c64_memory",
    {
      read: async () => ({ content: [] }),
    },
  );

  await assert.rejects(
    () => dispatcher(null, stubCtx),
    (error) => {
      assert.ok(error instanceof ToolValidationError);
      assert.equal(error.path, "$");
      return true;
    },
  );
});

test("createOperationDispatcher rejects non-string ops", async () => {
  const dispatcher = createOperationDispatcher(
    "c64_memory",
    {
      read: async () => ({ content: [] }),
    },
  );

  await assert.rejects(
    () => dispatcher({ op: 7 }, stubCtx),
    (error) => {
      assert.ok(error instanceof ToolValidationError);
      assert.equal(error.path, "$.op");
      return true;
    },
  );
});

test("createOperationDispatcher rejects unknown ops", async () => {
  const dispatcher = createOperationDispatcher(
    "c64_memory",
    {
      read: async () => ({ content: [] }),
      write: async () => ({ content: [] }),
    },
  );

  await assert.rejects(
    () => dispatcher({ op: "invalid" }, stubCtx),
    (error) => {
      assert.ok(error instanceof ToolValidationError);
      assert.equal(error.path, "$.op");
      assert.deepEqual(error.details?.allowed, ["read", "write"]);
      return true;
    },
  );
});

test("defineToolModule enforces operation-specific platforms before grouped execution", async () => {
  let executed = false;

  const module = defineToolModule({
    domain: "test",
    summary: "test module",
    supportedPlatforms: ["c64u", "vice"],
    tools: [
      {
        name: "c64_test",
        description: "test grouped tool",
        operationPlatforms: {
          restricted: ["c64u"],
        },
        operationToolNames: {
          restricted: "legacy_restricted_tool",
        },
        execute: async () => {
          executed = true;
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    ],
  });

  await assert.rejects(
    () => module.invoke("c64_test", { op: "restricted" }, {
      ...stubCtx,
      platform: { id: "vice", features: [], limitedFeatures: [] },
      setPlatform() {
        return { id: "vice", features: [], limitedFeatures: [] };
      },
    }),
    (error) => {
      assert.ok(error instanceof ToolUnsupportedPlatformError);
      assert.equal(error.tool, "legacy_restricted_tool");
      assert.equal(error.platform, "vice");
      assert.deepEqual(error.supported, ["c64u"]);
      return true;
    },
  );

  assert.equal(executed, false);
});

test("defineToolModule reports operation names when no legacy tool mapping exists", async () => {
  const module = defineToolModule({
    domain: "test",
    summary: "test module",
    supportedPlatforms: ["c64u", "vice"],
    tools: [
      {
        name: "c64_test",
        description: "test grouped tool",
        operationPlatforms: {
          device_only: ["c64u"],
        },
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ],
  });

  await assert.rejects(
    () => module.invoke("c64_test", { op: "device_only" }, {
      ...stubCtx,
      platform: { id: "vice", features: [], limitedFeatures: [] },
      setPlatform() {
        return { id: "vice", features: [], limitedFeatures: [] };
      },
    }),
    (error) => {
      assert.ok(error instanceof ToolUnsupportedPlatformError);
      assert.equal(error.tool, "device_only");
      return true;
    },
  );
});

test("defineToolModule falls back to grouped tool names when op is missing or empty", async () => {
  const module = defineToolModule({
    domain: "test",
    summary: "test module",
    supportedPlatforms: ["c64u"],
    tools: [
      {
        name: "c64_test",
        description: "test grouped tool",
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ],
  });

  for (const args of [{}, { op: "" }, null]) {
    await assert.rejects(
      () => module.invoke("c64_test", args, {
        ...stubCtx,
        platform: { id: "vice", features: [], limitedFeatures: [] },
        setPlatform() {
          return { id: "vice", features: [], limitedFeatures: [] };
        },
      }),
      (error) => {
        assert.ok(error instanceof ToolUnsupportedPlatformError);
        assert.equal(error.tool, "c64_test");
        return true;
      },
    );
  }
});

test("defineToolModule falls back to tool-level platforms when no op override exists", async () => {
  const calls = [];

  const module = defineToolModule({
    domain: "test",
    summary: "test module",
    supportedPlatforms: ["c64u"],
    tools: [
      {
        name: "c64_test",
        description: "test grouped tool",
        execute: async (args) => {
          calls.push(args);
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    ],
  });

  const result = await module.invoke("c64_test", { op: "allowed" }, stubCtx);
  assert.equal(result.content[0].text, "ok");
  assert.equal(calls.length, 1);

  await assert.rejects(
    () => module.invoke("c64_test", { op: "allowed" }, {
      ...stubCtx,
      platform: { id: "vice", features: [], limitedFeatures: [] },
      setPlatform() {
        return { id: "vice", features: [], limitedFeatures: [] };
      },
    }),
    ToolUnsupportedPlatformError,
  );
});

test("defineToolModule describeTools merges defaults and per-tool metadata", () => {
  const module = defineToolModule({
    domain: "test",
    summary: "test module",
    resources: ["c64://specs/basic"],
    prompts: ["basic-program"],
    defaultTags: ["default"],
    workflowHints: ["module hint"],
    prerequisites: ["bootstrap"],
    supportedPlatforms: ["c64u", "vice"],
    tools: [
      {
        name: "c64_test",
        description: "test grouped tool",
        summary: "summary override",
        relatedResources: ["c64://specs/vic"],
        relatedPrompts: ["graphics-demo"],
        tags: ["tool"],
        workflowHints: ["tool hint"],
        prerequisites: ["ready"],
        examples: [{ name: "Example", description: "desc", arguments: { op: "ping" } }],
        operationPlatforms: { ping: ["vice"] },
        lifecycle: "stream",
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ],
  });

  const [descriptor] = module.describeTools();
  assert.equal(descriptor.metadata.summary, "summary override");
  assert.equal(descriptor.metadata.lifecycle, "stream");
  assert.deepEqual(descriptor.metadata.resources, ["c64://specs/basic", "c64://specs/vic"]);
  assert.deepEqual(descriptor.metadata.prompts, ["basic-program", "graphics-demo"]);
  assert.deepEqual(descriptor.metadata.tags, ["default", "tool"]);
  assert.deepEqual(descriptor.metadata.workflowHints, ["module hint", "tool hint"]);
  assert.deepEqual(descriptor.metadata.prerequisites, ["bootstrap", "ready"]);
  assert.deepEqual(descriptor.metadata.platforms, ["c64u", "vice"]);
  assert.deepEqual(descriptor.metadata.operationPlatforms, { ping: ["vice"] });
  assert.equal(descriptor.metadata.examples.length, 1);
});

test("defineToolModule throws for unknown tools", async () => {
  const module = defineToolModule({
    domain: "test",
    summary: "test module",
    tools: [
      {
        name: "known_tool",
        description: "known",
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ],
  });

  await assert.rejects(
    () => module.invoke("missing_tool", {}, stubCtx),
    /Unknown tool: missing_tool/,
  );
});

test("defineToolModule reports operation name when op-specific platforms block access", async () => {
  const module = defineToolModule({
    domain: "test",
    summary: "test module",
    supportedPlatforms: ["c64u", "vice"],
    tools: [
      {
        name: "c64_test",
        description: "test grouped tool",
        operationPlatforms: {
          restricted: ["c64u"],
        },
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ],
  });

  await assert.rejects(
    () => module.invoke("c64_test", { op: "restricted" }, {
      ...stubCtx,
      platform: { id: "vice", features: [], limitedFeatures: [] },
      setPlatform() {
        return { id: "vice", features: [], limitedFeatures: [] };
      },
    }),
    (error) => {
      assert.ok(error instanceof ToolUnsupportedPlatformError);
      assert.equal(error.tool, "restricted");
      return true;
    },
  );
});

test("defineToolModule falls back to global platform state when ctx omits platform helpers", async () => {
  const previous = getPlatformStatus().id;
  setPlatform("c64u");

  try {
    let seenPlatform = null;
    let seenSetter = null;
    const module = defineToolModule({
      domain: "test",
      summary: "test module",
      tools: [
        {
          name: "c64_test",
          description: "test grouped tool",
          execute: async (_args, ctx) => {
            seenPlatform = ctx.platform.id;
            seenSetter = ctx.setPlatform;
            return { content: [{ type: "text", text: "ok" }] };
          },
        },
      ],
    });

    const result = await module.invoke("c64_test", {}, {
      client: {},
      rag: {},
      logger: stubCtx.logger,
    });

    assert.equal(result.content[0].text, "ok");
    assert.equal(seenPlatform, "c64u");
    assert.equal(typeof seenSetter, "function");
  } finally {
    setPlatform(previous);
  }
});
