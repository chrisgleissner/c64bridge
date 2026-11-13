/*
 * Readiness utilities for VICE BM: detect BASIC init and prompt visibility.
 */
import { ViceClient } from "./viceClient.js";

export type TimingSink = (label: string, start: bigint) => void;

function nowNs(): bigint { return process.hrtime.bigint(); }
function msSince(start: bigint): number { return Number((process.hrtime.bigint() - start) / 1_000_000n); }

async function exitMonitorIfNeeded(bm: ViceClient): Promise<void> {
  try {
    await bm.exitMonitor();
  } catch {
    // Ignore errors while resuming; monitor may already be running.
  }
}

export function buildReadyPattern(): Buffer {
  // Screen-codes for "READY." in power-on uppercase
  return Buffer.from([0x12, 0x05, 0x01, 0x04, 0x19, 0x2E]);
}

export async function waitForScreenPattern(
  bm: ViceClient,
  pattern: Buffer,
  timeoutMs: number,
  tickMs = 50,
  onRead?: TimingSink,
  between?: () => Promise<void> | void,
): Promise<number> {
  const start = nowNs();
  let idx = -1;
  while (msSince(start) < timeoutMs) {
    const t = nowNs();
    const screen = await bm.memGet(0x0400, 0x0400 + 999);
    onRead?.("bm_read_screen", t);
    idx = screen.indexOf(pattern);
    if (idx >= 0) break;
    await exitMonitorIfNeeded(bm);
    if (between) await between();
    await new Promise((r) => setTimeout(r, Math.max(1, tickMs)));
  }
  await exitMonitorIfNeeded(bm);
  return idx;
}

export async function waitForStableScreenPattern(
  bm: ViceClient,
  pattern: Buffer,
  timeoutMs: number,
  tickMs = 50,
  stableReads = 2,
  onRead?: TimingSink,
  between?: () => Promise<void> | void,
): Promise<number> {
  const requiredStableReads = Math.max(1, stableReads);
  const start = nowNs();
  let idx = -1;
  let stableIdx = -1;
  let consecutiveMatches = 0;

  while (msSince(start) < timeoutMs) {
    const t = nowNs();
    const screen = await bm.memGet(0x0400, 0x0400 + 999);
    onRead?.("bm_read_screen", t);
    idx = screen.indexOf(pattern);

    if (idx >= 0) {
      if (idx === stableIdx) {
        consecutiveMatches += 1;
      } else {
        stableIdx = idx;
        consecutiveMatches = 1;
      }
      if (consecutiveMatches >= requiredStableReads) {
        break;
      }
    } else {
      stableIdx = -1;
      consecutiveMatches = 0;
    }

    await exitMonitorIfNeeded(bm);
    if (between) await between();
    await new Promise((r) => setTimeout(r, Math.max(1, tickMs)));
  }

  await exitMonitorIfNeeded(bm);
  return consecutiveMatches >= requiredStableReads ? idx : -1;
}

/** Wait until any non-blank (non-0x00/0x20) character appears on the text screen. */
export async function waitForAnyScreenText(
  bm: ViceClient,
  timeoutMs: number,
  tickMs = 50,
  onRead?: TimingSink,
  between?: () => Promise<void> | void,
): Promise<boolean> {
  const start = nowNs();
  while (msSince(start) < timeoutMs) {
    const t = nowNs();
    const screen = await bm.memGet(0x0400, 0x0400 + 999);
    onRead?.("bm_read_screen", t);
    for (let i = 0; i < screen.length; i++) {
      const b = screen[i];
      if (b !== 0x00 && b !== 0x20) {
        return true;
      }
    }
    await exitMonitorIfNeeded(bm);
    if (between) await between();
    await new Promise((r) => setTimeout(r, Math.max(1, tickMs)));
  }
  await exitMonitorIfNeeded(bm);
  return false;
}

export async function waitForBasicReady(
  bm: ViceClient,
  options?: {
    timeoutMs?: number;
    ensurePrompt?: boolean;
    onPointersRead?: TimingSink;
    onScreenRead?: TimingSink;
    onPointersSample?: (v: { tx: number; va: number; ar: number; st: number }) => void;
  },
): Promise<{ pointersOk: boolean; promptOk: boolean }> {
  const timeoutMs = Math.max(1, options?.timeoutMs ?? 2_000);
  const ptrStart = nowNs();
  let pointersOk = false;
  while (msSince(ptrStart) < timeoutMs) {
    const tPtr = nowNs();
    const ptrs = await bm.memGet(0x002B, 0x0032);
    options?.onPointersRead?.("bm_read_basic_ptrs", tPtr);
    const tx = (ptrs[0] | (ptrs[1] << 8));
    const va = (ptrs[2] | (ptrs[3] << 8));
    const ar = (ptrs[4] | (ptrs[5] << 8));
    const st = (ptrs[6] | (ptrs[7] << 8));
    options?.onPointersSample?.({ tx, va, ar, st });
    // Be tolerant: we only require TXTTAB at $0801; other pointers may lag until first input
    if (tx === 0x0801 && va >= 0x0801 && ar >= 0x0801 && st >= 0x0801) { pointersOk = true; break; }
    await exitMonitorIfNeeded(bm);
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!pointersOk) return { pointersOk: false, promptOk: false };

  if (!options?.ensurePrompt) {
    await exitMonitorIfNeeded(bm);
    return { pointersOk: true, promptOk: false };
  }

  // Coax READY. by hitting RETURN, then poll for READY.
  await bm.keyboardFeed("\r");
  await exitMonitorIfNeeded(bm);
  const promptIdx = await waitForScreenPattern(
    bm,
    buildReadyPattern(),
    timeoutMs,
    50,
    options?.onScreenRead,
    async () => { await exitMonitorIfNeeded(bm); },
  );
  return { pointersOk: true, promptOk: promptIdx >= 0 };
}

export function asciiToScreenCodes(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    if (ch >= 'A' && ch <= 'Z') out.push(ch.charCodeAt(0) - 64);
    else if (ch >= '0' && ch <= '9') out.push(0x30 + (ch.charCodeAt(0) - 48));
    // Space, digits and punctuation ($20-$3F) have the same screen codes as ASCII.
    else if (ch >= ' ' && ch <= '?') out.push(ch.charCodeAt(0));
    // ignore others
  }
  return Buffer.from(out);
}

/** Marker byte written before a reset; the KERNAL's RAMTAS clears $0200-$03FF, so it vanishes once the boot is under way. */
const BOOT_MARKER_ADDRESS = 0x03ff;
const BOOT_MARKER_VALUE = 0xa5;
const BASIC_STATE_START = 0x002b;
const BASIC_STATE_END = 0x07e7;
const SCREEN_OFFSET = 0x0400 - BASIC_STATE_START;

export type BootWaitOptions = {
  /** Total time to wait for the prompt. */
  timeoutMs: number;
  /** Time to leave the machine alone after the reset before the first check. */
  firstCheckMs: number;
  /** Gap after the first check; it grows by half each time up to `maxGapMs`. */
  initialGapMs?: number;
  maxGapMs?: number;
  onSample?: (v: { tx: number; va: number; ar: number; st: number }) => void;
};

/**
 * Evaluates one read of $002B-$07E7: the BASIC pointers, the boot marker and the text screen.
 * The prompt counts only when the marker is gone (the reset has really run) and the screen shows
 * READY., so a screen left over from before the reset is never mistaken for the new boot.
 */
export function evaluateBootState(state: Uint8Array): { pointersOk: boolean; promptOk: boolean; pointers?: { tx: number; va: number; ar: number; st: number } } {
  if (state.length < BASIC_STATE_END - BASIC_STATE_START + 1) return { pointersOk: false, promptOk: false };
  const word = (i: number) => state[i] | (state[i + 1] << 8);
  const pointers = { tx: word(0), va: word(2), ar: word(4), st: word(6) };
  const pointersOk = pointers.tx === 0x0801 && pointers.va >= 0x0801 && pointers.ar >= 0x0801 && pointers.st >= 0x0801;
  const booted = state[BOOT_MARKER_ADDRESS - BASIC_STATE_START] !== BOOT_MARKER_VALUE;
  const screen = Buffer.from(state.subarray(SCREEN_OFFSET, SCREEN_OFFSET + 1000));
  const promptOk = pointersOk && booted && screen.indexOf(buildReadyPattern()) >= 0;
  return { pointersOk: pointersOk && booted, promptOk, pointers };
}

/**
 * Resets the machine and waits for the BASIC prompt with as little monitor traffic as possible.
 * Every monitor command stops the CPU, so polling during the KERNAL boot slows the boot itself.
 * This lets the machine run undisturbed for `firstCheckMs`, then checks with one memory read per
 * attempt and lengthens the gap between attempts. On success the CPU is left stopped in the
 * monitor, so the caller can continue without another stop.
 */
export async function resetAndWaitForBasic(
  bm: ViceClient,
  options: BootWaitOptions,
): Promise<{ pointersOk: boolean; promptOk: boolean }> {
  const timeoutMs = Math.max(1, options.timeoutMs);
  const maxGapMs = Math.max(1, options.maxGapMs ?? 400);
  await bm.memSet(BOOT_MARKER_ADDRESS, Buffer.from([BOOT_MARKER_VALUE]));
  await bm.reset();
  await exitMonitorIfNeeded(bm);
  const start = nowNs();
  let gap = Math.max(1, options.firstCheckMs);
  let nextGapMs = Math.max(1, options.initialGapMs ?? 120);
  let last = { pointersOk: false, promptOk: false };
  for (;;) {
    await new Promise((r) => setTimeout(r, gap));
    const state = await bm.memGet(BASIC_STATE_START, BASIC_STATE_END);
    const result = evaluateBootState(state);
    if (result.pointers) options.onSample?.(result.pointers);
    last = { pointersOk: result.pointersOk, promptOk: result.promptOk };
    if (result.promptOk) return last;
    if (msSince(start) >= timeoutMs) break;
    await exitMonitorIfNeeded(bm);
    gap = Math.min(nextGapMs, Math.max(1, timeoutMs - msSince(start)));
    nextGapMs = Math.min(maxGapMs, Math.ceil(nextGapMs * 1.5));
  }
  await exitMonitorIfNeeded(bm);
  return last;
}
