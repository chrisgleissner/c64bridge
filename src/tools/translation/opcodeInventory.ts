/**
 * Shared 6502/6510 opcode inventory.
 *
 * Entries are sorted by increasing binary opcode and cover the complete
 * 256-byte opcode space, including undocumented opcodes. Mnemonic naming
 * follows the canonical 1541U monitor convention:
 * HLT -> JAM, ASO -> SLO, LSE -> SRE, DCM -> DCP, INS -> ISC.
 */

export const OpcodeAddressingMode = {
  Imp: "implied",
  Acc: "accumulator",
  Imm: "immediate",
  Zp: "zeroPage",
  ZpX: "zeroPageX",
  ZpY: "zeroPageY",
  ZpS: "zeroPageS",
  Rel: "relative",
  Abs: "absolute",
  AbsX: "absoluteX",
  AbsY: "absoluteY",
  Ind: "indirect",
  IndX: "indirectX",
  IndY: "indirectY",
} as const;

export type OpcodeAddressingMode = typeof OpcodeAddressingMode[keyof typeof OpcodeAddressingMode];

export interface OpcodeInventoryEntry {
  readonly opcode: number;
  readonly mnemonic: string;
  readonly mode: OpcodeAddressingMode;
  readonly illegal: boolean;
}

type OpcodeTemplate = readonly [mnemonic: string, mode: OpcodeAddressingMode];

const M = OpcodeAddressingMode;

const OPCODE_ROWS = [
  // 0x00-0x0F
  [["BRK", M.Imp], ["ORA", M.IndX], ["HLT", M.Imp], ["ASO", M.IndX], ["NOP", M.Zp], ["ORA", M.Zp], ["ASL", M.Zp], ["ASO", M.Zp], ["PHP", M.Imp], ["ORA", M.Imm], ["ASL", M.Acc], ["ANC", M.Imm], ["NOP", M.Abs], ["ORA", M.Abs], ["ASL", M.Abs], ["ASO", M.Abs]],
  // 0x10-0x1F
  [["BPL", M.Rel], ["ORA", M.IndY], ["HLT", M.Imp], ["ASO", M.IndY], ["NOP", M.ZpX], ["ORA", M.ZpX], ["ASL", M.ZpX], ["ASO", M.ZpX], ["CLC", M.Imp], ["ORA", M.AbsY], ["NOP", M.Imp], ["ASO", M.AbsY], ["NOP", M.AbsX], ["ORA", M.AbsX], ["ASL", M.AbsX], ["ASO", M.AbsX]],
  // 0x20-0x2F
  [["JSR", M.Abs], ["AND", M.IndX], ["HLT", M.Imp], ["RLA", M.IndX], ["BIT", M.Zp], ["AND", M.Zp], ["ROL", M.Zp], ["RLA", M.Zp], ["PLP", M.Imp], ["AND", M.Imm], ["ROL", M.Acc], ["ANC", M.Imm], ["BIT", M.Abs], ["AND", M.Abs], ["ROL", M.Abs], ["RLA", M.Abs]],
  // 0x30-0x3F
  [["BMI", M.Rel], ["AND", M.IndY], ["HLT", M.Imp], ["RLA", M.IndY], ["NOP", M.ZpX], ["AND", M.ZpX], ["ROL", M.ZpX], ["RLA", M.ZpX], ["SEC", M.Imp], ["AND", M.AbsY], ["NOP", M.Imp], ["RLA", M.AbsY], ["NOP", M.AbsX], ["AND", M.AbsX], ["ROL", M.AbsX], ["RLA", M.AbsX]],
  // 0x40-0x4F
  [["RTI", M.Imp], ["EOR", M.IndX], ["HLT", M.Imp], ["LSE", M.IndX], ["NOP", M.Zp], ["EOR", M.Zp], ["LSR", M.Zp], ["LSE", M.Zp], ["PHA", M.Imp], ["EOR", M.Imm], ["LSR", M.Acc], ["ALR", M.Imm], ["JMP", M.Abs], ["EOR", M.Abs], ["LSR", M.Abs], ["LSE", M.Abs]],
  // 0x50-0x5F
  [["BVC", M.Rel], ["EOR", M.IndY], ["HLT", M.Imp], ["LSE", M.IndY], ["NOP", M.ZpX], ["EOR", M.ZpX], ["LSR", M.ZpX], ["LSE", M.ZpX], ["CLI", M.Imp], ["EOR", M.AbsY], ["NOP", M.Imp], ["LSE", M.AbsY], ["NOP", M.AbsX], ["EOR", M.AbsX], ["LSR", M.AbsX], ["LSE", M.AbsX]],
  // 0x60-0x6F
  [["RTS", M.Imp], ["ADC", M.IndX], ["HLT", M.Imp], ["RRA", M.IndX], ["NOP", M.Zp], ["ADC", M.Zp], ["ROR", M.Zp], ["RRA", M.Zp], ["PLA", M.Imp], ["ADC", M.Imm], ["ROR", M.Acc], ["ARR", M.Imm], ["JMP", M.Ind], ["ADC", M.Abs], ["ROR", M.Abs], ["RRA", M.Abs]],
  // 0x70-0x7F
  [["BVS", M.Rel], ["ADC", M.IndY], ["HLT", M.Imp], ["RRA", M.IndY], ["NOP", M.ZpX], ["ADC", M.ZpX], ["ROR", M.ZpX], ["RRA", M.ZpX], ["SEI", M.Imp], ["ADC", M.AbsY], ["NOP", M.Imp], ["RRA", M.AbsY], ["NOP", M.AbsX], ["ADC", M.AbsX], ["ROR", M.AbsX], ["RRA", M.AbsX]],
  // 0x80-0x8F
  [["NOP", M.Imm], ["STA", M.IndX], ["NOP", M.Imm], ["SAX", M.IndX], ["STY", M.Zp], ["STA", M.Zp], ["STX", M.Zp], ["SAX", M.Zp], ["DEY", M.Imp], ["NOP", M.Imm], ["TXA", M.Imp], ["XAA", M.Imm], ["STY", M.Abs], ["STA", M.Abs], ["STX", M.Abs], ["SAX", M.Abs]],
  // 0x90-0x9F
  [["BCC", M.Rel], ["STA", M.IndY], ["HLT", M.Imp], ["AHX", M.IndY], ["STY", M.ZpX], ["STA", M.ZpX], ["STX", M.ZpY], ["SAX", M.ZpY], ["TYA", M.Imp], ["STA", M.AbsY], ["TXS", M.Imp], ["TAS", M.AbsY], ["SHY", M.AbsX], ["STA", M.AbsX], ["SHX", M.AbsY], ["AHX", M.AbsY]],
  // 0xA0-0xAF
  [["LDY", M.Imm], ["LDA", M.IndX], ["LDX", M.Imm], ["LAX", M.IndX], ["LDY", M.Zp], ["LDA", M.Zp], ["LDX", M.Zp], ["LAX", M.Zp], ["TAY", M.Imp], ["LDA", M.Imm], ["TAX", M.Imp], ["LAX", M.Imm], ["LDY", M.Abs], ["LDA", M.Abs], ["LDX", M.Abs], ["LAX", M.Abs]],
  // 0xB0-0xBF
  [["BCS", M.Rel], ["LDA", M.IndY], ["HLT", M.Imp], ["LAX", M.IndY], ["LDY", M.ZpX], ["LDA", M.ZpX], ["LDX", M.ZpY], ["LAX", M.ZpY], ["CLV", M.Imp], ["LDA", M.AbsY], ["TSX", M.Imp], ["LAS", M.AbsY], ["LDY", M.AbsX], ["LDA", M.AbsX], ["LDX", M.AbsY], ["LAX", M.AbsY]],
  // 0xC0-0xCF
  [["CPY", M.Imm], ["CMP", M.IndX], ["NOP", M.Imm], ["DCM", M.IndX], ["CPY", M.Zp], ["CMP", M.Zp], ["DEC", M.Zp], ["DCM", M.Zp], ["INY", M.Imp], ["CMP", M.Imm], ["DEX", M.Imp], ["AXS", M.Imm], ["CPY", M.Abs], ["CMP", M.Abs], ["DEC", M.Abs], ["DCM", M.Abs]],
  // 0xD0-0xDF
  [["BNE", M.Rel], ["CMP", M.IndY], ["HLT", M.Imp], ["DCM", M.IndY], ["NOP", M.ZpX], ["CMP", M.ZpX], ["DEC", M.ZpX], ["DCM", M.ZpX], ["CLD", M.Imp], ["CMP", M.AbsY], ["NOP", M.Imp], ["DCM", M.AbsY], ["NOP", M.AbsX], ["CMP", M.AbsX], ["DEC", M.AbsX], ["DCM", M.AbsX]],
  // 0xE0-0xEF
  [["CPX", M.Imm], ["SBC", M.IndX], ["NOP", M.Imm], ["INS", M.IndX], ["CPX", M.Zp], ["SBC", M.Zp], ["INC", M.Zp], ["INS", M.Zp], ["INX", M.Imp], ["SBC", M.Imm], ["NOP", M.Imp], ["SBC", M.Imm], ["CPX", M.Abs], ["SBC", M.Abs], ["INC", M.Abs], ["INS", M.Abs]],
  // 0xF0-0xFF
  [["BEQ", M.Rel], ["SBC", M.IndY], ["HLT", M.Imp], ["INS", M.IndY], ["NOP", M.ZpS], ["SBC", M.ZpX], ["INC", M.ZpX], ["INS", M.ZpX], ["SED", M.Imp], ["SBC", M.AbsY], ["NOP", M.Imp], ["INS", M.AbsY], ["NOP", M.AbsX], ["SBC", M.AbsX], ["INC", M.AbsX], ["INS", M.AbsX]],
] as const satisfies ReadonlyArray<ReadonlyArray<OpcodeTemplate>>;

const ILLEGAL_MAP: ReadonlyArray<number> = [
  0x989C, 0x9C9C, 0x888C, 0x9C9C,
  0x889C, 0x9C9C, 0x889C, 0x9C9C,
  0x8A8D, 0xD88C, 0x8888, 0x888C,
  0x888C, 0x9C9C, 0x888C, 0x9C9C,
];

function isIllegal(opcode: number): boolean {
  const row = ILLEGAL_MAP[opcode >> 4]!;
  return ((row >> (opcode & 0x0F)) & 1) !== 0;
}

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

function buildOpcodeInventory(): OpcodeInventoryEntry[] {
  const entries = OPCODE_ROWS.flatMap((row, rowIndex) =>
    row.map(([mnemonic, mode], columnIndex) => {
      const opcode = (rowIndex << 4) | columnIndex;
      return {
        opcode,
        mnemonic: canonical(mnemonic),
        mode,
        illegal: isIllegal(opcode),
      };
    }),
  );
  validateOpcodeInventory(entries);
  return entries;
}

function validateOpcodeInventory(entries: readonly OpcodeInventoryEntry[]): void {
  if (entries.length !== 256) {
    throw new Error(`Opcode inventory must contain 256 entries, found ${entries.length}`);
  }
  for (let opcode = 0; opcode < 256; opcode += 1) {
    const entry = entries[opcode];
    if (!entry || entry.opcode !== opcode) {
      throw new Error(`Opcode inventory is not sorted at $${opcode.toString(16).padStart(2, "0")}`);
    }
  }
}

export function opcodeSize(mode: OpcodeAddressingMode): number {
  switch (mode) {
    case M.Imp:
    case M.Acc:
      return 1;
    case M.Imm:
    case M.Zp:
    case M.ZpX:
    case M.ZpY:
    case M.ZpS:
    case M.Rel:
    case M.IndX:
    case M.IndY:
      return 2;
    case M.Abs:
    case M.AbsX:
    case M.AbsY:
    case M.Ind:
      return 3;
  }
}

export const OPCODE_INVENTORY: readonly OpcodeInventoryEntry[] = Object.freeze(buildOpcodeInventory());
export const OPCODES_BY_BYTE: readonly OpcodeInventoryEntry[] = OPCODE_INVENTORY;
