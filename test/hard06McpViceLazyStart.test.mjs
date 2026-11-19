import test from "#test/runner";
import assert from "#test/assert";

process.env.C64BRIDGE_SKIP_AUTO_START = "1";
const { logConnectivity } = await import("../src/mcp-server.js");

function viceClient() {
  const calls = { readMemory: 0 };
  return {
    calls,
    async getBackendType() { return "vice"; },
    async readMemory() { calls.readMemory += 1; return { success: true, data: "$2F" }; },
  };
}

test("MCP-2 the startup probe does not touch VICE (which would start it) without prewarm", async () => {
  const client = viceClient();
  await logConnectivity(client, "http://127.0.0.1:1");
  assert.equal(client.calls.readMemory, 0);
  await logConnectivity(client, "http://127.0.0.1:1", undefined, { vicePrewarm: false });
  assert.equal(client.calls.readMemory, 0);
});

test("MCP-2 with prewarm configured the startup probe reads the zero page", async () => {
  const client = viceClient();
  await logConnectivity(client, "http://127.0.0.1:1", undefined, { vicePrewarm: true });
  assert.equal(client.calls.readMemory, 1);
});
