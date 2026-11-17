import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
