import test from "#test/runner";
import assert from "#test/assert";
import { shouldUseBunServerRuntime } from "./mcpTestClient.mjs";

test("mcpTestClient only defaults to Bun when it is available or explicitly configured", () => {
  assert.equal(shouldUseBunServerRuntime({ C64BRIDGE_TEST_MCP_SERVER_RUNTIME: "node" }), false);
  assert.equal(shouldUseBunServerRuntime({ C64BRIDGE_TEST_MCP_SERVER_RUNTIME: "bun" }), true);
  assert.equal(shouldUseBunServerRuntime({}), typeof globalThis.Bun !== "undefined");
  assert.equal(shouldUseBunServerRuntime({ C64BRIDGE_BUN_BIN: "/custom/bin/bun" }), true);
});