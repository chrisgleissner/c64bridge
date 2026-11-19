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
