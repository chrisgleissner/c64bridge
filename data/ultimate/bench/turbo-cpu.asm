; turbo-cpu - c64bridge Ultimate turbo benchmark (c64bridge assembler syntax)
; Edit ONLY the parameter block below, then upload_run_asm.
; See README.md in this directory for result decoding and the rerun recipe.
; Never read C64 memory while the program runs: REST/DMA reads pause the CPU and
; corrupt the measurement. Wait for the computed duration, then read $C000-$CEFF once.

VERSION    = 1
PROGRAM_ID = 1

; ---------------- PARAMETERS (edit these) ----------------
IDX_MASK_LO = $FF        ; bit n = measure speed index n (0-7)
IDX_MASK_HI = $FF        ; bits for indices 8-15.   $0001 = only index 0
COND_MASK   = $0F        ; bit0 screen on, bit1 screen blanked, bit2 on + 8 sprites, bit3 blank + 8 sprites
VAR_MASK    = $0F        ; bit0 RAM loop, bit1 $D020 writes, bit2 $D012 reads, bit3 CIA1 reads
NREP        = 3          ; repetitions per point (1-3)
USE_D031    = 1          ; 1 = program writes $D031 (index | BADBIT) per speed index; 0 = leave speed alone
BADBIT      = $00        ; OR-ed into the $D031 value: $00 or $80 (bit 7, badline control)
D030_WRITE  = 0          ; 1 = write D030_VALUE to $D030 once at start (TurboEnable-bit mode)
D030_VALUE  = $01
SPEED_TABLE = 1          ; 1 = Ultimate 64 / Elite table (max 48 MHz), 2 = C64U / U64E2 table (max 64 MHz)
NOMINAL_M   = 1          ; speed in MHz assumed when USE_D031 = 0 (scales the run length only)
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

REC_BASE = RECORDS
HDR_NOMINAL = H+$12

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

        lda #IDX_MASK_LO
        sta H+8
        lda #IDX_MASK_HI
        sta H+9
        lda #COND_MASK
        sta H+$A
        lda #VAR_MASK
        sta H+$B
        lda #NREP
        sta H+$C
        lda #USE_D031
        sta H+$D
        lda #BADBIT
        sta H+$E
        lda #D030_WRITE
        sta H+$F
        lda #D030_VALUE
        sta H+$10
        lda #SPEED_TABLE
        sta H+$11
        lda #NOMINAL_M
        sta HDR_NOMINAL
        jsr sprite_setup
        lda #D030_WRITE
        beq nod030
        lda #D030_VALUE
        sta $D030
nod030:
        jsr framecal
        lda #0
        sta z_idx
        lda #<REC_BASE
        sta p_idx
        lda #>REC_BASE
        sta p_idx+1
il:     lda z_idx
        cmp #8
        bcs il_hi
        tax
        lda #IDX_MASK_LO
        and bit8,x
        jmp il_t
il_hi:  and #7
        tax
        lda #IDX_MASK_HI
        and bit8,x
il_t:   bne il_run
        jmp il_next
il_run: lda z_idx
        sta HDR_PROGRESS
        jsr set_speed
        jsr calcn
        lda #0
        sta z_cond
        lda p_idx
        sta p_cond
        lda p_idx+1
        sta p_cond+1
cl:     ldx z_cond
        lda #COND_MASK
        and bit8,x
        bne cl_run
        jmp cl_next
cl_run: jsr setcond
        lda #0
        sta z_var
        lda p_cond
        sta p_var
        lda p_cond+1
        sta p_var+1
vl:     ldx z_var
        lda #VAR_MASK
        and bit8,x
        bne vl_run
        jmp vl_next
vl_run: lda p_var
        sta rp
        lda p_var+1
        sta rp+1
        lda #0
        sta z_rep
rl:     jsr do_run
        jsr store4
        inc z_rep
        lda z_rep
        cmp #NREP
        bne rl
        jsr flagchk
vl_next:
        ldx #p_var
        lda #12
        jsr add_p
        inc z_var
        lda z_var
        cmp #4
        beq vl_end
        jmp vl
vl_end:
cl_next:
        ldx #p_cond
        lda #48
        jsr add_p
        inc z_cond
        lda z_cond
        cmp #4
        beq cl_end
        jmp cl
cl_end:
il_next:
        ldx #p_idx
        lda #192
        jsr add_p
        inc z_idx
        lda z_idx
        cmp #16
        beq il_end
        jmp il
il_end:
        jsr finish_hw
        lda #$A5
        sta HDR_DONE
        jmp idle

; ---------------------------------------------------------------- speed
set_speed:
        lda #USE_D031
        bne ss_use
        lda #NOMINAL_M
        sta z_m
        ldx z_idx
        sta HDR_M,x
        lda #1
        sta HDR_STATUS,x
        rts
ss_use: ldx z_idx
        lda #SPEED_TABLE
        cmp #2
        beq ss_t2
        lda mtab_u64,x
        jmp ss_m
ss_t2:  lda mtab_c64u,x
ss_m:   sta z_m
        sta HDR_M,x
        lda #0
        sta z_t0
        lda z_m
        cmp #1
        bne ss_try
        ; index with 1 MHz: just write it and settle
        lda z_idx
        ora #BADBIT
        sta $D031
        lda #$F8
        jsr sync
        jsr sync
        lda #1
        sta z_t0
        jmp ss_live
ss_try: inc z_t0
        lda z_idx
        ora #BADBIT
        sta $D031
        lda #$F8
        jsr sync
        jsr sync
        lda #6               ; probe: 6 outer passes = 81 k cycles, > 65536 ticks at 1 MHz
        sta z_lo
        lda #1
        sta z_hi
        jsr timers_init
        jsr var_ram
        lda $DD06
        cmp #$FF             ; no timer A underflow: the probe ran faster than 1 MHz
        beq ss_live
        lda z_t0
        cmp #150
        bne ss_try
        lda #$FF
        sta z_t0
ss_live:
        ldx z_idx
        lda z_t0
        sta HDR_STATUS,x
        lda $D031
        sta HDR_READBACK,x
        rts

calcn:  lda #0               ; N = 29 * m outer passes (about 20 PAL frames at nominal speed)
        sta z_nlo
        sta z_nhi
        ldx #29
cn1:    clc
        lda z_nlo
        adc z_m
        sta z_nlo
        bcc cn2
        inc z_nhi
cn2:    dex
        bne cn1
        rts

do_run: jsr timers_init
        lda z_nlo
        sta z_lo
        lda z_nhi
        clc
        adc #1
        sta z_hi
        ldx z_rep
        lda startlines,x
        jsr sync
        lda z_var
        asl
        tax
        lda vtab+1,x
        pha
        lda vtab,x
        pha
        rts                  ; jumps to var_xxx, whose rts returns to the caller of do_run

vtab:   .word var_ram-1, var_vw-1, var_vr-1, var_cr-1

; ---------------------------------------------------------------- interference check
; Compares the NREP repetitions of one point (p_var). Flag = 1 when max-min > min/128 (0.78 %).
flagchk:
        lda #NREP
        cmp #2
        bcs fc_go
        rts
fc_go:  lda #0
        sta z_t0
        lda #NREP
        sta z_t1
        lda #$FF
        sta mn
        sta mn+1
        lda #0
        sta mx
        sta mx+1
fc_l:   ldy z_t0
        iny
        lda (p_var),y
        eor #$FF
        sta v_lo
        iny
        lda (p_var),y
        eor #$FF
        sta v_hi
        lda v_lo
        cmp mn
        lda v_hi
        sbc mn+1
        bcs fc_a
        lda v_lo
        sta mn
        lda v_hi
        sta mn+1
fc_a:   lda mx
        cmp v_lo
        lda mx+1
        sbc v_hi
        bcs fc_b
        lda v_lo
        sta mx
        lda v_hi
        sta mx+1
fc_b:   lda z_t0
        clc
        adc #4
        sta z_t0
        dec z_t1
        bne fc_l
        sec
        lda mx
        sbc mn
        sta df
        lda mx+1
        sbc mn+1
        sta df+1
        lda mn
        asl
        lda mn+1
        rol
        sta thr
        lda #0
        sta flg
        lda df+1
        bne fc_set
        lda thr
        cmp df
        bcs fc_out
fc_set: lda #1
        sta flg
fc_out: lda z_idx
        asl
        asl
        asl
        asl
        sta z_t2
        lda z_cond
        asl
        asl
        ora z_t2
        ora z_var
        tax
        lda flg
        sta FLAGS,x
        lda df+1
        beq fc_lo
        lda #$FF
        jmp fc_st
fc_lo:  lda df
fc_st:  sta DIFFS,x
        rts

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
        .align 256         ; the loop must not cross a page: a taken branch across a page costs +1 cycle
var_vw:
        ldx #0
        lda #1
        sta $DD0E          ; start timer A
vw_outer:
vw_inner:
        sta $D020
        nop
        nop
        sta $D020
        nop
        nop
        sta $D020
        nop
        nop
        sta $D020
        nop
        nop
        sta $D020
        nop
        nop
        sta $D020
        nop
        nop
        dex
        bne vw_inner
        dec z_lo
        bne vw_outer
        dec z_hi
        bne vw_outer
        lda #0
        sta $DD0E          ; stop timer A
        rts
        .align 256         ; the loop must not cross a page: a taken branch across a page costs +1 cycle
var_vr:
        ldx #0
        lda #1
        sta $DD0E          ; start timer A
vr_outer:
vr_inner:
        lda $D012
        nop
        nop
        lda $D012
        nop
        nop
        lda $D012
        nop
        nop
        lda $D012
        nop
        nop
        lda $D012
        nop
        nop
        lda $D012
        nop
        nop
        dex
        bne vr_inner
        dec z_lo
        bne vr_outer
        dec z_hi
        bne vr_outer
        lda #0
        sta $DD0E          ; stop timer A
        rts
        .align 256         ; the loop must not cross a page: a taken branch across a page costs +1 cycle
var_cr:
        ldx #0
        lda #1
        sta $DD0E          ; start timer A
cr_outer:
cr_inner:
        lda $DC05
        nop
        nop
        lda $DC05
        nop
        nop
        lda $DC05
        nop
        nop
        lda $DC05
        nop
        nop
        lda $DC05
        nop
        nop
        lda $DC05
        nop
        nop
        dex
        bne cr_inner
        dec z_lo
        bne cr_outer
        dec z_hi
        bne cr_outer
        lda #0
        sta $DD0E          ; stop timer A
        rts

; ---------------------------------------------------------------- helpers
sync:   cmp $D012            ; A = raster line (low 8 bits). Waits until the line has
        beq sync             ; been left, then until it is reached again
sync2:  cmp $D012
        bne sync2
        rts

timers_init:                 ; CIA2: timer A counts PHI2, timer B counts A underflows
        lda #0
        sta $DD0E
        sta $DD0F
        lda #$FF
        sta $DD04
        sta $DD05
        sta $DD06
        sta $DD07
        lda #$50
        sta $DD0F            ; force load B, input = timer A underflow
        lda #$10
        sta $DD0E            ; force load A
        lda #$41
        sta $DD0F            ; start B (waits for A)
        rts

store4:                       ; store A lo, A hi, B lo, B hi at (rp), advance rp
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

add_p:                        ; X = zero page pointer, A = amount
        clc
        adc $00,x
        sta $00,x
        bcc addx
        inc $01,x
addx:   rts

bit8:   .byte 1,2,4,8,16,32,64,128
tab_d011: .byte $1B,$0B,$1B,$0B
tab_d015: .byte $00,$00,$FF,$FF
startlines: .byte $F8,$60,$A0
mtab_u64:  .byte 1,2,3,4,5,6,8,10,12,14,16,20,24,32,40,48
mtab_c64u: .byte 1,2,3,4,6,8,10,12,14,16,20,24,32,40,48,64

sprite_setup:
        lda #$C0
        ldx #7
sps1:   sta $07F8,x          ; sprite pointers -> $3000
        dex
        bpl sps1
        lda #$FF
        ldx #62
sps2:   sta $3000,x
        dex
        bpl sps2
        sta $D017            ; double height: 42 DMA lines per sprite
        ldx #14
sps3:   lda #$60
        sta $D001,x          ; Y = $60 for all eight sprites
        txa
        asl
        clc
        adc #40
        sta $D000,x          ; X spread out
        dex
        dex
        bpl sps3
        lda #0
        sta $D010
        rts

setcond:                      ; z_cond: 0 screen on, 1 blank, 2 on+sprites, 3 blank+sprites
        ldx z_cond
        lda tab_d011,x
        sta $D011
        lda tab_d015,x
        sta $D015
        lda #$F8
        jsr sync
        jsr sync
        jsr sync
        rts

finish_hw:
        lda #0
        sta $D015
        lda #$1B
        sta $D011
        lda HDR_BORDER
        sta $D020
        lda #USE_D031
        beq fh1
        lda #0
        sta $D031
fh1:    lda #D030_WRITE
        beq fh2
        lda #0
        sta $D030
fh2:    rts

framecal:                     ; three frame-length measurements (PHI2 ticks, raw CIA2 counts)
        lda #<HDR_FRAMECAL
        sta rp
        lda #>HDR_FRAMECAL
        sta rp+1
        lda #3
        sta z_t0
fc1:    jsr timers_init
        lda #$F8
        jsr sync
        lda #1
        sta $DD0E
        lda #$F8
        jsr sync
        lda #0
        sta $DD0E
        jsr store4
        dec z_t0
        bne fc1
        rts

idle:   inc HDR_HB
        bne idle
        inc HDR_HB+1
        jmp idle
