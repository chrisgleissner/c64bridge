import test from "#test/runner";
import assert from "#test/assert";
import { assemblyToPrg, AssemblyError } from "../src/tools/assembler.js";
import { disassemble } from "../src/tools/disassembler.js";

test("assemblyToPrg assembles simple program with default load address", () => {
  const source = `
    .org $0801
start:
    lda #$42
    sta $0400
    rts
  `;

  const prg = assemblyToPrg(source);

  const expected = Buffer.from([
    0x01, 0x08, // load address
    0xa9, 0x42, // LDA #$42
    0x8d, 0x00, 0x04, // STA $0400
    0x60, // RTS
  ]);

  assert.equal(prg.length, expected.length);
  assert.deepEqual([...prg], [...expected]);
});

test("assemblyToPrg picks zero page or absolute opcodes based on operands", () => {
  const source = `
    org $0801
    lda #1
    sta $10
    sta $1234
    sta $10,X
    sta $2000,x
    rts
  `;

  const prg = assemblyToPrg(source);

  const expected = Buffer.from([
    0x01, 0x08,
    0xa9, 0x01, // LDA #1
    0x85, 0x10, // STA $10 (zero page)
    0x8d, 0x34, 0x12, // STA $1234 (absolute)
    0x95, 0x10, // STA $10,X (zero page,X)
    0x9d, 0x00, 0x20, // STA $2000,X (absolute,X)
    0x60, // RTS
  ]);

  assert.deepEqual([...prg], [...expected]);
});

test("assemblyToPrg encodes relative branches and local labels", () => {
  const source = `
    * = $0801
start:
    beq .skip
    nop
.skip:
    bne end
    nop
end:
    rts
  `;

  const prg = assemblyToPrg(source);

  const expected = Buffer.from([
    0x01, 0x08,
    0xf0, 0x01, // BEQ to .skip (skip the next instruction)
    0xea, // NOP
    0xd0, 0x01, // BNE end
    0xea, // NOP
    0x60, // RTS
  ]);

  assert.deepEqual([...prg], [...expected]);
});

test("assemblyToPrg handles directives and expressions", () => {
  const source = `
    .org $0801
value = $4000
start:
    jsr init
    rts
init:
    .byte $01,"AB"
    .word value + 1
    ds 2
    rts
  `;

  const prg = assemblyToPrg(source);
  const expected = Buffer.from([
    0x01, 0x08,
    0x20, 0x05, 0x08, // JSR init
    0x60, // RTS
    0x01, // .byte $01
    0x41, 0x42, // "AB"
    0x01, 0x40, // .word value + 1
    0x00, 0x00, // ds 2
    0x60, // RTS
  ]);

  assert.deepEqual([...prg], [...expected]);
});

test("assemblyToPrg reports undefined symbols", () => {
  const source = `
    org $0801
    lda missing
  `;

  assert.throws(
    () => assemblyToPrg(source),
    (error) => error instanceof AssemblyError && /Undefined expression/iu.test(error.message),
  );
});

test("assemblyToPrg roundtrips undocumented opcodes supported by the disassembler", () => {
  const source = `
    org $0801
    jam
    slo ($10,X)
    slo $10
    slo $1234
    slo ($10),Y
    slo $10,X
    slo $1234,Y
    slo $1234,X
    nop $10
    nop $1234
    nop $10,X
    nop $1234,X
    nop #$10
    nop $10,S
    anc #$10
    rla ($10,X)
    rla $10
    rla $1234
    rla ($10),Y
    rla $10,X
    rla $1234,Y
    rla $1234,X
    sre ($10,X)
    sre $10
    sre $1234
    sre ($10),Y
    sre $10,X
    sre $1234,Y
    sre $1234,X
    alr #$10
    rra ($10,X)
    rra $10
    rra $1234
    rra ($10),Y
    rra $10,X
    rra $1234,Y
    rra $1234,X
    arr #$10
    sax ($10,X)
    sax $10
    sax $1234
    sax $10,Y
    xaa #$10
    ahx ($10),Y
    ahx $1234,Y
    tas $1234,Y
    shy $1234,X
    shx $1234,Y
    lax ($10,X)
    lax $10
    lax #$10
    lax $1234
    lax ($10),Y
    lax $10,Y
    las $1234,Y
    lax $1234,Y
    dcp ($10,X)
    dcp $10
    dcp $1234
    dcp ($10),Y
    dcp $10,X
    dcp $1234,Y
    dcp $1234,X
    axs #$10
    isc ($10,X)
    isc $10
    isc $1234
    isc ($10),Y
    isc $10,X
    isc $1234,Y
    isc $1234,X
  `;

  const first = assemblyToPrg(source);
  const loadAddress = first.readUInt16LE(0);
  const firstLines = disassemble(first.subarray(2), loadAddress);
  const reassembledSource = [
    `org $${loadAddress.toString(16).toUpperCase().padStart(4, "0")}`,
    ...firstLines.map((line) => line.operand ? `${line.mnemonic} ${line.operand}` : line.mnemonic),
  ].join("\n");
  const second = assemblyToPrg(reassembledSource);
  const secondLines = disassemble(second.subarray(2), loadAddress);

  assert.deepEqual([...second], [...first]);
  assert.deepEqual(
    secondLines.map(semanticInstruction),
    firstLines.map(semanticInstruction),
  );
  assert.ok(firstLines.every((line) => line.undocumented), "expected every roundtripped instruction to be undocumented");
});

function semanticInstruction(line) {
  return {
    mnemonic: line.mnemonic,
    operand: line.operand,
    undocumented: line.undocumented,
  };
}
