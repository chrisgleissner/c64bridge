import { Buffer } from "node:buffer";
import type { C64Facade } from "./device.js";
import { SIDWAVE_PLAYER, isSidwaveIrqHandler } from "sidwave/compiler";

export const BASIC_IRQ = 0xea31;
const KEY_BUFFER = 0x0277;
const KEY_COUNT = 0xc6;

export async function irqVector(facade: C64Facade): Promise<number> {
  const bytes = await facade.readMemory(0x0314, 2);
  return (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8);
}

/** Recognize the original SIDWAVE IRQ stub, including players loaded outside this session. */
export async function isSidwaveIrq(facade: C64Facade, handler: number): Promise<boolean> {
  if (handler < 0x0816 || handler > 0xcffa || handler === BASIC_IRQ) return false;
  const code = await facade.readMemory(handler, SIDWAVE_PLAYER.irqHandler.length);
  const vector = await facade.readMemory(SIDWAVE_PLAYER.playAddress, SIDWAVE_PLAYER.playVectorLength);
  return isSidwaveIrqHandler(code, vector);
}

export async function keyboardIdle(facade: C64Facade): Promise<boolean> {
  return (await facade.readMemory(KEY_COUNT, 1))[0] === 0;
}

export async function basicReady(facade: C64Facade): Promise<boolean> {
  // CURLIN+1 ($3A) is $FF in direct mode after a direct command, and $00 at the READY prompt that follows a
  // reset (measured on the Ultimate 64 Elite, firmware 3.15a, 2026-11-20). The READY line and the idle
  // editor state below separate both from a running program.
  const curlinHigh = (await facade.readMemory(0x3a, 1))[0];
  const direct = curlinHigh === 0xff || curlinHigh === 0x00;
  const editor = await facade.readMemory(0xc5, 0x12);
  // LSTX = no key held, NDX = no pending input, PNTR = left margin.
  const cursor = editor[0xd6 - 0xc5] ?? 0;
  if (!direct || editor[0] !== 0x40 || editor[1] !== 0 || editor[0xd3 - 0xc5] !== 0 || cursor < 1 || cursor > 24) {
    return false;
  }
  const page = (await facade.readMemory(0x0288, 1))[0] ?? 0;
  if (page < 4 || page > 0xfc) return false;
  const screen = await facade.readMemory(page * 256 + (cursor - 1) * 40, 80);
  const ready = [18, 5, 1, 4, 25, 46];
  return screen.length === 80 && ready.every((code, i) => (screen[i]! & 0x7f) === code)
    && screen.subarray(ready.length).every((code) => (code & 0x7f) === 0x20);
}

export async function dmaStartSidwave(facade: C64Facade, prg: Buffer, entry: number): Promise<void> {
  const keys = Buffer.from(`SYS ${entry}\r`, "ascii");
  if (keys.length > 10) throw new Error("SIDWAVE SYS command does not fit the KERNAL queue");
  await facade.writeMemory(prg.readUInt16LE(0), prg.subarray(2));
  if (!await keyboardIdle(facade)) throw new Error("The BASIC keyboard queue became busy during SIDWAVE upload");
  await facade.writeMemory(KEY_BUFFER, keys);
  await facade.writeMemory(KEY_COUNT, Uint8Array.of(keys.length));
}
