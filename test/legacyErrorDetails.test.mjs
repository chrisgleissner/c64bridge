// Pre-2026 clients keep the v1 SDK message prefix ("MCP error <code>: ") for handler errors; 2026-07-28 requests get plain messages.
// The code of an unknown resource is -32602 for every era: the SDK's error encoder maps -32002 to -32602 (see the ledger, C6a).
import test from "#test/runner";
import assert from "#test/assert";
import { connect, startServer } from "./helpers/modernClient.mjs";

for (const transport of ["stdio", "http"]) {
  for (const era of ["legacy", "modern"]) {
    test(`[${transport}] ${era} request: unknown resource and unknown prompt error text`, async (t) => {
      const server = await startServer(t, { transport });
      const client = await connect(server, { era });
      const resource = await client.request("resources/read", { uri: "c64://no-such-resource" });
      assert.equal(resource.error?.code, -32602);
      assert.equal(resource.error.data?.uri, "c64://no-such-resource");
      const prompt = await client.request("prompts/get", { name: "no-such-prompt" });
      assert.equal(prompt.error?.code, -32602);
      if (era === "legacy") {
        assert.equal(resource.error.message, "MCP error -32002: Unknown resource: c64://no-such-resource");
        assert.match(prompt.error.message, /^MCP error -32602: /);
      } else {
        assert.equal(resource.error.message, "Unknown resource: c64://no-such-resource");
        assert.ok(!prompt.error.message.startsWith("MCP error "), prompt.error.message);
      }
    });
  }
}
