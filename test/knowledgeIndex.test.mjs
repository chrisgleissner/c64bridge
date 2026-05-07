import test from "#test/runner";
import assert from "#test/assert";
import { listKnowledgeResources, readKnowledgeResource } from "../src/rag/knowledgeIndex.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

test("listKnowledgeResources returns expected resources including charset", () => {
  const resources = listKnowledgeResources();
  
  assert.ok(Array.isArray(resources), "should return an array");
  assert.ok(resources.length > 0, "should have at least one resource");
  
  // Check that charset resource exists
  const charsetResource = resources.find((r) => r.uri === "c64://specs/charset");
  assert.ok(charsetResource, "should include charset resource");
  assert.equal(charsetResource.name, "PETSCII Character Set Reference");
  assert.equal(charsetResource.mimeType, "text/markdown");
  assert.ok(typeof charsetResource.buildContent === "function", "charset should have buildContent function");

  const fastPathResource = resources.find((r) => r.uri === "c64://context/fast-paths");
  assert.ok(fastPathResource, "should include fast-path workflow resource");
  assert.equal(fastPathResource.metadata.priority, "critical");

  const viceMonitorResource = resources.find((r) => r.uri === "c64://docs/vice/binary-monitor-spec");
  assert.ok(viceMonitorResource, "should include VICE Binary Monitor resource");
  assert.equal(viceMonitorResource.metadata.priority, "critical");
  assert.equal(viceMonitorResource.metadata.domain, "vice");
});

test("readKnowledgeResource returns fast-path workflow guidance", () => {
  const result = readKnowledgeResource("c64://context/fast-paths", projectRoot);

  assert.ok(result, "should return a result");
  assert.equal(result.uri, "c64://context/fast-paths");
  assert.equal(result.mimeType, "text/markdown");
  assert.equal(result.text.includes("cross_platform_greeting") || result.text.includes("fuer_elise"), true);
  assert.equal(result.text.includes("Quick Visible Demo") || result.text.includes("Quick Music Demo"), true);
});

test("readKnowledgeResource generates charset quickref dynamically", () => {
  const result = readKnowledgeResource("c64://specs/charset", projectRoot);
  
  assert.ok(result, "should return a result");
  assert.equal(result.uri, "c64://specs/charset");
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
  const result = readKnowledgeResource("c64://specs/vic", projectRoot);
  
  assert.ok(result, "should return a result");
  assert.equal(result.uri, "c64://specs/vic");
  assert.equal(result.mimeType, "text/markdown");
  assert.ok(typeof result.text === "string", "should return text content");
  assert.ok(result.text.length > 100, "should have substantial content");
});

test("readKnowledgeResource returns VICE Binary Monitor reference", () => {
  const result = readKnowledgeResource("c64://docs/vice/binary-monitor-spec", projectRoot);

  assert.ok(result, "should return a result");
  assert.equal(result.uri, "c64://docs/vice/binary-monitor-spec");
  assert.equal(result.mimeType, "text/markdown");
  assert.ok(result.text.includes("# VICE Binary Monitor Specification"), "should include the VICE monitor title");
  assert.ok(result.text.includes("dedicated connection configured with `-binarymonitor`") || result.text.includes("Commands may cause asynchronous monitor-entry events"), "should mention Binary Monitor protocol constraints");
});

test("readKnowledgeResource returns undefined for unknown URI", () => {
  const result = readKnowledgeResource("c64://unknown/resource", projectRoot);
  
  assert.equal(result, undefined, "should return undefined for unknown resource");
});

test("charset quickref includes all character data from CSV", () => {
  const result = readKnowledgeResource("c64://specs/charset", projectRoot);
  
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

test("readKnowledgeResource generates knowledge index dynamically", () => {
  const result = readKnowledgeResource("c64://docs/index", projectRoot);
  
  assert.ok(result, "should return a result");
  assert.equal(result.uri, "c64://docs/index");
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

