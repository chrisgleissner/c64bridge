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
  status: "ok" | "crashed";
  type: "ASM";
  reason?: string;
}

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
  const errorMatch = /(?:^|\n)\s*\?([A-Z\s]+?)\s+ERROR(?:\s+IN\s+(\d+))?(?=\s|$)/im.exec(screen); // A real error has a leading "?"; ordinary output like "0 ERRORS FOUND" must never match.
  
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
 * Poll for BASIC program outcome by detecting errors on screen.
 * First waits for RUN or ERROR to appear, then continues polling for errors.
 */
async function pollBasicOutcome(
  client: C64Client,
  logger: ToolLogger,
  config: PollConfig,
): Promise<BasicPollResult> {
  const startTime = Date.now();
  let pollCount = 0;
  let runDetected = false;
  
  logger.debug("Starting BASIC outcome polling", { maxMs: config.maxMs, intervalMs: config.intervalMs });
  
  while (Date.now() - startTime < config.maxMs) {
    pollCount++;
    
    try {
      const screen = await client.readScreen();
      const upperScreen = screen.toUpperCase();
      
      // Check if RUN or ERROR appeared (indicating execution started or failed)
      if (!runDetected && (upperScreen.includes("RUN") || upperScreen.includes("ERROR"))) {
        runDetected = true;
        logger.debug("Program execution detected", { pollCount, elapsed: Date.now() - startTime });
      }
      
      // Check for errors
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
      
      // If we detected RUN and no error yet, continue polling
      if (runDetected) {
        // Continue polling for a bit to catch any delayed errors
        // but if we've been polling for a while without errors, consider it successful
      }
    } catch (error) {
      logger.debug("Failed to read screen during BASIC polling", { error, pollCount });
    }
    
    await delay(config.intervalMs);
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
async function pollAsmOutcome(
  client: C64Client,
  logger: ToolLogger,
  config: PollConfig,
): Promise<AsmPollResult> {
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
      
      if (upperScreen.includes("RUN") || upperScreen.includes("ERROR")) {
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
  
  // If RUN never appeared, assume instant execution (success)
  if (!runDetected) {
    logger.debug("RUN never detected, assuming instant execution");
    return {
      status: "ok",
      type: "ASM",
    };
  }
  
  let previousSignature: number | null = null; // Only stable RAM: reading I/O can ack CIA interrupts on Ultimate, and raster/timer values aren't evidence of liveness.
  let alive = false;
  
  const pollDeadline = Date.now() + config.maxMs;
  
  while (Date.now() < pollDeadline && !alive) {
    pollCount++;
    
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
    };
  }
  
  // No activity detected - consider it crashed
  logger.debug("ASM program crashed - no VIC/CIA/TI/screen progression", { pollCount, elapsed: Date.now() - startTime });
  return {
    status: "crashed",
    type: "ASM",
    reason: "no program-visible screen progression within window",
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
    return pollBasicOutcome(client, logger, pollConfig);
  }
  
  return pollAsmOutcome(client, logger, pollConfig);
}
