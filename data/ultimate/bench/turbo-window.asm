; turbo-window - c64bridge Ultimate turbo benchmark (c64bridge assembler syntax)
; Edit ONLY the parameter block below, then upload_run_asm.
; See README.md in this directory for result decoding and the rerun recipe.
; Never read C64 memory while the program runs: REST/DMA reads pause the CPU and
; corrupt the measurement. Wait for the computed duration, then read $C000-$CEFF once.

VERSION    = 1
PROGRAM_ID = 3

; Measures how long after program start a $D031 speed request takes effect.
; Run it right after a machine reset / run_prg (the firmware ignores $D031 for a while).
; ---------------- PARAMETERS (edit these) ----------------
TARGET_IDX   = 15        ; speed index requested repeatedly
BADBIT       = $00
MAX_ATTEMPTS = 120       ; each attempt takes roughly 0.1 s at 1 MHz
; ----------------------------------------------------------

; ---- zero page ($02-$0F pointers, $E0-$FF scratch). KERNAL and BASIC are banked out
z_idx   = $F0
z_cond  = $F1
z_var   = $F2
z_rep   = $F3
z_m     = $F4
z_t0    = $F5
z_t1    = $F6
z_t2    = $F7
z_nlo   = $F8
z_nhi   = $F9
z_lo    = $FB
z_hi    = $FC
p_idx   = $02
p_cond  = $04
p_var   = $06
rp      = $08
v_lo    = $E0
v_hi    = $E1
mn      = $E2
mx      = $E4
df      = $E6
thr     = $E8
flg     = $E9
ptr     = $EA

; ---- result block (read $C000-$CEFF with one c64_memory read; see README)
H       = $C000
HDR_DONE      = H+5
HDR_PROG      = H+6
HDR_PROGRESS  = H+7
HDR_BORDER    = H+$14
HDR_HB        = H+$16
HDR_FRAMECAL  = H+$18
HDR_STATUS    = H+$30
HDR_READBACK  = H+$40
HDR_M         = H+$60
FLAGS   = $C100
DIFFS   = $C200
RECORDS = $C300

HDR_ATT     = H+$20       ; attempts made
HDR_FIRST   = H+$21       ; 1-based attempt that first ran fast ($FF = never)

start:
        sei
        cld
        ldx #$FF
        txs
        lda #$35
        sta $01              ; RAM everywhere except I/O at $D000-$DFFF, no ROMs
        lda #$7F
        sta $DC0D
        sta $DD0D            ; mask all CIA interrupt sources
        lda $DC0D
        lda $DD0D            ; acknowledge pending ones
        lda #0
        sta $D01A            ; no VIC interrupts
        lda #$FF
        sta $D019
        lda $D020
        pha
        ; clear the result block $C000-$CEFF
        lda #0
        sta ptr
        lda #$C0
        sta ptr+1
        ldy #0
        ldx #15
clr:    lda #0
        sta (ptr),y
        iny
        bne clr
        inc ptr+1
        dex
        bne clr
        pla
        sta HDR_BORDER
        lda #$54
        sta H
        lda #$55
        sta H+1
        lda #$52
        sta H+2
        lda #$42
        sta H+3              ; magic 'TURB'
        lda #VERSION
        sta H+4
        lda #PROGRAM_ID
        sta HDR_PROG
        lda $D031
        sta H+$13            ; $D031 read before any write ($FF when Turbo Control is Off)

        lda #TARGET_IDX
        sta H+$11
        lda #BADBIT
        sta H+$E
        ; CIA1 free-running 32-bit timer = wall clock since start (A counts PHI2, B counts A underflows)
        lda #0
        sta $DC0E
        sta $DC0F
        lda #$FF
        sta $DC04
        sta $DC05
        sta $DC06
        sta $DC07
        lda #$50
        sta $DC0F
        lda #$10
        sta $DC0E
        lda #$41
        sta $DC0F
        lda #$01
        sta $DC0E
        lda #$FF
        sta HDR_FIRST
        lda #<RECORDS
        sta rp
        lda #>RECORDS
        sta rp+1
        lda #0
        sta z_t0
wl:     inc z_t0
        lda #TARGET_IDX
        ora #BADBIT
        sta $D031
        lda #6
        sta z_lo
        lda #1
        sta z_hi
        jsr timers_init
        jsr var_ram
        ; record 8 bytes: probe timer (A lo, A hi, B lo, B hi) then wall clock W
        jsr store4
        jsr readw
        lda z_t0
        sta HDR_ATT
        lda $DD06
        cmp #$FF
        bne wl_slow
        lda HDR_FIRST
        cmp #$FF
        bne wl_slow
        lda z_t0
        sta HDR_FIRST
        jmp wl_done          ; first fast attempt: stop
wl_slow:
        lda z_t0
        cmp #MAX_ATTEMPTS
        bne wl
wl_done:
        lda $D031
        sta H+$40
        lda #0
        sta $DC0E
        lda #0
        sta $D031
        lda #$A5
        sta HDR_DONE
        jmp idle

readw:
rw:     lda $DC06
        sta z_t1
        lda $DC07
        sta z_t2
        lda $DC04
        sta v_lo
        lda $DC05
        sta v_hi
        lda $DC06
        cmp z_t1
        bne rw
        lda $DC07
        cmp z_t2
        bne rw
        ldy #0
        lda v_lo
        sta (rp),y
        iny
        lda v_hi
        sta (rp),y
        iny
        lda z_t1
        sta (rp),y
        iny
        lda z_t2
        sta (rp),y
        clc
        lda rp
        adc #4
        sta rp
        bcc rwx
        inc rp+1
rwx:    rts

        .align 256         ; the loop must not cross a page: a taken branch across a page costs +1 cycle
var_ram:
        ldx #0
        lda #1
        sta $DD0E          ; start timer A
ram_outer:
ram_inner:
        lda $CF00
        nop
        nop
        lda $CF00
        nop
        nop
        lda $CF00
        nop
        nop
        lda $CF00
        nop
        nop
        lda $CF00
        nop
        nop
        lda $CF00
        nop
        nop
        dex
        bne ram_inner
        dec z_lo
        bne ram_outer
        dec z_hi
        bne ram_outer
        lda #0
        sta $DD0E          ; stop timer A
        rts

timers_init:
        lda #0
        sta $DD0E
        sta $DD0F
        lda #$FF
        sta $DD04
        sta $DD05
        sta $DD06
        sta $DD07
        lda #$50
        sta $DD0F
        lda #$10
        sta $DD0E
        lda #$41
        sta $DD0F
        rts

store4:
        ldy #0
        lda $DD04
        sta (rp),y
        iny
        lda $DD05
        sta (rp),y
        iny
        lda $DD06
        sta (rp),y
        iny
        lda $DD07
        sta (rp),y
        clc
        lda rp
        adc #4
        sta rp
        bcc st4x
        inc rp+1
st4x:   rts

idle:   inc HDR_HB
        bne idle
        inc HDR_HB+1
        jmp idle
