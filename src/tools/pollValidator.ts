/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { createHash } from "node:crypto";
import type { C64Client } from "../c64Client.js";
import type { ToolLogger } from "./types.js";

/**
 * Configuration for polling behavior.
 */
export interface PollConfig {
  /** Maximum duration (in milliseconds) to continue polling after RUN appears */
  maxMs: number;
  /** Interval (in milliseconds) between consecutive screen polls */
  intervalMs: number;
  /** Stabilization window (in milliseconds) to wait after RUN detection before sampling hardware */
  stabilizeMs: number;
}

/**
 * Result of BASIC program polling.
 */
export interface BasicPollResult {
  status: "ok" | "error";
  type: "BASIC";
  message?: string;
  line?: number;
}

/**
 * Result of Assembly program polling.
 */
export interface AsmPollResult {
  /**
   * ok: the program showed signs of running (screen RAM changed, or it
   * returned to BASIC). unconfirmed: the program was loaded but nothing
   * observable changed, which is normal for a SID player, a border effect or a
   * `JMP *` loop. not_loaded: the bytes at the load address differ from the
   * assembled program, so the run request did not load it (HARD01-036).
   */
  status: "ok" | "unconfirmed" | "not_loaded";
  type: "ASM";
  reason?: string;
  loadCheck?: "matched" | "unavailable" | "skipped";
  /** Set when status is not_loaded: load address and the compared bytes as hex. */
  load?: { address: number; expected: string; found: string };
}

/** The first bytes of the assembled program, compared with memory after the upload. */
export interface ExpectedProgramBytes {
  readonly address: number;
  readonly bytes: Uint8Array;
}

const LOAD_CHECK_BYTES = 16;

export type PollResult = BasicPollResult | AsmPollResult;

/**
 * Load poll configuration from environment variables with defaults.
 */
export function loadPollConfig(): PollConfig {
  // In test environments with mock target, use shorter timeouts to avoid interfering with test screen queues
  const isTestMode = process.env.C64_TEST_TARGET === "mock" || process.env.NODE_ENV === "test";
  const defaultMaxMs = isTestMode ? 100 : 2000;
  const defaultIntervalMs = isTestMode ? 30 : 200;
  const defaultStabilizeMs = 100;
  
  const maxMs = parseInt(process.env.C64BRIDGE_POLL_MAX_MS ?? String(defaultMaxMs), 10);
  const intervalMs = parseInt(process.env.C64BRIDGE_POLL_INTERVAL_MS ?? String(defaultIntervalMs), 10);
  const stabilizeMs = parseInt(process.env.C64BRIDGE_POLL_STABILIZE_MS ?? String(defaultStabilizeMs), 10);

  return {
    maxMs: Number.isFinite(maxMs) && maxMs > 0 ? maxMs : defaultMaxMs,
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : defaultIntervalMs,
    stabilizeMs: Number.isFinite(stabilizeMs) && stabilizeMs >= 0 ? stabilizeMs : defaultStabilizeMs,
  };
}

/**
 * Wait for a specified duration.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute SHA-1 hash of screen content for change detection.
 */

/**
 * Compute fast 32-bit CRC32 checksum of buffer for change detection.
 */
function computeCrc32(buffer: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Compare two Uint8Arrays for equality.
 */
function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Concatenate multiple Uint8Arrays into a single buffer.
 */
function concatBuffers(...buffers: Uint8Array[]): Uint8Array {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.length;
  }
  return result;
}

/**
 * Extract BASIC error information from screen text.
 * Looks for patterns like "?SYNTAX ERROR" or "SYNTAX ERROR IN 120".
 */
function extractBasicError(screen: string): { message?: string; line?: number } | null {
  const errorMatch = /(?:^|\n)\s*\?([A-Z'\s]+?)\s+ERROR(?:\s+IN\s+(\d+))?(?=\s|$)/im.exec(screen); // A real error has a leading "?"; ordinary output like "0 ERRORS FOUND" must never match. The apostrophe covers UNDEF'D STATEMENT, REDIM'D ARRAY and CAN'T CONTINUE.
  
  if (errorMatch) {
    const errorType = errorMatch[1]?.trim().replace(/\s+/g, " ");
    const lineStr = errorMatch[2];
    const line = lineStr ? parseInt(lineStr, 10) : undefined;
    
    return {
      message: errorType,
      line: Number.isFinite(line) ? line : undefined,
    };
  }
  
  return null;
}

/**
 * True when the most recent typed SYS command is followed by a READY. prompt,
 * which is how a machine-code routine that ends with RTS hands back to BASIC.
 */
function returnedToBasicAfterSys(screen: string): boolean {
  const lines = screen.split("\n").map((line) => line.trim().toUpperCase());
  let sysLine = -1;
  lines.forEach((line, index) => {
    if (/^SYS\s*\d+$/.test(line)) sysLine = index;
  });
  return sysLine >= 0 && lines.slice(sysLine + 1).some((line) => line === "READY.");
}

function normaliseScreen(screen: string): string {
  return screen.split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

/** True when the last non-blank screen line is the READY. prompt, i.e. BASIC is waiting for input. */
function endsAtReadyPrompt(screen: string): boolean {
  const lines = screen.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.length > 0 && lines[lines.length - 1]!.toUpperCase() === "READY.";
}

/**
 * Poll for the outcome of a BASIC run.
 *
 * Evidence that the program ran: the screen shows RUN or an error, differs
 * from the screen captured before the run (a program that clears the screen
 * removes the RUN echo), or is blank. A BASIC error returns immediately. Once
 * there is evidence and the screen ends at the READY. prompt, the program has
 * finished without an error and the poll returns at once. A program that is
 * still running (no prompt) is watched for errors for the full window.
 */
async function pollBasicOutcome(
  client: C64Client,
  logger: ToolLogger,
  config: PollConfig,
  baselineScreen?: string,
): Promise<BasicPollResult> {
  const startTime = Date.now();
  let pollCount = 0;
  let runDetected = false;
  const baseline = baselineScreen === undefined ? undefined : normaliseScreen(baselineScreen);

  logger.debug("Starting BASIC outcome polling", { maxMs: config.maxMs, intervalMs: config.intervalMs });

  while (Date.now() - startTime < config.maxMs) {
    pollCount++;

    try {
      const screen = await client.readScreen();
      const upperScreen = screen.toUpperCase();

      const errorInfo = extractBasicError(screen);
      if (errorInfo) {
        logger.debug("BASIC error detected", { errorInfo, pollCount, elapsed: Date.now() - startTime });
        return {
          status: "error",
          type: "BASIC",
          message: errorInfo.message,
          line: errorInfo.line,
        };
      }

      if (!runDetected) {
        const changed = baseline !== undefined && normaliseScreen(screen) !== baseline;
        if (upperScreen.includes("RUN") || upperScreen.includes("ERROR") || changed || normaliseScreen(screen) === "") {
          runDetected = true;
          logger.debug("Program execution detected", { pollCount, elapsed: Date.now() - startTime });
        }
      }

      if (runDetected && endsAtReadyPrompt(screen)) {
        logger.debug("BASIC program finished without an error", { pollCount, elapsed: Date.now() - startTime });
        return { status: "ok", type: "BASIC" };
      }
    } catch (error) {
      logger.debug("Failed to read screen during BASIC polling", { error, pollCount });
    }
    await delay(config.intervalMs);
  }
  if (!runDetected) { // No sign of execution for the whole window: the firmware reported success, but nothing changed on screen (HARD01-011/036).
    logger.debug("BASIC polling completed without observing execution or an error", { pollCount, elapsed: Date.now() - startTime });
    return {
      status: "error",
      type: "BASIC",
      message: "No execution activity detected: the firmware reported success, but the program does not appear to have run.",
    };
  }
  logger.debug("BASIC polling completed without errors", { pollCount, elapsed: Date.now() - startTime });
  return {
    status: "ok",
    type: "BASIC",
  };
}

/**
 * Poll for Assembly program outcome by detecting hardware and screen activity.
 * Monitors VIC-II, SID, CIA, jiffy clock, screen memory, and low memory (zero page + stack)
 * to determine if program is alive or crashed.
 * First waits for RUN to appear, then monitors for activity across multiple memory regions.
 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

/**
 * Reads back up to 16 bytes at the load address and compares them with the
 * assembled program. A U2-family firmware answers run_prg with success without
 * loading anything, so this is the evidence that the program reached memory.
 * Needs confirmation on U2 hardware; it is exercised against mocks only.
 */
async function checkProgramLoaded(
  client: C64Client,
  logger: ToolLogger,
  program: ExpectedProgramBytes,
): Promise<Pick<AsmPollResult, "loadCheck" | "load">> {
  const length = Math.min(LOAD_CHECK_BYTES, program.bytes.length, 0x10000 - program.address);
  if (length <= 0) {
    return { loadCheck: "skipped" };
  }
  const expected = program.bytes.subarray(0, length);
  let found: Uint8Array;
  try {
    found = await client.readMemoryRaw(program.address, length);
  } catch (error) {
    logger.debug("Unable to read back the loaded program", { error });
    return { loadCheck: "unavailable" };
  }
  if (!buffersEqual(found.subarray(0, length), expected)) {
    return { loadCheck: "matched", load: { address: program.address, expected: toHex(expected), found: toHex(found.subarray(0, length)) } };
  }
  return { loadCheck: "matched" };
}

async function pollAsmOutcome(
  client: C64Client,
  logger: ToolLogger,
  config: PollConfig,
  program?: ExpectedProgramBytes,
): Promise<AsmPollResult> {
  let loadCheck: AsmPollResult["loadCheck"] = "skipped";
  if (program) {
    const check = await checkProgramLoaded(client, logger, program);
    loadCheck = check.loadCheck;
    if (check.load) {
      return {
        status: "not_loaded",
        type: "ASM",
        reason: `memory at $${program.address.toString(16).toUpperCase().padStart(4, "0")} does not contain the assembled program`,
        loadCheck: "matched",
        load: check.load,
      };
    }
  }
  const startTime = Date.now();
  let pollCount = 0;
  let runDetected = false;
  
  logger.debug("Starting ASM outcome polling with hardware monitoring", {
    maxMs: config.maxMs,
    intervalMs: config.intervalMs,
    stabilizeMs: config.stabilizeMs,
  });
  
  // Wait for RUN to appear first
  while (Date.now() - startTime < config.maxMs && !runDetected) {
    try {
      const screen = await client.readScreen();
      const upperScreen = screen.toUpperCase();
      
      if (returnedToBasicAfterSys(screen)) {
        // The typed SYS line is followed by READY., so the routine ran and returned with RTS.
        logger.debug("ASM program returned to BASIC", { elapsed: Date.now() - startTime });
        return { status: "ok", type: "ASM", loadCheck };
      }
      if (upperScreen.includes("RUN") || upperScreen.includes("SYS") || upperScreen.includes("ERROR")) {
        runDetected = true;
        logger.debug("RUN detected, starting stabilization window", {
          elapsed: Date.now() - startTime,
          stabilizeMs: config.stabilizeMs,
        });
        if (config.stabilizeMs > 0) {
          await delay(config.stabilizeMs);
        }
        break;
      }
    } catch (error) {
      logger.debug("Failed to read screen while waiting for RUN", { error });
    }
    
    await delay(config.intervalMs);
  }
  
  if (!runDetected) { // Fall through to the liveness check rather than assuming success. Skipping it here used to report false success for any run that never types anything visible, e.g. a firmware run_prg that silently no-ops instead of running the PRG (HARD01-036).
    logger.debug("RUN never detected; falling through to hardware liveness check instead of assuming success");
  }
  let previousSignature: number | null = null; // Only stable RAM: reading I/O can ack CIA interrupts on Ultimate, and raster/timer values aren't evidence of liveness.
  let alive = false;
  
  const pollDeadline = Date.now() + config.maxMs;
  
  while (Date.now() < pollDeadline && !alive) {
    pollCount++;
    
    try {
      // A routine that works for a while before RTS shows READY. only after the first screen read.
      if (returnedToBasicAfterSys(await client.readScreen())) {
        logger.debug("ASM program returned to BASIC", { pollCount, elapsed: Date.now() - startTime });
        return { status: "ok", type: "ASM", loadCheck };
      }
    } catch (error) {
      logger.debug("Failed to read screen during ASM polling", { error, pollCount });
    }

    try {
      const screenRam = await client.readMemoryRaw(0x0400, 0x03e8);
      const signature = computeCrc32(screenRam);
      
      // Check for any activity
      if (previousSignature !== null && signature !== previousSignature) {
        logger.debug("Program-visible screen activity detected", {
          pollCount, 
          elapsed: Date.now() - startTime,
          signatureChanged: true
        });
        alive = true;
        break;
      }
      
      previousSignature = signature;
      
    } catch (error) {
      logger.debug("Failed to read memory during ASM polling", { error, pollCount });
    }
    
    await delay(config.intervalMs);
  }
  
  if (alive) {
    logger.debug("ASM program alive - hardware or screen progressing", { pollCount, elapsed: Date.now() - startTime });
    return {
      status: "ok",
      type: "ASM",
      loadCheck,
    };
  }
  
  // No screen change: the program may be running silently, so this is not evidence of a crash.
  logger.debug("ASM program unconfirmed - no screen progression", { pollCount, elapsed: Date.now() - startTime });
  return {
    status: "unconfirmed",
    type: "ASM",
    reason: "no program-visible screen progression within window",
    loadCheck,
  };
}

/**
 * Main polling function that polls for program outcome.
 * 
 * @param type - Type of program (BASIC or ASM)
 * @param client - C64 client for screen reading
 * @param logger - Logger for debug output
 * @param config - Optional poll configuration (uses environment defaults if not provided)
 * @returns Promise resolving to poll result
 */
export async function pollForProgramOutcome(
  type: "BASIC" | "ASM",
  client: C64Client,
  logger: ToolLogger,
  config?: Partial<PollConfig>,
  program?: ExpectedProgramBytes,
  baselineScreen?: string,
): Promise<PollResult> {
  const defaults = loadPollConfig();
  const pollConfig: PollConfig = {
    maxMs: config?.maxMs ?? defaults.maxMs,
    intervalMs: config?.intervalMs ?? defaults.intervalMs,
    stabilizeMs: config?.stabilizeMs ?? defaults.stabilizeMs,
  };
  
  logger.debug("Starting program outcome polling", {
    type,
    maxMs: pollConfig.maxMs,
    intervalMs: pollConfig.intervalMs,
    stabilizeMs: pollConfig.stabilizeMs,
  });
  
  // Poll for program outcome based on type
  if (type === "BASIC") {
    return pollBasicOutcome(client, logger, pollConfig, baselineScreen);
  }
  
  return pollAsmOutcome(client, logger, pollConfig, program);
}
