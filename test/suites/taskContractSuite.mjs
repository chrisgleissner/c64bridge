// One parameterised contract suite for long allowlisted operations, run against two drivers:
//   - "native":  tools/call with the Tasks extension declared, then tasks/get and tasks/cancel
//   - "legacy":  c64_system start_task, task_result and stop_task for a client without the extension
// Both drivers run the same scenarios against the same mock and their outcomes are reduced by the same
// normaliser, so the two protocol paths have to agree. Only the drivers differ.
import os from "node:os";
import path from "node:path";
import { connect, resultData, startServer, waitFor, TASKS_EXT } from "../helpers/modernClient.mjs";

const INLINE_ENV = { C64BRIDGE_TASK_INLINE_MS: "150" };
let uniqueName = 0;

/** Reduces a final tool result to the fields both paths must agree on. */
export function normaliseResult(state, result) {
  const out = { state };
  if (!result) return out;
  const data = resultData(result) ?? {};
  out.isError = result.isError === true;
  if (typeof data.met === "boolean") out.met = data.met;
  if (typeof data.reason === "string") out.reason = data.reason;
  const error = data.error;
  if (error && typeof error === "object") {
    if (error.kind) out.errorKind = error.kind;
    if (error.code) out.errorCode = error.code;
  }
  if (data.cancelled === true) out.cancelled = true;
  return out;
}

/** Masks task ids so messages can be compared. */


function isTerminalStatus(status) {
  return status !== "working";
}

/** Native driver: Tasks extension declared on every request. */
export const nativeDriver = {
  id: "native",
  async open(server) {
    const client = await connect(server, { extensions: { [TASKS_EXT]: {} } });
    return {
      async start(tool, args) {
        const reply = await client.callTool(tool, args);
        if (reply.error) return { final: { state: "failed", rpcError: reply.error } };
        if (reply.result.resultType === "task") return { taskId: reply.result.taskId };
        return { final: { state: "completed", result: reply.result } };
      },
      async finish(handle, timeoutMs = 30_000) {
        const detail = await waitFor(async () => {
          const reply = await client.request("tasks/get", { taskId: handle.taskId });
          if (reply.error) throw new Error(`tasks/get failed: ${JSON.stringify(reply.error)}`);
          return isTerminalStatus(reply.result.status) ? reply.result : false;
        }, { timeoutMs, label: "native task to finish" });
        if (detail.status === "failed") return { state: "failed", rpcError: detail.error };
        return { state: detail.status, result: detail.result };
      },
      async cancel(handle) {
        const reply = await client.request("tasks/cancel", { taskId: handle.taskId });
        if (reply.error) throw new Error(`tasks/cancel failed: ${JSON.stringify(reply.error)}`);
      },
      /** An ordinary call, as any client makes it. */
      call(tool, args) { return client.callTool(tool, args); },
    };
  },
};

/** Legacy driver: a pre-2026 client, c64_system start_task + task_result. */
export const legacyDriver = {
  id: "legacy",
  async open(server) {
    const client = await connect(server, { era: "legacy" });
    const system = async (args) => {
      const reply = await client.callTool("c64_system", args);
      if (reply.error) throw new Error(`c64_system ${args.op} failed: ${JSON.stringify(reply.error)}`);
      return reply.result;
    };
    return {
      async start(tool, args) {
        const { op, ...rest } = args;
        const name = `contract-${(uniqueName += 1)}`;
        const started = await system({ op: "start_task", name, operation: `${tool}.${op}`, arguments: rest });
        if (started.isError) return { final: { state: "completed", result: started } };
        return { name };
      },
      async finish(handle, timeoutMs = 30_000) {
        const status = await waitFor(async () => {
          const result = await system({ op: "task_result", name: handle.name, waitMs: 500 });
          const data = resultData(result);
          return data.done ? data : false;
        }, { timeoutMs, label: "legacy task to finish" });
        if (status.status === "stopped") return { state: "cancelled", result: status.result };
        if (status.status === "error") {
          // A run that failed without a tool result carries only its message.
          return { state: "completed", result: status.result ?? { isError: true, content: [{ type: "text", text: status.error }] } };
        }
        return { state: "completed", result: status.result };
      },
      async cancel(handle) {
        await system({ op: "stop_task", name: handle.name });
      },
      call(tool, args) { return client.callTool(tool, args); },
    };
  },
};

export const DRIVERS = [nativeDriver, legacyDriver];

const MEMORY_C000 = 0xc000;
const unmet = (timeoutMs) => ({ op: "wait_until", condition: { type: "equals", address: "$C000", bytes: "FF" }, timeoutMs, pollIntervalMs: 50 });

/**
 * Scenario table. `env` is added to the server environment, `prepare(server)` arranges the mock,
 * `request` is the (tool, args) started through the driver, `whileRunning` acts after the start and
 * `expected` is the normalised outcome that BOTH drivers must produce.
 */
export const SCENARIOS = [
  {
    name: "success",
    request: { tool: "c64_memory", args: unmet(20_000) },
    whileRunning: ({ server }) => { server.mock.state.memory[MEMORY_C000] = 0xff; },
    expected: { main: { state: "completed", isError: false, met: true, reason: "condition_met" } },
  },
  {
    name: "validation error",
    request: { tool: "c64_memory", args: { op: "wait_until", condition: { type: "equals", address: "$C000", bytes: "FF" }, timeoutMs: 0 } },
    expected: { main: { state: "completed", isError: true, errorKind: "validation" } },
  },
  {
    name: "backend error",
    // Every device request fails from now on, so the first read of the wait fails whichever path issued it.
    prepare: (server) => { server.mock.state.faults = { errorRate: 1 }; },
    request: { tool: "c64_memory", args: unmet(5_000) },
    expected: { main: { state: "completed", isError: true, reason: "communication_failure", met: false } },
  },
  {
    name: "cancellation",
    request: { tool: "c64_memory", args: unmet(120_000) },
    whileRunning: ({ handle, session }) => session.cancel(handle),
    expected: { main: { state: "cancelled" } },
  },
  {
    name: "timeout",
    request: { tool: "c64_memory", args: unmet(500) },
    expected: { main: { state: "completed", isError: false, met: false, reason: "timeout" } },
  },
  {
    name: "access denial in read-only mode",
    env: { C64BRIDGE_ACCESS: "read-only" },
    request: { tool: "c64_program", args: { op: "batch_run", programs: [{ path: "/x.prg" }], durationMs: 1000, outputPath: path.join(os.tmpdir(), "c64bridge-contract-out") } },
    expected: { main: { state: "completed", isError: true, errorKind: "validation" } },
  },
  {
    name: "no-destructive mode allows an allowlisted write operation and still denies a destructive call",
    env: { C64BRIDGE_ACCESS: "no-destructive" },
    request: { tool: "c64_memory", args: unmet(500) },
    whileRunning: async ({ session, results }) => {
      results.destructive = await session.call("c64_system", { op: "poweroff" });
    },
    expected: { main: { state: "completed", isError: false, met: false, reason: "timeout" }, destructive: { isError: true, errorKind: "validation" } },
  },
  {
    name: "resource conflict with an exclusive task",
    request: { tool: "c64_program", args: { op: "batch_run", programs: [{ path: "/x.crt" }], durationMs: 30_000, outputPath: path.join(os.tmpdir(), "c64bridge-contract-out") } },
    whileRunning: async ({ session, handle, results }) => {
      const conflict = await session.call("c64_memory", { op: "write", address: "$C100", bytes: "$01" });
      results.conflict = conflict.result;
      await session.cancel(handle);
    },
    expected: { main: { state: "cancelled" }, conflict: { isError: true, errorKind: "execution", errorCode: "resource_conflict" } },
  },
];

/** Runs one scenario with one driver and returns the normalised outcomes (`main` plus anything recorded by whileRunning). */
export async function runScenario(t, driver, scenario) {
  const server = await startServer(t, { env: { ...INLINE_ENV, ...(scenario.env ?? {}) } });
  await scenario.prepare?.(server);
  const session = await driver.open(server);
  const results = {};
  const started = await session.start(scenario.request.tool, scenario.request.args);
  let final = started.final;
  if (!final) {
    await scenario.whileRunning?.({ server, session, handle: started, results });
    final = await session.finish(started);
  } else {
    await scenario.whileRunning?.({ server, session, handle: undefined, results });
  }
  const out = { main: normaliseResult(final.state, final.result) };
  if (final.rpcError) out.main.rpcError = final.rpcError.code;
  for (const [key, value] of Object.entries(results)) {
    const reply = value?.result ?? value;
    out[key] = normaliseResult(undefined, reply);
    delete out[key].state;
  }
  return out;
}
