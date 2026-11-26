import test from "#test/runner";
import assert from "#test/assert";
import { startServer, connect, resultText, TASKS_EXT, SKILLS_EXT, MODERN } from "./helpers/modernClient.mjs";

import { nativeTaskCandidate, registerTaskHandlers } from "../src/mcp/tasksAdapter.js";

const TRANSPORTS = ["stdio", "http"];
const INLINE_ENV = { C64BRIDGE_TASK_INLINE_MS: "0" };
const CLIENT_CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const TASK_NOT_DECLARED = -32021;
const INVALID_PARAMS = -32602;

const longCall = (client) => client.callTool("c64_memory", {
  op: "wait_until",
  condition: { type: "equals", address: "$C000", bytes: "FF" },
  timeoutMs: 400,
  pollIntervalMs: 50,
});

function assertTaskHandle(result) {
  assert.equal(result.resultType, "task", JSON.stringify(result));
  assert.equal(typeof result.taskId, "string", JSON.stringify(result));
  assert.equal(result.status, "working", JSON.stringify(result));
  assert.equal(result.ttlMs, null, JSON.stringify(result));
  assert.ok(result.createdAt !== undefined, `createdAt missing: ${JSON.stringify(result)}`);
  assert.ok(result.lastUpdatedAt !== undefined, `lastUpdatedAt missing: ${JSON.stringify(result)}`);
  assert.ok(result.pollIntervalMs !== undefined, `pollIntervalMs missing: ${JSON.stringify(result)}`);
}

function assertOrdinaryTimeout(result) {
  assert.notEqual(result.resultType, "task", JSON.stringify(result));
  assert.ok(result.resultType === undefined || result.resultType === "complete", JSON.stringify(result));
  assert.equal(result.taskId, undefined, JSON.stringify(result));
  assert.equal(result.content?.[0]?.type, "text", JSON.stringify(result));
  const payload = JSON.parse(resultText(result));
  assert.equal(payload.met, false, resultText(result));
  assert.equal(payload.reason, "timeout", resultText(result));
}

function assertNotATask(result) {
  assert.notEqual(result?.resultType, "task", `malformed metadata must not yield a task: ${JSON.stringify(result)}`);
}

function assertTaskErrorCode(reply, code, label) {
  assert.ok(reply.error, `${label}: expected a JSON-RPC error, got ${JSON.stringify(reply)}`);
  assert.equal(reply.error.code, code, `${label}: ${JSON.stringify(reply.error)}`);
}

function assertNotDeclaredError(reply, label) {
  assertTaskErrorCode(reply, TASK_NOT_DECLARED, label);
  assert.deepEqual(reply.error.data?.requiredCapabilities?.extensions?.[TASKS_EXT], {}, label);
}

// ---------------------------------------------------------------------------
// 1. Legacy (2025 initialize) client
// ---------------------------------------------------------------------------

for (const transport of TRANSPORTS) {
  test(`legacy client over ${transport}: no extensions advertised, no tasks, skills still readable`, async (t) => {
    const server = await startServer(t, { transport, env: INLINE_ENV });
    const client = await connect(server, { era: "legacy" });

    const caps = client.initializeResult.capabilities;
    assert.equal("extensions" in caps, false, `legacy capabilities must not carry extensions: ${JSON.stringify(caps)}`);
    assert.ok(caps.tools, "tools capability");
    assert.ok(caps.resources, "resources capability");
    assert.ok(caps.prompts, "prompts capability");

    const instructions = client.initializeResult.instructions ?? "";
    assert.ok(instructions.includes("start_task"), "instructions mention start_task");
    assert.ok(instructions.includes("wait_until"), "instructions mention wait_until");

    const call = await longCall(client);
    assert.ok(call.result, `long call failed: ${JSON.stringify(call)}`);
    assertOrdinaryTimeout(call.result);

    const get = await client.request("tasks/get", { taskId: "abc" });
    assertTaskErrorCode(get, TASK_NOT_DECLARED, "tasks/get on legacy");
    assert.deepEqual(get.error.data?.requiredCapabilities?.extensions?.[TASKS_EXT], {}, JSON.stringify(get.error));

    const read = await client.request("resources/read", { uri: "skill://hello-world/SKILL.md" });
    assert.ok(read.result, `resources/read failed: ${JSON.stringify(read)}`);
    assert.ok(read.result.contents?.[0]?.text?.length > 0, JSON.stringify(read.result).slice(0, 300));
  });
}

// ---------------------------------------------------------------------------
// 2. Modern client, declared-extension matrix
// ---------------------------------------------------------------------------

const DECLARATION_CASES = [
  { name: "none", extensions: {}, tasks: false },
  { name: "skills only", extensions: { [SKILLS_EXT]: {} }, tasks: false },
  { name: "tasks only", extensions: { [TASKS_EXT]: {} }, tasks: true },
  { name: "skills and tasks", extensions: { [SKILLS_EXT]: {}, [TASKS_EXT]: {} }, tasks: true },
  { name: "unknown extension", extensions: { "example.invalid/other": {} }, tasks: false },
];

for (const transport of TRANSPORTS) {
  for (const { name, extensions, tasks } of DECLARATION_CASES) {
    test(`modern client over ${transport}, extensions ${name}: task handles only with the tasks extension`, async (t) => {
      const server = await startServer(t, { transport, env: INLINE_ENV });
      const client = await connect(server, { era: "modern", extensions });

      const call = await longCall(client);
      assert.ok(call.result, `long call failed: ${JSON.stringify(call)}`);
      if (tasks) assertTaskHandle(call.result);
      else assertOrdinaryTimeout(call.result);

      for (const method of ["tasks/get", "tasks/cancel"]) {
        const reply = await client.request(method, { taskId: "abc" });
        if (tasks) assertTaskErrorCode(reply, INVALID_PARAMS, `${method} with tasks declared`);
        else assertNotDeclaredError(reply, `${method} without tasks declared`);
      }

      const update = await client.request("tasks/update", { taskId: "abc", inputResponses: {} });
      if (tasks) assertTaskErrorCode(update, INVALID_PARAMS, "tasks/update with tasks declared");
      else assertNotDeclaredError(update, "tasks/update without tasks declared");
    });
  }
}

// ---------------------------------------------------------------------------
// 3. server/discover advertises both extensions
// ---------------------------------------------------------------------------

for (const transport of TRANSPORTS) {
  test(`server/discover over ${transport}: advertises skills and tasks extensions`, async (t) => {
    const server = await startServer(t, { transport });
    const client = await connect(server, { era: "modern" });

    const discover = await client.request("server/discover", {});
    assert.ok(discover.result, `server/discover failed: ${JSON.stringify(discover)}`);
    assert.ok(discover.result.supportedVersions.includes(MODERN), JSON.stringify(discover.result.supportedVersions));

    const extensions = discover.result.capabilities.extensions ?? {};
    assert.deepEqual(extensions[SKILLS_EXT], {}, JSON.stringify(extensions));
    assert.deepEqual(extensions[TASKS_EXT], {}, JSON.stringify(extensions));

    const capabilities = discover.result.capabilities;
    assert.ok(capabilities.tools, "tools capability");
    assert.ok(capabilities.resources, "resources capability");
    assert.ok(capabilities.prompts, "prompts capability");
  });
}

// ---------------------------------------------------------------------------
// 4. Malformed capability metadata: never a task
// ---------------------------------------------------------------------------

const MALFORMED_CASES = [
  { name: "extensions is a string", params: { capabilities: { extensions: "yes" } }, invalidParams: true },
  { name: "tasks flag is not an object", params: { capabilities: { extensions: { [TASKS_EXT]: true } } }, invalidParams: true },
  { name: "capabilities is a string", params: { capabilities: "nope" }, invalidParams: true },
  {
    name: "client capabilities omitted",
    params: { extensions: { [TASKS_EXT]: {} }, omit: [CLIENT_CAPS_KEY] },
    invalidParams: true,
  },
  {
    name: "protocol version omitted",
    params: { extensions: { [TASKS_EXT]: {} }, omit: [PROTOCOL_VERSION_KEY] },
    invalidParams: false,
  },
];

for (const transport of TRANSPORTS) {
  for (const { name, params, invalidParams } of MALFORMED_CASES) {
    test(`malformed metadata over ${transport} (${name}): never a task, tasks/get is an error`, async (t) => {
      const server = await startServer(t, { transport, env: INLINE_ENV });
      const client = await connect(server, { era: "modern", ...params });

      const call = await longCall(client);
      if (invalidParams) {
        assertTaskErrorCode(call, INVALID_PARAMS, "long call");
      } else {
        // Stdio and HTTP answer this case differently; only the properties are fixed.
        if (call.result) assertNotATask(call.result);
        else assert.ok(call.error, JSON.stringify(call));
      }

      const get = await client.request("tasks/get", { taskId: "abc" });
      assert.ok(get.error, `tasks/get must be an error, got ${JSON.stringify(get)}`);
      if (invalidParams) assert.equal(get.error.code, INVALID_PARAMS, JSON.stringify(get.error));
    });
  }
}

test("a legacy connection cannot use Tasks even with a modern request context", async () => {
  const context = { mcpReq: { envelope: {
    [PROTOCOL_VERSION_KEY]: MODERN,
    [CLIENT_CAPS_KEY]: { extensions: { [TASKS_EXT]: {} } },
  } } };
  const args = { op: "wait_until" };
  assert.ok(nativeTaskCandidate(context, "c64_memory", args, "modern"));
  assert.equal(nativeTaskCandidate(context, "c64_memory", args, "legacy"), undefined);

  const handlers = new Map();
  registerTaskHandlers({ setRequestHandler: (method, _schema, handler) => handlers.set(method, handler) }, "legacy");
  for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
    await assert.rejects(handlers.get(method)({ taskId: "unused" }, context), { code: TASK_NOT_DECLARED });
  }
});
