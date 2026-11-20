import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { clearViceSymbols, getSymbolAddress, setViceSymbols } from "../src/tools/translation/symbolRegistry.ts";

function context(active = "c64u") {
  const switched = [];
  const platform = { id: active, features: [], limitedFeatures: [] };
  return {
    switched,
    ctx: {
      client: {
        getAvailableBackends: () => ["c64u", "vice"],
        getActiveBackendType: async () => active,
        switchBackend: (type) => { switched.push(type); active = type; },
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      rag: {},
      platform,
      setPlatform: (id) => ({ ...platform, id }),
    },
  };
}

function data(result) {
  return result.structuredContent.data;
}

test("WORKFLOW-1 the select result lists c64_input and c64_batch among the available tools", async () => {
  const { ctx } = context("c64u");
  const result = await toolRegistry.invoke("c64_select_backend", { op: "select", backend: "vice" }, ctx);
  assert.ok(data(result).availableTools.includes("c64_input"));
  assert.ok(data(result).availableTools.includes("c64_batch"));
  const listed = new Set([...data(result).availableTools, ...data(result).unavailableTools]);
  for (const tool of toolRegistry.list()) assert.ok(listed.has(tool.name), tool.name);
});

test("MCP-9 selecting the already active backend keeps labels and does not switch", async () => {
  clearViceSymbols();
  setViceSymbols([["start", 0xc000]]);
  try {
    const { ctx, switched } = context("c64u");
    const result = await toolRegistry.invoke("c64_select_backend", { op: "select", backend: "c64u" }, ctx);
    assert.equal(data(result).alreadyActive, true);
    assert.deepEqual(switched, []);
    assert.equal(getSymbolAddress("start"), 0xc000);

    await toolRegistry.invoke("c64_select_backend", { op: "select", backend: "vice" }, ctx);
    assert.deepEqual(switched, ["vice"]);
    assert.equal(getSymbolAddress("start"), undefined, "a real switch still clears labels (D5)");
  } finally {
    clearViceSymbols();
  }
});

test("WORKFLOW-16 read-only access allows selecting a backend", async () => {
  const previous = process.env.C64BRIDGE_ACCESS;
  process.env.C64BRIDGE_ACCESS = "read-only";
  try {
    const { ctx } = context("c64u");
    const result = await toolRegistry.invoke("c64_select_backend", { op: "select", backend: "vice" }, ctx);
    assert.notEqual(result.isError, true);
  } finally {
    if (previous === undefined) delete process.env.C64BRIDGE_ACCESS;
    else process.env.C64BRIDGE_ACCESS = previous;
  }
});
