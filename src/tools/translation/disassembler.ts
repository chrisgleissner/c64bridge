/**
 * 6502/6510 disassembler covering the full 256-opcode space, including
 * undocumented (illegal) opcodes. Mnemonic naming follows the canonical
 * convention used by the 1541U monitor (HLT->JAM, ASO->SLO, LSE->SRE,
 * DCM->DCP, INS->ISC).
 */

import {
  OpcodeAddressingMode as Mode,
  OPCODES_BY_BYTE as OPCODES,
  opcodeSize as modeSize,
} from "./opcodeInventory.js";
import type { OpcodeAddressingMode } from "./opcodeInventory.js";

function hex2(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, "0");
}

function hex4(v: number): string {
  return v.toString(16).toUpperCase().padStart(4, "0");
}

function labelOrHex4(addr: number, symbols: ReadonlyMap<number, string> | undefined): string {
  const label = symbols?.get(addr);
  return label ? `${label} ($${hex4(addr)})` : `$${hex4(addr)}`;
}

function formatOperand(
  mode: OpcodeAddressingMode,
  bytes: Uint8Array,
  offset: number,
  instrAddr: number,
  symbols: ReadonlyMap<number, string> | undefined,
): string {
  switch (mode) {
    case Mode.Imp:
      return "";
    case Mode.Acc:
      return "A";
    case Mode.Imm:
      return `#$${hex2(bytes[offset + 1] ?? 0)}`;
    case Mode.Zp:
      return `$${hex2(bytes[offset + 1] ?? 0)}`;
    case Mode.ZpX:
      return `$${hex2(bytes[offset + 1] ?? 0)},X`;
    case Mode.ZpY:
      return `$${hex2(bytes[offset + 1] ?? 0)},Y`;
    case Mode.ZpS:
      return `$${hex2(bytes[offset + 1] ?? 0)},S`;
    case Mode.Rel: {
      const rel = bytes[offset + 1] ?? 0;
      const signed = rel >= 0x80 ? rel - 0x100 : rel;
      const target = (instrAddr + 2 + signed) & 0xffff;
      return labelOrHex4(target, symbols);
    }
    case Mode.Abs: {
      const lo = bytes[offset + 1] ?? 0;
      const hi = bytes[offset + 2] ?? 0;
      const addr = lo | (hi << 8);
      return labelOrHex4(addr, symbols);
    }
    case Mode.AbsX: {
      const lo = bytes[offset + 1] ?? 0;
      const hi = bytes[offset + 2] ?? 0;
      const addr = lo | (hi << 8);
      return `${labelOrHex4(addr, symbols)},X`;
    }
    case Mode.AbsY: {
      const lo = bytes[offset + 1] ?? 0;
      const hi = bytes[offset + 2] ?? 0;
      const addr = lo | (hi << 8);
      return `${labelOrHex4(addr, symbols)},Y`;
    }
    case Mode.Ind: {
      const lo = bytes[offset + 1] ?? 0;
      const hi = bytes[offset + 2] ?? 0;
      const addr = lo | (hi << 8);
      return `($${hex4(addr)})`;
    }
    case Mode.IndX:
      return `($${hex2(bytes[offset + 1] ?? 0)},X)`;
    case Mode.IndY:
      return `($${hex2(bytes[offset + 1] ?? 0)}),Y`;
  }
}

export interface DisassemblyLine {
  readonly address: number;
  readonly bytes: readonly number[];
  readonly label: string | undefined;
  readonly mnemonic: string;
  readonly operand: string;
  readonly undocumented: boolean;
}

export interface DisassembleOptions {
  readonly count?: number;
  readonly symbols?: ReadonlyMap<number, string>;
  /**
   * When false, undocumented opcodes are emitted as `???`. When true (default)
   * they are decoded with their canonical mnemonic and the `undocumented`
   * flag is set.
   */
  readonly allowUndocumented?: boolean;
}

/**
 * Disassemble a block of 6502/6510 bytes.
 *
 * @param bytes               Raw memory bytes (may be longer than needed)
 * @param baseAddress         The C64 memory address of `bytes[0]`
 * @param countOrOptions      Either a max-instruction count (legacy form) or an options object
 * @param symbols             Optional address->label map (legacy positional form)
 */
export function disassemble(
  bytes: Uint8Array,
  baseAddress: number,
  countOrOptions?: number | DisassembleOptions,
  symbols?: ReadonlyMap<number, string>,
): DisassemblyLine[] {
  const options: DisassembleOptions =
    typeof countOrOptions === "object" && countOrOptions !== null
      ? countOrOptions
      : { count: countOrOptions, symbols };
  const limit = options.count ?? Infinity;
  const symMap = options.symbols ?? symbols;
  const allowUndocumented = options.allowUndocumented !== false;

  const lines: DisassemblyLine[] = [];
  let offset = 0;

  while (offset < bytes.length && lines.length < limit) {
    const instrAddr = (baseAddress + offset) & 0xffff;
    const opcode = bytes[offset] ?? 0;
    const op = OPCODES[opcode]!;
    const label = symMap?.get(instrAddr);

    if (op.illegal && !allowUndocumented) {
      lines.push({
        address: instrAddr,
        bytes: [opcode],
        label,
        mnemonic: "???",
        operand: `$${hex2(opcode)}`,
        undocumented: true,
      });
      offset += 1;
      continue;
    }

    const size = modeSize(op.mode);
    const instrBytes: number[] = [];
    for (let i = 0; i < size && offset + i < bytes.length; i += 1) {
      instrBytes.push(bytes[offset + i] ?? 0);
    }

    const operand = formatOperand(op.mode, bytes, offset, instrAddr, symMap);

    lines.push({
      address: instrAddr,
      bytes: instrBytes,
      label,
      mnemonic: op.mnemonic,
      operand,
      undocumented: op.illegal,
    });

    offset += size;
  }

  return lines;
}

/**
 * Render disassembly lines as a human-readable string.
 * Format: [label:\n] $ADDR  XX XX XX  MNEM operand   ; *undocumented*
 */
export function formatDisassembly(lines: DisassemblyLine[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    if (line.label) {
      parts.push(`${line.label}:`);
    }
    const addrStr = `$${hex4(line.address)}`;
    const byteStr = line.bytes.map((b) => hex2(b)).join(" ").padEnd(8);
    const mnemonic = line.undocumented ? `${line.mnemonic}*` : line.mnemonic;
    const instrStr = line.operand
      ? `${mnemonic} ${line.operand}`
      : mnemonic;
    parts.push(`  ${addrStr}  ${byteStr}  ${instrStr}`);
  }
  return parts.join("\n");
}

/** Returns true when the opcode is undocumented per the 1541U reference. */
export function isUndocumentedOpcode(opcode: number): boolean {
  return OPCODES[opcode & 0xff]!.illegal;
}

/** Lookup helper used by tests to verify table coverage. */
export function opcodeMetadata(opcode: number): { mnemonic: string; undocumented: boolean; size: number } {
  const entry = OPCODES[opcode & 0xff]!;
  return { mnemonic: entry.mnemonic, undocumented: entry.illegal, size: modeSize(entry.mode) };
}
