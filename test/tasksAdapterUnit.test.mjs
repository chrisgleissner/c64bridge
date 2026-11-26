// In-process tests of src/mcp/tasksAdapter.ts (the JSON-RPC tests in nativeTasks.test.mjs run the server in a
// child process, so they do not show up in coverage). Uses a stub client over a flat memory image.
import test from "#test/runner";
import assert from "#test/assert";
import {
  nativeTaskCandidate,
  requestDeclaresExtension,
  registerTaskHandlers,
  runNativeCall,
  TASKS_EXTENSION_ID,
  TASK_TTL_ENV,
} from "../src/mcp/tasksAdapter.js";
import { __resetForTests, cancelTask, getTask, MAX_WORKING_TASKS, submitCall } from "../src/tasks/engine.js";
import { lookupAllowlist } from "../src/tasks/allowlist.js";

const PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const platform = { id: "c64u", features: [], limitedFeatures: [] };
const modernEnvelope = { [PROTOCOL_KEY]: "2026-07-28", [CAPS_KEY]: { extensions: { [TASKS_EXTENSION_ID]: {} } } };
const modernCtx = { mcpReq: { envelope: modernEnvelope } };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stubClient(memory = new Uint8Array(0x10000)) {
  const facade = { type: "c64u" };
  return {
    async pinFacade() { return facade; },
    async getActiveBackendType() { return "c64u"; },
    getSelectedBackendType: () => "c64u",
    async readMemoryRaw(address, length) { return memory.slice(address, address + length); },
  };
}
const toolCtx = (client = stubClient()) => ({ client, rag: {}, logger, platform, setPlatform: () => platform });
const waitArgs = { op: "wait_until", condition: { type: "equals", address: "$C000", bytes: "FF" }, timeoutMs: 100, pollIntervalMs: 50 };

function candidate(args) {
  const found = nativeTaskCandidate(modernCtx, "c64_memory", args, "modern");
  assert.ok(found, "the call is a native task candidate");
  return found;
}

async function withEnv(name, value, body) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { await body(); } finally {
    if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
  }
}

function handlers() {
  const map = new Map();
  registerTaskHandlers({ setRequestHandler: (method, _schema, handler) => map.set(method, handler) }, "modern");
  return map;
}

test.afterEach(() => __resetForTests());

test("requestDeclaresExtension needs an envelope, the 2026 protocol version, and the extension object", () => {
  assert.equal(requestDeclaresExtension({ mcpReq: {} }, TASKS_EXTENSION_ID), false);
  assert.equal(requestDeclaresExtension({ mcpReq: { envelope: [] } }, TASKS_EXTENSION_ID), false);
  assert.equal(requestDeclaresExtension({ mcpReq: { envelope: { [CAPS_KEY]: modernEnvelope[CAPS_KEY] } } }, TASKS_EXTENSION_ID), false, "no protocol version");
  assert.equal(requestDeclaresExtension({ mcpReq: { envelope: { ...modernEnvelope, [PROTOCOL_KEY]: "2025-11-25" } } }, TASKS_EXTENSION_ID), false);
  assert.equal(requestDeclaresExtension({ mcpReq: { envelope: { [PROTOCOL_KEY]: "2026-07-28", [CAPS_KEY]: {} } } }, TASKS_EXTENSION_ID), false);
  assert.equal(requestDeclaresExtension({ mcpReq: { envelope: { [PROTOCOL_KEY]: "2026-07-28", [CAPS_KEY]: { extensions: { other: {} } } } } }, TASKS_EXTENSION_ID), false);
  assert.equal(requestDeclaresExtension(modernCtx, TASKS_EXTENSION_ID), true);
});

test("nativeTaskCandidate returns the allowlist entry and the arguments without op, and nothing for other calls", () => {
  const found = candidate(waitArgs);
  assert.equal(found.op, "wait_until");
  assert.equal(found.entry, lookupAllowlist("c64_memory.wait_until"));
  assert.equal("op" in found.rest, false);
  assert.equal(found.rest.timeoutMs, 100);
  assert.equal(nativeTaskCandidate(modernCtx, "c64_memory", waitArgs, "legacy"), undefined);
  assert.equal(nativeTaskCandidate(modernCtx, "c64_memory", waitArgs, undefined), undefined);
  assert.equal(nativeTaskCandidate({ mcpReq: {} }, "c64_memory", waitArgs, "modern"), undefined);
  assert.equal(nativeTaskCandidate(modernCtx, "c64_memory", "text", "modern"), undefined);
  assert.equal(nativeTaskCandidate(modernCtx, "c64_memory", { op: 3 }, "modern"), undefined);
  assert.equal(nativeTaskCandidate(modernCtx, "c64_memory", { op: "read" }, "modern"), undefined);
});

test("runNativeCall returns the ordinary result when the call finishes inside the inline window", async () => {
  const memory = new Uint8Array(0x10000);
  memory[0xc000] = 0xff;
  await withEnv("C64BRIDGE_TASK_INLINE_MS", "5000", async () => {
    const outcome = await runNativeCall(candidate(waitArgs), "c64_memory", toolCtx(stubClient(memory)), undefined);
    assert.equal(outcome.kind, "result");
    assert.equal(outcome.result.structuredContent.data.met, true);
  });
});

test("runNativeCall at the working-task limit runs the call directly and returns its ordinary result", async () => {
  const memory = new Uint8Array(0x10000);
  memory[0xc000] = 0xff;
  for (let i = 0; i < MAX_WORKING_TASKS; i += 1) {
    await submitCall({ tool: "c64_memory", op: "wait_for_text", ctx: toolCtx(), invoke: () => new Promise(() => {}) });
  }
  await withEnv("C64BRIDGE_TASK_INLINE_MS", "5000", async () => {
    const outcome = await runNativeCall(candidate(waitArgs), "c64_memory", toolCtx(stubClient(memory)), undefined);
    assert.equal(outcome.kind, "result");
    assert.equal(outcome.result.structuredContent.data.met, true);
    assert.equal(outcome.result.structuredContent.data.reason, "condition_met");
  });
});

test("runNativeCall rethrows errors other than the working-task limit, here a backend switch during submission", async () => {
  const client = { ...stubClient(), async pinFacade() { return { type: "vice" }; } };
  await withEnv("C64BRIDGE_TASK_INLINE_MS", "5000", async () => {
    await assert.rejects(
      runNativeCall(candidate(waitArgs), "c64_memory", toolCtx(client), undefined),
      { code: "resource_conflict" },
    );
  });
});

test("C64BRIDGE_TASK_TTL_MS sets the retention of a task; empty and invalid values use the engine default", async () => {
  const get = handlers().get("tasks/get");
  const ttlFor = async (value) => {
    let ttl;
    await withEnv(TASK_TTL_ENV, value, async () => {
      await withEnv("C64BRIDGE_TASK_INLINE_MS", "0", async () => {
        const outcome = await runNativeCall(candidate({ ...waitArgs, timeoutMs: 10 }), "c64_memory", toolCtx(), undefined);
        assert.equal(outcome.kind, "task");
        assert.equal(outcome.handle.resultType, "task");
        assert.equal(outcome.handle.status, "working");
        assert.equal(outcome.handle.ttlMs, null);
        const taskId = outcome.handle.taskId;
        for (let i = 0; i < 200 && getTask(taskId)?.state === "working"; i += 1) await delay(10);
        ttl = (await get({ taskId }, modernCtx)).ttlMs;
      });
    });
    return ttl;
  };
  const custom = await ttlFor("5000");
  assert.ok(custom >= 5000 && custom < 60_000, `custom ttl ${custom}`);
  for (const value of [undefined, "", "  ", "abc", "-1", "1.5", "86400001"]) {
    const ttl = await ttlFor(value);
    assert.ok(ttl >= 600_000, `default ttl for ${JSON.stringify(value)}: ${ttl}`);
  }
});

test("tasks/get reports a cancelled task without a result, and tasks/cancel and tasks/update acknowledge a known task", async () => {
  const map = handlers();
  const task = await submitCall({ tool: "c64_memory", op: "wait_for_text", ctx: toolCtx(), invoke: () => new Promise(() => {}) });
  const working = await map.get("tasks/get")({ taskId: task.id }, modernCtx);
  assert.equal(working.status, "working");
  assert.equal(working.ttlMs, null);
  assert.equal("result" in working, false);
  assert.deepEqual(await map.get("tasks/update")({ taskId: task.id }, modernCtx), { resultType: "complete" });
  assert.deepEqual(await map.get("tasks/cancel")({ taskId: task.id }, modernCtx), { resultType: "complete" });
  const cancelled = await map.get("tasks/get")({ taskId: task.id }, modernCtx);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.statusMessage, "Cancelled.");
  assert.equal("result" in cancelled, false);
  assert.equal("error" in cancelled, false);
  assert.equal(typeof cancelled.ttlMs, "number");
  cancelTask(task.id);
});

test("tasks/* handlers refuse a request that does not declare the extension and answer invalid params for an unknown task", async () => {
  const map = handlers();
  for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
    await assert.rejects(map.get(method)({ taskId: "x" }, { mcpReq: {} }), (error) => error?.constructor?.name === "MissingRequiredClientCapabilityError" || /capab/i.test(String(error?.message)));
    await assert.rejects(map.get(method)({ taskId: "missing" }, modernCtx), (error) => error?.code === -32602 && /Task not found/.test(error.message));
  }
});

test("tasks/get maps a thrown ToolError to a completed task whose result is the tool error result", async () => {
  const { ToolValidationError } = await import("../src/tools/errors.js");
  const task = await submitCall({ tool: "c64_memory", op: "wait_for_text", ctx: toolCtx(), invoke: async () => { throw new ToolValidationError("bad argument", { path: "$.x" }); } });
  await delay(20);
  const detail = await handlers().get("tasks/get")({ taskId: task.id }, modernCtx);
  assert.equal(detail.status, "completed");
  assert.equal(detail.result?.isError, true);
  assert.match(detail.result.content[0].text, /bad argument/);
});

test("tasks/get reports a numeric code and data of a thrown non-tool error, and the default code otherwise", async () => {
  const map = handlers();
  const fail = async (thrown) => {
    const task = await submitCall({ tool: "c64_memory", op: "wait_for_text", ctx: toolCtx(), invoke: async () => { throw thrown; } });
    await delay(20);
    return map.get("tasks/get")({ taskId: task.id }, modernCtx);
  };
  const withCode = await fail(Object.assign(new Error("coded"), { code: -32001, data: { why: "x" } }));
  assert.equal(withCode.status, "failed");
  assert.deepEqual(withCode.error, { code: -32001, message: "coded", data: { why: "x" } });
  const stringCode = await fail(Object.assign(new Error("text code"), { code: "ENOENT" }));
  assert.deepEqual(stringCode.error, { code: -32603, message: "text code" });
});
