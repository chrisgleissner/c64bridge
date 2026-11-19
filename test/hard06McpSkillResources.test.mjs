import test from "#test/runner";
import assert from "#test/assert";
import { registerHarnessSuite, withSharedMcpClient } from "./helpers/mcpTestHarness.mjs";
import {
  GetPromptResultSchema,
  InitializeResultSchema,
  ListResourcesResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { listSkillResources, rewriteSkillPaths } from "../src/mcp/skills.ts";

registerHarnessSuite("hard06-mcp-skills");

const PROMPTS = ["hello-world", "basic-program", "assembly-program", "game-development", "graphics-demo", "printer-job", "memory-debug", "drive-manager", "sid-music"];

test("MCP-3 every packaged skill is a c64://skills resource and prompts reference only readable skills", async () => {
  const skills = listSkillResources();
  assert.ok(skills.length >= 12);
  assert.equal(skills.some((skill) => skill.uri === "c64://skills/pr-converge"), false, "developer-only skill is not served");
  await withSharedMcpClient(async ({ client }) => {
    const listed = await client.request({ method: "resources/list", params: {} }, ListResourcesResultSchema);
    const uris = new Set(listed.resources.map((resource) => resource.uri));
    for (const skill of skills) assert.ok(uris.has(skill.uri), skill.uri);

    const game = await client.request({ method: "resources/read", params: { uri: "c64://skills/game-development" } }, ReadResourceResultSchema);
    assert.match(game.contents[0].text, /## Intent/);

    for (const name of PROMPTS) {
      const prompt = await client.request({ method: "prompts/get", params: { name, arguments: {} } }, GetPromptResultSchema);
      const text = prompt.messages.map((message) => message.content.text).join("\n");
      assert.equal(text.includes(".github/skills"), false, `${name} names a repository path`);
      for (const [uri] of text.matchAll(/c64:\/\/skills\/[a-z0-9-]+/g)) {
        assert.ok(uris.has(uri), `${name} references ${uri}`);
      }
    }
  });
});

test("MCP-3 knowledge text served to clients names skills by resource URI", async () => {
  assert.equal(rewriteSkillPaths("route to `.github/skills/hello-world/SKILL.md` or ../skills/sid-music/SKILL.md"), "route to `c64://skills/hello-world` or c64://skills/sid-music");
  assert.equal(rewriteSkillPaths("in `.github/skills/*/SKILL.md`"), "in `c64://skills/<name>`");
  await withSharedMcpClient(async ({ client }) => {
    const bootstrap = await client.request({ method: "resources/read", params: { uri: "c64://guide/bootstrap" } }, ReadResourceResultSchema);
    assert.equal(bootstrap.contents[0].text.includes(".github/skills/"), false);
  });
});

test("MCP-4 prompts/get names tools instead of embedding their descriptors", async () => {
  await withSharedMcpClient(async ({ client }) => {
    const prompt = await client.request({ method: "prompts/get", params: { name: "game-development", arguments: {} } }, GetPromptResultSchema);
    assert.ok(prompt._meta.tools.every((tool) => typeof tool === "string"));
    assert.ok(prompt._meta.tools.includes("c64_program"));
    assert.ok(JSON.stringify(prompt).length < 8_000, `prompts/get is ${JSON.stringify(prompt).length} bytes`);
  });
});

test("MCP-3 initialize returns instructions for the client", async () => {
  await withSharedMcpClient(async ({ client }) => {
    const instructions = client.getInstructions?.();
    assert.equal(typeof instructions, "string");
    assert.match(instructions, /`op`/);
    assert.match(instructions, /c64:\/\/platform\/status/);
    assert.match(instructions, /c64:\/\/skills\//);
    assert.match(instructions, /c64:\/\/gamedev\/index/);
    assert.match(instructions, /location: "host"/);
    const lines = instructions.split("\n").length;
    assert.ok(lines >= 10 && lines <= 15, `${lines} lines`);
  });
  assert.ok(InitializeResultSchema);
});
