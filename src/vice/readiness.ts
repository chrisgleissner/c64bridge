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
    else if (ch === ' ') out.push(0x20);
    else if (ch === '.') out.push(0x2E);
    else if (ch === ':') out.push(0x3A);
    else if (ch === '-') out.push(0x2D);
    // extend as needed; ignore others
  }
  return Buffer.from(out);
}
