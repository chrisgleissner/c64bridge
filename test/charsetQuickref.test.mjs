import test from "#test/runner";
import assert from "#test/assert";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KI = path.join(repoRoot, "src", "rag", "knowledgeIndex.ts");

function runFrom(cwd, body) {
  const script = `const m = await import(${JSON.stringify(KI)}); ${body}`;
  const res = spawnSync("node", ["--import", import.meta.resolve("tsx/esm"), "--input-type=module", "-e", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: path.join(repoRoot, "node_modules") },
  });
  return res;
}

test("CHARSET-001 the charset quickref resolves its CSV from the package root, not the process cwd", () => {
  const res = runFrom(os.tmpdir(), `const r = m.readKnowledgeResource("c64://graphics/character-set", ${JSON.stringify(repoRoot)}); console.log(r.text.length > 1000 ? "OK" : "SHORT");`);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /OK/);
});
