import { ToolValidationError } from "./errors.js";

/**
 * Effect classification of an operation.
 * - read: no change to the machine, the emulator or the host file system.
 * - write: changes machine or emulator state that a reset undoes, or writes a host file.
 * - destructive: survives a reset or interrupts availability (power off, power cycle, reboot,
 *   flash save/load/reset, drive ROM load, disk image creation, debug register write).
 */
export type ToolEffect = "read" | "write" | "destructive";

export type AccessMode = "full" | "no-destructive" | "read-only";

export const ACCESS_ENV_VAR = "C64BRIDGE_ACCESS";

const ACCESS_MODES: readonly AccessMode[] = ["full", "no-destructive", "read-only"];

const warnedValues = new Set<string>();

/**
 * Reads the access mode from the environment at call time. An unset or empty variable means
 * "full". An unknown value fails closed to "read-only" and logs a warning once per value.
 */
export function getAccessMode(env: NodeJS.ProcessEnv = process.env): AccessMode {
  const raw = env[ACCESS_ENV_VAR];
  if (raw === undefined || raw.trim() === "") {
    return "full";
  }
  const value = raw.trim().toLowerCase();
  if ((ACCESS_MODES as readonly string[]).includes(value)) {
    return value as AccessMode;
  }
  if (!warnedValues.has(value)) {
    warnedValues.add(value);
    process.stderr.write(
      `[c64bridge] Unknown ${ACCESS_ENV_VAR} value "${raw}"; using "read-only". Valid values: ${ACCESS_MODES.join(", ")}.\n`,
    );
  }
  return "read-only";
}

export function isEffectAllowed(mode: AccessMode, effect: ToolEffect): boolean {
  switch (mode) {
    case "full":
      return true;
    case "no-destructive":
      return effect !== "destructive";
    default:
      return effect === "read";
  }
}

/** Throws a validation error when the active access mode does not allow the effect. */
export function assertAccess(toolName: string, op: string | undefined, effect: ToolEffect): void {
  const mode = getAccessMode();
  if (isEffectAllowed(mode, effect)) {
    return;
  }
  const subject = op ? `${toolName} operation "${op}"` : toolName;
  throw new ToolValidationError(
    `${subject} is blocked: it has effect "${effect}" and the access mode is "${mode}" (${ACCESS_ENV_VAR}=${mode}). `
      + `${mode === "read-only" ? "Only read operations are allowed." : "Destructive operations are not allowed."}`,
    {
      path: "$.op",
      details: { tool: toolName, op: op ?? null, effect, accessMode: mode, variable: ACCESS_ENV_VAR },
    },
  );
}

/** Effect of a background task operation (read, write, read_screen, menu_button and the *_memory aliases). */
export function taskOperationEffect(operation: unknown): ToolEffect {
  switch (operation) {
    case "read":
    case "read_memory":
    case "read_screen":
      return "read";
    default:
      // write, write_memory, menu_button and unknown names (rejected later by validation).
      return "write";
  }
}

const NETWORK_CATEGORY = /network|wifi|wi-fi|ethernet|modem/i;

function isNetworkCategory(category: unknown): boolean {
  // The firmware matches category names with wildcards, so a wildcard may reach a network category.
  return typeof category === "string" && (/[*?]/.test(category) || NETWORK_CATEGORY.test(category));
}

/**
 * Effect override of c64_config set and batch_update: a write to a network category can cut the
 * bridge off from the device, so it is destructive. Other writes keep their declared effect.
 */
export function configWriteEffect(op: string | undefined, args: unknown): ToolEffect | undefined {
  if (op !== "set" && op !== "batch_update") {
    return undefined;
  }
  const record = (typeof args === "object" && args !== null ? args : {}) as { category?: unknown; updates?: unknown };
  if (op === "set") {
    return isNetworkCategory(record.category) ? "destructive" : undefined;
  }
  const updates = record.updates;
  if (typeof updates === "object" && updates !== null && Object.keys(updates).some(isNetworkCategory)) {
    return "destructive";
  }
  return undefined;
}

export interface ToolAnnotationsHint {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export function annotationsForEffects(effects: readonly ToolEffect[]): ToolAnnotationsHint {
  return {
    readOnlyHint: effects.length > 0 && effects.every((effect) => effect === "read"),
    destructiveHint: effects.includes("destructive"),
    idempotentHint: false,
    openWorldHint: false,
  };
}
