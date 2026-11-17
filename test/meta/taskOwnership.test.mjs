import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { withTaskStateLock } from "../../src/taskStateLock.ts";

async function worker(file) {
  const directory = await fs.mkdtemp(path.join(path.dirname(file), "worker-"));
  const child = spawn(process.execPath, [path.resolve("test/fixtures/task-owner.mjs"), directory], { env: { ...process.env, C64_TASK_STATE_FILE: file }, stdio: ["ignore", "ignore", "pipe"] });
  let errors = "", next = 0;
  child.stderr.on("data", (chunk) => { errors += chunk; });
  return { child, async request(tool, args = {}) {
    const index = next++;
    const input = path.join(directory, `input-${index}.json`);
    await fs.writeFile(input + ".tmp", JSON.stringify({ tool, args }));
    await fs.rename(input + ".tmp", input);
    const deadline = Date.now() + 5000;
    for (;;) {
      try { return JSON.parse(await fs.readFile(path.join(directory, `output-${index}.json`), "utf8")); }
      catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      if (Date.now() > deadline) throw new Error(`worker response timeout: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } };
}

test("HARD03-015 two live processes preserve each other's running tasks and ownership", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hard03-owners-"));
  const file = path.join(root, "tasks.json");
  const a = await worker(file), b = await worker(file);
  try {
    await Promise.all([a.request("list_background_tasks"), b.request("list_background_tasks")]);
    const [first, second] = await Promise.all([a.request("start_background_task", { name: "alpha", operation: "read", intervalMs: 100 }), b.request("start_background_task", { name: "beta", operation: "read", intervalMs: 100 })]);
    expect(first.metadata.success).toBe(true);
    expect(second.metadata.success).toBe(true);
    const listed = await b.request("list_background_tasks");
    expect(listed.structuredContent.data.tasks.filter((task) => task.status === "running").length).toBe(2);
    expect((await b.request("stop_background_task", { name: "alpha" })).isError).toBe(true);
    expect((await b.request("start_background_task", { name: "alpha", operation: "read" })).isError).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1200)); // both processes persist an iteration
    const disk = JSON.parse(await fs.readFile(file, "utf8")).tasks;
    expect(disk.length).toBe(2);
    expect(new Set(disk.map((task) => task.ownerPid)).size).toBe(2);
    expect(new Set(disk.map((task) => task.ownerSession)).size).toBe(2);
    expect(new Set(disk.map((task) => task.folder)).size).toBe(2);
    expect(disk.every((task) => task.status === "running" && task.iterations > 0)).toBe(true);
    const stopped = await b.request("stop_all_background_tasks");
    expect(stopped.structuredContent.data.count).toBe(1);
    const afterStop = (await a.request("list_background_tasks")).structuredContent.data.tasks;
    expect(afterStop.find((task) => task.name === "alpha").status).toBe("running");
    expect(afterStop.find((task) => task.name === "beta").status).toBe("stopped");
    expect((await b.request("delete_background_task", { name: "beta" })).metadata.success).toBe(true);
    expect((await a.request("list_background_tasks")).structuredContent.data.tasks.some((task) => task.name === "beta")).toBe(false);
    expect((await b.request("start_background_task", { name: "beta", operation: "read", intervalMs: 100 })).metadata.success).toBe(true);
    a.child.kill("SIGKILL");
    await new Promise((resolve) => a.child.once("exit", resolve));
    const recovered = (await b.request("list_background_tasks")).structuredContent.data.tasks;
    expect(recovered.find((task) => task.name === "alpha").status).toBe("stopped");
    expect(recovered.find((task) => task.name === "beta").status).toBe("running");
  } finally {
    a.child.kill("SIGKILL"); b.child.kill("SIGKILL");
    await Promise.all([a.child, b.child].map((child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve))));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 10000);

test("HARD03-015 crashed-owner lock is reclaimed and operation failures release locks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hard03-lock-"));
  const file = path.join(root, "tasks.json");
  try {
    await fs.mkdir(file + ".lock");
    await fs.writeFile(file + ".lock/owner.json", JSON.stringify({ pid: 2147483647, token: "dead" }));
    await fs.mkdir(file + ".lock.recovery"); // a crash in an older recovery path must not block new writers
    await fs.writeFile(file + ".lock/2147483647_dead-beef.json", JSON.stringify({ choosing: true, ticket: 0 }));
    let active = 0, maximum = 0;
    await Promise.all(Array.from({ length: 12 }, () => withTaskStateLock(file, async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
    })));
    expect(maximum).toBe(1);
    expect(await withTaskStateLock(file, async () => 42)).toBe(42);
    await expect(withTaskStateLock(file, async () => { throw new Error("expected"); })).rejects.toThrow("expected");
    expect(await withTaskStateLock(file, async () => 43)).toBe(43);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
