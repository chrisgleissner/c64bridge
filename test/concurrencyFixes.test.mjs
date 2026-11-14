import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "#test/runner";
import assert from "#test/assert";
import { C64Client } from "../src/c64Client.js";
import { tools as backgroundTools, stopAllBackgroundTasks } from "../src/tools/meta/background.js";

const backgroundTool = (name) => backgroundTools.find((tool) => tool.name === name);
const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

test("a resume is sent after one transport failure inside an owned pause", async (t) => {
  const seen = [];
  let dropReads = true;
  let paused = false;
  const server = http.createServer((req, res) => {
    const route = (req.url ?? "").split("?")[0];
    seen.push(`${req.method} ${route}`);
    if (route === "/v1/machine:readmem" && dropReads) {
      req.socket.destroy();
      return;
    }
    if (route === "/v1/machine:pause") paused = true;
    if (route === "/v1/machine:resume") paused = false;
    if (route === "/v1/machine:readmem") {
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.alloc(16));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ errors: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const client = new C64Client(`http://127.0.0.1:${server.address().port}`);
  const facade = await client.pinFacade();

  assert.equal((await client.acquirePause(facade)).success, true);
  assert.equal((await client.readMemory("$0400", "16", facade)).success, false);
  const released = await client.releasePause(facade);

  assert.equal(released.success, true, JSON.stringify(released));
  assert.ok(seen.includes("PUT /v1/machine:resume"), `requests: ${seen.join(", ")}`);
  assert.equal(paused, false);
});

test("a failed resume keeps the pause visible as explicit and carries a warning", async () => {
  const client = new C64Client("http://127.0.0.1:9");
  const calls = [];
  const facade = {
    pause: async () => { calls.push("pause"); return { success: true }; },
    resume: async () => { calls.push("resume"); return { success: false, details: { message: "unreachable" } }; },
  };
  assert.equal((await client.acquirePause(facade)).success, true);
  const released = await client.releasePause(facade);
  assert.equal(released.success, false);
  assert.ok(released.details.warning, "a warning is surfaced");
  // The CPU may still be paused, so a later owned pause must not assume a running machine.
  assert.equal((await client.acquirePause(facade)).success, true);
  assert.deepEqual(calls, ["pause", "resume"]);
});

test("c64_system pause waits for a pending owned pause and does not record an explicit pause when it fails", async () => {
  const client = new C64Client("http://127.0.0.1:9");
  const calls = [];
  let rejectFirst;
  const facade = {
    pause: () => {
      calls.push("pause");
      if (calls.length === 1) return new Promise((resolve) => { rejectFirst = resolve; });
      return Promise.resolve({ success: true });
    },
    resume: async () => ({ success: true }),
  };
  const acquireA = client.acquirePause(facade);
  const explicit = client.explicitPause(facade);
  rejectFirst({ success: false, details: { message: "down" } });
  assert.equal((await acquireA).success, false);
  const result = await explicit;
  // The explicit pause fell through to a real device pause instead of reporting "alreadyPaused".
  assert.equal(result.details?.alreadyPaused, undefined);
  assert.deepEqual(calls, ["pause", "pause"]);
  assert.equal((await client.acquirePause(facade)).success, true);
});

test("c64_system pause pauses the device itself when the owning call released while it waited", async () => {
  const client = new C64Client("http://127.0.0.1:9");
  const calls = [];
  let finishFirst;
  const facade = {
    pause: () => {
      calls.push("pause");
      if (calls.length === 1) return new Promise((resolve) => { finishFirst = resolve; });
      return Promise.resolve({ success: true });
    },
    resume: async () => { calls.push("resume"); return { success: true }; },
  };
  const acquireA = client.acquirePause(facade);
  const explicit = client.explicitPause(facade);
  const releaseA = client.releasePause(facade); // the owner finishes before its pause response arrives
  finishFirst({ success: true });
  await acquireA;
  await releaseA;
  const result = await explicit;
  assert.equal(result.success, true);
  assert.equal(result.details?.alreadyPaused, undefined);
  // The owner's resume ran, so the explicit pause had to send a pause of its own afterwards.
  assert.deepEqual(calls, ["pause", "resume", "pause"]);
});

test("a failed background task start undoes its reservation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-bgstart-"));
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = path.join(dir, "tasks.json");
  fs.writeFileSync(path.join(dir, "tasks"), "not a directory"); // mkdir of tasks/background/<id> fails
  try {
    const ctx = { client: { pinFacade: async () => ({ type: "vice" }), readMemory: async () => ({ success: true, data: "$00" }) }, logger: quietLogger };
    const start = backgroundTool("start_background_task");
    const first = await start.execute({ name: "bg-fail", operation: "read", intervalMs: 100 }, ctx);
    const second = await start.execute({ name: "bg-fail", operation: "read", intervalMs: 100 }, ctx);
    const text = (r) => JSON.stringify(r.content);
    assert.ok(first.isError, text(first));
    assert.ok(!/already running/.test(text(second)), `second start must reach the same file error: ${text(second)}`);
    const listed = await backgroundTool("list_background_tasks").execute({}, ctx);
    const tasks = listed.structuredContent?.data?.tasks ?? [];
    assert.equal(tasks.filter((task) => task.name === "bg-fail").length, 0);
  } finally {
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("a stopped task's in-flight iteration does not overwrite a restarted task's task.json", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-bgrestart-"));
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = path.join(dir, "tasks.json");
  const realAppend = fs.promises.appendFile;
  const realRename = fs.promises.rename;
  let reached;
  const reachedPromise = new Promise((resolve) => { reached = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const taskJsonWrites = [];
  // Hold the first iteration after its status check, inside the log append.
  fs.promises.appendFile = async (file, data, ...rest) => {
    if (String(data).includes("iteration=1")) { reached(); await gate; }
    return realAppend(file, data, ...rest);
  };
  fs.promises.rename = async (from, to) => {
    if (String(to).endsWith("task.json")) taskJsonWrites.push(JSON.parse(fs.readFileSync(from, "utf8")).intervalMs);
    return realRename(from, to);
  };
  try {
    const ctx = { client: { pinFacade: async () => ({ type: "vice" }), readMemory: async () => ({ success: true, data: "$00" }) }, logger: quietLogger };
    const start = backgroundTool("start_background_task");
    assert.ok(!(await start.execute({ name: "bg-restart", operation: "read", intervalMs: 100 }, ctx)).isError);
    await reachedPromise;
    await backgroundTool("stop_background_task").execute({ name: "bg-restart" }, ctx);
    assert.ok(!(await start.execute({ name: "bg-restart", operation: "read", intervalMs: 5000 }, ctx)).isError);
    release();
    await stopAllBackgroundTasks(); // queued behind the stale iteration's persist
    const lastNew = taskJsonWrites.lastIndexOf(5000);
    assert.ok(lastNew >= 0);
    const firstNew = taskJsonWrites.indexOf(5000);
    assert.ok(!taskJsonWrites.slice(firstNew).includes(100), `stale task.json write after restart: ${taskJsonWrites.join(",")}`);
  } finally {
    fs.promises.appendFile = realAppend;
    fs.promises.rename = realRename;
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});

test("an owned pause acquired while the post-reset resume is pending still sends machine:pause", async (t) => {
  const seen = [];
  let resumeResponse;
  const resumeSeen = new Promise((resolve) => { resumeResponse = { resolve }; });
  let releaseResume;
  const server = http.createServer((req, res) => {
    const route = (req.url ?? "").split("?")[0];
    seen.push(route);
    res.setHeader("content-type", "application/json");
    if (route === "/v1/machine:resume" && !releaseResume) {
      // Hold the first resume (the one that follows the reset) until the test releases it.
      releaseResume = () => res.end(JSON.stringify({ errors: [] }));
      resumeResponse.resolve();
      return;
    }
    res.end(JSON.stringify({ errors: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const client = new C64Client(`http://127.0.0.1:${server.address().port}`);
  const facade = await client.pinFacade();

  assert.equal((await client.explicitPause(facade)).success, true);
  const reset = client.reset();
  await resumeSeen;
  const acquiring = client.acquirePause(facade);
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseResume();
  assert.equal((await reset).success, true);
  assert.equal((await acquiring).success, true);

  const pauses = seen.filter((route) => route === "/v1/machine:pause").length;
  assert.equal(pauses, 2, `explicit pause plus the owned pause expected; requests: ${seen.join(", ")}`);
  assert.equal(seen.lastIndexOf("/v1/machine:pause") > seen.indexOf("/v1/machine:resume"), true, "owned pause must follow the resume");
  assert.equal((await client.releasePause(facade)).success, true);
  assert.equal(seen[seen.length - 1], "/v1/machine:resume");
});

test("a background task start that is stopped and replaced while pinning does not overwrite the new task's files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-bgsuper-"));
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = path.join(dir, "tasks.json");
  try {
    let releasePin;
    const pinGate = new Promise((resolve) => { releasePin = resolve; });
    let pins = 0;
    const slowCtx = { client: { pinFacade: async () => { pins += 1; if (pins === 1) await pinGate; return { type: "vice" }; }, readMemory: async () => ({ success: true, data: "$00" }) }, logger: quietLogger };
    const start = backgroundTool("start_background_task");
    const startA = start.execute({ name: "bg-super", operation: "read", intervalMs: 100 }, slowCtx);
    await new Promise((resolve) => setTimeout(resolve, 20)); // A is now suspended in pinFacade
    await backgroundTool("stop_background_task").execute({ name: "bg-super" }, slowCtx);
    const startB = await start.execute({ name: "bg-super", operation: "read", intervalMs: 5000 }, slowCtx);
    assert.ok(!startB.isError, JSON.stringify(startB.content));
    releasePin();
    await startA;
    const registry = JSON.parse(fs.readFileSync(path.join(dir, "tasks.json"), "utf8"));
    const entry = (registry.tasks ?? registry).find?.((t) => t.name === "bg-super") ?? registry.tasks?.["bg-super"] ?? registry["bg-super"];
    const id = entry.id;
    const taskJson = JSON.parse(fs.readFileSync(path.join(dir, "tasks", "background", id, "task.json"), "utf8"));
    assert.equal(taskJson.intervalMs, 5000, `task.json was overwritten by the superseded start A: ${JSON.stringify(taskJson)}`);
    assert.equal(taskJson.status, "running");
    assert.equal(entry.status, "running");
  } finally {
    await stopAllBackgroundTasks();
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
});
