import test from "#test/runner";
import assert from "#test/assert";
import { assemblyToPrg, AssemblyError } from "../src/tools/assember.js";

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
