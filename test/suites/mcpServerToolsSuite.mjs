import test from "#test/runner";
import assert from "#test/assert";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { toolRegistry } from "../../src/tools/registry/index.js";
import { publishedInputSchema } from "../../src/tools/types.js";

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
            stripUndefinedDeep(publishedInputSchema(descriptor.inputSchema, { verbose: false })),
            "input schema should match the published form of the registry schema",
          );
        } else {
          assert.ok(
            listed.inputSchema === undefined || listed.inputSchema === null,
            "input schema should be absent when registry omits it",
          );
        }

        assert.ok(metadata, "tool metadata should exist");
        assert.equal(metadata.domain, descriptor.metadata.domain);
        assert.equal(metadata.lifecycle, descriptor.metadata.lifecycle);
        assert.deepEqual(metadata.platforms, descriptor.metadata.platforms);
        assert.deepEqual(metadata.operationEffects, descriptor.metadata.operationEffects);
        assert.equal(metadata.effect, descriptor.metadata.effect);
        if (!process.env.C64BRIDGE_VERBOSE_SCHEMA) {
          for (const key of ["summary", "examples", "workflowHints", "resources", "prompts", "tags", "prerequisites"]) {
            assert.ok(!(key in metadata), `${descriptor.name} should not publish _meta.${key} unless C64BRIDGE_VERBOSE_SCHEMA=1`);
          }
        }
      }
    });
  });

  test("tools/list stays below 71 KB and omits the duplicated per-op schemas", async () => {
    await withSharedMcpClient(async ({ client }) => {
      const listResult = await client.request(
        { method: "tools/list", params: {} },
        ListToolsResultSchema,
      );
      const bytes = Buffer.byteLength(JSON.stringify(listResult));
      assert.ok(bytes < 71_000, `tools/list is ${bytes} bytes`);
      for (const tool of listResult.tools) {
        assert.ok(
          !("x-c64bridge-operations" in (tool.inputSchema ?? {})),
          `${tool.name} should not publish x-c64bridge-operations`,
        );
      }
    });
  });

  test("tools/list publishes annotations derived from the operation effects", async () => {
    await withSharedMcpClient(async ({ client }) => {
      const listResult = await client.request(
        { method: "tools/list", params: {} },
        ListToolsResultSchema,
      );
      const listed = new Map(listResult.tools.map((tool) => [tool.name, tool]));
      assert.deepEqual(listed.get("c64_rag").annotations, {
        readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false,
      });
      assert.equal(listed.get("c64_system").annotations.destructiveHint, true);
      assert.equal(listed.get("c64_system").annotations.readOnlyHint, false);
      assert.equal(listed.get("c64_memory").annotations.destructiveHint, false);
      assert.match(listed.get("c64_system").inputSchema.description, /\n- poweroff \[c64u, vice\] \[destructive\]: /);
      for (const descriptor of toolRegistry.list()) {
        assert.deepEqual(listed.get(descriptor.name).annotations, descriptor.annotations, descriptor.name);
      }
    });
  });

  test("published grouped tool descriptions state required parameters per op", async () => {
    await withSharedMcpClient(async ({ client }) => {
      const listResult = await client.request(
        { method: "tools/list", params: {} },
        ListToolsResultSchema,
      );
      const listed = new Map(listResult.tools.map((tool) => [tool.name, tool]));
      let checked = 0;
      for (const descriptor of toolRegistry.list()) {
        const operations = descriptor.inputSchema?.["x-c64bridge-operations"];
        if (!operations) continue;
        const text = listed.get(descriptor.name).inputSchema.description;
        for (const operation of operations) {
          const line = text.split("\n").find((entry) => entry.startsWith(`- ${operation.op} `) || entry.startsWith(`- ${operation.op}:`));
          assert.ok(line, `${descriptor.name} description should list op ${operation.op}`);
          if (operation.required.length > 0) {
            assert.ok(line.includes(`Required inputs: ${operation.required.join(", ")}.`), `${descriptor.name}.${operation.op}: ${line}`);
          }
          for (const name of operation.optional) {
            assert.ok(line.includes(name), `${descriptor.name}.${operation.op} should name optional ${name}`);
          }
          checked += 1;
        }
      }
      assert.ok(checked > 50, `checked ${checked} operations`);
    });
  });
}
