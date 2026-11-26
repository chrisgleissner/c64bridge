/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

/**
 * Polling loop for `wait_until` (contract C7). All side effects are injected: the reader, a monotonic clock and
 * the sleep. One iteration runs at a time: the next read starts only after the previous read finished and the
 * poll interval has elapsed.
 *
 * Error policy: one failed read ends the wait at once with reason `communication_failure`, carrying the
 * observations collected so far. A read error is never retried and is never reported as a timeout.
 */

import { evaluate, describeTarget, readPlan, type Condition, type Observation, type ReadTarget } from "./conditions.js";

export type WaitReason = "condition_met" | "timeout" | "max_iterations" | "cancelled" | "communication_failure";

export interface PollerDeps {
  /** Reads what the condition needs. Rejects on any communication problem. */
  readonly read: (target: ReadTarget) => Promise<Observation>;
  /** Monotonic milliseconds. */
  readonly now: () => number;
  /** Resolves after `ms`, or earlier when the signal aborts. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (completed: number, total: number, message: string) => void;
}

export interface PollerOptions {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly maxIterations: number;
  readonly backend: string;
}

export interface ObservationRecord {
  readonly iteration: number;
  readonly elapsedMs: number;
  readonly value: string | number;
}

export interface WaitResult {
  readonly met: boolean;
  readonly reason: WaitReason;
  readonly target: Record<string, unknown>;
  readonly expected: string;
  readonly observed: string | number | null;
  readonly firstObservation: ObservationRecord | null;
  readonly lastObservation: ObservationRecord | null;
  readonly iterations: number;
  readonly elapsedMs: number;
  readonly backend: string;
  /** Set with reason communication_failure. */
  readonly error?: string;
}

const ABORTED = Symbol("aborted");

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.resolve(ABORTED);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** Expected text of a condition before any iteration ran. */
function initialExpected(condition: Condition): string {
  // evaluate() needs an observation; a neutral one of the right kind is only used to read `expected`.
  const target = readPlan(condition);
  const neutral: Observation = target.kind === "memory"
    ? { kind: "bytes", bytes: new Uint8Array(target.length) }
    : target.kind === "screen" ? { kind: "screen", text: "" } : { kind: "hits", count: 0 };
  return evaluate(condition, neutral, neutral).expected;
}

export async function pollUntil(condition: Condition, options: PollerOptions, deps: PollerDeps): Promise<WaitResult> {
  const { signal } = deps;
  const target = readPlan(condition);
  const targetJson = describeTarget(target);
  const started = deps.now();
  let iterations = 0;
  let initial: Observation | undefined;
  let first: ObservationRecord | null = null;
  let last: ObservationRecord | null = null;
  let expected = initialExpected(condition);

  const finish = (reason: WaitReason, error?: string): WaitResult => ({
    met: reason === "condition_met",
    reason,
    target: targetJson,
    expected,
    observed: last ? last.value : null,
    firstObservation: first,
    lastObservation: last,
    iterations,
    elapsedMs: Math.max(0, deps.now() - started),
    backend: options.backend,
    ...(error !== undefined ? { error } : {}),
  });

  for (;;) {
    if (signal?.aborted) return finish("cancelled");
    let observation: Observation | typeof ABORTED;
    try {
      observation = await raceAbort(deps.read(target), signal);
    } catch (error) {
      if (signal?.aborted) return finish("cancelled");
      return finish("communication_failure", error instanceof Error ? error.message : String(error));
    }
    if (observation === ABORTED || signal?.aborted) return finish("cancelled");
    iterations += 1;
    initial ??= observation;
    const evaluation = evaluate(condition, observation, initial);
    expected = evaluation.expected;
    const record: ObservationRecord = { iteration: iterations, elapsedMs: Math.max(0, deps.now() - started), value: evaluation.observed };
    first ??= record;
    last = record;
    if (evaluation.met) return finish("condition_met");
    deps.onProgress?.(iterations, options.maxIterations, `iteration ${iterations} of at most ${options.maxIterations}, condition not met yet`);
    if (iterations >= options.maxIterations) return finish("max_iterations");
    const remaining = options.timeoutMs - (deps.now() - started);
    if (remaining <= 0) return finish("timeout");
    try {
      await deps.sleep(Math.min(options.pollIntervalMs, remaining), signal);
    } catch {
      // A sleep that rejects on abort is treated like one that resolves early; the abort check follows.
    }
  }
}
