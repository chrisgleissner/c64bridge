import { cancelGeneratedSidPlayback } from "./audio.js";
import { clearViceSymbols } from "./translation/symbolRegistry.js";
import { cancelledResult, defineToolModule } from "./types.js";
import { booleanSchema, numberSchema, objectSchema, optionalSchema } from "./schema.js";
import { waitForScreenText, MAX_WAIT_TIMEOUT_MS } from "./meta/screen.js";
import type { ToolExecutionContext } from "./types.js";
import { jsonResult, textResult } from "./responses.js";
import { Buffer } from "node:buffer";
import {
  ToolError,
  ToolExecutionError,
  toolErrorResult,
  unknownErrorResult,
} from "./errors.js";

function createNoArgsSchema(description: string) {
  return objectSchema<Record<string, never>>({
    description,
    properties: {},
    additionalProperties: false,
  });
}

function toRecord(details: unknown): Record<string, unknown> | undefined {
  if (details && typeof details === "object") {
    return details as Record<string, unknown>;
  }
  return undefined;
}

function normaliseFailure(details: unknown): Record<string, unknown> | undefined {
  if (details === undefined || details === null) {
    return undefined;
  }
  if (typeof details === "object") {
    return details as Record<string, unknown>;
  }
  return { value: details };
}

function isMissingMenuScreenEndpoint(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "response" in error
    && (error as { response?: { status?: unknown } }).response?.status === 404;
}

function createWaitSchema(description: string) {
  return objectSchema<{ waitForReady?: boolean; readyTimeoutMs?: number }>({
    description,
    properties: {
      waitForReady: optionalSchema(booleanSchema({
        description: "Wait for the BASIC READY. prompt before returning; a timeout gives ready=false, not an error.",
        default: false,
      }), false),
      readyTimeoutMs: optionalSchema(numberSchema({
        description: "Maximum time to wait for READY. when waitForReady is true (1-120000 ms).",
        integer: true,
        minimum: 1,
        maximum: MAX_WAIT_TIMEOUT_MS,
        default: 15_000,
      }), 15_000),
    },
    additionalProperties: false,
  });
}

const READY_SETTLE_MS = 300;
/** After this long, a screen identical to the one before the reset counts as the new boot screen (fallback without a marker). */
const READY_UNCHANGED_GRACE_MS = 3_000;
const SNAPSHOT_TIMEOUT_MS = 2_000;
/** Poll interval while a screen marker is in place: the marker makes every read conclusive, so no settle time is needed. */
const MARKED_POLL_INTERVAL_MS = 100;
/** Screen RAM after a reset: the KERNAL sets the screen page $0288 to $04. */
const DEFAULT_SCREEN_BASE = 0x0400;

/** Resolves to undefined when the operation does not settle within `ms`; the late result is ignored. */
async function withinMs<T>(operation: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(0, ms)); });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A byte written into the top-left screen cell ($0400) before the reset. The
 * KERNAL reset runs CINT ($FCFB JSR $FF5B), which clears the screen from line
 * 24 up to line 0 and each line from column 39 down to column 0 ($E55E-$E564,
 * $E9FF-$EA0F; source: mist64/c64ref ROM disassembly). $0400 is therefore the
 * last cell cleared: once it no longer holds the marker, the old screen is
 * gone and a READY. on screen is the new prompt.
 */
interface ResetMarker {
  readonly address: number;
  readonly value: number;
  readonly original: number;
}

/** What is known about the screen before the reset, used to tell a stale READY. from the new one. */
interface ResetObservation {
  /** Screen text before the reset; read only when no marker could be placed. */
  readonly before?: string;
  readonly marker?: ResetMarker;
}

type MarkerClient = Pick<ToolExecutionContext["client"], "readScreenDetailed" | "readMemoryRaw" | "writeMemoryRaw">;

/**
 * Places the marker when the screen is at $0400 and memory can be read and written. Returns undefined
 * otherwise (a relocated screen is not cleared at its old address by a reset), and the caller falls back
 * to comparing screen text.
 */
async function placeResetMarker(ctx: ToolExecutionContext): Promise<ResetMarker | undefined> {
  const client = ctx.client as Partial<MarkerClient>;
  if (typeof client.readScreenDetailed !== "function" || typeof client.readMemoryRaw !== "function" || typeof client.writeMemoryRaw !== "function") {
    return undefined;
  }
  try {
    const screen = await withinMs(client.readScreenDetailed.call(ctx.client), SNAPSHOT_TIMEOUT_MS);
    if (!screen || screen.baseAddress !== DEFAULT_SCREEN_BASE) return undefined;
    const current = (await withinMs(client.readMemoryRaw.call(ctx.client, DEFAULT_SCREEN_BASE, 1), SNAPSHOT_TIMEOUT_MS))?.[0];
    if (current === undefined) return undefined;
    const value = current === 0x2a ? 0x2b : 0x2a; // screen codes for "*" and "+"; never the $20 the clear writes
    await withinMs(client.writeMemoryRaw.call(ctx.client, DEFAULT_SCREEN_BASE, Uint8Array.of(value)), SNAPSHOT_TIMEOUT_MS);
    const readBack = (await withinMs(client.readMemoryRaw.call(ctx.client, DEFAULT_SCREEN_BASE, 1), SNAPSHOT_TIMEOUT_MS))?.[0];
    return readBack === value ? { address: DEFAULT_SCREEN_BASE, value, original: current } : undefined;
  } catch {
    return undefined;
  }
}

/** Puts the original byte back when the reset was not carried out. Best effort. */
async function removeResetMarker(ctx: ToolExecutionContext, observation: ResetObservation): Promise<void> {
  const marker = observation.marker;
  if (!marker) return;
  try {
    const current = (await withinMs(ctx.client.readMemoryRaw(marker.address, 1), SNAPSHOT_TIMEOUT_MS))?.[0];
    if (current === marker.value) await withinMs(ctx.client.writeMemoryRaw(marker.address, Uint8Array.of(marker.original)), SNAPSHOT_TIMEOUT_MS);
  } catch {
    // The marker stays visible; nothing else depends on it.
  }
}

/** Marks the screen (or, failing that, reads its text) before the reset. Nothing is done without waitForReady. */
async function screenBeforeReset(ctx: ToolExecutionContext, parsed: { waitForReady?: boolean }): Promise<ResetObservation> {
  if (parsed.waitForReady !== true) return {};
  const marker = await placeResetMarker(ctx);
  if (marker) return { marker };
  try {
    return { before: await withinMs(ctx.client.readScreen(), SNAPSHOT_TIMEOUT_MS) };
  } catch {
    return {};
  }
}

/**
 * Polls the screen until READY. appears or the timeout elapses. Never throws.
 * With a marker, a screen is only accepted once the marker cell has been
 * cleared by the reset, so no fixed wait is needed. Without one, a screen
 * identical to the one read before the reset is ignored for the first few
 * seconds, so the READY. still visible from before the reset is not taken for
 * the new one. Each read is bounded by the remaining time.
 */
async function waitForReadyPrompt(
  ctx: ToolExecutionContext,
  timeoutMs: number,
  observation: ResetObservation,
): Promise<{ ready: boolean; readyElapsedMs: number; lastError?: string; cancelled?: true }> {
  const start = Date.now();
  const { before, marker } = observation;
  if (!marker) await new Promise((resolve) => setTimeout(resolve, Math.min(READY_SETTLE_MS, timeoutMs)));
  let lastError: string | undefined;
  // A boot clears the screen, so once any read differs from the screen before the reset, a READY.
  // that matches the old screen again is the new prompt and needs no grace period.
  let changedSinceReset = false;
  const tolerantClient = {
    async readScreen(): Promise<string> {
      const remaining = () => timeoutMs - (Date.now() - start);
      try {
        if (marker) {
          const cell = (await withinMs(ctx.client.readMemoryRaw(marker.address, 1), remaining()))?.[0];
          if (cell === undefined || cell === marker.value) return ""; // the old screen has not been cleared yet
        }
        const screen = await withinMs(ctx.client.readScreen(), remaining());
        if (screen === undefined) return "";
        lastError = undefined;
        if (before !== undefined && screen !== before) changedSinceReset = true;
        if (before !== undefined && !changedSinceReset && screen === before && Date.now() - start < READY_UNCHANGED_GRACE_MS) return "";
        return screen;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        return ""; // device not reachable yet
      }
    },
  };
  const remaining = Math.max(1, timeoutMs - (Date.now() - start));
  const intervalMs = marker ? MARKED_POLL_INTERVAL_MS : 250;
  const outcome = await waitForScreenText(tolerantClient, { pattern: "READY.", timeoutMs: remaining, intervalMs, signal: ctx.signal });
  if (!outcome.matched && outcome.cancelled) {
    return { ready: false, readyElapsedMs: Date.now() - start, cancelled: true };
  }
  return { ready: outcome.matched, readyElapsedMs: Date.now() - start, ...(outcome.matched || !lastError ? {} : { lastError }) };
}

async function withReadyResult(
  ctx: ToolExecutionContext,
  parsed: { waitForReady?: boolean; readyTimeoutMs?: number },
  observation: ResetObservation,
  baseMessage: string,
  details: Record<string, unknown>,
) {
  if (parsed.waitForReady !== true) {
    return textResult(baseMessage, { success: true, details });
  }
  if (details.promptOk === true) {
    // The backend itself waited for the READY. prompt (VICE does on reset and reboot).
    return textResult(`${baseMessage} READY. prompt confirmed by the backend.`, { success: true, details, ready: true, readyElapsedMs: 0 });
  }
  const { ready, readyElapsedMs, lastError, cancelled } = await waitForReadyPrompt(ctx, parsed.readyTimeoutMs ?? 15_000, observation);
  if (cancelled) {
    // The command itself was already sent; only the wait for READY. was abandoned.
    return cancelledResult(`${baseMessage} The wait for the READY. prompt was cancelled by the client after ${readyElapsedMs} ms; the command had already been sent and the machine may still be starting.`);
  }
  const message = ready
    ? `${baseMessage} READY. prompt reached after ${readyElapsedMs} ms.`
    : `${baseMessage} The READY. prompt was not seen within ${readyElapsedMs} ms; the machine may still be starting.`
      + (lastError ? ` The last screen read failed: ${lastError}` : "");
  return textResult(message, { success: true, details, ready, readyElapsedMs, ...(lastError ? { readyError: lastError } : {}) });
}

const resetArgsSchema = createWaitSchema("Reset the C64. Optionally wait for the READY. prompt.");
const rebootArgsSchema = createWaitSchema("Reboot the C64 firmware. Optionally wait for the READY. prompt.");
const pauseArgsSchema = createNoArgsSchema("No arguments required to pause the machine.");
const resumeArgsSchema = createNoArgsSchema("No arguments required to resume the machine after a pause.");
const poweroffArgsSchema = createNoArgsSchema("No arguments required to power off the machine.");
const powerCycleArgsSchema = createWaitSchema("Power cycle the active system. Optionally wait for the READY. prompt.");
const menuButtonArgsSchema = createNoArgsSchema("No arguments required to toggle the Ultimate menu button.");
const readMenuScreenArgsSchema = createNoArgsSchema("No arguments required to read the active Ultimate menu screen matrix.");

const POWER_RESTORE_NOTE = "The machine cannot be restarted by software afterwards: power must be restored at the outlet, and the machine starts by itself only if automatic startup on power restoration is enabled.";

export const machineControlModule = defineToolModule({
  domain: "machine",
  summary: "Power, reset, pause/resume, and diagnostic controls for the C64 and Ultimate hardware.",
  resources: ["c64://guide/bootstrap"],
  prompts: ["memory-debug"],
  defaultTags: ["machine", "control"],
  workflowHints: [
    "Reach for machine controls when the user mentions resets, power states, or DMA pause/resume.",
    "Explain the operational impact (e.g. soft reset vs firmware reboot) so the user knows what changed.",
  ],
  tools: [
    {
      name: "reset_c64",
      description: "Reset the C64 via Ultimate firmware. Review c64://guide/bootstrap safety rules.",
      summary: "Issues a soft reset, equivalent to power cycling without cutting power.",
      inputSchema: resetArgsSchema.jsonSchema,
      tags: ["reset"],
      prerequisites: [],
      examples: [
        { name: "Soft reset", description: "Reset machine", arguments: {} },
      ],
      workflowHints: [
        "Use when the user wants a quick restart without losing power; mention that memory contents may persist.",
      ],
      supportedPlatforms: ["c64u", "u2", "vice"],
      async execute(args, ctx) {
        try {
          const parsed = resetArgsSchema.parse(args ?? {});
          ctx.logger.info("Resetting C64");

          const observation = await screenBeforeReset(ctx, parsed);
          await cancelGeneratedSidPlayback(ctx.client);
          const result = await ctx.client.reset();
          if (result.success) clearViceSymbols(); // labels belong to one program
          if (!result.success) {
            await removeResetMarker(ctx, observation);
            throw new ToolExecutionError("C64 backend reported failure while resetting", {
              details: normaliseFailure(result.details),
            });
          }

          const details = toRecord(result.details) ?? {};

          if (typeof details.warning === "string") {
            // The CPU may still be stopped, so a READY. wait would only time out.
            await removeResetMarker(ctx, observation);
            return textResult(`C64 reset command issued. Warning: ${details.warning}`, { success: true, details, warning: details.warning });
          }
          return await withReadyResult(ctx, parsed, observation, "C64 reset command issued successfully.", details);
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "reboot_c64",
      description: "Reboot the Ultimate firmware and C64. See c64://guide/bootstrap.",
      summary: "Triggers a firmware reboot, useful after configuration changes.",
      inputSchema: rebootArgsSchema.jsonSchema,
      tags: ["reboot"],
      prerequisites: [],
      examples: [
        { name: "Firmware reboot", description: "Hard reboot", arguments: {} },
      ],
      workflowHints: [
        "Choose reboot when configuration changed or hardware is stuck; warn that it will interrupt any running program.",
      ],
      supportedPlatforms: ["c64u", "u2", "vice"],
      async execute(args, ctx) {
        try {
          const parsed = rebootArgsSchema.parse(args ?? {});
          ctx.logger.info("Rebooting C64");

          const observation = await screenBeforeReset(ctx, parsed);
          await cancelGeneratedSidPlayback(ctx.client);
          const result = await ctx.client.reboot();
          if (result.success) clearViceSymbols(); // labels belong to one program
          if (!result.success) {
            await removeResetMarker(ctx, observation);
            throw new ToolExecutionError("C64 backend reported failure while rebooting", {
              details: normaliseFailure(result.details),
            });
          }

          const details = toRecord(result.details) ?? {};

          return await withReadyResult(ctx, parsed, observation, "C64 reboot command issued successfully.", details);
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "pause",
      description: "Pause the machine until resume. On VICE the pause holds the monitor connection open, and a reset, reboot, power cycle or power-off ends it. See memory safety checklist in c64://guide/bootstrap.",
      summary: "Suspends CPU execution on Ultimate hardware until resumed.",
      inputSchema: pauseArgsSchema.jsonSchema,
      tags: ["pause"],
      prerequisites: [],
      examples: [
        { name: "Pause", description: "Halt CPU", arguments: {} },
      ],
      workflowHints: [
        "Pause when the user needs a stable memory snapshot; remind them to resume to continue execution.",
      ],
      supportedPlatforms: ["c64u", "u2", "vice"],
      async execute(args, ctx) {
        try {
          pauseArgsSchema.parse(args ?? {});
          ctx.logger.info("Pausing C64 execution");

          // An explicit pause stays in effect until an explicit resume, even if tool calls pause and resume meanwhile.
          const result = ctx.client.explicitPause ? await ctx.client.explicitPause(await ctx.client.pinFacade?.()) : await ctx.client.pause();
          if (!result.success) {
            throw new ToolExecutionError("C64 backend reported failure while pausing", {
              details: normaliseFailure(result.details),
            });
          }

          const details = toRecord(result.details) ?? {};

          return textResult("C64 execution paused.", {
            success: true,
            details,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "resume",
      description: "Resume the machine after a pause.",
      summary: "Releases the Ultimate hardware pause so the CPU can continue.",
      inputSchema: resumeArgsSchema.jsonSchema,
      tags: ["resume"],
      prerequisites: ["pause"],
      examples: [
        { name: "Resume", description: "Continue CPU", arguments: {} },
      ],
      workflowHints: [
        "Call after a pause or diagnostic halt and confirm the machine is running again.",
      ],
      supportedPlatforms: ["c64u", "u2", "vice"],
      async execute(args, ctx) {
        try {
          resumeArgsSchema.parse(args ?? {});
          ctx.logger.info("Resuming C64 execution");

          const result = ctx.client.explicitResume ? await ctx.client.explicitResume(await ctx.client.pinFacade?.()) : await ctx.client.resume();
          if (!result.success) {
            throw new ToolExecutionError("C64 backend reported failure while resuming", {
              details: normaliseFailure(result.details),
            });
          }

          const details = toRecord(result.details) ?? {};

          return textResult("C64 execution resumed.", {
            success: true,
            details,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "poweroff",
      description: `Power off the machine via Ultimate firmware. See safety notes in c64://guide/bootstrap. ${POWER_RESTORE_NOTE}`,
      summary: "Attempts a controlled shutdown through the Ultimate control interface.",
      inputSchema: poweroffArgsSchema.jsonSchema,
      tags: ["power"],
      prerequisites: [],
      examples: [
        { name: "Power off", description: "Shut down", arguments: {} },
      ],
      workflowHints: [
        "Use when the user explicitly requests power off; remind them to power on manually or via drive controls afterwards.",
      ],
      supportedPlatforms: ["c64u", "vice"],
      async execute(args, ctx) {
        try {
          poweroffArgsSchema.parse(args ?? {});
          ctx.logger.info("Powering off C64");

          const result = await ctx.client.poweroff();
          if (result.success) clearViceSymbols(); // labels belong to one program
          if (!result.success) {
            throw new ToolExecutionError("C64 backend reported failure while powering off", {
              details: normaliseFailure(result.details),
            });
          }

          const details = toRecord(result.details) ?? {};

          const message = ctx.platform?.id === "vice"
            ? "Power off command acknowledged."
            : `Power off command acknowledged. ${POWER_RESTORE_NOTE}`;

          return textResult(message, {
            success: true,
            details,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "power_cycle",
      description: "Return the active system to a fresh state: C64U/U64 uses verified Tool Menu navigation, U2-family reboots through REST, and managed VICE restarts.",
      summary: "Performs the platform-appropriate full power-cycle equivalent and reports the strategy used.",
      inputSchema: powerCycleArgsSchema.jsonSchema,
      tags: ["power", "reboot", "fresh-start"],
      prerequisites: [],
      examples: [
        { name: "Fresh start", description: "Power cycle the active system", arguments: {} },
      ],
      workflowHints: [
        "Use only when the user explicitly requests a fresh start or power cycle; it interrupts active work.",
        "On C64U/U64, verify Tool Menu navigation through machine:menu_screen before selecting Power Cycle.",
      ],
      supportedPlatforms: ["c64u", "u2", "vice"],
      async execute(args, ctx) {
        try {
          const parsed = powerCycleArgsSchema.parse(args ?? {});
          ctx.logger.info("Power cycling active backend");
          // The menu sequence is never interrupted between steps, so cancellation is honoured only before it starts.
          if (ctx.signal?.aborted) {
            return cancelledResult("power_cycle was cancelled by the client before it started; no menu input was sent and the machine was not touched.");
          }
          const observation = await screenBeforeReset(ctx, parsed);
          await cancelGeneratedSidPlayback(ctx.client);
          const result = await ctx.client.powerCycle();
          if (result.success) clearViceSymbols(); // labels belong to one program
          if (!result.success) {
            await removeResetMarker(ctx, observation);
            throw new ToolExecutionError("Power cycle did not complete", {
              details: normaliseFailure(result.details),
            });
          }
          const details = toRecord(result.details) ?? {};
          return await withReadyResult(ctx, parsed, observation, "Power-cycle request completed.", details);
        } catch (error) {
          if (error instanceof ToolError) return toolErrorResult(error);
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "menu_button",
      description: "Toggle the Ultimate 64 menu button.",
      summary: "Simulates the on-device menu button for navigation or exit.",
      inputSchema: menuButtonArgsSchema.jsonSchema,
      tags: ["menu"],
      prerequisites: [],
      examples: [
        { name: "Menu", description: "Toggle menu", arguments: {} },
      ],
      workflowHints: [
        "Use when the user needs to open or close the Ultimate menu; suggest following up with drive operations if relevant.",
      ],
      supportedPlatforms: ["c64u", "u2"],
      async execute(args, ctx) {
        try {
          menuButtonArgsSchema.parse(args ?? {});
          ctx.logger.info("Toggling Ultimate menu button");

          const result = await ctx.client.menuButton();
          if (!result.success) {
            throw new ToolExecutionError("C64 backend reported failure while toggling menu button", {
              details: normaliseFailure(result.details),
            });
          }

          const details = toRecord(result.details) ?? {};

          return textResult("Menu button command sent.", {
            success: true,
            details,
          });
        } catch (error) {
          if (error instanceof ToolError) {
            return toolErrorResult(error);
          }
          return unknownErrorResult(error);
        }
      },
    },
    {
      name: "read_menu_screen",
      description: "Read the raw character and colour matrix for the currently visible Ultimate menu screen.",
      summary: "Returns the firmware-defined menu matrix bytes, including text and colour information.",
      inputSchema: readMenuScreenArgsSchema.jsonSchema,
      tags: ["menu", "screen", "diagnostic"],
      prerequisites: ["menu_button"],
      examples: [
        { name: "Inspect active menu", description: "Read the currently visible Ultimate menu", arguments: {} },
      ],
      workflowHints: [
        "Read c64://platform/status first. Call after opening the Ultimate menu; if the endpoint is unavailable or no menu is active, the tool returns fallback guidance instead of a transport error.",
        "The firmware returns an opaque character-and-colour matrix, preserved as base64 without guessing a layout.",
      ],
      supportedPlatforms: ["c64u", "u2"],
      async execute(args, ctx) {
        try {
          readMenuScreenArgsSchema.parse(args ?? {});
          const bytes = await ctx.client.readMenuScreen();
          return jsonResult({
            encoding: "base64",
            byteLength: bytes.length,
            matrix: Buffer.from(bytes).toString("base64"),
          });
        } catch (error) {
          if (error instanceof ToolError) return toolErrorResult(error);
          if (isMissingMenuScreenEndpoint(error)) {
            return toolErrorResult(new ToolExecutionError(
              "No menu matrix is available. Open the Ultimate menu and retry; if it remains unavailable, this firmware does not provide machine:menu_screen. Use REST configuration instead of menu navigation where possible.",
              { code: "native_menu_screen_unavailable", details: { fallback: "rest_configuration_or_manual_menu" }, cause: error },
            ));
          }
          return unknownErrorResult(error);
        }
      },
    },
  ],
});
