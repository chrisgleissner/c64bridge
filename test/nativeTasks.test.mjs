// Native Tasks extension over real JSON-RPC (stdio and stateless HTTP) against the mock C64.
// The server runs with C64BRIDGE_TASK_INLINE_MS=0 unless a test needs the inline window, so a long call
// returns its task handle at once; every wait is a bounded poll on a condition.
import test from "#test/runner";
import assert from "#test/assert";
import { connect, resultData, startServer, waitFor, TASKS_EXT } from "./helpers/modernClient.mjs";

const TRANSPORTS = ["stdio", "http"];
const MEMORY_C000 = 0xc000;
const unmet = (timeoutMs, extra = {}) => ({ op: "wait_until", condition: { type: "equals", address: "$C000", bytes: "FF" }, timeoutMs, pollIntervalMs: 50, ...extra });
const STATUS = new Set(["working", "completed", "failed", "cancelled"]);

async function tasksClient(server) {
  return connect(server, { extensions: { [TASKS_EXT]: {} } });
}

async function startTask(client, args, tool = "c64_memory", params = {}) {
  const reply = await client.callTool(tool, args, params);
  assert.ok(reply.result, `tools/call failed: ${JSON.stringify(reply)}`);
  assert.equal(reply.result.resultType, "task", JSON.stringify(reply.result));
  return reply.result;
}

const getTask = async (client, taskId) => (await client.ok("tasks/get", { taskId }));

async function untilStatus(client, taskId, wanted) {
  return waitFor(async () => {
    const task = await getTask(client, taskId);
    return task.status === wanted ? task : false;
  }, { label: `task ${wanted}` });
}

for (const transport of TRANSPORTS) {
  test(`[${transport}] a delayed allowlisted call returns a task handle, tasks/get reports working then completed with the result`, async (t) => {
    const server = await startServer(t, { transport, env: { C64BRIDGE_TASK_INLINE_MS: "0" } });
    const client = await tasksClient(server);
    const handle = await startTask(client, unmet(60_000));
    assert.equal(handle.status, "working");
    assert.equal(handle.ttlMs, null);
    assert.equal(typeof handle.taskId, "string");
    assert.ok(handle.taskId.length >= 32, "task ids are unguessable");
    assert.ok(!Number.isNaN(Date.parse(handle.createdAt)) && !Number.isNaN(Date.parse(handle.lastUpdatedAt)));
    assert.equal(typeof handle.pollIntervalMs, "number");

    const working = await getTask(client, handle.taskId);
    assert.equal(working.resultType, "complete");
    assert.equal(working.status, "working");
    assert.equal(working.taskId, handle.taskId);
    assert.equal("result" in working, false);
    // The task keeps polling the mock until the condition holds.
    server.mock.state.memory[MEMORY_C000] = 0xff;
    const done = await untilStatus(client, handle.taskId, "completed");
    assert.ok(STATUS.has(done.status));
    assert.equal(resultData(done.result).met, true);
    assert.equal(resultData(done.result).reason, "condition_met");
    assert.equal(typeof done.ttlMs, "number");
    assert.ok(done.ttlMs > 0);
    // The embedded result is stable: asking again returns it again.
    assert.deepEqual(resultData((await getTask(client, handle.taskId)).result), resultData(done.result));
  });

  test(`[${transport}] wait_for_text runs as a task and completes when the text appears`, async (t) => {
    const server = await startServer(t, { transport, env: { C64BRIDGE_TASK_INLINE_MS: "0" } });
    const client = await tasksClient(server);
    const handle = await startTask(client, { op: "wait_for_text", pattern: "HELLO", timeoutMs: 60_000 });
    assert.equal((await getTask(client, handle.taskId)).status, "working");
    server.mock.state.memory.set([8, 5, 12, 12, 15], 0x0400 + 40 * 5);
    const done = await untilStatus(client, handle.taskId, "completed");
    assert.equal(resultData(done.result).matched, true);
  });

  test(`[${transport}] cancel stops a running task, a repeated cancel is acknowledged, and a cancel after completion changes nothing`, async (t) => {
    const server = await startServer(t, { transport, env: { C64BRIDGE_TASK_INLINE_MS: "0" } });
    const client = await tasksClient(server);
    const running = await startTask(client, unmet(120_000));
    const ack = await client.ok("tasks/cancel", { taskId: running.taskId });
    assert.equal(ack.resultType, "complete");
    const cancelled = await untilStatus(client, running.taskId, "cancelled");
    assert.equal("result" in cancelled, false);
    const again = await client.ok("tasks/cancel", { taskId: running.taskId });
    assert.equal(again.resultType, "complete");
    assert.equal((await getTask(client, running.taskId)).status, "cancelled");

    const quick = await startTask(client, unmet(200));
    const finished = await untilStatus(client, quick.taskId, "completed");
    assert.equal(resultData(finished.result).reason, "timeout");
    await client.ok("tasks/cancel", { taskId: quick.taskId });
    assert.equal((await getTask(client, quick.taskId)).status, "completed", "a late cancel does not overwrite a completed task");
  });

  test(`[${transport}] cancel racing completion ends in exactly one terminal state that stays stable`, async (t) => {
    const server = await startServer(t, { transport, env: { C64BRIDGE_TASK_INLINE_MS: "0" } });
    const client = await tasksClient(server);
    const handle = await startTask(client, unmet(60_000));
    server.mock.state.memory[MEMORY_C000] = 0xff;
    const cancel = await client.request("tasks/cancel", { taskId: handle.taskId });
    assert.ok(cancel.result, JSON.stringify(cancel));
    const terminal = await waitFor(async () => {
      const task = await getTask(client, handle.taskId);
      return task.status === "working" ? false : task;
    }, { label: "terminal state" });
    assert.ok(terminal.status === "cancelled" || terminal.status === "completed", terminal.status);
    for (let i = 0; i < 3; i += 1) {
      const again = await getTask(client, handle.taskId);
      assert.equal(again.status, terminal.status);
    }
  });

  test(`[${transport}] unknown task ids are invalid params for get, update and cancel`, async (t) => {
    const server = await startServer(t, { transport, env: { C64BRIDGE_TASK_INLINE_MS: "0" } });
    const client = await tasksClient(server);
    for (const [method, params] of [["tasks/get", {}], ["tasks/update", { inputResponses: {} }], ["tasks/cancel", {}]]) {
      const reply = await client.request(method, { taskId: "00000000-0000-4000-8000-000000000000", ...params });
      assert.equal(reply.error?.code, -32602, `${method}: ${JSON.stringify(reply)}`);
    }
  });

  test(`[${transport}] tasks/update acknowledges a known task`, async (t) => {
    const server = await startServer(t, { transport, env: { C64BRIDGE_TASK_INLINE_MS: "0" } });
    const client = await tasksClient(server);
    const handle = await startTask(client, unmet(120_000));
    const ack = await client.ok("tasks/update", { taskId: handle.taskId, inputResponses: {} });
    assert.equal(ack.resultType, "complete");
    await client.ok("tasks/cancel", { taskId: handle.taskId });
  });

  test(`[${transport}] a call that finishes inside the inline window returns the ordinary result; a validation error is the ordinary error result`, async (t) => {
    const server = await startServer(t, { transport, env: { C64BRIDGE_TASK_INLINE_MS: "10000" } });
    server.mock.state.memory[MEMORY_C000] = 0xff;
    const client = await tasksClient(server);
    const fast = await client.callTool("c64_memory", unmet(5_000));
    assert.ok(fast.result, JSON.stringify(fast));
    assert.notEqual(fast.result.resultType, "task");
    assert.equal(resultData(fast.result).met, true);
    const invalid = await client.callTool("c64_memory", { op: "wait_until", condition: { type: "equals", address: "$C000", bytes: "FF" }, timeoutMs: 0 });
    assert.ok(invalid.result, JSON.stringify(invalid));
    assert.notEqual(invalid.result.resultType, "task");
    assert.equal(invalid.result.isError, true);
    assert.equal(resultData(invalid.result).error.kind, "validation");
  });

  test(`[${transport}] access mode and argument validation apply to a native call as to a direct call`, async (t) => {
    const server = await startServer(t, { transport, env: { C64BRIDGE_TASK_INLINE_MS: "0", C64BRIDGE_ACCESS: "read-only" } });
    const client = await tasksClient(server);
    // batch_run has effect "write": denied before any task exists, even though the client could take a task.
    const denied = await client.callTool("c64_program", { op: "batch_run", programs: [{ path: "/x.crt" }], durationMs: 1000 });
    assert.equal(denied.result?.isError, true, JSON.stringify(denied));
    assert.notEqual(denied.result.resultType, "task");
    assert.match(denied.result.content[0].text, /read-only/);
    // A read operation is still allowed and becomes a task.
    const handle = await startTask(client, unmet(60_000));
    await client.ok("tasks/cancel", { taskId: handle.taskId });
  });
}

test("[http] task state is shared between separate stateless requests, and the bearer token guards tasks/*", async (t) => {
  const token = "native-task-token";
  const server = await startServer(t, { transport: "http", env: { C64BRIDGE_TASK_INLINE_MS: "0", C64BRIDGE_HTTP_TOKEN: token } });
  const first = await tasksClient(server);
  const handle = await startTask(first, unmet(120_000));
  const second = await tasksClient(server);
  assert.equal((await getTask(second, handle.taskId)).status, "working", "a different request sees the same task");

  const post = (headers) => fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tasks/get", "mcp-name": handle.taskId, ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tasks/get",
      params: { taskId: handle.taskId, _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "no-token", version: "0" },
        "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXT]: {} } },
      } },
    }),
  });
  const missing = await post({});
  assert.equal(missing.status, 401);
  assert.ok(!(await missing.text()).includes(handle.taskId), "the rejection does not reveal the task");
  const wrong = await post({ authorization: "Bearer wrong-token" });
  assert.equal(wrong.status, 401);
  const allowed = await post({ authorization: `Bearer ${token}` });
  assert.equal(allowed.status, 200);
  await first.ok("tasks/cancel", { taskId: handle.taskId });
});

test("[stdio] cancelling the request after the handover does not stop the task, and progress stops at the handover", async (t) => {
  const server = await startServer(t, { env: { C64BRIDGE_TASK_INLINE_MS: "0" } });
  const client = await tasksClient(server);
  const progressToken = "native-progress";
  const handle = await startTask(client, unmet(120_000), "c64_memory", { _meta: { progressToken } });
  const progressAtHandover = () => client.channel.notifications.filter((n) => n.method === "notifications/progress" && n.params?.progressToken === progressToken).length;
  const before = progressAtHandover();
  // The request id of the tools/call is the first id used by this client.
  client.channel.notify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "client gave up" } });
  // The task keeps iterating (its status message advances), which proves it runs on without the request.
  const advanced = await waitFor(async () => {
    const task = await getTask(client, handle.taskId);
    return task.status === "working" && /iteration ([3-9]|\d\d+)/.test(task.statusMessage ?? "") ? task : false;
  }, { label: "task still iterating after request cancellation" });
  assert.equal(advanced.status, "working");
  assert.equal(progressAtHandover(), before, "no progress notification for the finished request after the handover");
  server.mock.state.memory[MEMORY_C000] = 0xff;
  const done = await untilStatus(client, handle.taskId, "completed");
  assert.equal(resultData(done.result).met, true);
});

test("a finished task expires after its ttl: tasks/get then answers invalid params", async (t) => {
  const server = await startServer(t, { env: { C64BRIDGE_TASK_INLINE_MS: "0", C64BRIDGE_TASK_TTL_MS: "400" } });
  const client = await tasksClient(server);
  const handle = await startTask(client, unmet(100));
  const done = await untilStatus(client, handle.taskId, "completed");
  assert.ok(done.ttlMs >= 400, `ttlMs counts from createdAt: ${done.ttlMs}`);
  await waitFor(async () => (await client.request("tasks/get", { taskId: handle.taskId })).error?.code === -32602, { label: "task expiry" });
  const cancel = await client.request("tasks/cancel", { taskId: handle.taskId });
  assert.equal(cancel.error?.code, -32602);
});
