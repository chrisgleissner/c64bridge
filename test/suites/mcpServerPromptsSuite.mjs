import test from "#test/runner";
import assert from "#test/assert";
import {
  ListPromptsResultSchema,
  GetPromptResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createPromptRegistry } from "../../src/prompts/registry.js";

const promptRegistry = createPromptRegistry();

function normaliseSegmentRole(role) {
  return role === "user" ? "user" : "assistant";
}

export function registerMcpServerPromptsTests(withSharedMcpClient) {
  test("prompts/list mirrors registry descriptors", async () => {
    await withSharedMcpClient(async ({ client }) => {
      const listResult = await client.request(
        { method: "prompts/list", params: {} },
        ListPromptsResultSchema,
      );

      assert.ok(Array.isArray(listResult.prompts), "prompts should be an array");

      const registryEntries = promptRegistry.list();
      assert.equal(
        listResult.prompts.length,
        registryEntries.length,
        "ListPrompts should return every registry prompt",
      );

      const listedByName = new Map(listResult.prompts.map((prompt) => [prompt.name, prompt]));

      for (const entry of registryEntries) {
        const listed = listedByName.get(entry.descriptor.name);
        assert.ok(listed, `Prompt ${entry.descriptor.name} should be listed`);
        assert.equal(listed.title, entry.descriptor.title);
        assert.equal(listed.description, entry.descriptor.description);

        if (entry.arguments && entry.arguments.length > 0) {
          assert.ok(Array.isArray(listed.arguments), "arguments should be present");
          const listedArgs = new Map(listed.arguments.map((arg) => [arg.name, arg]));
          const argumentOptions = listed._meta?.argumentOptions ?? {};
          for (const arg of entry.arguments) {
            const listedArg = listedArgs.get(arg.name);
            assert.ok(listedArg, `Argument ${arg.name} should be returned`);
            assert.equal(listedArg.description, arg.description);
            if (arg.required !== undefined) {
              assert.equal(listedArg.required, arg.required);
            }
            if (arg.options) {
              assert.deepEqual(argumentOptions[arg.name], arg.options);
            }
          }
        } else {
          assert.ok(
            !listed.arguments || listed.arguments.length === 0,
            "arguments should be omitted when registry has none",
          );
        }

        assert.ok(listed._meta, "Prompt list responses should include metadata");
        assert.deepEqual(listed._meta.requiredResources, entry.descriptor.requiredResources);
        assert.deepEqual(listed._meta.optionalResources, entry.descriptor.optionalResources ?? []);
        assert.deepEqual(listed._meta.tools, entry.descriptor.tools);
        assert.deepEqual(listed._meta.tags, entry.descriptor.tags ?? []);
      }
    });
  });

  test("prompts/get returns assembled guidance and metadata", async () => {
    await withSharedMcpClient(async ({ client }) => {
      const result = await client.request(
        { method: "prompts/get", params: { name: "basic-program" } },
        GetPromptResultSchema,
      );

      const expected = promptRegistry.resolve("basic-program", {});

      assert.equal(result.description, expected.description);
      assert.equal(result.messages.length, expected.messages.length);

      for (let index = 0; index < expected.messages.length; index += 1) {
        const expectedSegment = expected.messages[index];
        const message = result.messages[index];
        assert.equal(message.role, normaliseSegmentRole(expectedSegment.role));
        assert.equal(message.content.type, "text");
        assert.equal(message.content.text, expectedSegment.content);
      }

      const meta = result._meta;
      assert.ok(meta, "Prompt should return _meta payload");
      const resourceUris = meta.resources.map((resource) => resource.uri);
      assert.deepEqual(resourceUris, expected.resources.map((resource) => resource.uri));
      const toolNames = meta.tools.map((tool) => tool.name ?? tool.title ?? tool);
      assert.deepEqual(
        toolNames,
        expected.tools.map((tool) => tool.name),
        "Prompt should surface matching tool descriptors",
      );
    });
  });

  test("prompts/get honours assembly hardware argument", async () => {
    await withSharedMcpClient(async ({ client }) => {
      const args = { hardware: "sid" };
      const result = await client.request(
        { method: "prompts/get", params: { name: "assembly-program", arguments: args } },
        GetPromptResultSchema,
      );

      const expected = promptRegistry.resolve("assembly-program", args);
      assert.equal(result._meta?.arguments?.hardware, "sid");
      assert.ok(
        result.messages.some((message) =>
          message.content.type === "text" && /SID register usage/i.test(message.content.text),
        ),
        "Assembly prompt should mention SID guidance when hardware=sid",
      );
      const resourceUris = result._meta?.resources?.map((resource) => resource.uri) ?? [];
      assert.deepEqual(resourceUris.sort(), expected.resources.map((resource) => resource.uri).sort());
    });
  });

  test("graphics prompt surfaces mode-specific tools", async () => {
    await withSharedMcpClient(async ({ client }) => {
      const args = { mode: "sprite" };
      const result = await client.request(
        { method: "prompts/get", params: { name: "graphics-demo", arguments: args } },
        GetPromptResultSchema,
      );

      assert.ok(
        result._meta?.tools?.some((tool) => tool.name === "c64_graphics"),
        "Graphics prompt should include c64_graphics grouped tool",
      );
      assert.ok(
        result._meta?.tools?.some((tool) => tool.name === "c64_memory"),
        "Graphics prompt should include c64_memory",
      );
      assert.ok(
        result.messages.some((message) =>
          message.content.type === "text" && /sprite data/i.test(message.content.text),
        ),
        "Graphics prompt should reference sprite guidance when mode=sprite",
      );
    });
  });

  test("printer prompt selects matching resources for Epson", async () => {
    await withSharedMcpClient(async ({ client }) => {
      const args = { printerType: "epson" };
      const result = await client.request(
        { method: "prompts/get", params: { name: "printer-job", arguments: args } },
        GetPromptResultSchema,
      );

      const resourceUris = (result._meta?.resources ?? []).map((resource) => resource.uri);
      assert.ok(resourceUris.includes("c64://printer/epson/text"), "should include Epson text guide");
      assert.ok(resourceUris.includes("c64://printer/epson/bitmap"), "should include Epson bitmap guide");
      assert.ok(
        result._meta?.tools?.some((tool) => tool.name === "c64_printer"),
        "should include c64_printer tool",
      );
    });
  });
}
