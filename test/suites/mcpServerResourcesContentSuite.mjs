import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ListResourcesResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { listKnowledgeResources } from "../../src/rag/knowledgeIndex.js";
import {
  CANONICAL_KNOWLEDGE_RESOURCE_URIS,
  PLATFORM_RESOURCE_URI,
} from "../../src/rag/resourceUris.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

export function registerMcpServerResourcesContentTests(withSharedMcpClient) {
  test("MCP resources list matches knowledgeIndex + platform; file-backed contents exact", async () => {
    await withSharedMcpClient(async ({ client }) => {
      // 1) List resources from the running MCP server
      const listResult = await client.request(
        { method: "resources/list", params: {} },
        ListResourcesResultSchema,
      );

      const serverUris = new Set(listResult.resources.map((r) => r.uri));

      // 2) Build expected set from hardcoded list + platform resource
      const knowledge = listKnowledgeResources();
      const expectedUris = new Set([...CANONICAL_KNOWLEDGE_RESOURCE_URIS, PLATFORM_RESOURCE_URI]);

      // Ensure both sets match exactly
      const missingOnServer = [...expectedUris].filter((u) => !serverUris.has(u));
      const unexpectedOnServer = [...serverUris].filter((u) => !expectedUris.has(u));

      assert.equal(
        missingOnServer.length,
        0,
        `server is missing expected resources: ${missingOnServer.join(", ")}`,
      );
      assert.equal(
        unexpectedOnServer.length,
        0,
        `server listed unexpected resources: ${unexpectedOnServer.join(", ")}`,
      );

      // Map resource URI -> relativePath (when file-backed)
      const uriToRelativePath = new Map(
        knowledge
          .filter((r) => typeof r.relativePath === "string" && r.relativePath && !r.buildContent)
          .map((r) => [r.uri, r.relativePath])
      );

      // 3) For each resource, read it and compare exact text for file-backed entries
      for (const { uri } of listResult.resources) {
        const readResult = await client.request(
          { method: "resources/read", params: { uri } },
          ReadResourceResultSchema,
        );
        assert.ok(readResult.contents.length > 0, `${uri} should return content`);
        const content = readResult.contents[0];
        assert.equal(content.uri, uri);
        assert.equal(typeof content.text, "string");

        // Strengthened check: content should be at least 100 bytes
        const byteLength = Buffer.byteLength(content.text, "utf8");
        assert.ok(
          byteLength >= 100,
          `${uri} content should be at least 100 bytes, got ${byteLength}`,
        );

        const relativePath = uriToRelativePath.get(uri);
        if (!relativePath) {
          // Skip non-file-backed resources such as the knowledge index and platform status
          continue;
        }

        const fullPath = path.join(repoRoot, relativePath);
        assert.ok(
          fs.existsSync(fullPath),
          `expected file for ${uri} to exist at ${fullPath}`,
        );
        const fileText = fs.readFileSync(fullPath, "utf8");
        assert.equal(
          content.text,
          fileText,
          `resource ${uri} text should exactly match ${relativePath}`,
        );
      }
    });
  });

  test("MCP resources list excludes removed legacy URIs", async () => {
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
      const listResult = await client.request(
        { method: "resources/list", params: {} },
        ListResourcesResultSchema,
      );

      const serverUris = new Set(listResult.resources.map((resource) => resource.uri));
      for (const legacyUri of legacyUris) {
        assert.ok(!serverUris.has(legacyUri), `${legacyUri} should not be listed`);
      }
    });
  });
}
