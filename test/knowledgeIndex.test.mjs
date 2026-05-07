import test from "#test/runner";
import assert from "#test/assert";
import { listKnowledgeResources, readKnowledgeResource } from "../src/rag/knowledgeIndex.js";
import { CANONICAL_KNOWLEDGE_RESOURCE_URIS, RESOURCE_URIS } from "../src/rag/resourceUris.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

test("listKnowledgeResources returns expected resources including charset", () => {
  const resources = listKnowledgeResources();
  
  assert.ok(Array.isArray(resources), "should return an array");
  assert.ok(resources.length > 0, "should have at least one resource");
  assert.deepEqual(
    resources.map((resource) => resource.uri),
    [...CANONICAL_KNOWLEDGE_RESOURCE_URIS],
    "should expose the canonical resource URIs in registry order",
  );
  
  // Check that charset resource exists
  const charsetResource = resources.find((r) => r.uri === RESOURCE_URIS.graphics.characterSet);
  assert.ok(charsetResource, "should include charset resource");
  assert.equal(charsetResource.name, "PETSCII Character Set Reference");
  assert.equal(charsetResource.mimeType, "text/markdown");
  assert.ok(typeof charsetResource.buildContent === "function", "charset should have buildContent function");

  const fastPathResource = resources.find((r) => r.uri === RESOURCE_URIS.guide.fastPaths);
  assert.ok(fastPathResource, "should include fast-path workflow resource");
  assert.equal(fastPathResource.metadata.priority, "critical");

  const viceMonitorResource = resources.find((r) => r.uri === RESOURCE_URIS.vice.binaryMonitorSpec);
  assert.ok(viceMonitorResource, "should include VICE Binary Monitor resource");
  assert.equal(viceMonitorResource.metadata.priority, "critical");
  assert.equal(viceMonitorResource.metadata.domain, "vice");
});

test("readKnowledgeResource returns fast-path workflow guidance", () => {
  const result = readKnowledgeResource(RESOURCE_URIS.guide.fastPaths, projectRoot);

  assert.ok(result, "should return a result");
  assert.equal(result.uri, RESOURCE_URIS.guide.fastPaths);
  assert.equal(result.mimeType, "text/markdown");
  assert.equal(result.text.includes("cross_platform_greeting") || result.text.includes("fuer_elise"), true);
  assert.equal(result.text.includes("Quick Visible Demo") || result.text.includes("Quick Music Demo"), true);
});

test("readKnowledgeResource generates charset quickref dynamically", () => {
  const result = readKnowledgeResource(RESOURCE_URIS.graphics.characterSet, projectRoot);
  
  assert.ok(result, "should return a result");
  assert.equal(result.uri, RESOURCE_URIS.graphics.characterSet);
  assert.equal(result.mimeType, "text/markdown");
  assert.ok(typeof result.text === "string", "should return text content");
  assert.ok(result.text.length > 100, "should generate substantial content");
  
  // Verify key sections are present
  assert.ok(result.text.includes("# PETSCII Character Set Reference"), "should have title");
  assert.ok(result.text.includes("## Character Code Table"), "should have table section");
  assert.ok(result.text.includes("Screen Code"), "should have screen code column");
  assert.ok(result.text.includes("PETSCII"), "should have PETSCII column");
  assert.ok(result.text.includes("## Usage Notes"), "should have usage notes");
  assert.ok(result.text.includes("## Common Patterns"), "should have common patterns");
  
  // Verify some character entries are present
  assert.ok(result.text.includes("$41"), "should include PETSCII code examples");
  assert.ok(result.text.includes("A-Z"), "should reference uppercase letters");
});

test("readKnowledgeResource returns file-backed resource content", () => {
  const result = readKnowledgeResource(RESOURCE_URIS.graphics.vic.spec, projectRoot);
  
  assert.ok(result, "should return a result");
  assert.equal(result.uri, RESOURCE_URIS.graphics.vic.spec);
  assert.equal(result.mimeType, "text/markdown");
  assert.ok(typeof result.text === "string", "should return text content");
  assert.ok(result.text.length > 100, "should have substantial content");
});

test("readKnowledgeResource returns VICE Binary Monitor reference", () => {
  const result = readKnowledgeResource(RESOURCE_URIS.vice.binaryMonitorSpec, projectRoot);

  assert.ok(result, "should return a result");
  assert.equal(result.uri, RESOURCE_URIS.vice.binaryMonitorSpec);
  assert.equal(result.mimeType, "text/markdown");
  assert.ok(result.text.includes("# VICE Binary Monitor Specification"), "should include the VICE monitor title");
  assert.ok(result.text.includes("dedicated connection configured with `-binarymonitor`") || result.text.includes("Commands may cause asynchronous monitor-entry events"), "should mention Binary Monitor protocol constraints");
});

test("readKnowledgeResource returns undefined for unknown URI", () => {
  const result = readKnowledgeResource("c64://unknown/resource", projectRoot);
  
  assert.equal(result, undefined, "should return undefined for unknown resource");
});

test("charset quickref includes all character data from CSV", () => {
  const result = readKnowledgeResource(RESOURCE_URIS.graphics.characterSet, projectRoot);
  
  assert.ok(result, "should return a result");
  
  // Check that various character codes are present (sampling from CSV)
  assert.ok(result.text.includes("$00"), "should include first character");
  assert.ok(result.text.includes("$20"), "should include space character");
  assert.ok(result.text.includes("$41"), "should include 'A' character");
  
  // Verify table format is correct
  const lines = result.text.split("\n");
  const tableLines = lines.filter(line => line.includes("|") && line.includes("$"));
  assert.ok(tableLines.length > 200, "should have many character entries in table");
});

test("knowledge resources have proper metadata", () => {
  const resources = listKnowledgeResources();
  
  for (const resource of resources) {
    assert.ok(resource.uri, "resource should have URI");
    assert.ok(resource.name, "resource should have name");
    assert.ok(resource.description, "resource should have description");
    assert.ok(resource.mimeType, "resource should have mimeType");
    assert.ok(resource.metadata, "resource should have metadata");
    assert.ok(resource.metadata.priority, "metadata should have priority");
    assert.ok(Array.isArray(resource.metadata.prompts), "metadata should have prompts array");
    assert.ok(Array.isArray(resource.metadata.tools), "metadata should have tools array");
  }
});

test("canonical resource URIs do not expose redundant duplicated prefixes", () => {
  for (const uri of CANONICAL_KNOWLEDGE_RESOURCE_URIS) {
    assert.ok(!uri.includes("/basic-spec"), `${uri} should not use redundant basic-spec naming`);
    assert.ok(!uri.includes("/printer-spec"), `${uri} should not use redundant printer-spec naming`);
    assert.ok(!uri.includes("/vice-binary-monitor-spec"), `${uri} should not use redundant vice-binary-monitor-spec naming`);
    assert.ok(!uri.includes("/io-spec"), `${uri} should not use redundant io-spec naming`);
    assert.ok(!uri.includes("/sid-spec"), `${uri} should not use redundant sid-spec naming`);
  }
});

test("legacy resource URIs are not supported", () => {
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

  for (const legacyUri of legacyUris) {
    assert.equal(
      readKnowledgeResource(legacyUri, projectRoot),
      undefined,
      `${legacyUri} should no longer resolve`,
    );
  }
});

test("readKnowledgeResource generates knowledge index dynamically", () => {
  const result = readKnowledgeResource(RESOURCE_URIS.guide.index, projectRoot);
  
  assert.ok(result, "should return a result");
  assert.equal(result.uri, RESOURCE_URIS.guide.index);
  assert.equal(result.mimeType, "text/markdown");
  assert.ok(typeof result.text === "string", "should return text content");
  assert.ok(result.text.length > 100, "should generate substantial content");
  
  // Verify key sections are present
  assert.ok(result.text.includes("# C64 Knowledge Map"), "should have title");
  assert.ok(result.text.includes("Start with critical"), "should have intro text");
  assert.ok(result.text.includes("## "), "should have bundle sections");
  
  // Verify critical resource markers
  assert.ok(result.text.includes("★"), "should mark critical resources");
  
  // Verify resource entries format
  assert.ok(result.text.includes("c64://"), "should include resource URIs");
  assert.ok(result.text.includes("Prompts:") || result.text.includes("Tools:"), "should include prompts or tools");
});
