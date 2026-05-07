import test from "#test/runner";
import assert from "#test/assert";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { toolRegistry } from "../../src/tools/registry/index.js";

function stripUndefinedDeep(value) {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedDeep);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([entryKey, entryValue]) => [entryKey, stripUndefinedDeep(entryValue)]),
  );
}

function assertDescriptorMetadata(metadata) {
  assert.ok(metadata, "tool metadata should exist");
  assert.equal(typeof metadata.domain, "string", "metadata.domain should be string");
  assert.ok(metadata.domain.length > 0, "metadata.domain should not be empty");
  assert.equal(typeof metadata.summary, "string", "metadata.summary should be string");
  assert.ok(metadata.summary.length > 0, "metadata.summary should not be empty");
  assert.ok(Array.isArray(metadata.resources), "metadata.resources should be array");
  assert.ok(Array.isArray(metadata.prompts), "metadata.prompts should be array");
  assert.ok(Array.isArray(metadata.tags), "metadata.tags should be array");
  assert.ok(Array.isArray(metadata.platforms), "metadata.platforms should be array");
  assert.ok(metadata.platforms.length > 0, "metadata.platforms should not be empty");
  if (metadata.examples !== undefined) {
    assert.ok(Array.isArray(metadata.examples), "metadata.examples should be array when present");
  }
  if (metadata.workflowHints !== undefined) {
    assert.ok(Array.isArray(metadata.workflowHints), "metadata.workflowHints should be array when present");
  }
  if (metadata.prerequisites !== undefined) {
    assert.ok(Array.isArray(metadata.prerequisites), "metadata.prerequisites should be array when present");
  }
}

export function registerMcpServerToolsTests(withSharedMcpClient) {
  test("MCP server exposes tool descriptors from registry", async () => {
    await withSharedMcpClient(async ({ client }) => {
      const listResult = await client.request(
        { method: "tools/list", params: {} },
        ListToolsResultSchema,
      );

      assert.ok(Array.isArray(listResult.tools), "tools should be an array");

      const registryDescriptors = toolRegistry.list();
      assert.equal(
        listResult.tools.length,
        registryDescriptors.length,
        "ListTools should mirror registry tool count",
      );

      const listedByName = new Map(listResult.tools.map((tool) => [tool.name, tool]));

      for (const descriptor of registryDescriptors) {
        const listed = listedByName.get(descriptor.name);
        const metadata = listed?._meta;
        assert.ok(listed, `tool ${descriptor.name} should be returned`);
        assert.equal(listed.description, descriptor.description, "description should match registry");
        if (descriptor.inputSchema) {
          assert.deepEqual(
            stripUndefinedDeep(listed.inputSchema),
            stripUndefinedDeep(descriptor.inputSchema),
            "input schema should match registry",
          );
        } else {
          assert.ok(
            listed.inputSchema === undefined || listed.inputSchema === null,
            "input schema should be absent when registry omits it",
          );
        }

        assertDescriptorMetadata(metadata);
        assert.equal(metadata.domain, descriptor.metadata.domain);
        assert.equal(metadata.summary, descriptor.metadata.summary);
        assert.equal(metadata.lifecycle, descriptor.metadata.lifecycle);
        assert.deepEqual(metadata.resources, descriptor.metadata.resources);
        assert.deepEqual(metadata.prompts, descriptor.metadata.prompts);
        assert.deepEqual(metadata.tags, descriptor.metadata.tags);
        assert.deepEqual(metadata.platforms, descriptor.metadata.platforms);

        if (descriptor.metadata.workflowHints) {
          assert.deepEqual(metadata.workflowHints, descriptor.metadata.workflowHints);
        } else {
          assert.ok(
            metadata.workflowHints === undefined || metadata.workflowHints === null,
            "workflowHints should be absent when registry omits them",
          );
        }

        if (descriptor.metadata.prerequisites) {
          assert.deepEqual(metadata.prerequisites, descriptor.metadata.prerequisites);
        } else {
          assert.ok(
            metadata.prerequisites === undefined || metadata.prerequisites === null,
            "prerequisites should be absent when registry omits them",
          );
        }

        if (descriptor.metadata.examples) {
          assert.deepEqual(metadata.examples, descriptor.metadata.examples);
        } else {
          assert.ok(
            metadata.examples === undefined || metadata.examples === null,
            "examples should be absent when registry omits them",
          );
        }
      }
    });
  });
}
