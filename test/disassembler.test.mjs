import test from "#test/runner";
import assert from "#test/assert";
import {
  disassemble,
  formatDisassembly,
  isUndocumentedOpcode,
  opcodeMetadata,
} from "../src/tools/disassembler.js";

test("disassembler covers the full 256-opcode space", () => {
  for (let opcode = 0; opcode < 256; opcode++) {
    const meta = opcodeMetadata(opcode);
    assert.ok(typeof meta.mnemonic === "string" && meta.mnemonic.length === 3, `opcode $${opcode.toString(16)} missing mnemonic`);
    assert.ok([1, 2, 3].includes(meta.size), `opcode $${opcode.toString(16)} unexpected size`);
    assert.equal(typeof meta.undocumented, "boolean");
  }
});

test("disassembler decodes official opcodes for a small program", () => {
  // LDA #$42 ; STA $0400 ; RTS
  const bytes = Uint8Array.of(0xA9, 0x42, 0x8D, 0x00, 0x04, 0x60);
  const lines = disassemble(bytes, 0x0801);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].mnemonic, "LDA");
  assert.equal(lines[0].operand, "#$42");
  assert.equal(lines[0].undocumented, false);
  assert.equal(lines[1].mnemonic, "STA");
  assert.equal(lines[1].operand, "$0400");
  assert.equal(lines[2].mnemonic, "RTS");
  assert.equal(lines[2].operand, "");
});

test("disassembler decodes undocumented SLO/SRE/DCP/ISC/JAM with canonical names", () => {
  const cases = [
    { byte: 0x07, expected: "SLO", note: "ASO -> SLO" },
    { byte: 0x47, expected: "SRE", note: "LSE -> SRE" },
    { byte: 0xC7, expected: "DCP", note: "DCM -> DCP" },
    { byte: 0xE7, expected: "ISC", note: "INS -> ISC" },
    { byte: 0x02, expected: "JAM", note: "HLT -> JAM" },
  ];
  for (const { byte, expected, note } of cases) {
    const meta = opcodeMetadata(byte);
    assert.equal(meta.mnemonic, expected, `${note} (opcode $${byte.toString(16).toUpperCase().padStart(2, "0")})`);
    assert.equal(meta.undocumented, true, `${note} should be marked undocumented`);
  }
});

test("disassembler can fall back to ??? when undocumented decoding is disabled", () => {
  const bytes = Uint8Array.of(0x02, 0xA9, 0x42); // JAM, then LDA #$42
  const allowed = disassemble(bytes, 0x0800, { count: 2 });
  assert.equal(allowed[0].mnemonic, "JAM");
  assert.equal(allowed[0].undocumented, true);
  assert.equal(allowed[1].mnemonic, "LDA");

  const denied = disassemble(bytes, 0x0800, { count: 2, allowUndocumented: false });
  assert.equal(denied[0].mnemonic, "???");
  assert.equal(denied[0].undocumented, true);
  assert.equal(denied[0].bytes.length, 1, "??? entries advance one byte");
  assert.equal(denied[1].mnemonic, "LDA");
});

test("disassembler annotates symbols and renders labels in formatted output", () => {
  // JSR $C000 ; JMP target_label
  const symbols = new Map([
    [0xC000, "INIT"],
    [0xC003, "MAIN"],
  ]);
  const bytes = Uint8Array.of(0x20, 0x00, 0xC0, 0x4C, 0x03, 0xC0);
  const lines = disassemble(bytes, 0xC000, undefined, symbols);
  assert.equal(lines[0].label, "INIT");
  assert.match(lines[0].operand, /INIT \(\$C000\)/);
  assert.match(lines[1].operand, /MAIN \(\$C003\)/);

  const formatted = formatDisassembly(lines);
  assert.match(formatted, /INIT:/);
  assert.match(formatted, /MAIN:/);
});

test("isUndocumentedOpcode classifies opcodes consistently with disassembly output", () => {
  // 0xEA NOP is official; 0x1A NOP is illegal per 1541U map
  assert.equal(isUndocumentedOpcode(0xEA), false);
  assert.equal(isUndocumentedOpcode(0x1A), true);
});

test("disassembler handles relative branches with signed offsets", () => {
  // BNE $0805 from $0800 = +3 (0x03), should target $0805
  const bytes = Uint8Array.of(0xD0, 0x03);
  const [line] = disassemble(bytes, 0x0800);
  assert.equal(line.mnemonic, "BNE");
  assert.equal(line.operand, "$0805");

  // BMI -2 (0xFE) from $1000 = $1000 + 2 - 2 = $1000
  const back = disassemble(Uint8Array.of(0x30, 0xFE), 0x1000);
  assert.equal(back[0].mnemonic, "BMI");
  assert.equal(back[0].operand, "$1000");
});

test("formatDisassembly marks undocumented instructions with an asterisk", () => {
  const bytes = Uint8Array.of(0x07, 0x10); // SLO $10 (illegal)
  const lines = disassemble(bytes, 0x0800);
  const text = formatDisassembly(lines);
  assert.match(text, /SLO\*/, "expected SLO to be flagged with *");
});
