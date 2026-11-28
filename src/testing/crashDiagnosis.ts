/**
 * Crash diagnosis from register samples and a 64 KB memory image as the CPU sees it.
 */
import { disassemble } from "../tools/translation/disassembler.js";

export type CrashVerdict = "running" | "jam" | "stuck_pc" | "pc_outside_code" | "stack_low";

export interface CpuSample {
  readonly pc: number;
  readonly sp: number;
}

export interface CrashInput {
  /** Samples in time order; the last one is the one reported. */
  readonly samples: readonly CpuSample[];
  /** 65536 bytes, read while the last sample's registers were current. */
  readonly memory: Uint8Array;
  /**
   * The CPU was stopped when the last sample was taken and was not resumed: either from the start
   * (one sample) or by a stop during sampling. The PC cannot then be judged as not moving.
   */
  readonly halted?: boolean;
  /** Values of the program's frame counter at the first and the last sample. */
  readonly frameCounter?: { readonly first: number; readonly last: number };
  readonly codeRange?: { readonly start: number; readonly end: number };
  /** Stack bytes to scan for return addresses. */
  readonly stackDepth: number;
  readonly symbols?: ReadonlyMap<number, string>;
}

export interface SymbolisedAddress {
  readonly address: string;
  readonly symbol?: string;
}

export interface CrashReport {
  readonly verdict: CrashVerdict;
  readonly pc: SymbolisedAddress;
  readonly opcodeAtPc: string;
  readonly port01: string;
  readonly vectors: Readonly<Record<"irq0314" | "brk0316" | "nmi0318" | "hardwareIrq" | "hardwareNmi" | "hardwareReset", SymbolisedAddress>>;
  readonly stack: ReadonlyArray<{ readonly returnAddress: string; readonly symbol?: string }>;
  readonly notes: string[];
}

/** Undocumented opcodes that halt the NMOS 6502 until reset. */
export const JAM_OPCODES: ReadonlySet<number> = new Set([0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2]);

const JSR = 0x20;
const STACK_LOW_LIMIT = 0x10;

export function formatWord(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function formatByte(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(2, "0")}`;
}

/** A label further below an address than this says nothing about it (for example a ROM address after a program label). */
const MAX_SYMBOL_OFFSET = 0x1000;

/** `label` or `label+offset` of the nearest label at or below the address. */
export function nearestSymbol(address: number, symbols: ReadonlyMap<number, string> | undefined): string | undefined {
  let best = -1;
  for (const candidate of symbols?.keys() ?? []) {
    if (candidate <= address && candidate > best) best = candidate;
  }
  if (best < 0 || address - best >= MAX_SYMBOL_OFFSET) return undefined;
  const name = symbols!.get(best)!;
  return best === address ? name : `${name}+${address - best}`;
}

function describe(address: number, symbols: ReadonlyMap<number, string> | undefined): SymbolisedAddress {
  const symbol = nearestSymbol(address, symbols);
  return { address: formatWord(address), ...(symbol ? { symbol } : {}) };
}

function label(entry: SymbolisedAddress): string {
  return entry.symbol ? `${entry.symbol} (${entry.address})` : entry.address;
}

/**
 * Return addresses on the stack. JSR pushes the address of its own third byte, so a byte pair
 * counts only when a JSR opcode stands two bytes before the address it holds.
 */
export function returnAddresses(memory: Uint8Array, sp: number, depth: number): number[] {
  const found: number[] = [];
  const end = Math.min(0x1ff, 0x100 + sp + depth);
  for (let at = 0x101 + sp; at < end; at += 1) {
    const pushed = memory[at]! | (memory[at + 1]! << 8);
    if (memory[(pushed - 2) & 0xffff] === JSR) {
      found.push((pushed + 1) & 0xffff);
      at += 1;
    }
  }
  return found;
}

export function diagnoseCrash(input: CrashInput): CrashReport {
  const { samples, memory, symbols, codeRange } = input;
  const last = samples[samples.length - 1]!;
  const word = (address: number) => memory[address]! | (memory[(address + 1) & 0xffff]! << 8);
  const opcode = memory[last.pc]!;
  const samePc = samples.every((sample) => sample.pc === last.pc);
  const outside = (pc: number) => codeRange !== undefined && (pc < codeRange.start || pc > codeRange.end);
  const pc = describe(last.pc, symbols);
  const returns = returnAddresses(memory, last.sp, input.stackDepth);
  const notes: string[] = [];
  if (input.halted) {
    notes.push(samples.length === 1
      ? "The CPU was already stopped and was not resumed: one sample was taken, so a PC that does not move cannot be detected."
      : `The CPU stopped during sampling (checkpoint, step or pause) and was not resumed: ${samples.length} samples were taken, and a PC that does not move cannot be detected.`);
  }
  const counting = input.frameCounter !== undefined && input.frameCounter.first !== input.frameCounter.last;

  let verdict: CrashVerdict = "running";
  if (JAM_OPCODES.has(opcode) && samePc) {
    verdict = "jam";
    notes.push(`JAM opcode ${formatByte(opcode)} at ${label(pc)}: the CPU is halted until a reset.`);
  } else if (samples.every((sample) => outside(sample.pc))) {
    verdict = "pc_outside_code";
    const caller = returns[0] === undefined ? undefined : describe((returns[0] - 3) & 0xffff, symbols);
    notes.push(`PC at ${label(pc)}, outside the code range ${formatWord(codeRange!.start)}-${formatWord(codeRange!.end)}${caller ? `, called from ${label(caller)}` : "; no return address was found on the stack"}.`);
    if (counting) {
      notes.push("The frame counter changed, so the program still runs. VICE takes the samples at frame boundaries, where a ROM routine or an interrupt handler outside the code range can be sampled every time.");
    }
  } else if (last.sp < STACK_LOW_LIMIT) {
    verdict = "stack_low";
    notes.push(`SP is ${formatByte(last.sp)}: the stack is close to overflowing.`);
  } else if (samePc && !input.halted && samples.length > 1 && counting) {
    notes.push(`Every sample had the PC at ${label(pc)}, but the frame counter changed, so the program is running. VICE takes the samples at frame boundaries, where a wait loop can show the same PC.`);
  } else if (samePc && !input.halted && samples.length > 1) {
    verdict = "stuck_pc";
    const [line] = disassemble(memory.subarray(last.pc, Math.min(last.pc + 3, 0x10000)), last.pc, 1, symbols);
    if (line) notes.push(`The PC did not move: ${`${line.mnemonic} ${line.operandLabel ?? line.operand}`.trim()} at ${label(pc)}.`);
    notes.push("VICE takes the samples at frame boundaries; pass frameCounter to tell a frame wait loop from a hang.");
  } else if (outside(last.pc)) {
    notes.push(`The PC of the last sample, ${label(pc)}, is outside the code range, but not every sample is: this can be an interrupt or a ROM call.`);
  }

  return {
    verdict,
    pc,
    opcodeAtPc: formatByte(opcode),
    port01: formatByte(memory[0x01]!),
    vectors: {
      irq0314: describe(word(0x0314), symbols),
      brk0316: describe(word(0x0316), symbols),
      nmi0318: describe(word(0x0318), symbols),
      hardwareIrq: describe(word(0xfffe), symbols),
      hardwareNmi: describe(word(0xfffa), symbols),
      hardwareReset: describe(word(0xfffc), symbols),
    },
    stack: returns.map((address) => {
      const symbol = nearestSymbol(address, symbols);
      return { returnAddress: formatWord(address), ...(symbol ? { symbol } : {}) };
    }),
    notes,
  };
}
