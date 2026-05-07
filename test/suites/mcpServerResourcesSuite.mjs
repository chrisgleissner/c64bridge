import test from "#test/runner";
import assert from "#test/assert";
import {
  ListResourcesResultSchema,
  ReadResourceResultSchema,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { RESOURCE_URIS } from "../../src/rag/resourceUris.js";

const expectedResources = [
  { uri: RESOURCE_URIS.guide.index, domain: "guide", priority: "critical", includeInIndex: true },
  { uri: RESOURCE_URIS.guide.bootstrap, domain: "guide", priority: "critical", includeInIndex: true },
  { uri: RESOURCE_URIS.guide.fastPaths, domain: "guide", priority: "critical", includeInIndex: true },
  { uri: RESOURCE_URIS.vice.binaryMonitorSpec, domain: "vice", priority: "critical", includeInIndex: true },
  { uri: RESOURCE_URIS.basic.spec, domain: "languages", priority: "critical", includeInIndex: true },
  { uri: RESOURCE_URIS.basic.pitfalls, domain: "languages", priority: "reference", includeInIndex: true },
  { uri: RESOURCE_URIS.assembly.spec6510, domain: "languages", priority: "critical", includeInIndex: true },
  { uri: RESOURCE_URIS.sound.sid.spec, domain: "audio", priority: "critical", includeInIndex: true },
  { uri: RESOURCE_URIS.sound.sidwave.spec, domain: "audio", priority: "reference", includeInIndex: true },
  { uri: RESOURCE_URIS.sound.sid.fileFormat, domain: "audio", priority: "reference", includeInIndex: true },
  { uri: RESOURCE_URIS.sound.sid.bestPractices, domain: "audio", priority: "reference", includeInIndex: true },
  { uri: RESOURCE_URIS.graphics.vic.spec, domain: "graphics", priority: "critical", includeInIndex: true },
  { uri: RESOURCE_URIS.memory.map, domain: "memory", priority: "critical", includeInIndex: true },
  { uri: RESOURCE_URIS.memory.zeroPageAndWorkspace, domain: "memory", priority: "reference", includeInIndex: true },
  { uri: RESOURCE_URIS.kernal.romRoutines, domain: "memory", priority: "reference", includeInIndex: true },
  { uri: RESOURCE_URIS.io.spec, domain: "memory", priority: "critical", includeInIndex: true },
  { uri: RESOURCE_URIS.io.cia.spec, domain: "memory", priority: "reference", includeInIndex: true },
  { uri: RESOURCE_URIS.printer.spec, domain: "printer", priority: "critical", includeInIndex: true },
  { uri: RESOURCE_URIS.printer.commodore.text, domain: "printer", priority: "reference", includeInIndex: true },
  { uri: RESOURCE_URIS.printer.commodore.bitmap, domain: "printer", priority: "reference", includeInIndex: true },
  { uri: RESOURCE_URIS.printer.epson.text, domain: "printer", priority: "reference", includeInIndex: true },
  { uri: RESOURCE_URIS.printer.epson.bitmap, domain: "printer", priority: "reference", includeInIndex: true },
  { uri: RESOURCE_URIS.printer.promptGuide, domain: "printer", priority: "supplemental", includeInIndex: true },
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
          { method: "resources/read", params: { uri: RESOURCE_URIS.guide.index } },
          ReadResourceResultSchema,
        )
      ).contents[0].text;

      for (const { uri, includeInIndex } of expectedResources) {
        if (!includeInIndex || uri === RESOURCE_URIS.guide.index) {
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

      // The RAG tool should include the BASIC spec in its primary resources
      // Verify we can read that resource via ReadResource
      const basicSpecUri = RESOURCE_URIS.basic.spec;
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

  test("legacy resource URIs are rejected by direct reads", async () => {
    const legacyUris = [
      "c64://index",
      "c64://context/bootstrap",
      "c64://context/fast-paths",
      "c64://vice/vice-binary-monitor-spec",
      "c64://basic/basic-spec",
      "c64://assembly/assembly-spec",
      "c64://sound/sid-spec",
      "c64://graphics/vic-spec",
      "c64://memory/memory-map",
      "c64://printer/printer-spec",
    ];

    await withSharedMcpClient(async ({ client }) => {
      for (const uri of legacyUris) {
        await assert.rejects(
          client.request(
            { method: "resources/read", params: { uri } },
            ReadResourceResultSchema,
          ),
          undefined,
          `${uri} should be rejected`,
        );
      }
    });
  });
}
