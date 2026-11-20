import test from "#test/runner";
import assert from "#test/assert";
import { assemblyToPrgDetailed, AssemblyError } from "../src/tools/translation/assembler.js";
import { disassemble, formatDisassembly } from "../src/tools/translation/disassembler.js";

// HARD06 TRANSLATE-3 to 8, 12 to 16: assembler dialect, expressions, diagnostics.

const asm = (source, options) => [...assemblyToPrgDetailed(`* = $c000\n${source}\n`, options).prg].slice(2);
const fails = (source, pattern, options) => assert.throws(() => assemblyToPrgDetailed(`* = $c000\n${source}\n`, options), pattern);

test("string escapes: \\0, \\xNN, \\n, \\r, \\t, \\\\, \\\" and an error for anything else (TRANSLATE-3)", () => {
  assert.deepEqual(asm('.byte "A\\0B"'), [0x41, 0x00, 0x42]);
  assert.deepEqual(asm('.byte "\\x41\\xff\\x00"'), [0x41, 0xff, 0x00]);
  assert.deepEqual(asm('.byte "\\n\\r\\t\\\\\\""'), [10, 13, 9, 0x5c, 0x22]);
  fails('.byte "a\\qb"', /Unknown escape "\\q"/);
  fails('.byte "\\x4"', /two hex digits/);
});

test("ACME spellings and screen-code text (TRANSLATE-4)", () => {
  assert.deepEqual(asm("!byte 1,2\n!by 3\n!08 4\n!8 5"), [1, 2, 3, 4, 5]);
  assert.deepEqual(asm("!word $1234\n!wo 2\n!16 3"), [0x34, 0x12, 2, 0, 3, 0]);
  assert.deepEqual(asm("!fill 3,7\n!fi 1,9"), [7, 7, 7, 9]);
  assert.deepEqual(asm("nop\n!align 3,0\nnop"), [0xea, 0xea, 0xea, 0xea, 0xea]);
  // ACME !align ANDVALUE, EQUALVALUE: pad to the next page, default fill NOP.
  const page = assemblyToPrgDetailed("* = $c0f0\nnop\n!align $ff, 0\nrts\n").prg;
  assert.equal(page.length, 2 + 0x11);
  assert.equal(page[2 + 0x10], 0x60);
  assert.equal(page[2 + 1], 0xea);
  fails("!align 3", /needs ANDVALUE, EQUALVALUE/);
});

test("spellings no supported assembler documents fail with the one to use (review point 3)", () => {
  fails('.scr "A"', /unsupported directive \.scr \(use !scr/);
  fails('.screen "A"', /unsupported directive \.screen \(use !scr/);
  fails('.petscii "A"', /unsupported directive \.petscii \(use !pet/);
  fails(".rept 2\n nop\n.endr", /no matching \.endrepeat|unsupported directive \.endr/);
  fails(".pc = $1000", /unsupported directive \.pc .*\* = address/);
  fails(".repeat 3, I\n.byte I\n.endrep", /counter name .* is not supported/);
  fails(" ldx #3\n- dex\n bne -", /Anonymous labels/);
  fails(" bne +\n nop\n+ rts", /Anonymous labels/);
  // ACME rejects a longer string in !byte and !word; a single character is a value.
  fails('!byte "ab"', /single character, as in ACME/);
  assert.deepEqual(asm('!byte "a"\n!word "b"\n.byte "cd"'), [0x61, 0x62, 0x00, 0x63, 0x64]);
});

test("ca65, 64tass and Kick Assembler data spellings (review point 3)", () => {
  assert.deepEqual(asm(".byt 1, 2\n.by 3\n.wo $1234"), [1, 2, 3, 0x34, 0x12]);
  assert.deepEqual(asm("F = 0\n.if F\n lda #1\n.fi\n rts"), [0x60]);
  const options = { resolveIncbin: () => Uint8Array.of(1, 2, 3, 4, 5) };
  assert.deepEqual(asm('.binary "f", 2, 2', options), [3, 4]);
});

test(".text folds letters and warns once that 64tass and Kick Assembler differ (review point 3)", () => {
  const lower = assemblyToPrgDetailed('* = $c000\n.text "ab"\n.ascii "c"\n');
  assert.deepEqual([...lower.prg].slice(2), [0x41, 0x42, 0x43]);
  assert.equal(lower.warnings.length, 1);
  assert.match(lower.warnings[0], /:2: \.text turns a-z into the PETSCII letters/);
  assert.deepEqual(assemblyToPrgDetailed('* = $c000\n.text "AB {clr}"\n').warnings, []);
});

test(".res n,value fills, .res n reserves (TRANSLATE-4)", () => {
  assert.deepEqual(asm(".res 3,$ff"), [0xff, 0xff, 0xff]);
  assert.deepEqual(asm("nop\n.res 2\nnop"), [0xea, 0, 0, 0xea]);
});

test("labels without a colon in column 0 (TRANSLATE-5)", () => {
  assert.deepEqual(asm("start lda #1\n bne start\nmsg .byte 7\nloop\n dex\n bne loop"), [0xa9, 1, 0xd0, 0xfc, 7, 0xca, 0xd0, 0xfd]);
  assert.deepEqual(asm("value = 5\nother .equ 6\n lda #value+other"), [0xa9, 11]);
  fails("lad #1", /Unknown instruction "lad".*colon|Unknown instruction "lad"/s);
  // A typo in an instruction with an operand is still an error, not a label.
  fails("ldaa #1\n", /Unknown instruction "ldaa"/);
});

test("a misspelt mnemonic alone in column 0 is an error, not a silent label (review point 1)", () => {
  fails("lda #1\nrts2", (error) => error instanceof AssemblyError && /:3: Unknown instruction "rts2"/.test(error.message) && /"rts2:"/.test(error.message));
  fails("nop\nclc2\n nop", /Unknown instruction "clc2"/);
  // Referenced, it is a label; with a colon it is always one.
  assert.deepEqual(asm("loop\n dex\n bne loop"), [0xca, 0xd0, 0xfd]);
  assert.deepEqual(asm("unused:\n rts"), [0x60]);
  assert.deepEqual(assemblyToPrgDetailed("* = $c000\nunused:\n rts\n").warnings, []);
  // Before a statement it stays a label, with a warning naming the line.
  const result = assemblyToPrgDetailed("* = $c000\nrst2 nop\nmsg .byte 7\n lda msg\n");
  assert.deepEqual([...result.prg].slice(2), [0xea, 7, 0xad, 0x01, 0xc0]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /\(input\):2: "rst2" in column 0 is taken as a label/);
});

test("unsupported directives say so before the operand is parsed and list what is supported", () => {
  for (const source of ['.segment "CODE"', ".proc foo", '.incbin2 "x"', "!to \"a.prg\",cbm", ".define x(a) a", "!zone x"]) {
    fails(source, /unsupported directive \S+; supported: .*\.byte.*!scr.*\.macro.*\.repeat/s);
  }
});

test("conditional assembly with .if, .else and .endif", () => {
  const source = (value) => `FLAG = ${value}\n.if FLAG\n lda #1\n.else\n lda #2\n.endif\n rts`;
  assert.deepEqual(asm(source(1)), [0xa9, 1, 0x60]);
  assert.deepEqual(asm(source(0)), [0xa9, 2, 0x60]);
  // Labels and nested blocks in the skipped branch are ignored.
  assert.deepEqual(asm("X = 0\n.if X\nbad: nop\n.if 1\n nop\n.endif\n.else\ngood: nop\n.endif\n jmp good"), [0xea, 0x4c, 0x00, 0xc0]);
  fails(".if 1\n nop", /\.if has no matching \.endif/);
  fails(".endif", /without a matching \.if/);
  fails(".if later\n.endif\nlater = 1", /Undefined symbol "later"|known at this point/);
});

test("macros: ca65 and 64tass definitions, calls and parameter references (review point 3)", () => {
  const ca65 = [
    ".macro setborder color",
    " lda #color",
    " sta $d020",
    ".endmacro",
    ".mac twice",
    " nop",
    " nop",
    ".endmac",
    " setborder 5",
    " setborder 2+1",
    " twice",
  ].join("\n");
  assert.deepEqual(asm(ca65), [0xa9, 5, 0x8d, 0x20, 0xd0, 0xa9, 3, 0x8d, 0x20, 0xd0, 0xea, 0xea]);
  assert.deepEqual(asm(".macro two\n lda #\\1\n ldx #\\2\n.endm\n two 1, 2"), [0xa9, 1, 0xa2, 2]);
  // 64tass: "name .macro", called as #name or .name; \1, \name, \{name}; \@ is the parameter list.
  const tass = [
    "inc16 .macro",
    " inc \\1",
    " .endm",
    "store .macro value, addr",
    " lda #\\value",
    " sta \\{addr}+1",
    " .endmacro",
    "list .macro",
    " .byte \\@",
    " .endm",
    " #inc16 $fb",
    " .store 7, $c0",
    " #list 1, 2 ; comment",
  ].join("\n");
  assert.deepEqual(asm(tass), [0xe6, 0xfb, 0xa9, 7, 0x85, 0xc1, 1, 2]);
  // In a 64tass macro a bare parameter name is not replaced; in a string \n stays an escape.
  assert.deepEqual(asm("m .macro n\n .byte n, \\n\n .text \"a\\nb\"\n .endm\nn = 9\n #m 4"), [9, 4, 0x41, 0x0d, 0x42]);
  fails(".repeat 2\n .byte \\@\n.endrep", /only valid inside a macro/);
  fails(" #nothing 1", /not defined/);
  fails(".macro one a\n nop\n.endmacro\n one 1, 2", /Macro one takes 1 argument .*got 2/);
  fails(".macro one a\n nop\n.endmacro\n one", /got 0/);
  // An error inside an expansion names the macro and the calling line.
  assert.throws(
    () => assemblyToPrgDetailed("* = $c000\n.macro bad\n lda #300\n.endmacro\n bad\n"),
    (error) => error instanceof AssemblyError && /:5 \(in macro bad\)/.test(error.message) && /300/.test(error.message),
  );
  fails(".macro lda x\n.endmacro", /mnemonic or directive/);
  fails(".macro open\n nop", /no matching \.endmacro/);
  fails(".macro a\n nop\n.endmacro\n.macro a\n.endmacro", /already defined/);
});

test("macro expansion is bounded", () => {
  const source = ".macro boom\n boom\n.endmacro\n boom";
  fails(source, /nesting is deeper|exceeds/);
});

test(".repeat/.endrep/.endrepeat (ca65) and .rept/.endrept (64tass) with constants (TRANSLATE-4)", () => {
  assert.deepEqual(asm(".repeat 3\n nop\n.endrepeat"), [0xea, 0xea, 0xea]);
  assert.deepEqual(asm("N = 2\n.rept N*2\n inx\n.endrept"), [0xe8, 0xe8, 0xe8, 0xe8]);
  assert.deepEqual(asm(".repeat 2\n asl\n.endrep"), [0x0a, 0x0a]);
  assert.deepEqual(asm(".repeat 0\n nop\n.endrepeat\n rts"), [0x60]);
  fails(".repeat later\n nop\n.endrepeat\nlater = 1", /needs a count/);
  fails(".repeat 70000\n.endrepeat", /needs a count/);
  fails(".repeat 3\n nop", /no matching \.endrepeat/);
});

test(".include and .incbin through resolvers", () => {
  const files = { "lib.asm": "helper: rts\n", "data.bin": Uint8Array.of(1, 2, 3, 4, 5) };
  const options = {
    resolveInclude: (path) => files[path],
    resolveIncbin: (path) => files[path],
  };
  assert.deepEqual(asm('jsr helper\n.include "lib.asm"', options), [0x20, 0x03, 0xc0, 0x60]);
  assert.deepEqual(asm('!source "lib.asm"', options), [0x60]);
  assert.deepEqual(asm('.incbin "data.bin"\n.incbin "data.bin", 1\n.incbin "data.bin", 1, 2', options), [1, 2, 3, 4, 5, 2, 3, 4, 5, 2, 3]);
  fails('.incbin "data.bin", 9', /do not fit/, options);
  fails('.incbin "data.bin"', /needs a resolveIncbin option/);
  fails('.include "lib.asm"', /needs a resolveInclude option/);
});

test("expressions that start with a parenthesis and one-character strings in data (TRANSLATE-6, 7)", () => {
  assert.deepEqual(asm("lda (1+2)*3"), [0xa5, 9]);
  assert.deepEqual(asm("lda (4)+1"), [0xa5, 5]);
  assert.deepEqual(asm("lda ($10)+1,x"), [0xb5, 0x11]);
  assert.deepEqual(asm("lda ($10),y\nlda ($10,x)\njmp ($1234)"), [0xb1, 0x10, 0xa1, 0x10, 0x6c, 0x34, 0x12]);
  assert.deepEqual(asm(".byte 'A'-64, \"B\"-64, 'C'\n.text 'A'+1"), [1, 2, 0x43, 0x42]);
});

test("a relative branch takes no index register (TRANSLATE-12)", () => {
  fails("bne foo,x\nfoo:", /relative branch and takes no ,X index/);
});

test("a symbol named a, // comments, BOM, NBSP and forward equates (TRANSLATE-13)", () => {
  assert.deepEqual(asm("a: nop\n lda a\n lda a+1"), [0xea, 0xad, 0x00, 0xc0, 0xad, 0x01, 0xc0]);
  assert.deepEqual(asm(" asl a\n lsr"), [0x0a, 0x4a]);
  assert.deepEqual(asm("lda #1 // comment\n// whole line"), [0xa9, 1]);
  assert.deepEqual([...assemblyToPrgDetailed("\ufeff* = $c000\n\u00a0nop\n").prg].slice(2), [0xea]);
  assert.deepEqual(asm("size = end - start\nstart: nop\n nop\nend:\n lda #size"), [0xea, 0xea, 0xa9, 2]);
  assert.deepEqual(asm("lda #later+1\nlater = other * 2\nother = 4"), [0xa9, 9]);
  assert.deepEqual(asm("main: nop\n.x = .y - main\n.y: nop\n lda #.x"), [0xea, 0xea, 0xa9, 1]);
  fails("lda #nowhere\nnowhere = missing + 1", /Undefined symbol/);
  fails("bne Start\nstart:", /case-sensitive; did you mean "start"/);
  fails("lda #1\n bogus bar baz", (error) => error instanceof AssemblyError && /:3: /.test(error.message) && /bogus bar baz/.test(error.message));
  fails('.text "{sparkle}"', /not a known control code/);
  assert.deepEqual(asm('.text "{clr}{red}A{$05}"'), [147, 28, 0x41, 5]);
  fails("lda #1 \u00a7", /U\+00A7/);
});

test("zero-filled gaps and trailing .res are reported as warnings (TRANSLATE-14)", () => {
  const gap = assemblyToPrgDetailed("* = $c000\nnop\n* = $c800\nnop\n");
  assert.equal(gap.warnings.length, 1);
  assert.match(gap.warnings[0], /2047 zero bytes \$C001-\$C7FF/);
  const trailing = assemblyToPrgDetailed("* = $c000\nnop\nbuf: .res 4096\n");
  assert.match(trailing.warnings.join("\n"), /\.res space next to the emitted bytes adds 4096 zero bytes/);
  assert.match(assemblyToPrgDetailed("start: ").warnings.join("\n"), /emits no bytes/);
  assert.deepEqual(assemblyToPrgDetailed("* = $c000\nnop\n* = $c010\nnop\n").warnings, []);
  assert.deepEqual(assemblyToPrgDetailed("* = $c000\nnop\n").warnings, []);
});

test("many reserved blocks merge in linear time (TRANSLATE-8)", () => {
  const lines = ["* = $8000", "nop"];
  const count = 20000;
  for (let index = 0; index < count; index += 1) lines.push(`* = $${(0x8000 + count - index).toString(16)}`, ".res 1");
  const started = performance.now();
  const result = assemblyToPrgDetailed(lines.join("\n"));
  const elapsed = performance.now() - started;
  assert.equal(result.prg.length, 2 + count + 1);
  assert.ok(elapsed < 1500, `took ${elapsed} ms`);
  // Ranges on both sides of the image extend it; a detached range does not.
  const around = assemblyToPrgDetailed("* = $c010\n.res 4\nnop\n.res 2\n* = $c100\n.res 8\n").prg;
  assert.deepEqual([...around.subarray(0, 2)], [0x10, 0xc0]);
  assert.equal(around.length, 2 + 4 + 1 + 2);
});

test("disassembler operands stay assemblable and symbols are reported separately (TRANSLATE-16)", () => {
  const lines = disassemble(Uint8Array.of(0xad, 0x00, 0xd0, 0x20, 0x10, 0xff), 0xc000, undefined, new Map([[0xd000, "VIC"], [0xff10, "foo"]]));
  assert.equal(lines[0].operand, "$D000");
  assert.equal(lines[0].operandLabel, "VIC");
  assert.match(formatDisassembly(lines), /LDA \$D000 {2}; VIC/);
  const text = lines.map((line) => `${line.mnemonic} ${line.operand}`).join("\n");
  assert.deepEqual(asm(text), [0xad, 0x00, 0xd0, 0x20, 0x10, 0xff]);
});
