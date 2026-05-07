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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

// The MCP server adds a synthetic platform status resource alongside knowledge resources
const PLATFORM_RESOURCE_URI = "c64://platform/status";

// Hardcode the full set of expected knowledge resource URIs. This ensures that
// any addition/removal must be intentional and reflected here.
const EXPECTED_RESOURCE_URIS = [
  // Orientation
  "c64://context/bootstrap",
  "c64://context/fast-paths",
  // VICE emulator
  "c64://docs/vice/binary-monitor-spec",
  // Languages
  "c64://specs/basic",
  "c64://docs/basic/pitfalls",
  "c64://specs/assembly",
  // Audio / SID
  "c64://specs/sid",
  "c64://specs/sidwave",
  "c64://docs/sid/file-structure",
  "c64://docs/sid/best-practices",
  // Graphics / VIC-II
  "c64://specs/vic",
  "c64://specs/charset",
  "c64://docs/petscii-style",
  "c64://docs/sprite-charset-workflows",
  // Memory & I/O
  "c64://specs/memory-map",
  "c64://specs/memory-low",
  "c64://specs/memory-kernal",
  "c64://specs/io",
  "c64://specs/cia",
  // Printers
  "c64://specs/printer",
  "c64://docs/printer/guide",
  "c64://docs/printer/commodore-text",
  "c64://docs/printer/commodore-bitmap",
  "c64://docs/printer/epson-text",
  "c64://docs/printer/epson-bitmap",
  "c64://docs/printer/prompts",
  // Knowledge index (synthetic)
  "c64://docs/index",
];

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
      const expectedUris = new Set([...EXPECTED_RESOURCE_URIS, PLATFORM_RESOURCE_URI]);

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
}
