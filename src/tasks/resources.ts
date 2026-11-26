// Resource coordination for detached tasks (contract C4). Process-local: leases are plain
// in-memory records, so they say nothing about other MCP processes or other users of the device.
import { ToolExecutionError } from "../tools/errors.js";
import type { ToolEffect } from "../tools/access.js";

export type OperationClass =
  | "passive-read"
  | "interrupting-read"
  | "memory-write"
  | "program-start"
  | "reset-power"
  | "input"
  | "capture"
  | "configuration"
  | "backend-switch"
  | "host-only";

export type LeaseMode = "observe" | "exclusive" | "none";

export interface Lease {
  readonly taskId: string;
  readonly backendId: string;
  readonly mode: "observe" | "exclusive";
  readonly tool: string;
  readonly op: string;
  /** See AllowlistEntry.pinned. */
  readonly pinned: boolean;
}

/** Foreground classes an exclusive lease rejects. passive-read and host-only stay allowed. */
const BLOCKED_BY_EXCLUSIVE: ReadonlySet<OperationClass> = new Set<OperationClass>([
  "interrupting-read", "memory-write", "program-start", "reset-power", "input", "capture", "configuration", "backend-switch",
]);

const HOST_ONLY_TOOLS: ReadonlySet<string> = new Set(["c64_rag", "c64_batch"]);
const TASK_MANAGEMENT_OPS: ReadonlySet<string> = new Set([
  "start_task", "stop_task", "stop_all_tasks", "delete_task", "list_tasks", "task_result", "performance_report",
]);
const RESET_POWER_OPS: ReadonlySet<string> = new Set(["reset", "reboot", "poweroff", "power_cycle", "nuclear_reset"]);
const CAPTURE_OPS: ReadonlySet<string> = new Set([
  "capture_frame", "capture_samples", "record_analyze", "bundle_run",
]);
const PROGRAM_START_OPS: ReadonlySet<string> = new Set([
  "load_prg", "run_prg", "run_crt", "upload_run_basic", "upload_run_asm", "batch_run", "cross_platform_greeting",
  "play_sid_file", "play_mod_file", "compile_play", "play_preset", "pipeline",
]);

/**
 * Class of a foreground call. Unknown operations classify from their effect: read is
 * passive-read (interrupting-read on VICE, whose monitor stops the CPU), anything else
 * memory-write.
 */
export function classifyOperation(tool: string, op: string | undefined, effect: ToolEffect | undefined, backendType: string | undefined, taskOperation?: unknown): OperationClass {
  if (tool === "c64_select_backend") return op === "select" || op === undefined ? "backend-switch" : "passive-read";
  if (HOST_ONLY_TOOLS.has(tool)) return "host-only";
  if (tool === "c64_system" && op !== undefined && TASK_MANAGEMENT_OPS.has(op)) {
    if (op === "start_task") {
      switch (taskOperation) {
        case "write":
        case "write_memory": return "memory-write";
        case "menu_button": return "input";
        case "read":
        case "read_memory":
        case "read_screen": return backendType === "vice" ? "interrupting-read" : "passive-read";
      }
    }
    // Allowlisted calls take their lease through the engine.
    return "host-only";
  }
  if (op !== undefined) {
    if (RESET_POWER_OPS.has(op)) return "reset-power";
    if (tool === "c64_input" && op !== "state") return "input";
    if (tool === "c64_system" && (op === "menu")) return "input";
    if (tool === "c64_stream" && effect !== "read") return "capture";
    if (CAPTURE_OPS.has(op) && tool !== "c64_program") return "capture";
    if (tool === "c64_program" && op === "bundle_run") return "capture";
    if (tool === "c64_program" && PROGRAM_START_OPS.has(op)) return "program-start";
    if (tool === "c64_sound" && PROGRAM_START_OPS.has(op)) return "program-start";
    if (tool === "c64_config" && effect !== "read") return "configuration";
  }
  if (effect === "read") return backendType === "vice" ? "interrupting-read" : "passive-read";
  return "memory-write";
}

const leases = new Set<Lease>();

export function listLeases(): readonly Lease[] {
  return [...leases];
}

function describe(lease: Lease): string {
  return `task ${lease.taskId} (${lease.tool}.${lease.op}, ${lease.mode} lease on ${lease.backendId})`;
}

function cancelHint(lease: Lease): string {
  return `Cancel it with c64_system {op: "stop_task"} (legacy name) or the Tasks cancel for task id ${lease.taskId}, or wait for it to finish.`;
}

/**
 * Takes a lease for a task. An exclusive lease conflicts with any other exclusive lease on the
 * same backend; observe leases never conflict. Mode "none" holds nothing and returns null.
 * Throws ToolExecutionError naming the holding task on a conflict.
 */
export function acquireLease(request: {
  taskId: string; backendId: string; mode: LeaseMode; tool: string; op: string; pinned: boolean;
}): Lease | null {
  if (request.mode === "none") return null;
  if (request.mode === "exclusive") {
    for (const held of leases) {
      if (held.mode === "exclusive" && (held.backendId === request.backendId || held.backendId === "unknown" || request.backendId === "unknown")) {
        throw new ToolExecutionError(
          `${request.tool}.${request.op} cannot start: ${describe(held)} already holds the exclusive lease. ${cancelHint(held)}`,
          { code: "resource_conflict", details: { heldBy: held.taskId, tool: held.tool, op: held.op, backend: held.backendId } },
        );
      }
    }
  }
  const lease: Lease = { taskId: request.taskId, backendId: request.backendId, mode: request.mode, tool: request.tool, op: request.op, pinned: request.pinned };
  leases.add(lease);
  return lease;
}

export function releaseLease(lease: Lease | null | undefined): void {
  if (lease) leases.delete(lease);
}

export interface ForegroundCall {
  readonly tool: string;
  readonly op?: string;
  readonly effect?: ToolEffect;
  readonly taskOperation?: unknown;
  /** Active backend type of the call, when known. */
  readonly backendId?: string;
}

/** Throws ToolExecutionError when the call conflicts with a lease held by another task. */
export function assertForegroundAllowed(call: ForegroundCall, taskLease?: string): void {
  if (leases.size === 0) return;
  const cls = classifyOperation(call.tool, call.op, call.effect, call.backendId, call.taskOperation);
  for (const held of leases) {
    if (held.taskId === taskLease) continue;
    if (call.backendId !== undefined && held.backendId !== "unknown" && held.backendId !== call.backendId) continue;
    const blocks = held.mode === "exclusive"
      ? BLOCKED_BY_EXCLUSIVE.has(cls)
      // A task that reads through the active backend would follow a switch to another backend.
      : cls === "backend-switch" && !held.pinned;
    if (blocks) {
      throw new ToolExecutionError(
        `${call.tool}${call.op ? `.${call.op}` : ""} (${cls}) is blocked by ${describe(held)}. ${cancelHint(held)}`,
        { code: "resource_conflict", details: { heldBy: held.taskId, tool: held.tool, op: held.op, backend: held.backendId, class: cls } },
      );
    }
  }
}

/** True when no lease is held, so the registry gate can skip the async backend lookup. */
export function noLeasesHeld(): boolean {
  return leases.size === 0;
}

export function __resetLeasesForTests(): void {
  leases.clear();
}
