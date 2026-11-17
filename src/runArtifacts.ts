import { promises as fs } from "node:fs";
import { join } from "node:path";
import { stateRootDir } from "./hostPaths.js";

const MAX_RUNS = 200;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Only generated runs are retained here; explicit output directories are never pruned. */
export async function pruneRunArtifacts(): Promise<void> {
  const root = join(stateRootDir(), "runs");
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  const runs = await Promise.all(entries.filter((entry) => entry.isDirectory() && /^(batch|shuffle|cycle)_/.test(entry.name)).map(async (entry) => {
    const path = join(root, entry.name);
    const stat = await fs.stat(path);
    return { path, time: stat.mtimeMs };
  }));
  runs.sort((a, b) => b.time - a.time);
  await Promise.all(runs.filter((run, index) => index >= MAX_RUNS || run.time < Date.now() - MAX_AGE_MS).map((run) => fs.rm(run.path, { recursive: true, force: true })));
}

export async function createDefaultRunDirectory(kind: "batch" | "shuffle" | "cycle"): Promise<string> {
  const root = join(stateRootDir(), "runs");
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(join(root, `${kind}_${Date.now()}_`));
}
