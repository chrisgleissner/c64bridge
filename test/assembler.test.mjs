import test from "#test/runner";
import assert from "#test/assert";
import { assemblyToPrg, AssemblyError, prgEntryAddress } from "../src/tools/translation/assembler.js";
import { disassemble } from "../src/tools/translation/disassembler.js";

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

test("assemblyToPrg assembles at the load address when no org directive is given", () => {
  const source = `
start:
    lda #1
    jmp start
  `;

  // At the default $0801 the code follows a "10 SYS02062" stub, because BASIC
  // relinks whatever is loaded at $0801 as program lines.
  const prg = assemblyToPrg(source);
  assert.deepEqual(
    [...prg],
    [
      0x01, 0x08,
      0x0c, 0x08, 0x0a, 0x00, 0x9e, 0x30, 0x32, 0x30, 0x36, 0x32, 0x00, 0x00, 0x00, // 10 SYS02062
      0xa9, 0x01, 0x4c, 0x0e, 0x08, // $080E: LDA #1, JMP start
    ],
  );
  assert.equal(prgEntryAddress(prg), 0x080e);
  assert.deepEqual(
    [...assemblyToPrg(source, { loadAddress: 0xc000 })],
    [0x00, 0xc0, 0xa9, 0x01, 0x4c, 0x00, 0xc0],
  );
});

test("assemblyToPrg adds no stub when the source sets its own origin", () => {
  const withOrg = assemblyToPrg(`
* = $0801
    .byte $0b, $08, $0a, $00, $9e, $34, $30, $39, $36, $00, $00, $00
* = $1000
    rts
  `);
  assert.equal(withOrg.readUInt16LE(0), 0x0801);
  assert.deepEqual([...withOrg.subarray(2, 14)], [0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x34, 0x30, 0x39, 0x36, 0x00, 0x00, 0x00]);
  // The user's own stub says SYS4096.
  assert.equal(prgEntryAddress(withOrg), 0x1000);
  assert.equal(prgEntryAddress(assemblyToPrg("* = $c000\n rts")), 0xc000);
});

test("assemblyToPrg rejects indexed addressing modes the instruction does not support", () => {
  for (const line of ["stx $1234,y", "sty $1234,x", "ldx $10,x", "ldy $10,y", "stx fwd,y", "lda $10,s"]) {
    const source = `
    * = $c000
    ${line}
    rts
fwd = $1234
    `;
    assert.throws(
      () => assemblyToPrg(source),
      (error) => error instanceof AssemblyError && /does not support/iu.test(error.message),
      `expected "${line}" to be rejected`,
    );
  }
});

test("assemblyToPrg encodes zero-page-only indexed modes, including forward references", () => {
  const source = `
    * = $c000
    stx $10,y
    sty $10,x
    ldx $10,y
    ldx $1234,y
    ldy $10,x
    ldy $1234,x
    stx fwd,y
    sty fwd,x
    rts
fwd = $20
  `;

  assert.deepEqual([...assemblyToPrg(source)], [
    0x00, 0xc0,
    0x96, 0x10, // STX $10,Y
    0x94, 0x10, // STY $10,X
    0xb6, 0x10, // LDX $10,Y
    0xbe, 0x34, 0x12, // LDX $1234,Y
    0xb4, 0x10, // LDY $10,X
    0xbc, 0x34, 0x12, // LDY $1234,X
    0x96, 0x20, // STX fwd,Y
    0x94, 0x20, // STY fwd,X
    0x60, // RTS
  ]);
});

test("assemblyToPrg keeps the local label scope across constant assignments", () => {
  const source = `
    * = $c000
start:
    ldx #3
SCREEN = $0400
.loop:
    dex
    bne .loop
    stx SCREEN
    rts
  `;

  assert.deepEqual([...assemblyToPrg(source)], [
    0x00, 0xc0,
    0xa2, 0x03, // LDX #3
    0xca, // DEX
    0xd0, 0xfd, // BNE .loop
    0x8e, 0x00, 0x04, // STX SCREEN
    0x60, // RTS
  ]);
});

test("assemblyToPrg sizes the PRG to the emitted bytes and ignores label-only org blocks", () => {
  const code = `
    * = $c000
    lda #1
    rts
  `;

  assert.deepEqual([...assemblyToPrg(`${code}\n* = $e000\nbuffer:\n`)], [0x00, 0xc0, 0xa9, 0x01, 0x60]);
  assert.deepEqual([...assemblyToPrg(`${code}\n* = $0400\nscreen:\n`)], [0x00, 0xc0, 0xa9, 0x01, 0x60]);
  assert.deepEqual(
    [...assemblyToPrg(`${code}\n* = $c004\n.byte $ff\n* = $c003\n.byte $ee\n`)],
    [0x00, 0xc0, 0xa9, 0x01, 0x60, 0xee, 0xff],
  );
});

test("assemblyToPrg evaluates * as the current PC and < > as low and high byte selectors", () => {
  const source = `
    * = $c000
    jmp *
    lda #<msg
    ldx #>msg
    lda #<(msg + $ff)
    lda #2*3
    lda #* - $bf00
msg:
    .byte 0
  `;

  assert.deepEqual([...assemblyToPrg(source)], [
    0x00, 0xc0,
    0x4c, 0x00, 0xc0, // JMP *
    0xa9, 0x0d, // LDA #<msg
    0xa2, 0xc0, // LDX #>msg
    0xa9, 0x0c, // LDA #<(msg + $ff) = $c10c
    0xa9, 0x06, // LDA #2*3
    0xa9, 0x0b, // LDA #* - $bf00 = $c00b - $bf00 = $010b
    0x00, // msg
  ]);
});

test("assemblyToPrg reads %-prefixed binary literals and keeps % as modulo after a value", () => {
  const source = `
    * = $c000
    lda #%00001111
    and %10000001
    .byte %1, %10
mask = %101
    ldx #mask
    ldy #7 % 4
  `;

  assert.deepEqual([...assemblyToPrg(source)], [
    0x00, 0xc0,
    0xa9, 0x0f, // LDA #%00001111
    0x25, 0x81, // AND $81
    0x01, 0x02, // .byte %1, %10
    0xa2, 0x05, // LDX #%101
    0xa0, 0x03, // LDY #7 % 4
  ]);
});

test("assemblyToPrg points the automatic SYS stub at the first instruction when data comes first", () => {
  const prg = assemblyToPrg(`
msg: .byte 1, 2, 3
start: lda msg
    rts
  `);
  // Stub at $0801, data at $080E-$0810, first instruction at $0811 (2065).
  assert.deepEqual([...prg.subarray(2, 15)], [0x0c, 0x08, 0x0a, 0x00, 0x9e, 0x30, 0x32, 0x30, 0x36, 0x35, 0x00, 0x00, 0x00]);
  assert.equal(prgEntryAddress(prg), 0x0811);
  assert.deepEqual([...prg.subarray(15)], [0x01, 0x02, 0x03, 0xad, 0x0e, 0x08, 0x60]);
});
