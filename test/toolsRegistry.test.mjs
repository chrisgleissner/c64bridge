import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry, describeToolModules } from "../src/tools/registry/index.js";
import { getMcpProjectMetadata, getMcpServerImplementationInfo } from "../src/mcp/metadata.js";
import { getPlatformStatus, setPlatform } from "../src/platform.js";

function createStubLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function createStubCtx(overrides = {}) {
  return {
    client: {
      async version() {
        return { version: "stub" };
      },
    },
    rag: {},
    logger: createStubLogger(),
    platform: getPlatformStatus(),
    setPlatform,
    ...overrides,
  };
}

test("toolRegistry.list returns all registered tools", () => {
  const tools = toolRegistry.list();
  assert.ok(Array.isArray(tools), "should return an array");
  assert.ok(tools.length > 0, "should have at least one tool");
  
  // Check that each tool has required fields
  for (const tool of tools) {
    assert.ok(tool.name, `tool should have a name: ${JSON.stringify(tool)}`);
    assert.ok(tool.description, `tool ${tool.name} should have a description`);
    assert.ok(tool.parameters || tool.inputSchema, `tool ${tool.name} should have parameters or inputSchema`);
  }
});

test("toolRegistry.invoke executes a tool", async () => {
  // Use explicit c64u platform since c64_config.version is a c64u tool.
  // This test verifies registry dispatch mechanics, not platform behaviour.
  const ctx = createStubCtx({
    platform: { id: "c64u", features: [], limitedFeatures: [] },
  });

  const result = await toolRegistry.invoke("c64_config", { op: "version" }, ctx);
  assert.ok(result, "should return a result");
  assert.equal(result.metadata?.success, true, "version operation should mark success");
  assert.deepEqual(result.structuredContent?.data, { version: "stub" });
});

test("toolRegistry.invoke throws for unknown tool", async () => {
  const ctx = createStubCtx();

  await assert.rejects(
    () => toolRegistry.invoke("nonexistent_tool_xyz", {}, ctx),
    (err) => {
      assert.ok(err.message.includes("Unknown tool"));
      return true;
    }
  );
});

test("describeToolModules returns module descriptors", () => {
  const modules = describeToolModules();
  assert.ok(Array.isArray(modules), "should return an array");
  assert.ok(modules.length > 0, "should have at least one module");
  
  for (const module of modules) {
    assert.ok(module.domain, `module should have domain: ${JSON.stringify(module)}`);
    assert.ok(module.summary, `module ${module.domain} should have summary`);
    assert.ok(Array.isArray(module.defaultTags), `module ${module.domain} should have defaultTags array`);
    assert.ok(Array.isArray(module.workflowHints), `module ${module.domain} should have workflowHints array`);
    assert.ok(Array.isArray(module.tools), `module ${module.domain} should have tools array`);
    assert.ok(module.tools.length > 0, `module ${module.domain} should have at least one tool`);
  }
});

test("MCP metadata exposes implementation and project details", () => {
  const implementation = getMcpServerImplementationInfo();
  const project = getMcpProjectMetadata();

  assert.equal(typeof implementation.name, "string");
  assert.equal(typeof implementation.version, "string");
  assert.equal(project.name, implementation.name);
  assert.equal(project.version, implementation.version);
  assert.ok(Array.isArray(project.transports));
  assert.ok(project.transports.includes("stdio"));
});

test("with a task lease held, a foreground call runs when the client cannot report its backend type", async () => {
  const { acquireLease, __resetLeasesForTests } = await import("../src/tasks/resources.js");
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const clients = {
    throwing: { getActiveBackendType: async () => { throw new Error("backend probe failed"); } },
    nonString: { getActiveBackendType: async () => 42 },
    missing: {},
  };
  __resetLeasesForTests();
  try {
    acquireLease({ taskId: "observer-1", backendId: "c64u", mode: "observe", tool: "c64_memory", op: "wait_for_text", pinned: false });
    for (const [label, client] of Object.entries(clients)) {
      const ctx = { client, rag: {}, logger, platform: { id: "c64u", features: [], limitedFeatures: [] }, setPlatform: () => ({ id: "c64u", features: [], limitedFeatures: [] }) };
      // c64_memory.read_screen needs a lease check; with no known backend the observe lease does not block it,
      // and the failure (if any) comes from the missing readMemoryRaw, not from the backend probe.
      let thrown;
      let result;
      try { result = await toolRegistry.invoke("c64_memory", { op: "read", address: "$0400", length: 1 }, ctx); } catch (error) { thrown = error; }
      const message = thrown ? String(thrown.message) : JSON.stringify(result);
      assert.ok(!/backend probe failed/.test(message), `${label}: ${message}`);
      assert.ok(!/resource_conflict|holds the exclusive lease/.test(message), `${label}: an observe lease never blocks a foreground call`);
    }
  } finally {
    __resetLeasesForTests();
  }
});
