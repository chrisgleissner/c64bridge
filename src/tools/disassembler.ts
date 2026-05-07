/**
 * 6502/6510 disassembler covering the full 256-opcode space, including
 * undocumented (illegal) opcodes. Mnemonic naming follows the canonical
 * convention used by the 1541U monitor (HLT->JAM, ASO->SLO, LSE->SRE,
 * DCM->DCP, INS->ISC).
 */

const enum Mode {
  Imp,    // implied                1 byte
  Acc,    // accumulator A          1 byte
  Imm,    // #$xx                   2 bytes
  Zp,     // $xx                    2 bytes
  ZpX,    // $xx,X                  2 bytes
  ZpY,    // $xx,Y                  2 bytes
  ZpS,    // $xx,S (illegal NOP)    2 bytes
  Rel,    // branch offset          2 bytes
  Abs,    // $xxxx                  3 bytes
  AbsX,   // $xxxx,X                3 bytes
  AbsY,   // $xxxx,Y                3 bytes
  Ind,    // ($xxxx)                3 bytes
  IndX,   // ($xx,X)                2 bytes
  IndY,   // ($xx),Y                2 bytes
}

interface OpcodeEntry {
  readonly mnemonic: string;
  readonly mode: Mode;
  readonly illegal: boolean;
}

function entry(mnemonic: string, mode: Mode, illegal = false): OpcodeEntry {
  return { mnemonic, mode, illegal };
}

// Canonicalization rules from disassembler_6502.cc:
//   HLT -> JAM, ASO -> SLO, LSE -> SRE, DCM -> DCP, INS -> ISC
function canonical(mnemonic: string): string {
  switch (mnemonic) {
    case "HLT": return "JAM";
    case "ASO": return "SLO";
    case "LSE": return "SRE";
    case "DCM": return "DCP";
    case "INS": return "ISC";
    default: return mnemonic;
  }
}

// 256-entry opcode table mirroring `opcode_templates` in disassembler_6502.cc.
// `illegal` is taken from the bitmap `illegal_map` in the same reference.
const OPCODES: ReadonlyArray<OpcodeEntry> = (() => {
  // Build the illegal-opcode bitmap from the reference file.
  const ILLEGAL_MAP: ReadonlyArray<number> = [
    0x989C, 0x9C9C, 0x888C, 0x9C9C,
    0x889C, 0x9C9C, 0x889C, 0x9C9C,
    0x8A8D, 0xD88C, 0x8888, 0x888C,
    0x888C, 0x9C9C, 0x888C, 0x9C9C,
  ];
  const isIllegal = (op: number): boolean => {
    const row = ILLEGAL_MAP[op >> 4]!;
    return ((row >> (op & 0x0F)) & 1) !== 0;
  };

  const t: OpcodeEntry[] = new Array(256);

  // Helper: fill one row of 16 entries by mnemonic/mode pairs.
  const set = (op: number, mnemonic: string, mode: Mode): void => {
    t[op] = { mnemonic: canonical(mnemonic), mode, illegal: isIllegal(op) };
  };

  // 0x00-0x0F
  set(0x00, "BRK", Mode.Imp);
  set(0x01, "ORA", Mode.IndX);
  set(0x02, "HLT", Mode.Imp);
  set(0x03, "ASO", Mode.IndX);
  set(0x04, "NOP", Mode.Zp);
  set(0x05, "ORA", Mode.Zp);
  set(0x06, "ASL", Mode.Zp);
  set(0x07, "ASO", Mode.Zp);
  set(0x08, "PHP", Mode.Imp);
  set(0x09, "ORA", Mode.Imm);
  set(0x0A, "ASL", Mode.Acc);
  set(0x0B, "ANC", Mode.Imm);
  set(0x0C, "NOP", Mode.Abs);
  set(0x0D, "ORA", Mode.Abs);
  set(0x0E, "ASL", Mode.Abs);
  set(0x0F, "ASO", Mode.Abs);
  // 0x10-0x1F
  set(0x10, "BPL", Mode.Rel);
  set(0x11, "ORA", Mode.IndY);
  set(0x12, "HLT", Mode.Imp);
  set(0x13, "ASO", Mode.IndY);
  set(0x14, "NOP", Mode.ZpX);
  set(0x15, "ORA", Mode.ZpX);
  set(0x16, "ASL", Mode.ZpX);
  set(0x17, "ASO", Mode.ZpX);
  set(0x18, "CLC", Mode.Imp);
  set(0x19, "ORA", Mode.AbsY);
  set(0x1A, "NOP", Mode.Imp);
  set(0x1B, "ASO", Mode.AbsY);
  set(0x1C, "NOP", Mode.AbsX);
  set(0x1D, "ORA", Mode.AbsX);
  set(0x1E, "ASL", Mode.AbsX);
  set(0x1F, "ASO", Mode.AbsX);
  // 0x20-0x2F
  set(0x20, "JSR", Mode.Abs);
  set(0x21, "AND", Mode.IndX);
  set(0x22, "HLT", Mode.Imp);
  set(0x23, "RLA", Mode.IndX);
  set(0x24, "BIT", Mode.Zp);
  set(0x25, "AND", Mode.Zp);
  set(0x26, "ROL", Mode.Zp);
  set(0x27, "RLA", Mode.Zp);
  set(0x28, "PLP", Mode.Imp);
  set(0x29, "AND", Mode.Imm);
  set(0x2A, "ROL", Mode.Acc);
  set(0x2B, "ANC", Mode.Imm);
  set(0x2C, "BIT", Mode.Abs);
  set(0x2D, "AND", Mode.Abs);
  set(0x2E, "ROL", Mode.Abs);
  set(0x2F, "RLA", Mode.Abs);
  // 0x30-0x3F
  set(0x30, "BMI", Mode.Rel);
  set(0x31, "AND", Mode.IndY);
  set(0x32, "HLT", Mode.Imp);
  set(0x33, "RLA", Mode.IndY);
  set(0x34, "NOP", Mode.ZpX);
  set(0x35, "AND", Mode.ZpX);
  set(0x36, "ROL", Mode.ZpX);
  set(0x37, "RLA", Mode.ZpX);
  set(0x38, "SEC", Mode.Imp);
  set(0x39, "AND", Mode.AbsY);
  set(0x3A, "NOP", Mode.Imp);
  set(0x3B, "RLA", Mode.AbsY);
  set(0x3C, "NOP", Mode.AbsX);
  set(0x3D, "AND", Mode.AbsX);
  set(0x3E, "ROL", Mode.AbsX);
  set(0x3F, "RLA", Mode.AbsX);
  // 0x40-0x4F
  set(0x40, "RTI", Mode.Imp);
  set(0x41, "EOR", Mode.IndX);
  set(0x42, "HLT", Mode.Imp);
  set(0x43, "LSE", Mode.IndX);
  set(0x44, "NOP", Mode.Zp);
  set(0x45, "EOR", Mode.Zp);
  set(0x46, "LSR", Mode.Zp);
  set(0x47, "LSE", Mode.Zp);
  set(0x48, "PHA", Mode.Imp);
  set(0x49, "EOR", Mode.Imm);
  set(0x4A, "LSR", Mode.Acc);
  set(0x4B, "ALR", Mode.Imm);
  set(0x4C, "JMP", Mode.Abs);
  set(0x4D, "EOR", Mode.Abs);
  set(0x4E, "LSR", Mode.Abs);
  set(0x4F, "LSE", Mode.Abs);
  // 0x50-0x5F
  set(0x50, "BVC", Mode.Rel);
  set(0x51, "EOR", Mode.IndY);
  set(0x52, "HLT", Mode.Imp);
  set(0x53, "LSE", Mode.IndY);
  set(0x54, "NOP", Mode.ZpX);
  set(0x55, "EOR", Mode.ZpX);
  set(0x56, "LSR", Mode.ZpX);
  set(0x57, "LSE", Mode.ZpX);
  set(0x58, "CLI", Mode.Imp);
  set(0x59, "EOR", Mode.AbsY);
  set(0x5A, "NOP", Mode.Imp);
  set(0x5B, "LSE", Mode.AbsY);
  set(0x5C, "NOP", Mode.AbsX);
  set(0x5D, "EOR", Mode.AbsX);
  set(0x5E, "LSR", Mode.AbsX);
  set(0x5F, "LSE", Mode.AbsX);
  // 0x60-0x6F
  set(0x60, "RTS", Mode.Imp);
  set(0x61, "ADC", Mode.IndX);
  set(0x62, "HLT", Mode.Imp);
  set(0x63, "RRA", Mode.IndX);
  set(0x64, "NOP", Mode.Zp);
  set(0x65, "ADC", Mode.Zp);
  set(0x66, "ROR", Mode.Zp);
  set(0x67, "RRA", Mode.Zp);
  set(0x68, "PLA", Mode.Imp);
  set(0x69, "ADC", Mode.Imm);
  set(0x6A, "ROR", Mode.Acc);
  set(0x6B, "ARR", Mode.Imm);
  set(0x6C, "JMP", Mode.Ind);
  set(0x6D, "ADC", Mode.Abs);
  set(0x6E, "ROR", Mode.Abs);
  set(0x6F, "RRA", Mode.Abs);
  // 0x70-0x7F
  set(0x70, "BVS", Mode.Rel);
  set(0x71, "ADC", Mode.IndY);
  set(0x72, "HLT", Mode.Imp);
  set(0x73, "RRA", Mode.IndY);
  set(0x74, "NOP", Mode.ZpX);
  set(0x75, "ADC", Mode.ZpX);
  set(0x76, "ROR", Mode.ZpX);
  set(0x77, "RRA", Mode.ZpX);
  set(0x78, "SEI", Mode.Imp);
  set(0x79, "ADC", Mode.AbsY);
  set(0x7A, "NOP", Mode.Imp);
  set(0x7B, "RRA", Mode.AbsY);
  set(0x7C, "NOP", Mode.AbsX);
  set(0x7D, "ADC", Mode.AbsX);
  set(0x7E, "ROR", Mode.AbsX);
  set(0x7F, "RRA", Mode.AbsX);
  // 0x80-0x8F
  set(0x80, "NOP", Mode.Imm);
  set(0x81, "STA", Mode.IndX);
  set(0x82, "NOP", Mode.Imm);
  set(0x83, "SAX", Mode.IndX);
  set(0x84, "STY", Mode.Zp);
  set(0x85, "STA", Mode.Zp);
  set(0x86, "STX", Mode.Zp);
  set(0x87, "SAX", Mode.Zp);
  set(0x88, "DEY", Mode.Imp);
  set(0x89, "NOP", Mode.Imm);
  set(0x8A, "TXA", Mode.Imp);
  set(0x8B, "XAA", Mode.Imm);
  set(0x8C, "STY", Mode.Abs);
  set(0x8D, "STA", Mode.Abs);
  set(0x8E, "STX", Mode.Abs);
  set(0x8F, "SAX", Mode.Abs);
  // 0x90-0x9F
  set(0x90, "BCC", Mode.Rel);
  set(0x91, "STA", Mode.IndY);
  set(0x92, "HLT", Mode.Imp);
  set(0x93, "AHX", Mode.IndY);
  set(0x94, "STY", Mode.ZpX);
  set(0x95, "STA", Mode.ZpX);
  set(0x96, "STX", Mode.ZpY);
  set(0x97, "SAX", Mode.ZpY);
  set(0x98, "TYA", Mode.Imp);
  set(0x99, "STA", Mode.AbsY);
  set(0x9A, "TXS", Mode.Imp);
  set(0x9B, "TAS", Mode.AbsY);
  set(0x9C, "SHY", Mode.AbsX);
  set(0x9D, "STA", Mode.AbsX);
  set(0x9E, "SHX", Mode.AbsY);
  set(0x9F, "AHX", Mode.AbsY);
  // 0xA0-0xAF
  set(0xA0, "LDY", Mode.Imm);
  set(0xA1, "LDA", Mode.IndX);
  set(0xA2, "LDX", Mode.Imm);
  set(0xA3, "LAX", Mode.IndX);
  set(0xA4, "LDY", Mode.Zp);
  set(0xA5, "LDA", Mode.Zp);
  set(0xA6, "LDX", Mode.Zp);
  set(0xA7, "LAX", Mode.Zp);
  set(0xA8, "TAY", Mode.Imp);
  set(0xA9, "LDA", Mode.Imm);
  set(0xAA, "TAX", Mode.Imp);
  set(0xAB, "LAX", Mode.Imm);
  set(0xAC, "LDY", Mode.Abs);
  set(0xAD, "LDA", Mode.Abs);
  set(0xAE, "LDX", Mode.Abs);
  set(0xAF, "LAX", Mode.Abs);
  // 0xB0-0xBF
  set(0xB0, "BCS", Mode.Rel);
  set(0xB1, "LDA", Mode.IndY);
  set(0xB2, "HLT", Mode.Imp);
  set(0xB3, "LAX", Mode.IndY);
  set(0xB4, "LDY", Mode.ZpX);
  set(0xB5, "LDA", Mode.ZpX);
  set(0xB6, "LDX", Mode.ZpY);
  set(0xB7, "LAX", Mode.ZpY);
  set(0xB8, "CLV", Mode.Imp);
  set(0xB9, "LDA", Mode.AbsY);
  set(0xBA, "TSX", Mode.Imp);
  set(0xBB, "LAS", Mode.AbsY);
  set(0xBC, "LDY", Mode.AbsX);
  set(0xBD, "LDA", Mode.AbsX);
  set(0xBE, "LDX", Mode.AbsY);
  set(0xBF, "LAX", Mode.AbsY);
  // 0xC0-0xCF
  set(0xC0, "CPY", Mode.Imm);
  set(0xC1, "CMP", Mode.IndX);
  set(0xC2, "NOP", Mode.Imm);
  set(0xC3, "DCM", Mode.IndX);
  set(0xC4, "CPY", Mode.Zp);
  set(0xC5, "CMP", Mode.Zp);
  set(0xC6, "DEC", Mode.Zp);
  set(0xC7, "DCM", Mode.Zp);
  set(0xC8, "INY", Mode.Imp);
  set(0xC9, "CMP", Mode.Imm);
  set(0xCA, "DEX", Mode.Imp);
  set(0xCB, "AXS", Mode.Imm);
  set(0xCC, "CPY", Mode.Abs);
  set(0xCD, "CMP", Mode.Abs);
  set(0xCE, "DEC", Mode.Abs);
  set(0xCF, "DCM", Mode.Abs);
  // 0xD0-0xDF
  set(0xD0, "BNE", Mode.Rel);
  set(0xD1, "CMP", Mode.IndY);
  set(0xD2, "HLT", Mode.Imp);
  set(0xD3, "DCM", Mode.IndY);
  set(0xD4, "NOP", Mode.ZpX);
  set(0xD5, "CMP", Mode.ZpX);
  set(0xD6, "DEC", Mode.ZpX);
  set(0xD7, "DCM", Mode.ZpX);
  set(0xD8, "CLD", Mode.Imp);
  set(0xD9, "CMP", Mode.AbsY);
  set(0xDA, "NOP", Mode.Imp);
  set(0xDB, "DCM", Mode.AbsY);
  set(0xDC, "NOP", Mode.AbsX);
  set(0xDD, "CMP", Mode.AbsX);
  set(0xDE, "DEC", Mode.AbsX);
  set(0xDF, "DCM", Mode.AbsX);
  // 0xE0-0xEF
  set(0xE0, "CPX", Mode.Imm);
  set(0xE1, "SBC", Mode.IndX);
  set(0xE2, "NOP", Mode.Imm);
  set(0xE3, "INS", Mode.IndX);
  set(0xE4, "CPX", Mode.Zp);
  set(0xE5, "SBC", Mode.Zp);
  set(0xE6, "INC", Mode.Zp);
  set(0xE7, "INS", Mode.Zp);
  set(0xE8, "INX", Mode.Imp);
  set(0xE9, "SBC", Mode.Imm);
  set(0xEA, "NOP", Mode.Imp);
  set(0xEB, "SBC", Mode.Imm);
  set(0xEC, "CPX", Mode.Abs);
  set(0xED, "SBC", Mode.Abs);
  set(0xEE, "INC", Mode.Abs);
  set(0xEF, "INS", Mode.Abs);
  // 0xF0-0xFF
  set(0xF0, "BEQ", Mode.Rel);
  set(0xF1, "SBC", Mode.IndY);
  set(0xF2, "HLT", Mode.Imp);
  set(0xF3, "INS", Mode.IndY);
  set(0xF4, "NOP", Mode.ZpS);
  set(0xF5, "SBC", Mode.ZpX);
  set(0xF6, "INC", Mode.ZpX);
  set(0xF7, "INS", Mode.ZpX);
  set(0xF8, "SED", Mode.Imp);
  set(0xF9, "SBC", Mode.AbsY);
  set(0xFA, "NOP", Mode.Imp);
  set(0xFB, "INS", Mode.AbsY);
  set(0xFC, "NOP", Mode.AbsX);
  set(0xFD, "SBC", Mode.AbsX);
  set(0xFE, "INC", Mode.AbsX);
  set(0xFF, "INS", Mode.AbsX);

  return t;
})();

function modeSize(mode: Mode): number {
  switch (mode) {
    case Mode.Imp:
    case Mode.Acc:
      return 1;
    case Mode.Imm:
    case Mode.Zp:
    case Mode.ZpX:
    case Mode.ZpY:
    case Mode.ZpS:
    case Mode.Rel:
    case Mode.IndX:
    case Mode.IndY:
      return 2;
    case Mode.Abs:
    case Mode.AbsX:
    case Mode.AbsY:
    case Mode.Ind:
      return 3;
  }
}

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
  mode: Mode,
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
    for (let i = 0; i < size && offset + i < bytes.length; i++) {
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
