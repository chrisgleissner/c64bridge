import test from "#test/runner";
import assert from "#test/assert";
import { createProgressReporter } from "../src/mcp/progress.ts";
import { toolRegistry } from "../src/tools/registry/index.js";
import { registerHarnessSuite, withSharedMcpClient } from "./helpers/mcpTestHarness.mjs";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

registerHarnessSuite("hard06-mcp-progress");

test("MCP-6 progress strictly increases, carries the total and keeps a heartbeat until stopped", async () => {
  const sent = [];
  const reporter = createProgressReporter("tok", (notification) => { sent.push(notification); }, { heartbeatMs: 20 });
  reporter.report(0, 2, "first");
  await new Promise((resolve) => setTimeout(resolve, 70));
  reporter.report(1, 2, "second");
  reporter.report(1, 2, "again");
  reporter.stop();
  const count = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, count, "no notification after stop");
  assert.ok(sent.length >= 4, `${sent.length} notifications`);
  for (let index = 1; index < sent.length; index += 1) {
    assert.ok(sent[index].params.progress > sent[index - 1].params.progress, "progress increases");
  }
  assert.ok(sent.every((notification) => notification.method === "notifications/progress" && notification.params.progressToken === "tok"));
  assert.equal(sent.at(-1).params.total, 2);
});

test("MCP-6 c64_batch reports one progress step per command through the context hook", async () => {
  const reports = [];
  const ctx = {
    client: { getActiveBackendType: async () => "c64u", getAvailableBackends: () => ["c64u"] },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    rag: {},
    platform: { id: "c64u", features: [], limitedFeatures: [] },
    setPlatform: () => ({ id: "c64u", features: [], limitedFeatures: [] }),
    reportProgress: (completed, total, message) => reports.push({ completed, total, message }),
  };
  await toolRegistry.invoke("c64_batch", {
    stopOnError: false,
    commands: [{ tool: "c64_memory", args: { op: "nope" } }, { tool: "c64_memory", args: { op: "nope" } }],
  }, ctx);
  assert.deepEqual(reports.map((entry) => [entry.completed, entry.total]), [[0, 2], [1, 2], [2, 2]]);
});

test("MCP-6 the server sends notifications/progress when the request carries a progress token", async () => {
  await withSharedMcpClient(async ({ client }) => {
    const seen = [];
    const result = await client.request(
      { method: "tools/call", params: { name: "c64_batch", arguments: { commands: [
        { tool: "c64_memory", args: { op: "read", address: "$0400", length: 1 } },
        { tool: "c64_memory", args: { op: "read", address: "$0401", length: 1 } },
      ] } } },
      CallToolResultSchema,
      { onprogress: (progress) => seen.push(progress) },
    );
    assert.notEqual(result.isError, true);
    assert.ok(seen.length >= 3, `${seen.length} progress notifications`);
    assert.equal(seen.at(-1).total, 2);
  });
});
