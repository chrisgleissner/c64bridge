import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "#test/runner";
import assert from "#test/assert";
import { FORBIDDEN_PATTERNS } from "../../scripts/check-package-budget.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("PACKAGE-9 package ships what the server reads and nothing the budget forbids", () => {
  const json = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const files = JSON.parse(json)[0].files.map((file) => file.path);
  for (const required of [
    "package.json", "mcp.json", "AGENTS.md", "README.md", "scripts/cli.js", "scripts/start.mjs",
    "data/context/bootstrap.md", "data/embeddings_basic.json", ".github/skills/hello-world/SKILL.md",
    ".github/prompts/hello-world-session.prompt.md", "doc/hardening-behavior.md", "scripts/turbo-bench.mjs",
  ]) {
    assert.ok(files.includes(required), `missing ${required}`);
  }
  assert.deepEqual(files.filter((file) => FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file))), []);
});
