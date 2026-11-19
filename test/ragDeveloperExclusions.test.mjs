import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildAllIndexes, loadIndexes } from "../src/rag/indexer.ts";
import { LocalMiniHashEmbedding } from "../src/rag/embeddings.ts";

const root = path.resolve(import.meta.dirname, "..");
const developerOnly = (file) => /(?:^|\/)\.github\/(?:prompts\/(?:steer|pr-converge)\.prompt\.md|skills\/pr-converge(?:\/|$))/.test(file.replaceAll("\\", "/"));

test("HARD03-041 index inputs exclude repository maintenance instructions", async () => {
  const embeddingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-exclusions-"));
  try {
    await buildAllIndexes({ model: new LocalMiniHashEmbedding(16), embeddingsDir,
      basicDirs: [], asmDirs: [], externalDirs: [],
      docFiles: [path.join(root, ".github/prompts/steer.prompt.md"), path.join(root, ".github/prompts/pr-converge.prompt.md"), path.join(root, ".github/skills/pr-converge/SKILL.md")],
    });
    const indexes = await loadIndexes({ embeddingsDir });
    const records = Object.values(indexes).flatMap((index) => index?.records ?? []);
    assert.ok(records.some((record) => /\.github\/prompts\//.test(record.sourcePath ?? record.origin ?? "")), "ordinary user prompts remain indexed");
    assert.deepEqual(records.filter((record) => developerOnly(record.sourcePath ?? "") || developerOnly(record.origin ?? "")), []);
  } finally {
    await fs.rm(embeddingsDir, { recursive: true, force: true });
  }
});


test("HARD03-041 npm package excludes repository maintenance instructions", async () => {
  const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: root, encoding: "utf8", timeout: 25000, maxBuffer: 4 * 1024 * 1024,
  });
  const files = JSON.parse(stdout)[0].files.map((file) => file.path);
  assert.ok(files.includes("doc/hardening-behavior.md"), "published guidance includes its linked hardening behavior reference");
  assert.ok(files.some((file) => file.startsWith(".github/prompts/")), "ordinary user prompts remain packaged");
  assert.deepEqual(files.filter(developerOnly), []);
});

test("KNOWLEDGE-3 index inputs exclude developer documents but keep C64 reference documents", async () => {
  const embeddingsDir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-developer-docs-"));
  const excluded = ["AGENTS.md", "doc/developer.md", "doc/troubleshooting-mcp.md", "doc/agent-state-spec.md", "doc/hardening-behavior.md", "doc/audit/secret-handling.md"];
  const kept = ["data/gamedev/techniques.md", "doc/c64u/c64-rest-api.md"];
  try {
    await buildAllIndexes({ model: new LocalMiniHashEmbedding(16), embeddingsDir, basicDirs: [], asmDirs: [], externalDirs: [],
      docFiles: [...excluded, ...kept].map((file) => path.join(root, file)) });
    const indexes = await loadIndexes({ embeddingsDir });
    const sources = new Set(Object.values(indexes).flatMap((index) => index?.records ?? []).map((record) => (record.sourcePath ?? "").replaceAll("\\", "/").replace(`${root.replaceAll("\\", "/")}/`, "")));
    for (const file of excluded) assert.equal([...sources].some((source) => source === file), false, `${file} is indexed`);
    for (const file of kept) assert.ok([...sources].some((source) => source === file), `${file} is missing`);
  } finally {
    await fs.rm(embeddingsDir, { recursive: true, force: true });
  }
});
