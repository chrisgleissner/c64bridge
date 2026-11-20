import { start } from "./lib.mjs";
const backend = process.argv[2] ?? "c64u";
const h = await start();
if (backend === "vice") await h.call("c64_select_backend", { op: "select", backend: "vice" }, { show: 100 });
const P = (o) => h.call("c64_program", o, { show: 3000 });
const M = (o) => h.call("c64_memory", o, { show: 3000 });
const src = `
* = $0810
start:
    sei
    lda #$0d
    sta $07f8          ; sprite 0 pointer -> $0340
    ldx #62
fill:
    lda #$ff
    sta $0340,x
    dex
    bpl fill
    lda #1
    sta $d015
    lda #100
    sta $d000
    sta $d001
    lda #0
    sta score
    sta score+1
    cli
loop:
wait:
    lda $d012
    cmp #250
    bne wait
    lda $dc00          ; joystick port 2
    and #$10
    bne nofire
    inc score
nofire:
    lda $dc00
    and #$04
    bne noleft
    dec $d000
noleft:
    jmp loop
score:
    .word 0
msg:
    .text "SCORE"
`;
await P({ op: "upload_run_asm", program: src });
await P({ op: "upload_run_asm", program: src, verify: true });
await M({ op: "read", address: "score", length: 2 });
await M({ op: "write", address: "score", bytes: "34 12" });
await M({ op: "read", address: "score", length: 2 });
await M({ op: "read", address: "score+1", length: 1 });
await M({ op: "disassemble", address: "loop", instructionCount: 8 });
await M({ op: "disassemble", address: "start", length: 16 });
await M({ op: "wait_for_text", pattern: "SCORE", timeoutMs: 400 });
await M({ op: "search_memory", startAddress: "start", endAddress: "$0900", pattern: "SCORE" });
await M({ op: "search_memory", startAddress: "start", endAddress: "$0900", pattern: "53 43 4F" });
// syntax error
await P({ op: "upload_run_asm", program: "* = $c000\nstart: lda #$01\n  sta $d020\n  bnx start\n  rts" });
await P({ op: "upload_run_asm", program: "* = $c000\nstart: lda ($fb)\n rts" });
await P({ op: "upload_run_asm", program: "* = $c000\nstart: lda #1\n jmp undefined_label\n" });
await P({ op: "upload_run_asm", program: "start: lda #1\n rts\n" });
await P({ op: "upload_run_asm", program: "* = $c000\nstart: lda #300\n rts\n" });
await P({ op: "upload_run_asm", program: "*=$c000\n ldx #0\nl: lda msg,x\n beq done\n sta $0400,x\n inx\n bne l\ndone: rts\nmsg: .text \"HI\"\n .byte 0\n" });
await h.stop(); process.exit(0);
