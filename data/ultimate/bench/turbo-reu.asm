; turbo-reu - c64bridge Ultimate turbo benchmark (c64bridge assembler syntax)
; Edit ONLY the parameter block below, then upload_run_asm.
; See README.md in this directory for result decoding and the rerun recipe.
; Never read C64 memory while the program runs: REST/DMA reads pause the CPU and
; corrupt the measurement. Wait for the computed duration, then read $C000-$CEFF once.

VERSION    = 1
PROGRAM_ID = 2

; ---------------- PARAMETERS (edit these) ----------------
IDX_MASK_LO = $FF
IDX_MASK_HI = $FF
COND_MASK   = $03        ; bit0 screen on (badlines), bit1 screen blanked
NREP        = 3
USE_D031    = 1
BADBIT      = $00
D030_WRITE  = 0
D030_VALUE  = $01
SPEED_TABLE = 1
NOMINAL_M   = 1
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

HDR_NOMINAL = H+$12
HDR_REUPRES = H+$15

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
        ; REU present? the address register must read back
        lda #$A5
        sta $DF02
        lda $DF02
        cmp #$A5
        bne noreu
        lda #1
        sta HDR_REUPRES
noreu:
        lda #D030_WRITE
        beq nod030
        lda #D030_VALUE
        sta $D030
nod030:
        jsr framecal
        lda #0
        sta z_idx
        lda #<RECORDS
        sta p_idx
        lda #>RECORDS
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
        lda #0
        sta z_cond
        lda p_idx
        sta rp
        lda p_idx+1
        sta rp+1
cl:     ldx z_cond
        lda #COND_MASK
        and bit8,x
        bne cl_run
        ; skipped condition: keep layout (3 reps x 6 transfers x 4 bytes = 72 bytes)
        ldx #rp
        lda #72
        jsr add_p
        jmp cl_next
cl_run: jsr setcond
        lda #0
        sta z_rep
rl:     lda #0
        sta z_var            ; transfer index 0..5
xl:     jsr do_xfer
        inc z_var
        lda z_var
        cmp #6
        bne xl
        inc z_rep
        lda z_rep
        cmp #NREP
        bne rl
        ; unused repetitions keep the layout
        lda #NREP
        cmp #3
        beq cl_next
        lda #3
        sec
        sbc #NREP
        tax
cl_pad: txa
        pha
        ldx #rp
        lda #24
        jsr add_p
        pla
        tax
        dex
        bne cl_pad
cl_next:
        inc z_cond
        lda z_cond
        cmp #2
        beq cl_end
        jmp cl
cl_end:
il_next:
        ldx #p_idx
        lda #144
        jsr add_p
        lda p_idx
        sta rp
        lda p_idx+1
        sta rp+1
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

; transfer table: 0 stash 32 KB, 1 stash 16 KB, 2 stash 1 byte, 3 fetch 32 KB, 4 fetch 16 KB, 5 fetch 1 byte
xlen_lo: .byte $00,$00,$01,$00,$00,$01
xlen_hi: .byte $80,$40,$00,$80,$40,$00
xcmd:    .byte $90,$90,$90,$91,$91,$91

do_xfer:
        ldx z_var
        lda #0
        sta $DF02            ; C64 address $4000
        lda #$40
        sta $DF03
        lda #0
        sta $DF04            ; REU address 0
        sta $DF05
        sta $DF06
        sta $DF0A            ; both addresses increment
        lda xlen_lo,x
        sta $DF07
        lda xlen_hi,x
        sta $DF08
        lda xcmd,x
        sta z_t1
        jsr timers_init
        ldx z_rep
        lda startlines,x
        jsr sync
        lda #1
        sta $DD0E            ; start timer A
        lda z_t1
        sta $DF01            ; execute (FF00-disabled): the CPU waits while the REC transfers
        lda #0
        sta $DD0E            ; stop timer A
        jsr store4
        rts

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
        lda #6
        sta z_lo
        lda #1
        sta z_hi
        jsr timers_init
        jsr var_ram
        lda $DD06
        cmp #$FF
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
