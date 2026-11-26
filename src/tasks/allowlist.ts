// Allowlist of tool operations that can run as detached "call" tasks (contract C3).
// Pure data: no imports from the tool registry, so access.ts and the engine can read it.
import type { ToolEffect } from "../tools/access.js";
import type { LeaseMode, OperationClass } from "./resources.js";

export interface AllowlistEntry {
  readonly tool: string;
  readonly op: string;
  /** Resource class of the task, used for the lease (not the class of a foreground call). */
  readonly resourceClass: OperationClass;
  readonly lease: LeaseMode;
  /**
   * True when the operation does not follow a later backend switch (it works on a facade pinned
   * at submission or only reads). False when it reads through the active backend on every step,
   * so a backend switch would retarget it; the gate then rejects a switch while it runs.
   */
  readonly pinned: boolean;
  /** Declared effect of the operation, enforced against the access mode at start (and again by the inner invoke). */
  readonly effect: ToolEffect;
  /**
   * "honoured": the operation stops at the next step when ctx.signal aborts.
   * "bounded": it ignores the signal but is bounded by a count/timeout limit; after a cancel its
   * lease stays held until the underlying call has finished.
   */
  readonly cancellation: "honoured" | "bounded";
}

const ENTRIES: readonly AllowlistEntry[] = [
  // Implemented by a later package; reserved here so the legacy and native adapters accept the key.
  { tool: "c64_memory", op: "wait_until", resourceClass: "passive-read", lease: "observe", pinned: true, effect: "read", cancellation: "honoured" },
  { tool: "c64_memory", op: "wait_for_text", resourceClass: "passive-read", lease: "observe", pinned: false, effect: "read", cancellation: "honoured" },
  { tool: "c64_debug", op: "wait_for_state", resourceClass: "passive-read", lease: "observe", pinned: false, effect: "read", cancellation: "honoured" },
  { tool: "c64_sound", op: "capture_samples", resourceClass: "capture", lease: "exclusive", pinned: false, effect: "read", cancellation: "honoured" },
  { tool: "c64_sound", op: "pipeline", resourceClass: "capture", lease: "exclusive", pinned: false, effect: "write", cancellation: "honoured" },
  { tool: "c64_graphics", op: "capture_frame", resourceClass: "capture", lease: "exclusive", pinned: false, effect: "read", cancellation: "bounded" },
  { tool: "c64_program", op: "batch_run", resourceClass: "program-start", lease: "exclusive", pinned: false, effect: "write", cancellation: "honoured" },
  { tool: "c64_program", op: "bundle_run", resourceClass: "capture", lease: "exclusive", pinned: false, effect: "write", cancellation: "bounded" },
];

const TABLE: ReadonlyMap<string, AllowlistEntry> = new Map(ENTRIES.map((entry) => [`${entry.tool}.${entry.op}`, entry]));

export function allowlistKey(tool: string, op: string): string {
  return `${tool}.${op}`;
}

export function lookupAllowlist(key: unknown): AllowlistEntry | undefined {
  return typeof key === "string" ? TABLE.get(key) : undefined;
}

export function listAllowlistKeys(): string[] {
  return [...TABLE.keys()];
}

/** True for operation names that are meant as allowlist keys ("tool.op"). */
export function looksLikeAllowlistKey(operation: unknown): operation is string {
  return typeof operation === "string" && operation.includes(".");
}
