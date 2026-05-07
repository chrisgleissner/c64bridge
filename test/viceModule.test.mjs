import test from "#test/runner";
import assert from "#test/assert";
import { viceModuleGroup } from "../src/tools/vice.js";

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function createCtx(overrides = {}) {
  return {
    client: {
      async viceResourceGet() {
        return { type: "string", value: "demo" };
      },
      async viceResourceSet() {},
    },
    logger: createLogger(),
    platform: { id: "vice", features: [], limitedFeatures: [] },
    ...overrides,
  };
}

test("c64_vice resource_get returns JSON payload for string values", async () => {
  const calls = [];
  const ctx = createCtx({
    client: {
      async viceResourceGet(name) {
        calls.push(name);
        return { type: "string", value: "resid-fp" };
      },
      async viceResourceSet() {},
    },
  });

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_get", name: "SidEngine" },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.name, "SidEngine");
  assert.equal(result.metadata.type, "string");
  assert.deepEqual(result.structuredContent?.data, {
    name: "SidEngine",
    type: "string",
    value: "resid-fp",
  });
  assert.deepEqual(calls, ["SidEngine"]);
});

test("c64_vice resource_get supports integer values", async () => {
  const ctx = createCtx({
    client: {
      async viceResourceGet() {
        return { type: "int", value: 2 };
      },
      async viceResourceSet() {},
    },
  });

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_get", name: "VICIIDoubleSize" },
    ctx,
  );

  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.type, "int");
  assert.deepEqual(result.structuredContent?.data, {
    name: "VICIIDoubleSize",
    type: "int",
    value: 2,
  });
});

test("c64_vice resource_get rejects empty string values", async () => {
  const ctx = createCtx({
    client: {
      async viceResourceGet() {
        return { type: "string", value: "" };
      },
      async viceResourceSet() {},
    },
  });

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_get", name: "SidEngine" },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "execution");
  assert.deepEqual(result.metadata.error.details, { name: "SidEngine" });
});

test("c64_vice resource_get rejects unsafe resource names", async () => {
  const ctx = createCtx();

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_get", name: "Drive8Type" },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "validation");
  assert.equal(result.metadata.error.path, "$.name");
});

test("c64_vice resource_set writes string resource values", async () => {
  const calls = [];
  const ctx = createCtx({
    client: {
      async viceResourceGet() {
        return { type: "string", value: "demo" };
      },
      async viceResourceSet(name, value) {
        calls.push({ name, value });
      },
    },
  });

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_set", name: "MachineVideoStandard", value: "PAL" },
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.metadata.success, true);
  assert.equal(result.metadata.name, "MachineVideoStandard");
  assert.equal(result.metadata.value, "PAL");
  assert.deepEqual(calls, [{ name: "MachineVideoStandard", value: "PAL" }]);
});

test("c64_vice resource_set rejects non-integer numbers", async () => {
  const ctx = createCtx();

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_set", name: "SidEngine", value: 1.5 },
    ctx,
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "validation");
  assert.equal(result.metadata.error.path, "$.value");
});

test("c64_vice resource_set writes integer resource values", async () => {
  const calls = [];
  const ctx = createCtx({
    client: {
      async viceResourceGet() {
        return { type: "string", value: "demo" };
      },
      async viceResourceSet(name, value) {
        calls.push({ name, value });
      },
    },
  });

  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_set", name: "SidEngine", value: 2 },
    ctx,
  );

  assert.equal(result.metadata.success, true);
  assert.deepEqual(calls, [{ name: "SidEngine", value: 2 }]);
});

test("c64_vice resource_get rejects invalid resource name syntax", async () => {
  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_get", name: "sid engine" },
    createCtx(),
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "validation");
  assert.equal(result.metadata.error.path, "$.name");
});

test("c64_vice wraps unexpected client errors", async () => {
  const result = await viceModuleGroup.invoke(
    "c64_vice",
    { op: "resource_get", name: "SidEngine" },
    createCtx({
      client: {
        async viceResourceGet() {
          throw new Error("socket gone");
        },
        async viceResourceSet() {},
      },
    }),
  );

  assert.equal(result.isError, true);
  assert.equal(result.metadata.error.kind, "unknown");
});

test("c64_vice describes a flattened Claude-compatible input schema", () => {
  const [descriptor] = viceModuleGroup.describeTools();

  assert.deepEqual(descriptor.inputSchema.properties.op.enum, ["resource_get", "resource_set"]);
  assert.deepEqual(descriptor.inputSchema.properties.value.type, ["string", "integer"]);
  assert.equal(descriptor.inputSchema.oneOf, undefined);
  assert.equal(descriptor.inputSchema.discriminator, undefined);
});
