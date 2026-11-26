import test from "#test/runner";
import assert from "#test/assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblyToPrgDetailed, AssemblyError } from "../src/assembler.js";

// HARD06 review point 4 of branch F (decision D5): differential check of the built-in assembler.
//
// The expected bytes below are the output of independent assemblers, run on 2026-11-20:
//   ACME 0.97 (svn trunk of acme-crossass on SourceForge, built from source), 64tass 1.60,
//   ca65/ld65 2.19 and Kick Assembler 5.25. Every legal opcode line gave the same bytes in ACME,
//   64tass and ca65. A snippet either gives the reference assembler's bytes, or fails with a clear
//   error (an unsupported feature), or is a stated divergence (.text, see the dialect comment in
//   src/tools/translation/assembler.ts) that adds a warning.
//
// To re-run the reference assemblers against these fixtures:
//   C64BRIDGE_ASM_ORACLES=1 ACME=/path/to/acme KICKASS_JAR=/path/to/KickAss.jar bun test test/hard06AssemblerDifferential.test.mjs
// (64tass, ca65, ld65 and java are taken from PATH; a missing tool is reported, not skipped silently.)

  // [source line, bytes] - identical output of ACME 0.97, 64tass 1.60 and ca65 2.19.
const LEGAL_OPCODES = [
  ["brk", "00"],
  ["ora ($12,x)", "01 12"],
  ["ora $12", "05 12"],
  ["asl $12", "06 12"],
  ["php", "08"],
  ["ora #$12", "09 12"],
  ["asl", "0a"],
  ["ora $1234", "0d 34 12"],
  ["asl $1234", "0e 34 12"],
  ["bpl *+$12", "10 10"],
  ["ora ($12),y", "11 12"],
  ["ora $12,x", "15 12"],
  ["asl $12,x", "16 12"],
  ["clc", "18"],
  ["ora $1234,y", "19 34 12"],
  ["ora $1234,x", "1d 34 12"],
  ["asl $1234,x", "1e 34 12"],
  ["jsr $1234", "20 34 12"],
  ["and ($12,x)", "21 12"],
  ["bit $12", "24 12"],
  ["and $12", "25 12"],
  ["rol $12", "26 12"],
  ["plp", "28"],
  ["and #$12", "29 12"],
  ["rol", "2a"],
  ["bit $1234", "2c 34 12"],
  ["and $1234", "2d 34 12"],
  ["rol $1234", "2e 34 12"],
  ["bmi *+$12", "30 10"],
  ["and ($12),y", "31 12"],
  ["and $12,x", "35 12"],
  ["rol $12,x", "36 12"],
  ["sec", "38"],
  ["and $1234,y", "39 34 12"],
  ["and $1234,x", "3d 34 12"],
  ["rol $1234,x", "3e 34 12"],
  ["rti", "40"],
  ["eor ($12,x)", "41 12"],
  ["eor $12", "45 12"],
  ["lsr $12", "46 12"],
  ["pha", "48"],
  ["eor #$12", "49 12"],
  ["lsr", "4a"],
  ["jmp $1234", "4c 34 12"],
  ["eor $1234", "4d 34 12"],
  ["lsr $1234", "4e 34 12"],
  ["bvc *+$12", "50 10"],
  ["eor ($12),y", "51 12"],
  ["eor $12,x", "55 12"],
  ["lsr $12,x", "56 12"],
  ["cli", "58"],
  ["eor $1234,y", "59 34 12"],
  ["eor $1234,x", "5d 34 12"],
  ["lsr $1234,x", "5e 34 12"],
  ["rts", "60"],
  ["adc ($12,x)", "61 12"],
  ["adc $12", "65 12"],
  ["ror $12", "66 12"],
  ["pla", "68"],
  ["adc #$12", "69 12"],
  ["ror", "6a"],
  ["jmp ($1234)", "6c 34 12"],
  ["adc $1234", "6d 34 12"],
  ["ror $1234", "6e 34 12"],
  ["bvs *+$12", "70 10"],
  ["adc ($12),y", "71 12"],
  ["adc $12,x", "75 12"],
  ["ror $12,x", "76 12"],
  ["sei", "78"],
  ["adc $1234,y", "79 34 12"],
  ["adc $1234,x", "7d 34 12"],
  ["ror $1234,x", "7e 34 12"],
  ["sta ($12,x)", "81 12"],
  ["sty $12", "84 12"],
  ["sta $12", "85 12"],
  ["stx $12", "86 12"],
  ["dey", "88"],
  ["txa", "8a"],
  ["sty $1234", "8c 34 12"],
  ["sta $1234", "8d 34 12"],
  ["stx $1234", "8e 34 12"],
  ["bcc *+$12", "90 10"],
  ["sta ($12),y", "91 12"],
  ["sty $12,x", "94 12"],
  ["sta $12,x", "95 12"],
  ["stx $12,y", "96 12"],
  ["tya", "98"],
  ["sta $1234,y", "99 34 12"],
  ["txs", "9a"],
  ["sta $1234,x", "9d 34 12"],
  ["ldy #$12", "a0 12"],
  ["lda ($12,x)", "a1 12"],
  ["ldx #$12", "a2 12"],
  ["ldy $12", "a4 12"],
  ["lda $12", "a5 12"],
  ["ldx $12", "a6 12"],
  ["tay", "a8"],
  ["lda #$12", "a9 12"],
  ["tax", "aa"],
  ["ldy $1234", "ac 34 12"],
  ["lda $1234", "ad 34 12"],
  ["ldx $1234", "ae 34 12"],
  ["bcs *+$12", "b0 10"],
  ["lda ($12),y", "b1 12"],
  ["ldy $12,x", "b4 12"],
  ["lda $12,x", "b5 12"],
  ["ldx $12,y", "b6 12"],
  ["clv", "b8"],
  ["lda $1234,y", "b9 34 12"],
  ["tsx", "ba"],
  ["ldy $1234,x", "bc 34 12"],
  ["lda $1234,x", "bd 34 12"],
  ["ldx $1234,y", "be 34 12"],
  ["cpy #$12", "c0 12"],
  ["cmp ($12,x)", "c1 12"],
  ["cpy $12", "c4 12"],
  ["cmp $12", "c5 12"],
  ["dec $12", "c6 12"],
  ["iny", "c8"],
  ["cmp #$12", "c9 12"],
  ["dex", "ca"],
  ["cpy $1234", "cc 34 12"],
  ["cmp $1234", "cd 34 12"],
  ["dec $1234", "ce 34 12"],
  ["bne *+$12", "d0 10"],
  ["cmp ($12),y", "d1 12"],
  ["cmp $12,x", "d5 12"],
  ["dec $12,x", "d6 12"],
  ["cld", "d8"],
  ["cmp $1234,y", "d9 34 12"],
  ["cmp $1234,x", "dd 34 12"],
  ["dec $1234,x", "de 34 12"],
  ["cpx #$12", "e0 12"],
  ["sbc ($12,x)", "e1 12"],
  ["cpx $12", "e4 12"],
  ["sbc $12", "e5 12"],
  ["inc $12", "e6 12"],
  ["inx", "e8"],
  ["sbc #$12", "e9 12"],
  ["nop", "ea"],
  ["cpx $1234", "ec 34 12"],
  ["sbc $1234", "ed 34 12"],
  ["inc $1234", "ee 34 12"],
  ["beq *+$12", "f0 10"],
  ["sbc ($12),y", "f1 12"],
  ["sbc $12,x", "f5 12"],
  ["inc $12,x", "f6 12"],
  ["sed", "f8"],
  ["sbc $1234,y", "f9 34 12"],
  ["sbc $1234,x", "fd 34 12"],
  ["inc $1234,x", "fe 34 12"],
];

const SNIPPETS = [
  { dialect: "acme", name: "bytes and char", source: "* = $1000\n!byte 1, 2, $ff, %101, 'A'\n", bytes: "01 02 ff 05 41" },
  { dialect: "acme", name: "!8 !08 !by with low/high byte", source: "* = $1000\n!8 -1, <$1234, >$1234\n!08 7\n!by 9\n", bytes: "ff 34 12 07 09" },
  { dialect: "acme", name: "!word !wo !16", source: "* = $1000\n!word $1234\n!wo 2\n!16 65535\n", bytes: "34 12 02 00 ff ff" },
  { dialect: "acme", name: "!text is raw", source: "* = $1000\n!text \"Test@[\", 0\n", bytes: "54 65 73 74 40 5b 00" },
  { dialect: "acme", name: "!tx and !txt", source: "* = $1000\n!tx \"ab\"\n!txt \"C\"\n", bytes: "61 62 43" },
  { dialect: "acme", name: "!pet swaps case", source: "* = $1000\n!pet \"Test\", 13\n", bytes: "d4 45 53 54 0d" },
  { dialect: "acme", name: "!scr screen codes", source: "* = $1000\n!scr \"Test@[]^ \"\n", bytes: "54 05 13 14 00 1b 1d 1e 20" },
  { dialect: "acme", name: "!fill !fi", source: "* = $1000\n!fill 3, $aa\n!fi 2\n", bytes: "aa aa aa 00 00" },
  { dialect: "acme", name: "!align default NOP fill", source: "* = $1000\nnop\n!align 3, 0\nrts\n", bytes: "ea ea ea ea 60" },
  { dialect: "acme", name: "!align with fill", source: "* = $1000\nnop\n!align 7, 0, $ff\nrts\n", bytes: "ea ff ff ff ff ff ff ff 60" },
  { dialect: "acme", name: "label without colon", source: "* = $1000\nstart ldx #3\nloop dex\n bne loop\n rts\n", bytes: "a2 03 ca d0 fd 60" },
  { dialect: "acme", name: "low/high byte of an expression", source: "* = $1000\nmsg = $12ff\n lda #<msg+1\n ldx #>msg+1\n rts\n", bytes: "a9 00 a2 13 60" },
  { dialect: "acme", name: "zone-local label", source: "* = $1000\nmain\n ldx #0\n.l inx\n bne .l\n rts\n", error: "unsupported directive \\.l;.*local label needs a trailing \":\"", oracle: "a2 00 e8 d0 fd 60" },
  { dialect: "acme", name: "!text escapes", source: "* = $1000\n!text \"a\\nb\\\\\"\n", bytes: "61 0a 62 5c" },
  { dialect: "acme", name: "!pet single char in expression", source: "* = $1000\n!pet 'a'+1\n", bytes: "42" },
  { dialect: "acme", name: "!byte with string longer than one", source: "* = $1000\n!byte \"ab\"\n", error: "single character, as in ACME", oracle: "ERROR: Error - File s.a, line 2 (Zone <untitled>): There'..." },
  { dialect: "acme", name: "!macro unsupported", source: "* = $1000\n!macro m {\n nop\n}\n+m\n", error: "unsupported directive !macro", oracle: "ea" },
  { dialect: "acme", name: "!word of the program counter and a label difference", source: "* = $1000\nstart nop\n!word *, end-start\nend\n", bytes: "ea 01 10 05 00" },
  { dialect: "acme", name: "operator precedence", source: "* = $1000\n!byte 2+3*4, (2+3)*4, 7/2, 1<<3|1\n", bytes: "0e 14 03 09" },
  { dialect: "64tass", name: ".byte .word", source: "* = $1000\n.byte 255, $03\n.word $2342, $4555\n", bytes: "ff 03 42 23 55 45" },
  { dialect: "64tass", name: ".text raw", source: "* = $1000\n.text \"Test@[\"\n", bytes: "54 45 53 54 40 5b", divergent: { oracle: "54 65 73 74 40 5b", reason: "this assembler's .text folds a-z (data/assembly/assembly-spec.md); 64tass emits ASCII" } },
  { dialect: "64tass", name: ".fill with value", source: "* = $1000\n.fill 4, $55\n rts\n", bytes: "55 55 55 55 60" },
  { dialect: "64tass", name: ".fill without value", source: "* = $1000\n nop\n.fill 2\n nop\n", bytes: "ea 00 00 ea" },
  { dialect: "64tass", name: "label in column 0 without colon", source: "* = $1000\nstart   ldx #3\nloop    dex\n        bne loop\n        rts\n", bytes: "a2 03 ca d0 fd 60" },
  { dialect: "64tass", name: ".if .else .endif", source: "* = $1000\nflag = 1\n.if flag\n lda #1\n.else\n lda #2\n.endif\n", bytes: "a9 01" },
  { dialect: "64tass", name: ".if .fi", source: "* = $1000\nflag = 0\n.if flag\n lda #1\n.fi\n rts\n", bytes: "60" },
  { dialect: "64tass", name: ".rept .endrept", source: "* = $1000\n.rept 3\n nop\n.endrept\n", bytes: "ea ea ea" },
  { dialect: "64tass", name: ".macro with \\1", source: "* = $1000\ninc16 .macro\n inc \\1\n bne +\n inc \\1+1\n+\n .endm\n #inc16 $fb\n", error: "Anonymous labels", oracle: "e6 fb d0 02 e6 fc" },
  { dialect: "64tass", name: ".macro called with # and a named label", source: "* = $1000\ninc16 .macro\n inc \\1\n bne skip\n inc \\1+1\nskip\n .endm\n #inc16 $fb\n rts\n", bytes: "e6 fb d0 02 e6 fc 60" },
  { dialect: "64tass", name: ".align page with fill", source: "* = $1000\n nop\n.align $10, $ee\n rts\n", bytes: "ea ee ee ee ee ee ee ee ee ee ee ee ee ee ee ee 60" },
  { dialect: "64tass", name: "anonymous label", source: "* = $1000\n ldx #3\n- dex\n bne -\n rts\n", error: "Anonymous labels", oracle: "a2 03 ca d0 fd 60" },
  { dialect: "64tass", name: "indirect and indexed operands", source: "* = $1000\n lda ($fb),y\n sta ($fb,x)\n jmp ($fffc)\n lda $d000,x\n", bytes: "b1 fb 81 fb 6c fc ff bd 00 d0" },
  { dialect: "64tass", name: ".word with a forward label", source: "* = $1000\n .word target-1\ntarget rts\n", bytes: "01 10 60" },
  { dialect: "64tass", name: "local label .x", source: "* = $1000\nmain ldx #0\n_l inx\n bne _l\n rts\n", bytes: "a2 00 e8 d0 fd 60" },
  { dialect: "ca65", name: ".byte strings are raw", source: ".org $1000\n.byte \"Hi\", $0d, 0\n", bytes: "48 69 0d 00" },
  { dialect: "ca65", name: ".byt .word", source: ".org $1000\n.byt 1, 2\n.word $1234, *\n", bytes: "01 02 34 12 04 10" },
  { dialect: "ca65", name: ".res with fill", source: ".org $1000\n.res 3, $ea\nrts\n", bytes: "ea ea ea 60" },
  { dialect: "ca65", name: ".res trailing", source: ".org $1000\nrts\n.res 2\n", bytes: "60 00 00" },
  { dialect: "ca65", name: ".align with fill", source: ".org $1000\nnop\n.align 4, $ff\nrts\n", bytes: "ea ff ff ff 60" },
  { dialect: "ca65", name: ".repeat .endrep", source: ".org $1000\n.repeat 3\nnop\n.endrep\n", bytes: "ea ea ea" },
  { dialect: "ca65", name: ".repeat .endrepeat", source: ".org $1000\n.repeat 2\nasl\n.endrepeat\n", bytes: "0a 0a" },
  { dialect: "ca65", name: ".macro .endmacro named param", source: ".org $1000\n.macro poke addr, val\nlda #val\nsta addr\n.endmacro\npoke $d020, 0\n", bytes: "a9 00 8d 20 d0" },
  { dialect: "ca65", name: ".mac .endmac", source: ".org $1000\n.mac twice\nnop\nnop\n.endmac\ntwice\n", bytes: "ea ea" },
  { dialect: "ca65", name: ".if .else .endif", source: ".org $1000\nval = 2\n.if val > 1\nlda #1\n.else\nlda #2\n.endif\n", bytes: "a9 01" },
  { dialect: "ca65", name: "labels with colon", source: ".org $1000\nstart: ldx #3\nloop: dex\nbne loop\nrts\n", bytes: "a2 03 ca d0 fd 60" },
  { dialect: "ca65", name: "address size prefix", source: ".org $1000\nlda a:$12\n", error: "Unexpected tokens after operand", oracle: "ad 12 00" },
  { dialect: "ca65", name: ".repeat with counter", source: ".org $1000\n.repeat 3, I\n.byte I\n.endrep\n", error: "counter name", oracle: "00 01 02" },
  { dialect: "ca65", name: "cheap local label", source: ".org $1000\n@l: dex\nbne @l\n", error: "cheap local labels", oracle: "ca d0 fd" },
  { dialect: "ca65", name: ".lobytes", source: ".org $1000\n.lobytes $1234, $5678\n", error: "unsupported directive \\.lobytes", oracle: "34 78" },
  { dialect: "kick", name: ".byte .by .word .wo", source: "* = $1000\n.byte 1, 2\n.by 3\n.word $1234\n.wo 5\n", bytes: "01 02 03 34 12 05 00" },
  { dialect: "kick", name: "labels with colon and // comments", source: "* = $1000\nstart: ldx #3 // count\nloop: dex\n bne loop\n rts\n", bytes: "a2 03 ca d0 fd 60" },
  { dialect: "kick", name: ".fill constant", source: "* = $1000\n.fill 5, 0\n rts\n", bytes: "00 00 00 00 00 60" },
  { dialect: "kick", name: ".fill with i", source: "* = $1000\n.fill 4, i\n", error: "Undefined symbol \"i\"", oracle: "00 01 02 03" },
  { dialect: "kick", name: ".text screen codes", source: "* = $1000\n.text \"Test\"\n", bytes: "54 45 53 54", divergent: { oracle: "54 05 13 14", reason: "this assembler's .text folds a-z; Kick Assembler emits screen codes" } },
  { dialect: "kick", name: ".align", source: "* = $1000\n nop\n.align $10\n rts\n", bytes: "ea 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 60" },
  { dialect: "kick", name: ".pc", source: ".pc = $1000\n nop\n", error: "unsupported directive \\.pc", oracle: "ea" },
  { dialect: "kick", name: ".const", source: "* = $1000\n.const C = 5\n lda #C\n", error: "unsupported directive \\.const", oracle: "a9 05" },
  { dialect: "kick", name: "low/high byte", source: "* = $1000\nmsg: .byte 0\n lda #<msg\n ldx #>msg\n", bytes: "00 a9 00 a2 10" },
  { dialect: "kick", name: "multi-label line", source: "* = $1000\na1: b1: nop\n", bytes: "ea" },
  { dialect: "kick", name: ".import binary", source: "* = $1000\n.import binary \"x.bin\"\n", error: "unsupported directive \\.import", oracle: "ERROR: Error: Can't open file 'x.bin'" },
  { dialect: "kick", name: "BasicUpstart2", source: "BasicUpstart2(start)\n* = $1000\nstart: rts\n", error: "Unknown instruction \"BasicUpstart2\"", oracle: "0b 08 0a 00 9e 34 30 39 36 00 00 00 00 00 00 00 00 00 00 ..." },
  { dialect: "kick", name: ".encoding", source: "* = $1000\n.encoding \"petscii_upper\"\n.text \"AB\"\n", error: "unsupported directive \\.encoding", oracle: "41 42" },
  { dialect: "kick", name: "branch to label", source: "* = $1000\nloop: dey\n bne loop\n rts\n", bytes: "88 d0 fd 60" },
];

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
const body = (source) => hex(assemblyToPrgDetailed(source).prg.subarray(2));

test("all 151 legal 6502 opcodes give the bytes of ACME, 64tass and ca65", () => {
  assert.equal(LEGAL_OPCODES.length, 151);
  assert.equal(new Set(LEGAL_OPCODES.map(([, bytes]) => bytes.slice(0, 2))).size, 151);
  for (const [line, bytes] of LEGAL_OPCODES) {
    assert.equal(body(`* = $1000\n ${line}\n`), bytes, line);
  }
});

test("snippets in ACME, 64tass, ca65 and Kick Assembler style give the reference bytes or a clear error", () => {
  assert.ok(SNIPPETS.length >= 40, `${SNIPPETS.length} snippets`);
  for (const dialect of ["acme", "64tass", "ca65", "kick"]) {
    assert.ok(SNIPPETS.filter((snippet) => snippet.dialect === dialect).length >= 8, dialect);
  }
  for (const snippet of SNIPPETS) {
    const label = `${snippet.dialect}: ${snippet.name}`;
    if (snippet.error) {
      assert.throws(
        () => assemblyToPrgDetailed(snippet.source),
        (error) => error instanceof AssemblyError && /^\(input\):\d+/.test(error.message) && new RegExp(snippet.error).test(error.message),
        label,
      );
      continue;
    }
    const result = assemblyToPrgDetailed(snippet.source);
    assert.equal(hex(result.prg.subarray(2)), snippet.bytes, label);
    if (snippet.divergent) {
      assert.notEqual(snippet.divergent.oracle, snippet.bytes, label);
      assert.match(result.warnings.join("\n"), /\.text turns a-z/, label);
    }
  }
});

const ORACLES = process.env.C64BRIDGE_ASM_ORACLES === "1";

(ORACLES ? test : test.skip)("reference assemblers still give the recorded bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "c64bridge-asm-oracle-"));
  const run = (dialect, source) => {
    const out = join(dir, "out.bin");
    rmSync(out, { force: true });
    const exec = (command, args) => execFileSync(command, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    if (dialect === "acme") {
      writeFileSync(join(dir, "s.a"), source);
      exec(process.env.ACME ?? "acme", ["-f", "plain", "-o", out, "s.a"]);
    } else if (dialect === "64tass") {
      writeFileSync(join(dir, "s.s"), source);
      exec("64tass", ["-q", "--nostart", "-o", out, "s.s"]);
    } else if (dialect === "ca65") {
      writeFileSync(join(dir, "s.s"), source);
      writeFileSync(join(dir, "s.cfg"), "MEMORY { RAM: start = $1000, size = $F000, file = %O; }\nSEGMENTS { CODE: load = RAM, type = rw; }\n");
      exec("ca65", ["-o", "s.o", "s.s"]);
      exec("ld65", ["-C", "s.cfg", "-o", out, "s.o"]);
    } else {
      writeFileSync(join(dir, "s.asm"), source);
      const log = exec("java", ["-jar", process.env.KICKASS_JAR ?? "KickAss.jar", "s.asm", "-binfile", "-o", out]).toString();
      if (/Error/.test(log)) throw new Error(log);
    }
    return hex(readFileSync(out));
  };
  try {
    const lines = LEGAL_OPCODES.map(([line]) => ` ${line}`).join("\n");
    const expected = LEGAL_OPCODES.map(([, bytes]) => bytes).join(" ");
    assert.equal(run("acme", `* = $1000\n${lines}\n`), expected, "acme");
    assert.equal(run("64tass", `* = $1000\n${lines}\n`), expected, "64tass");
    assert.equal(run("ca65", `.org $1000\n${lines}\n`), expected, "ca65");
    for (const snippet of SNIPPETS) {
      if (snippet.error) continue;
      const reference = snippet.divergent ? snippet.divergent.oracle : snippet.bytes;
      assert.equal(run(snippet.dialect, snippet.source), reference, `${snippet.dialect}: ${snippet.name}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
