/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

/**
 * `c64_memory` op `wait_until`, synchronous form (contract C7): blocks until a typed condition on memory, the
 * screen or a VICE checkpoint is met, the timeout or iteration cap is reached, or the request is cancelled.
 *
 * Pinning: the backend facade is pinned once at the start and every read, and the checkpoint cleanup, goes to
 * that facade. Addresses and symbols are resolved once at the start. A later `c64_select_backend` or a new
 * symbol table cannot retarget a running wait.
 */

import { performance } from "node:perf_hooks";
import type { C64Facade } from "../device.js";
import { screenLayoutFromRegisters } from "../device.js";
import { screenCodesToAscii } from "../petscii.js";
import { rangeOverlapsIo } from "../ioRange.js";
import { ToolError, ToolValidationError, toolErrorResult, unknownErrorResult } from "../tools/errors.js";
import { jsonResult } from "../tools/responses.js";
import type { JsonSchema, ToolExecutionContext, ToolRunResult } from "../tools/types.js";
import { parseAddressArg } from "../tools/memory.js";
import { parseCondition, readPlan, hex, type Condition, type Observation, type ReadTarget } from "./conditions.js";
import { pollUntil, type PollerDeps, type WaitResult } from "./poller.js";

export const DEFAULT_POLL_INTERVAL_MS = 250;
export const MIN_POLL_INTERVAL_MS = 50;
export const MAX_POLL_INTERVAL_MS = 60_000;
export const MAX_TIMEOUT_MS = 3_600_000;
export const DEFAULT_MAX_ITERATIONS = 10_000;
export const MAX_MAX_ITERATIONS = 100_000;

const TOP_LEVEL_KEYS = new Set(["op", "condition", "pollIntervalMs", "timeoutMs", "maxIterations", "includeIo"]);

export const WAIT_UNTIL_DESCRIPTION =
  "Wait until a condition on memory, the screen or a VICE checkpoint holds. Timeout or maxIterations: success with met false. A failed read ends the wait with an error result (communication_failure) carrying the data so far. Addresses and backend are fixed at the start.";

const conditionSchema: JsonSchema = {
  type: "object",
  description: "{type: equals|not_equals|masked|range|threshold|changed|screen_text|screen_changed|checkpoint, address, bytes|mask,value|min,max,width|comparison,value,width|length|text|kind}",
};

export const waitUntilArgsJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    condition: conditionSchema,
    pollIntervalMs: { type: "integer", minimum: MIN_POLL_INTERVAL_MS, maximum: MAX_POLL_INTERVAL_MS, default: DEFAULT_POLL_INTERVAL_MS },
    timeoutMs: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS, description: "Required timeout ms." },
    maxIterations: { type: "integer", minimum: 1, maximum: MAX_MAX_ITERATIONS, default: DEFAULT_MAX_ITERATIONS },
    includeIo: { type: "boolean", default: false, description: "Ultimate: allow $D000-$DFFF." },
  },
  required: ["condition", "timeoutMs"],
  additionalProperties: false,
};

function integerOption(raw: unknown, path: string, name: string, min: number, max: number, fallback: number | undefined): number {
  if (raw === undefined) {
    if (fallback === undefined) throw new ToolValidationError(`${name} is required (${min}..${max})`, { path });
    return fallback;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw)) throw new ToolValidationError(`${name} must be an integer`, { path, details: { received: raw } });
  if (raw < min || raw > max) throw new ToolValidationError(`${name} must be ${min}..${max}`, { path, details: { minimum: min, maximum: max, received: raw } });
  return raw;
}

export interface ParsedWaitArgs {
  readonly condition: unknown;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly maxIterations: number;
  readonly includeIo: boolean;
}

export function parseWaitUntilArgs(raw: unknown): ParsedWaitArgs {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ToolValidationError("Arguments must be an object", { path: "$" });
  const args = raw as Record<string, unknown>;
  for (const key of Object.keys(args)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new ToolValidationError(`Unknown property "${key}"; allowed: ${[...TOP_LEVEL_KEYS].filter((k) => k !== "op").join(", ")}`, { path: `$.${key}` });
  }
  if (args.condition === undefined) throw new ToolValidationError("condition is required", { path: "$.condition" });
  const timeoutMs = integerOption(args.timeoutMs, "$.timeoutMs", "timeoutMs", 1, MAX_TIMEOUT_MS, undefined);
  const pollIntervalMs = integerOption(args.pollIntervalMs, "$.pollIntervalMs", "pollIntervalMs", MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS);
  const maxIterations = integerOption(args.maxIterations, "$.maxIterations", "maxIterations", 1, MAX_MAX_ITERATIONS, DEFAULT_MAX_ITERATIONS);
  if (args.includeIo !== undefined && typeof args.includeIo !== "boolean") throw new ToolValidationError("includeIo must be true or false", { path: "$.includeIo" });
  return { condition: args.condition, pollIntervalMs, timeoutMs, maxIterations, includeIo: args.includeIo === true };
}

/** Reads the text screen where the VIC-II shows it (base and character set from $D018/$DD00) through the pinned facade. */
export async function readScreenThroughFacade(ctx: ToolExecutionContext, facade: C64Facade | undefined): Promise<string> {
  if (facade?.readScreenState) {
    const state = await facade.readScreenState();
    return screenCodesToAscii(state.bytes, { columns: 40, rows: 25, charset: state.charset });
  }
  let d018: number | undefined;
  let dd00: number | undefined;
  try {
    d018 = (await ctx.client.readMemoryRaw(0xd018, 1, facade))[0];
    dd00 = (await ctx.client.readMemoryRaw(0xdd00, 1, facade))[0];
  } catch {
    // Keep the defaults ($0400, upper case) when the registers cannot be read.
  }
  const layout = screenLayoutFromRegisters(d018, dd00);
  const bytes = await ctx.client.readMemoryRaw(layout.baseAddress, Math.min(0x03e8, 0x10000 - layout.baseAddress), facade);
  return screenCodesToAscii(bytes, { columns: 40, rows: 25, charset: layout.charset });
}

interface CheckpointRunner {
  checkpointOperation<T>(fn: (client: import("../vice/viceClient.js").ViceClient) => Promise<T>): Promise<T>;
}

function sleepUntilAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function resultFor(result: WaitResult, warnings: string[]): ToolRunResult {
  const data = { ...result, ...(warnings.length ? { warnings } : {}) };
  if (result.reason === "cancelled") {
    const message = `wait_until was cancelled after ${result.iterations} iteration(s) and ${result.elapsedMs} ms`;
    return {
      content: [{ type: "text", text: message }],
      structuredContent: { type: "json", data: { message, cancelled: true, ...data } },
      metadata: { success: false, cancelled: true, reason: "cancelled" },
      isError: true,
    };
  }
  if (result.reason === "communication_failure") {
    const message = `wait_until stopped by a communication failure after ${result.iterations} iteration(s): ${result.error ?? "read failed"}`;
    return {
      content: [{ type: "text", text: `${message}\n${JSON.stringify(data)}` }],
      structuredContent: { type: "json", data },
      metadata: { success: false, reason: "communication_failure", error: { kind: "execution", details: { reason: "communication_failure" } } },
      isError: true,
    };
  }
  return jsonResult(data, { success: true, met: result.met, reason: result.reason });
}

export async function executeWaitUntil(rawArgs: unknown, ctx: ToolExecutionContext): Promise<ToolRunResult> {
  try {
    const args = parseWaitUntilArgs(rawArgs);
    if (ctx.signal?.aborted) {
      return resultFor({ met: false, reason: "cancelled", target: {}, expected: "", observed: null, firstObservation: null, lastObservation: null, iterations: 0, elapsedMs: 0, backend: ctx.platform?.id ?? "unknown" }, []);
    }
    // Pin the facade once; every later read and the checkpoint cleanup use it.
    const facade = ctx.client.pinFacade ? await ctx.client.pinFacade() : undefined;
    const backend: string = facade?.type ?? (ctx.client.getActiveBackendType ? await ctx.client.getActiveBackendType() : ctx.platform?.id) ?? "unknown";

    const condition: Condition = parseCondition(args.condition, (raw, path) => parseAddressArg(raw, path));
    const target = readPlan(condition);
    if (condition.type === "checkpoint" && backend !== "vice") {
      throw new ToolValidationError(`The checkpoint condition needs the VICE backend; the active backend is ${backend}. Use a memory or screen condition, or select VICE with c64_select_backend.`, { path: "$.condition.type", details: { backend } });
    }
    if (target.kind === "memory" && backend !== "vice" && !args.includeIo && rangeOverlapsIo(target.address, target.length)) {
      throw new ToolValidationError(
        `${hex(target.address, 4)}-${hex(target.address + target.length - 1, 4)} overlaps the I/O area $D000-$DFFF; on Ultimate hardware reading it can clear pending CIA interrupts. Pass includeIo: true to read it anyway, or choose an address outside it.`,
        { path: "$.condition.address" },
      );
    }

    const warnings: string[] = [];
    let checkpointId: number | undefined;
    let runner: CheckpointRunner | undefined;
    let result: WaitResult;
    try {
      if (condition.type === "checkpoint") {
        runner = facade as unknown as CheckpointRunner;
        if (typeof runner?.checkpointOperation !== "function") {
          throw new ToolValidationError("The active VICE backend does not support checkpoints", { path: "$.condition.type" });
        }
        const created = await runner.checkpointOperation((client) => client.checkpointCreate({
          start: condition.address,
          end: condition.address,
          stopOnHit: false,
          enabled: true,
          temporary: false,
          operations: { execute: condition.kind === "exec", load: condition.kind === "load", store: condition.kind === "store" },
          memspace: 0,
        }));
        checkpointId = created.id;
      }

      const read = async (t: ReadTarget): Promise<Observation> => {
        if (t.kind === "memory") return { kind: "bytes", bytes: await ctx.client.readMemoryRaw(t.address, t.length, facade) };
        if (t.kind === "screen") return { kind: "screen", text: await readScreenThroughFacade(ctx, facade) };
        const info = await runner!.checkpointOperation((client) => client.checkpointGet(checkpointId!));
        return { kind: "hits", count: info.hitCount };
      };
      const deps: PollerDeps = {
        read,
        now: () => performance.now(),
        sleep: sleepUntilAbort,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onProgress: (done, total, message) => ctx.reportProgress?.(done, total, message),
      };
      result = await pollUntil(condition, { pollIntervalMs: args.pollIntervalMs, timeoutMs: args.timeoutMs, maxIterations: args.maxIterations, backend }, deps);
    } finally {
      if (runner && checkpointId !== undefined) {
        try {
          await runner.checkpointOperation((client) => client.checkpointDelete(checkpointId!));
        } catch (error) {
          warnings.push(`Temporary checkpoint ${checkpointId} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
          ctx.logger.warn("wait_until could not remove its checkpoint", { id: checkpointId });
        }
      }
    }
    return resultFor(result, warnings);
  } catch (error) {
    if (error instanceof ToolError) return toolErrorResult(error);
    return unknownErrorResult(error);
  }
}
