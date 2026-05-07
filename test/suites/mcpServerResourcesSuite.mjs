import test from "#test/runner";
import assert from "#test/assert";
import {
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

const expectedResources = [
  { uri: "c64://docs/index", domain: "overview", priority: "critical", includeInIndex: true },
  { uri: "c64://context/bootstrap", domain: "orientation", priority: "critical", includeInIndex: true },
  { uri: "c64://context/fast-paths", domain: "orientation", priority: "critical", includeInIndex: true },
  { uri: "c64://docs/vice/binary-monitor-spec", domain: "vice", priority: "critical", includeInIndex: true },
  { uri: "c64://specs/basic", domain: "languages", priority: "critical", includeInIndex: true },
  { uri: "c64://docs/basic/pitfalls", domain: "languages", priority: "reference", includeInIndex: true },
  { uri: "c64://specs/assembly", domain: "languages", priority: "critical", includeInIndex: true },
  { uri: "c64://specs/sid", domain: "audio", priority: "critical", includeInIndex: true },
  { uri: "c64://specs/sidwave", domain: "audio", priority: "reference", includeInIndex: true },
  { uri: "c64://docs/sid/file-structure", domain: "audio", priority: "reference", includeInIndex: true },
  { uri: "c64://docs/sid/best-practices", domain: "audio", priority: "reference", includeInIndex: true },
  { uri: "c64://specs/vic", domain: "graphics", priority: "critical", includeInIndex: true },
  { uri: "c64://specs/memory-map", domain: "memory", priority: "critical", includeInIndex: true },
  { uri: "c64://specs/memory-low", domain: "memory", priority: "reference", includeInIndex: true },
  { uri: "c64://specs/memory-kernal", domain: "memory", priority: "reference", includeInIndex: true },
  { uri: "c64://specs/io", domain: "memory", priority: "critical", includeInIndex: true },
  { uri: "c64://specs/cia", domain: "memory", priority: "reference", includeInIndex: true },
  { uri: "c64://specs/printer", domain: "printer", priority: "critical", includeInIndex: true },
  { uri: "c64://docs/printer/guide", domain: "printer", priority: "reference", includeInIndex: true },
  { uri: "c64://docs/printer/commodore-text", domain: "printer", priority: "reference", includeInIndex: true },
  { uri: "c64://docs/printer/commodore-bitmap", domain: "printer", priority: "reference", includeInIndex: true },
  { uri: "c64://docs/printer/epson-text", domain: "printer", priority: "reference", includeInIndex: true },
  { uri: "c64://docs/printer/epson-bitmap", domain: "printer", priority: "reference", includeInIndex: true },
  { uri: "c64://docs/printer/prompts", domain: "printer", priority: "supplemental", includeInIndex: true },
  { uri: "c64://platform/status", domain: "platform", priority: "critical", includeInIndex: false },
];

export function registerMcpServerResourcesTests(withSharedMcpClient) {
  test("MCP server exposes expected resources", async () => {
    await withSharedMcpClient(async ({ client }) => {
      const listResult = await client.request(
        { method: "resources/list", params: {} },
        ListResourcesResultSchema,
      );

      const resourcesByUri = new Map(
        listResult.resources.map((resource) => [resource.uri, resource]),
      );

      for (const expected of expectedResources) {
        const resource = resourcesByUri.get(expected.uri);
        const metadata = resource?._meta;
        assert.ok(resource, `resource ${expected.uri} should be listed`);
        assert.equal(resource.mimeType, "text/markdown");
        assert.ok(metadata, "resource metadata should be present");
        assert.equal(metadata.domain, expected.domain);
        assert.equal(metadata.priority, expected.priority);
        assert.ok(
          typeof metadata.summary === "string" &&
            metadata.summary.length > 0,
          "resource metadata should include a non-empty summary",
        );
        assert.ok(
          Array.isArray(metadata.prompts),
          "metadata.prompts should be an array",
        );
        assert.ok(
          Array.isArray(metadata.tools),
          "metadata.tools should be an array",
        );
        assert.ok(
          Array.isArray(metadata.relatedResources),
          "metadata.relatedResources should be an array",
        );
      }

      const readUris = new Set(expectedResources.map((resource) => resource.uri));

      for (const uri of readUris) {
        const readResult = await client.request(
          { method: "resources/read", params: { uri } },
          ReadResourceResultSchema,
        );

        assert.ok(readResult.contents.length > 0, `${uri} should return content`);
        const [content] = readResult.contents;
        assert.equal(content.uri, uri, "content should preserve URI");
        assert.equal(content.mimeType, "text/markdown", "content should be markdown");
        assert.equal(typeof content.text, "string", "content should include text");
        assert.ok(content.text.length > 0, `resource ${uri} should not be empty`);

        if (uri === "c64://platform/status") {
          assert.match(
            content.text,
            /Current platform: `(?:c64u|vice)`/,
            "platform resource should report current platform",
          );
        }
      }

      const indexText = (
        await client.request(
          { method: "resources/read", params: { uri: "c64://docs/index" } },
          ReadResourceResultSchema,
        )
      ).contents[0].text;

      for (const { uri, includeInIndex } of expectedResources) {
        if (!includeInIndex || uri === "c64://docs/index") {
          continue;
        }
        assert.ok(indexText.includes(uri), `knowledge index should reference ${uri}`);
      }
    });
  });

  test("RAG retrieve returns c64:// URIs that can be opened via ReadResource", async () => {
    await withSharedMcpClient(async ({ client }) => {
      // Call rag_retrieve_basic to get RAG results
      const toolResult = await client.request(
        {
          method: "tools/call",
          params: {
            name: "rag_retrieve_basic",
            arguments: {
              q: "PRINT statement",
              k: 3,
            },
          },
        },
        CallToolResultSchema,
      );

      // Verify the tool returned content
      assert.ok(toolResult.content, "rag_retrieve_basic should return content");
      assert.ok(toolResult.content.length > 0, "should have content items");

      // The RAG tool should include c64://specs/basic in its primary resources
      // Verify we can read that resource via ReadResource
      const basicSpecUri = "c64://specs/basic";
      const readResult = await client.request(
        { method: "resources/read", params: { uri: basicSpecUri } },
        ReadResourceResultSchema,
      );

      // Verify the resource was successfully read
      assert.ok(readResult.contents.length > 0, `${basicSpecUri} should return content`);
      const content = readResult.contents[0];
      assert.equal(content.uri, basicSpecUri, "URI should match requested");
      assert.ok(content.text.length > 0, "Resource content should not be empty");
      assert.match(content.text, /PRINT/i, "BASIC spec should mention PRINT");
    });
  });
}
