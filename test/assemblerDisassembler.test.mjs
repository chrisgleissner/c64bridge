import test from "#test/runner";
import assert from "#test/assert";
import { assemblyToPrg, assemblyToPrgDetailed } from "../src/tools/translation/assembler.js";
import { disassemble, formatDisassembly } from "../src/tools/translation/disassembler.js";

// Assembler and disassembler round trips. The disassembler is part of c64bridge, so these tests stay here;
// the assembler tests proper live in packages/asm6502/test.

const asm = (source, options) => [...assemblyToPrgDetailed(`* = $c000\n${source}\n`, options).prg].slice(2);

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

test("disassembler operands stay assemblable and symbols are reported separately (TRANSLATE-16)", () => {
  const lines = disassemble(Uint8Array.of(0xad, 0x00, 0xd0, 0x20, 0x10, 0xff), 0xc000, undefined, new Map([[0xd000, "VIC"], [0xff10, "foo"]]));
  assert.equal(lines[0].operand, "$D000");
  assert.equal(lines[0].operandLabel, "VIC");
  assert.match(formatDisassembly(lines), /LDA \$D000 {2}; VIC/);
  const text = lines.map((line) => `${line.mnemonic} ${line.operand}`).join("\n");
  assert.deepEqual(asm(text), [0xad, 0x00, 0xd0, 0x20, 0x10, 0xff]);
});
