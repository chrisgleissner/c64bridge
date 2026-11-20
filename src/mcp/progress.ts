/**
 * MCP progress for long tool calls. A client that sends `_meta.progressToken` gets
 * `notifications/progress`: from handlers through `ctx.reportProgress(completed, total, message)`,
 * and a heartbeat while the call runs, so clients that extend their request timeout on progress
 * (the TypeScript SDK default timeout is 60 s) do not cancel a long wait.
 */
export type ProgressToken = string | number;

export interface ProgressNotification {
  readonly method: "notifications/progress";
  readonly params: { progressToken: ProgressToken; progress: number; total?: number; message?: string };
}

export interface ProgressReporter {
  /** Handler hook: `completed` steps of `total` (optional) are done. */
  readonly report: (completed: number, total?: number, message?: string) => void;
  /** Stops the heartbeat; later reports are ignored. */
  readonly stop: () => void;
  /** Resolves once every notification sent so far has been handed to the transport. */
  readonly flush: () => Promise<void>;
}

export const PROGRESS_HEARTBEAT_MS = 10_000;
/** Heartbeats advance by this much, so progress strictly increases without reaching the next step. */
const HEARTBEAT_STEP = 0.001;

export function createProgressReporter(
  token: ProgressToken,
  send: (notification: ProgressNotification) => Promise<void> | void,
  options: { heartbeatMs?: number } = {},
): ProgressReporter {
  let last = 0;
  let total: number | undefined;
  let stopped = false;
  const pending = new Set<Promise<void>>();
  const emit = (progress: number, message?: string) => {
    if (stopped) return;
    last = progress;
    const params = {
      progressToken: token,
      progress: Number(progress.toFixed(3)),
      ...(total !== undefined ? { total } : {}),
      ...(message ? { message } : {}),
    };
    try {
      const sent: Promise<void> = Promise.resolve(send({ method: "notifications/progress", params })).catch(() => {});
      pending.add(sent);
      void sent.finally(() => pending.delete(sent));
    } catch {
      // A closed transport must not fail the tool call.
    }
  };
  const timer = setInterval(() => emit(last + HEARTBEAT_STEP, "still running"), options.heartbeatMs ?? PROGRESS_HEARTBEAT_MS);
  timer.unref?.();
  return {
    report(completed, newTotal, message) {
      if (!Number.isFinite(completed)) return;
      if (newTotal !== undefined && Number.isFinite(newTotal) && newTotal > 0) total = newTotal;
      // Progress must increase with every notification.
      emit(Math.max(completed, last + HEARTBEAT_STEP), message);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    async flush() {
      // The tool result must not overtake its own progress notifications on the transport.
      await Promise.all([...pending]);
    },
  };
}
