import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "#test/runner";
import assert from "#test/assert";

const readme = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../README.md"), "utf8");
const section = readme.slice(readme.indexOf("## HTTP Invocation"), readme.indexOf("## Build and Test"));

test("PACKAGE-2 README HTTP section documents the real /mcp JSON-RPC endpoint", () => {
  assert.ok(section.includes("--http"), "must show how to enable the HTTP bridge");
  assert.ok(section.includes("/mcp"), "must use the /mcp endpoint");
  assert.ok(section.includes("application/json, text/event-stream"), "must send the required Accept header");
  assert.ok(!/\/tools\/c64_/.test(section), "there are no /tools/<name> routes");
  assert.ok(!section.includes("8000"), "the default port is 3000");
});

test("PACKAGE-10 developer guide states that Bun is required to build and test", () => {
  const guide = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../doc/developer.md"), "utf8");
  assert.ok(!/Bun\*\* ≥ 1\.3 optional/.test(guide));
  assert.ok(/Bun[^\n]*required to build and test/.test(guide));
  assert.ok(!guide.includes("respects package-lock"));
});

test("PACKAGE-11/12 client setup snippets use the documented formats and no Linux-only paths", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(!agents.includes("github.copilot.chat.experimental.mcp"));
  assert.ok(agents.includes(".vscode/mcp.json"));
  assert.ok(!/node_modules\/c64bridge\/dist\/index\.js/.test(agents));
  assert.ok(readme.includes('"mcpServers"') && readme.includes(".cursor/mcp.json") && readme.includes("claude_desktop_config.json"));
  const badges = [...readme.matchAll(/(?:config=|mcp-install\?)([^)&\s]+)/g)].map((match) => match[1]);
  assert.ok(badges.length >= 4);
  for (const badge of badges) {
    const text = badge.startsWith("eyJ") ? Buffer.from(badge, "base64").toString("utf8") : decodeURIComponent(badge);
    assert.ok(!text.includes("/usr/local"), text);
    assert.ok(JSON.parse(text).command === "npx");
  }
});
