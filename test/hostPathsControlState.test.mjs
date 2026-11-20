import test from "#test/runner";
import assert from "#test/assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHostPath } from "../src/hostPaths.js";
import { ToolValidationError } from "../src/tools/errors.js";
import { toolRegistry } from "../src/tools/registry/index.js";

function createLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

async function withControlStateFixture(fn) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "c64bridge-control-")));
  const state = path.join(base, "state");
  const cwd = path.join(base, "cwd");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const keys = ["C64BRIDGE_STATE_DIR", "C64_TASK_STATE_FILE", "C64BRIDGE_ALLOWED_DIRS", "C64BRIDGE_ALLOW_HIDDEN_PATHS", "C64BRIDGE_DIAGNOSTICS_DIR"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const savedCwd = process.cwd();
  process.env.C64BRIDGE_STATE_DIR = state;
  for (const key of keys.slice(1)) delete process.env[key];
  process.chdir(cwd);
  try {
    return await fn({ base, state, cwd });
  } finally {
    process.chdir(savedCwd);
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function assertControlStateRejected(input) {
  for (const purpose of ["read", "write"]) {
    assert.throws(
      () => resolveHostPath(input, { purpose }),
      (error) => error instanceof ToolValidationError && /server configuration or state/.test(error.message),
      `${input} (${purpose})`,
    );
  }
}

test("I15 resolveHostPath rejects the task state lock directory and its descendants, also through a symbolic link", async () => {
  await withControlStateFixture(async ({ state, cwd }) => {
    const lock = path.join(state, "tasks.json.lock");
    fs.mkdirSync(lock, { recursive: true });
    assertControlStateRejected(lock);
    assertControlStateRejected(path.join(lock, `${process.pid}_00000000-0000-4000-8000-000000000000.json`));
    fs.symlinkSync(lock, path.join(cwd, "claims"));
    assertControlStateRejected(path.join(cwd, "claims", `${process.pid}_x.json`));
    // A file next to the lock directory stays usable.
    assert.doesNotThrow(() => resolveHostPath(path.join(state, "tasks.json.lockfile.bin"), { purpose: "write" }));
  });
});

test("I15 save_memory cannot plant a task lock claim and reads no device memory", async () => {
  await withControlStateFixture(async ({ state }) => {
    const claim = path.join(state, "tasks.json.lock", `${process.pid}_00000000-0000-4000-8000-000000000000.json`);
    let reads = 0;
    const ctx = { client: { async readMemoryRaw() { reads += 1; return Uint8Array.from(Buffer.from('{"choosing":true,"ticket":0}')); } }, logger: createLogger() };
    const res = await toolRegistry.invoke("c64_memory", { op: "save_memory", startAddress: "$2000", endAddress: "$201B", filePath: claim, asPrg: false }, ctx);
    assert.equal(res.isError, true, JSON.stringify(res.content));
    assert.equal(reads, 0, "rejected before any device read");
    assert.equal(fs.existsSync(path.join(state, "tasks.json.lock")), false, "nothing was created");
  });
});

test("I16 resolveHostPath rejects background task folders, the find/run state and diagnostics files", async () => {
  await withControlStateFixture(async ({ state, base }) => {
    assertControlStateRejected(path.join(state, "tasks", "background", "0001_read", "result.json"));
    assertControlStateRejected(path.join(state, "tasks", "background", "0001_read", "task.json"));
    assertControlStateRejected(path.join(state, "meta", "find_and_run_program_by_name.json"));
    assertControlStateRejected(path.join(state, "diagnostics", "2026-11-19T10-00-00-000Z-1-runtime.ndjson"));
    // Explicit locations follow their overrides.
    process.env.C64_TASK_STATE_FILE = path.join(base, "elsewhere", "tasks.json");
    process.env.C64BRIDGE_DIAGNOSTICS_DIR = path.join(state, "diag");
    process.env.C64BRIDGE_ALLOWED_DIRS = base;
    assertControlStateRejected(path.join(base, "elsewhere", "tasks", "background", "x", "log"));
    assertControlStateRejected(path.join(base, "elsewhere", "meta", "find_and_run_program_by_name.json"));
    assertControlStateRejected(path.join(state, "diag", "session.ndjson"));
    // Generated run directories remain the default output location.
    assert.doesNotThrow(() => resolveHostPath(path.join(state, "runs", "batch_1", "results.json"), { purpose: "write" }));
  });
});

test("I16 save_memory cannot overwrite a background task result", async () => {
  await withControlStateFixture(async ({ state }) => {
    const result = path.join(state, "tasks", "background", "0001_read", "result.json");
    let reads = 0;
    const ctx = { client: { async readMemoryRaw() { reads += 1; return Uint8Array.of(0x7b, 0x7d); } }, logger: createLogger() };
    const res = await toolRegistry.invoke("c64_memory", { op: "save_memory", startAddress: "$2000", endAddress: "$2001", filePath: result, asPrg: false }, ctx);
    assert.equal(res.isError, true, JSON.stringify(res.content));
    assert.equal(reads, 0);
    assert.equal(fs.existsSync(path.join(state, "tasks")), false);
  });
});
