import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerHarnessSuite, withSharedMcpClient } from "./helpers/mcpTestHarness.mjs";
import { ListResourceTemplatesResultSchema, ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
registerHarnessSuite("hard06-mcp-resource-reads");

test("MCP-14 resources/templates/list answers with an empty list", async () => {
  await withSharedMcpClient(async ({ client }) => {
    const result = await client.request({ method: "resources/templates/list", params: {} }, ListResourceTemplatesResultSchema);
    assert.deepEqual(result.resourceTemplates, []);
  });
});

test("WORKFLOW-10 a resource link with a #fragment (as c64_rag returns) reads the document", async () => {
  await withSharedMcpClient(async ({ client }) => {
    const plain = await client.request({ method: "resources/read", params: { uri: "c64://memory/map" } }, ReadResourceResultSchema);
    const linked = await client.request({ method: "resources/read", params: { uri: "c64://memory/map#zero-page" } }, ReadResourceResultSchema);
    assert.equal(linked.contents[0].text, plain.contents[0].text);
  });
});

test("PACKAGE-8 the entry point enables the compile cache and the prompt registry is built lazily", () => {
  const entry = fs.readFileSync(path.join(repoRoot, "src", "index.ts"), "utf8");
  assert.match(entry, /enableCompileCache\?\.\(\)/);
  assert.ok(entry.indexOf("enableCompileCache") < entry.indexOf('import("./mcp-server.js")'), "cache before the server modules load");
  const server = fs.readFileSync(path.join(repoRoot, "src", "mcp-server.ts"), "utf8");
  assert.equal(/const promptRegistry = createPromptRegistry\(\)/.test(server), false);
});
