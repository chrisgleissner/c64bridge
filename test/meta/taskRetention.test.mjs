import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultRunDirectory, pruneRunArtifacts } from "../../src/runArtifacts.ts";

test("HARD03-014 generated runs are unique and prune old/excess artifacts only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hard03-runs-"));
  const previous = process.env.C64BRIDGE_STATE_DIR;
  process.env.C64BRIDGE_STATE_DIR = root;
  try {
    const paths = await Promise.all(Array.from({ length: 205 }, () => createDefaultRunDirectory("batch")));
    expect(new Set(paths).size).toBe(205);
    await fs.mkdir(path.join(root, "runs", "operator-output"));
    await fs.utimes(paths[0], new Date(0), new Date(0));
    await pruneRunArtifacts();
    const remaining = await fs.readdir(path.join(root, "runs"));
    expect(remaining.filter((name) => name.startsWith("batch_")).length).toBe(200);
    expect(remaining).toContain("operator-output");
    expect(remaining).not.toContain(path.basename(paths[0]));
  } finally {
    if (previous === undefined) delete process.env.C64BRIDGE_STATE_DIR; else process.env.C64BRIDGE_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HARD03-014 finished registry is bounded, deletion refuses running and result tracks completion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hard03-tasks-"));
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = path.join(root, "tasks.json");
  try {
    const tasks = Array.from({ length: 205 }, (_, n) => ({ id: `${n}_saved`, name: `saved${n}`, type: "background", operation: "read", args: {}, intervalMs: 100, iterations: 1, status: "completed", startedAt: new Date(n).toISOString(), updatedAt: new Date(n).toISOString(), folder: `tasks/background/${n}_saved` }));
    await Promise.all(tasks.map((task) => fs.mkdir(path.join(root, task.folder), { recursive: true })));
    await fs.writeFile(process.env.C64_TASK_STATE_FILE, JSON.stringify({ tasks }));
    const { tools } = await import(`../../src/tools/meta/background.ts?retention=${Date.now()}`);
    const run = (name, args) => tools.find((t) => t.name === name).execute(args, { client: { readMemory: async () => ({ success: true }) } });
    expect((await run("list_background_tasks", {})).metadata.count).toBe(200);
    expect((await fs.readdir(path.join(root, "tasks/background"))).length).toBe(200);
    const started = await run("start_background_task", { name: "fresh", operation: "read", intervalMs: 100, maxIterations: 2 });
    expect((await run("delete_background_task", { name: "fresh" })).isError).toBe(true);
    const resultFile = path.join(root, started.structuredContent.data.task.folder, "result.json");
    const deadline = Date.now() + 5000;
    let result;
    do { result = JSON.parse(await fs.readFile(resultFile, "utf8")); if (result.status === "completed") break; await new Promise((r) => setTimeout(r, 10)); } while (Date.now() < deadline);
    expect(result).toMatchObject({ status: "completed", iterations: 2 });
    expect((await run("list_background_tasks", {})).metadata.count).toBe(200);
    expect((await run("delete_background_task", { name: "fresh" })).metadata.success).toBe(true);
    expect((await run("list_background_tasks", {})).metadata.count).toBe(199);
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE; else process.env.C64_TASK_STATE_FILE = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("HARD03-014 frequent iterations coalesce disk writes while stop flushes immediately", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hard03-coalesce-"));
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = path.join(root, "tasks.json");
  const { tools } = await import(`../../src/tools/meta/background.ts?coalesce=${Date.now()}`);
  const run = (name, args = {}) => tools.find((t) => t.name === name).execute(args, { client: { readMemory: async () => ({ success: true }) } });
  try {
    const started = await run("start_background_task", { name: "fast", operation: "read", intervalMs: 100 });
    const resultFile = path.join(root, started.structuredContent.data.task.folder, "result.json");
    const deadline = Date.now() + 900;
    let current;
    do {
      current = (await run("list_background_tasks")).structuredContent.data.tasks[0];
      if (current.iterations >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    } while (Date.now() < deadline);
    expect(current.iterations).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(await fs.readFile(resultFile, "utf8")).iterations).toBe(0);
    await run("stop_background_task", { name: "fast" });
    const stopped = JSON.parse(await fs.readFile(resultFile, "utf8"));
    expect(stopped.status).toBe("stopped");
    expect(stopped.iterations).toBeGreaterThanOrEqual(3);
  } finally {
    await run("stop_all_background_tasks");
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE; else process.env.C64_TASK_STATE_FILE = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
