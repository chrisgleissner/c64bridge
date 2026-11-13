import test from "#test/runner";
import assert from "#test/assert";
import { jsonResult } from "../src/tools/responses.ts";
import { memoryModule } from "../src/tools/memory.js";
import { toCallToolResult } from "../src/mcp/callToolResult.ts";

const HEX = "$" + "AB".repeat(1024);
const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("WIRE-001 a memory read sends its hex payload in content and structuredContent only", async () => {
  const client = {
    async readMemory() { return { success: true, data: HEX, details: { address: "0400", length: 1024 } }; },
    async pinFacade() { return { type: "mock" }; },
  };
  const result = await memoryModule.invoke("read", { address: "$0400", length: 1024 }, { client, logger });
  const wire = toCallToolResult(result);
  assert.equal("metadata" in wire, false, "metadata is not an MCP result field and must not be sent");
  assert.equal(JSON.stringify(wire).split(HEX).length - 1, 2, "payload appears once in text and once in structuredContent");
  assert.equal(wire.structuredContent.data.success, true, "small metadata stays available in structuredContent");
});

test("WIRE-002 a json result is serialized compactly and not duplicated in metadata", () => {
  const data = { items: [1, 2, 3], note: HEX };
  const result = jsonResult(data, { success: true });
  assert.equal(result.content[0].text, JSON.stringify(data), "text is compact JSON");
  const wire = toCallToolResult(result);
  assert.equal("metadata" in wire, false);
  assert.equal(JSON.stringify(wire).split(HEX).length - 1, 2);
});
