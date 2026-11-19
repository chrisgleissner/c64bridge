import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs/promises";
import path from "node:path";
import { metaModule } from "../../src/tools/meta/index.js";
import { createLogger, tmpPath, waitForTaskCompletion } from "./helpers.mjs";

async function withState(name, fn) {
  const { file, dir } = tmpPath(name, "tasks.json");
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const previous = process.env.C64_TASK_STATE_FILE;
  process.env.C64_TASK_STATE_FILE = file;
  try {
    return await fn({ file, dir });
  } finally {
    await metaModule.invoke("stop_all_background_tasks", {}, { client: {}, logger: createLogger() });
    if (previous === undefined) delete process.env.C64_TASK_STATE_FILE;
    else process.env.C64_TASK_STATE_FILE = previous;
  }
}

const readClient = () => ({ readMemory: async () => ({ success: true, data: "$00" }) });

test("HARD06 META-1 an interval above one day is rejected instead of becoming a 1 ms timer", async () => {
  await withState("h6bg1", async () => {
    const ctx = { client: readClient(), logger: createLogger() };
    const res = await metaModule.invoke("start_background_task", { name: "big", operation: "read", intervalMs: 3_000_000_000 }, ctx);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /intervalMs/);
  });
});

test("HARD06 META-20 a bad read or write argument fails the start", async () => {
  await withState("h6bg2", async () => {
    const ctx = { client: readClient(), logger: createLogger() };
    for (const args of [
      { operation: "read", arguments: { address: "zzz" } },
      { operation: "read", arguments: { address: "$FFF0", length: 64 } },
      { operation: "read", arguments: { address: "$0400", length: "lots" } },
      { operation: "write", arguments: { address: "$0400", bytes: "$A" } },
    ]) {
      const res = await metaModule.invoke("start_background_task", { name: "bad", intervalMs: 100, ...args }, ctx);
      assert.equal(res.isError, true, JSON.stringify(args));
      assert.equal(res.metadata?.error?.kind, "validation");
    }
    const list = await metaModule.invoke("list_background_tasks", {}, ctx);
    assert.equal(list.structuredContent.data.tasks.length, 0);
  });
});

test("HARD06 META-4 a running task left by an earlier process with the same PID can be stopped and restarted", async () => {
  await withState("h6bg3", async ({ file }) => {
    const now = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify({ tasks: [{
      ownerPid: process.pid, ownerSession: "previous-session", id: "previous-session_1_poll", name: "poll", type: "background",
      operation: "read", args: {}, intervalMs: 1000, iterations: 5, status: "running", startedAt: now, updatedAt: now,
      stoppedAt: null, lastError: null, lastResult: null, nextRunAt: null, folder: "tasks/background/previous-session_1_poll", backendId: null,
    }] }));
    const ctx = { client: readClient(), logger: createLogger() };
    const list = await metaModule.invoke("list_background_tasks", {}, ctx);
    assert.equal(list.structuredContent.data.tasks.find((t) => t.name === "poll").status, "stopped");
    const started = await metaModule.invoke("start_background_task", { name: "poll", operation: "read", intervalMs: 1000 }, ctx);
    assert.equal(started.isError, undefined, JSON.stringify(started.content));
  });
});

test("HARD06 META-5 a failing task whose folder vanished does not raise an unhandled rejection", async () => {
  await withState("h6bg4", async ({ dir }) => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const ctx = { client: { readMemory: async () => ({ success: false, details: { message: "boom" } }) }, logger: createLogger() };
      const started = await metaModule.invoke("start_background_task", { name: "vanish", operation: "read", intervalMs: 100 }, ctx);
      assert.equal(started.isError, undefined);
      await fs.rm(path.join(dir, "tasks"), { recursive: true, force: true });
      const done = await waitForTaskCompletion(metaModule, "vanish", ctx);
      assert.equal(done.status, "error");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(rejections, []);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

test("HARD06 META-14 a read_screen task reads the screen where $D018 and $DD00 place it", async () => {
  await withState("h6bg5", async () => {
    const reads = [];
    const facade = { type: "c64u" };
    const client = {
      pinFacade: async () => facade,
      getActiveBackendType: async () => "c64u",
      // $D018 = $20 puts the screen at $0800 (bank 0, $DD00 = $03); screen RAM holds "A" (screen code 1) at its first cell.
      readMemoryRaw: async (address, length, pinned) => {
        assert.equal(pinned, facade);
        reads.push([address, length]);
        if (address === 0xd018) return Uint8Array.of(0x20);
        if (address === 0xdd00) return Uint8Array.of(0x03);
        const bytes = new Uint8Array(length).fill(0x20);
        if (address === 0x0800) bytes[0] = 0x01;
        return bytes;
      },
    };
    const ctx = { client, logger: createLogger() };
    const started = await metaModule.invoke("start_background_task", { name: "scr", operation: "read_screen", intervalMs: 100, maxIterations: 1 }, ctx);
    assert.equal(started.isError, undefined, JSON.stringify(started.content));
    const done = await waitForTaskCompletion(metaModule, "scr", ctx);
    assert.equal(done.status, "completed", JSON.stringify(done));
    assert.equal(done.lastResult, "A");
    assert.ok(reads.some(([address]) => address === 0x0800));
  });
});

test("HARD06 META-18 a stored task result is capped at 1024 characters", async () => {
  await withState("h6bg6", async () => {
    const client = { readMemory: async () => ({ success: true, data: "$" + "AB".repeat(2000) }) };
    const ctx = { client, logger: createLogger() };
    await metaModule.invoke("start_background_task", { name: "big", operation: "read", intervalMs: 100, maxIterations: 1 }, ctx);
    const done = await waitForTaskCompletion(metaModule, "big", ctx);
    assert.equal(done.status, "completed");
    assert.equal(done.lastResult.truncated, true);
    assert.equal(done.lastResult.preview.length, 1024);
  });
});
