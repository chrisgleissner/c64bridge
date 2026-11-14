import test from "#test/runner";
import assert from "#test/assert";
import { toolRegistry } from "../src/tools/registry/index.js";
import { publishedToolMeta } from "../src/tools/types.ts";
import { listKnowledgeResources, publishedResourceMeta } from "../src/rag/knowledgeIndex.ts";

test("META-001 tool _meta is slim by default and complete in verbose mode", () => {
  const tool = toolRegistry.list().find((entry) => entry.metadata.examples && entry.metadata.workflowHints);
  assert.ok(tool);
  const slim = publishedToolMeta(tool.metadata, { verbose: false });
  assert.deepEqual(Object.keys(slim).filter((k) => ["examples", "workflowHints", "summary", "resources", "prompts", "tags"].includes(k)), []);
  assert.ok(slim.domain && slim.platforms, "functional fields stay");
  assert.deepEqual(publishedToolMeta(tool.metadata, { verbose: true }), tool.metadata);
  const size = (verbose) => toolRegistry.list().reduce((n, t) => n + JSON.stringify(publishedToolMeta(t.metadata, { verbose })).length, 0);
  assert.ok(size(false) < size(true) / 3, `slim ${size(false)} vs verbose ${size(true)}`);
});

test("META-002 resource _meta is slim by default and complete in verbose mode", () => {
  const resource = listKnowledgeResources()[0];
  const slim = publishedResourceMeta(resource.metadata, { verbose: false });
  assert.deepEqual(Object.keys(slim).sort(), ["domain", "order", "priority"]);
  assert.deepEqual(publishedResourceMeta(resource.metadata, { verbose: true }), resource.metadata);
});
