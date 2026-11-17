import { promises as fs } from "node:fs";
import { join } from "node:path";
import { processIsAlive } from "./taskStateLock.js";
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
    try {
      const stat = await fs.stat(path);
      let foreignLive = false;
      try {
        const owner = JSON.parse(await fs.readFile(join(path, ".owner.json"), "utf8"));
        foreignLive = owner.pid !== process.pid && processIsAlive(owner.pid);
      } catch { /* old runs did not have owner metadata */ }
      return { path, time: stat.mtimeMs, foreignLive };
    } catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
  }));
  const existing = runs.filter((run): run is NonNullable<typeof run> => run !== null);
  existing.sort((a, b) => b.time - a.time);
  await Promise.all(existing.filter((run, index) => !run.foreignLive && (index >= MAX_RUNS || run.time < Date.now() - MAX_AGE_MS)).map((run) => fs.rm(run.path, { recursive: true, force: true })));
}

export async function createDefaultRunDirectory(kind: "batch" | "shuffle" | "cycle"): Promise<string> {
  const root = join(stateRootDir(), "runs");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(join(root, `${kind}_${Date.now()}_`));
  await fs.writeFile(join(directory, ".owner.json"), JSON.stringify({ pid: process.pid }));
  return directory;
}
