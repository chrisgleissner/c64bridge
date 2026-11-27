; PULSE GUARD - the c64bridge + SIDWave showcase game. PAL C64, joystick in port 2.
;
; Assembled by build.mjs with 6502-toolkit. "music.acme" is the symbol file of the SIDWave game build of
; pulse_guard.yaml; "art.acme" is generated from art.txt.
;
; Timing: one raster interrupt per frame at line 250. It copies the sprite shadow registers to the VIC,
; scrolls the stars and calls the SIDWave player (or starts the requested song). The main loop runs once per
; frame after the interrupt, updates the game and starts sound effects with sidwave_sfx.
;
; Coordinates: x is stored in half pixels (sprite X = 2 * x), so one byte covers the screen.

        !source "music.acme"
        !source "art.acme"      ; constants only

SCREEN   = $0400
COLOR    = $d800
CHARSET  = $3000
SPRPTR   = $07f8

CH_STAR  = 64                   ; 3 layers of 8 characters: 64-87
CH_BLOCK = 88
CH_FULL  = 89
CH_EMPTY = 90

ST_TITLE = 0
ST_PLAY  = 1
ST_WARN  = 2
ST_BOSS  = 3
ST_BDIE  = 4
ST_CLEAR = 5
ST_DIE   = 6
ST_OVER  = 7

T_FREE   = 0
T_DRONE  = 1
T_MOTH   = 2
T_HUNTER = 3
T_CELL   = 4
T_BOMB   = 5
T_BOOM   = 6

OBJS     = 5                    ; object slots, sprites 3-7
SONG_TITLE  = 0
SONG_FLIGHT = 1
SONG_BOSS   = 2
SONG_CLEAR  = 3
SONG_OVER   = 4

; zero page (the player saves and restores $FB-$FE)
ptr      = $02
cptr     = $04
tmp      = $06
tmp2     = $07
tmp3     = $08
row      = $09
col      = $0a

        * = $0801
        !byte $0b,$08,$0a,$00,$9e,$32,$30,$36,$34,$00,$00,$00      ; 10 SYS2064
        !fill $0810 - *, 0

; ---------------------------------------------------------------------------------------------------------------
start:  sei
        cld
        lda #$7f
        sta $dc0d
        sta $dd0d
        lda $dc0d
        lda $dd0d
        jsr make_charset
        lda #0
        sta $d020
        sta $d021
        sta $d015
        ldx #0
.clv:   sta vars,x
        inx
        cpx #<(vars_end - vars)
        bne .clv
        lda #$ff
        sta song_req
        sta $d01c               ; all sprites multicolour
        lda #0
        sta $dc02               ; port A as input: joystick port 2
        lda #1
        sta $d025
        lda #8
        sta $d026
        lda #%11111000
        sta $d01b               ; objects pass behind the text
        lda #$1c                ; screen $0400, charset $3000
        sta $d018
        lda #$a5
        sta seed
        lda #SONG_TITLE
        ldx #0
        jsr sidwave_init
        jsr title_enter
        lda #$01
        sta $d01a
        lda #250
        sta $d012
        lda $d011
        and #$7f
        sta $d011
        lda #<irq
        sta $0314
        lda #>irq
        sta $0315
        lda #$ff
        sta $d019
        cli

mainloop:
        lda frame
.wait:  cmp frame
        beq .wait
        lda frame
        sec
        sbc last_frame
        cmp #2
        bcc .intime
        inc overruns            ; the previous update took longer than one frame
.intime:
        lda frame
        sta last_frame
        jsr read_input
        jsr dispatch
        jsr compose_sprites
        jmp mainloop

dispatch:
        lda state
        asl
        tax
        lda state_table+1,x
        pha
        lda state_table,x
        pha
        rts
state_table:
        !word title_update-1, play_update-1, warn_update-1, boss_update-1
        !word bdie_update-1, clear_update-1, die_update-1, over_update-1

; ---------------------------------------------------------------------------------------------------------------
irq:    cld
        lda #$01
        sta $d019
        ; sprite shadow registers
        lda #0
        sta tmpirq
        ldx #7
        ldy #14
.spr:   lda sh_x,x
        asl
        rol tmpirq
        sta $d000,y
        lda sh_y,x
        sta $d001,y
        lda sh_ptr,x
        sta SPRPTR,x
        lda sh_col,x
        sta $d027,x
        dey
        dey
        dex
        bpl .spr
        lda tmpirq
        sta $d010
        lda sh_en
        sta $d015
        lda sh_exp
        sta $d017
        sta $d01d
        lda border              ; write the border only when it changes: on a newer VIC-II every write
        cmp border_shown        ; to a colour register leaves a grey dot
        beq .same
        sta $d020
        sta border_shown
.same:
        jsr scroll_stars
        lda song_req
        bmi .play
        ldx #0
        jsr sidwave_init
        lda #$ff
        sta song_req
        jmp .done
.play:  ; measure the player with CIA 2 timer A (includes badline and sprite cycles)
        lda #$ff
        sta $dd04
        sta $dd05
        lda #%00011001          ; force load, one shot, start
        sta $dd0e
        jsr sidwave_play
        lda #0
        sta $dd0e
        sec
        lda #$ff
        sbc $dd04
        tax
        lda #$ff
        sbc $dd05
        cmp play_max+1
        bcc .done
        bne .newmax
        cpx play_max
        bcc .done
.newmax:
        stx play_max
        sta play_max+1
.done:  inc frame
        jmp $ea81

; Three star layers move down at 1/3, 1 and 2 pixels per frame by moving bytes inside character data.
scroll_stars:
        inc star_div
        lda star_div
        cmp #3
        bcc .mid
        lda #0
        sta star_div
        lda star0
        tax
        clc
        adc #29
        and #63
        tay
        lda #0
        sta CHARSET + 64*8,x
        sta CHARSET + 64*8,y
        inx
        txa
        and #63
        sta star0
        tax
        clc
        adc #29
        and #63
        tay
        lda #%00001000
        sta CHARSET + 64*8,x
        sta CHARSET + 64*8,y
.mid:
        lda star1
        tax
        clc
        adc #37
        and #63
        tay
        lda #0
        sta CHARSET + 72*8,x
        sta CHARSET + 72*8,y
        inx
        txa
        and #63
        sta star1
        tax
        clc
        adc #37
        and #63
        tay
        lda #%00100000
        sta CHARSET + 72*8,x
        sta CHARSET + 72*8,y
        ; the near layer moves two pixels and draws a short streak
        ldx star2
        lda #0
        sta CHARSET + 80*8,x
        inx
        txa
        and #63
        tax
        lda #0
        sta CHARSET + 80*8,x
        inx
        txa
        and #63
        sta star2
        tax
        lda #%00000010
        sta CHARSET + 80*8,x
        inx
        txa
        and #63
        tax
        lda #%00000010
        sta CHARSET + 80*8,x
        rts

; ---------------------------------------------------------------------------------------------------------------
make_charset:
        lda #$33                ; character ROM visible
        sta $01
        ldx #0
.copy:  lda $d000,x
        sta CHARSET,x
        lda $d100,x
        sta CHARSET + $100,x
        lda $d200,x
        sta CHARSET + $200,x
        lda $d300,x
        sta CHARSET + $300,x
        lda $d400,x
        sta CHARSET + $400,x
        lda $d500,x
        sta CHARSET + $500,x
        lda $d600,x
        sta CHARSET + $600,x
        lda $d700,x
        sta CHARSET + $700,x
        inx
        bne .copy
        lda #$37
        sta $01
        lda #0
        ldx #0
.stars: sta CHARSET + 64*8,x
        inx
        cpx #192
        bne .stars
        ldx #23
.glyph: lda glyphs,x
        sta CHARSET + 88*8,x
        dex
        bpl .glyph
        rts
glyphs: !byte $fe,$fe,$fe,$fe,$fe,$fe,$fe,$00     ; logo block
        !byte $00,$7e,$7e,$7e,$7e,$7e,$7e,$00     ; bar segment, full
        !byte $00,$00,$00,$18,$18,$00,$00,$00     ; bar segment, empty

; ---------------------------------------------------------------------------------------------------------------
; Screen helpers.

; set_row: ptr/cptr point at the start of screen row A
set_row:
        tax
        lda row_lo,x
        sta ptr
        sta cptr
        lda row_hi,x
        sta ptr+1
        clc
        adc #$d4
        sta cptr+1
        rts

; draw_star_row: restore the background of row A (rows 0 and 24 are blank)
draw_star_row:
        sta row
        jsr set_row
        ldy #39
.cell:  lda row
        beq .blank
        cmp #24
        beq .blank
        lda star_layer,y
        bmi .blank
        tax
        lda row
        clc
        adc star_phase,y
        and #7
        clc
        adc layer_base,x
        sta (ptr),y
        lda layer_col,x
        sta (cptr),y
        jmp .next
.blank: lda #32
        sta (ptr),y
        lda #1
        sta (cptr),y
.next:  dey
        bpl .cell
        rts

clear_screen:
        lda #0
.rows:  pha
        jsr draw_star_row
        pla
        clc
        adc #1
        cmp #25
        bne .rows
        rts

; print: A/X = address of a message: row, column, colour, screen codes, $ff
print:  sta src+1
        stx src+2
        jsr .get
        pha
        jsr .get
        sta col
        jsr .get
        sta tmp3
        pla
        jsr set_row
.chars: jsr .get
        cmp #$ff
        beq .end
        ldy col
        sta (ptr),y
        lda tmp3
        sta (cptr),y
        inc col
        jmp .chars
.end:   rts
.get:
src:    lda $ffff
        inc src+1
        bne .ok
        inc src+2
.ok:    rts

; digits: print the BCD byte in A as two digits at (ptr),y, colour white
digits: pha
        lsr
        lsr
        lsr
        lsr
        jsr .one
        pla
        and #15
.one:   ora #$30
        sta (ptr),y
        lda #1
        sta (cptr),y
        iny
        rts

; ---------------------------------------------------------------------------------------------------------------
read_input:
        lda joy
        sta joy_old
        lda $dc00
        eor #$ff
        and #$1f
        sta joy                 ; 1 up, 2 down, 4 left, 8 right, 16 fire
        eor joy_old
        and joy
        sta joy_new             ; newly pressed
        rts

random: lda seed
        asl
        bcc .keep
        eor #$1d
.keep:  sta seed
        eor $d012
        rts

; sfx: start effect A on any voice it allows; preserves X
sfx:    stx sfx_x
        ldy #$ff
        jsr sidwave_sfx
        ldx sfx_x
        rts

; ---------------------------------------------------------------------------------------------------------------
; Title screen.
title_enter:
        lda #ST_TITLE
        sta state
        lda #0
        sta sh_en
        sta sh_exp
        sta border
        sta timer
        sta timer+1
        sta shine
        jsr clear_screen
        lda #<msg_head
        ldx #>msg_head
        jsr print
        ; logo
        lda #0
        sta tmp2                ; letter number 0-9
.letter:
        ldx tmp2
        lda logo_col,x
        sta col
        lda logo_top,x
        sta row
        lda logo_letter,x       ; offset into logo_font (7 bytes per letter)
        sta tmp3
        lda #0
        sta tmp                 ; font row
.frow:  lda row
        clc
        adc tmp
        jsr set_row
        lda tmp3
        clc
        adc tmp
        tax
        lda logo_font,x
        sta bits
        ldy col
        ldx #5
.fbit:  asl bits
        bcc .skip
        lda #CH_BLOCK
        sta (ptr),y
        sty ysave
        ldy tmp
        lda logo_colour,y
        ldy ysave
        sta (cptr),y
.skip:  iny
        dex
        bne .fbit
        inc tmp
        lda tmp
        cmp #7
        bne .frow
        inc tmp2
        lda tmp2
        cmp #10
        bne .letter
        lda #<msg_joy
        ldx #>msg_joy
        jsr print
        lda #<msg_points
        ldx #>msg_points
        jsr print
        lda #<msg_press
        ldx #>msg_press
        jsr print
        lda #<msg_hi
        ldx #>msg_hi
        jsr print
        lda #24
        jsr set_row
        ldy #22
        lda hiscore+2
        jsr digits
        lda hiscore+1
        jsr digits
        lda hiscore
        jsr digits
        ; the four things to meet, shown as sprites above their points
        ldx #3
.leg:   lda legend_x,x
        sta sh_x+3,x
        lda #205
        sta sh_y+3,x
        lda legend_col,x
        sta sh_col+3,x
        dex
        bpl .leg
        lda #%01111000
        sta sh_en
        rts

title_update:
        inc timer
        bne .nohi
        inc timer+1
.nohi:  ; legend animation
        lda timer
        lsr
        lsr
        lsr
        lsr
        and #1
        sta tmp
        ldx #3
.anim:  lda legend_ptr,x
        clc
        adc tmp
        sta sh_ptr+3,x
        dex
        bpl .anim
        ; blinking prompt
        lda timer
        and #31
        bne .noblink
        lda timer
        and #32
        bne .off
        lda #<msg_press
        ldx #>msg_press
        jsr print
        jmp .noblink
.off:   lda #<msg_blank
        ldx #>msg_blank
        jsr print
.noblink:
        jsr shine_logo
        lda joy_new
        and #16
        beq .done
        jmp game_start
.done:  rts

; A white highlight runs across the logo every few seconds.
shine_logo:
        lda shine
        cmp #40
        bcs .step
        sta col
        jsr .restore
        inc shine
        lda shine
        cmp #40
        bcs .done
        sta col
        ldx #0
.white: stx tmp
        lda shine_rows,x
        jsr set_row
        ldy col
        lda (ptr),y
        cmp #CH_BLOCK
        bne .n
        lda #1
        sta (cptr),y
.n:     ldx tmp
        inx
        cpx #14
        bne .white
.done:  rts
.step:  inc shine               ; pause, then start again at column 0
        lda shine
        cmp #200
        bcc .done
        lda #0
        sta shine
        rts
.restore:
        ldx #0
.r:     stx tmp
        lda shine_rows,x
        jsr set_row
        ldy col
        lda (ptr),y
        cmp #CH_BLOCK
        bne .rn
        lda tmp
.mod:   cmp #7
        bcc .col
        sbc #7
        bcs .mod
.col:   tax
        lda logo_colour,x
        sta (cptr),y
.rn:    ldx tmp
        inx
        cpx #14
        bne .r
        rts

; ---------------------------------------------------------------------------------------------------------------
game_start:
        lda #0
        sta score
        sta score+1
        sta score+2
        sta sh_en
        lda #1
        sta wave
        sta wave_bcd
        lda #5
        sta shield
        lda #84
        sta px
        lda #212
        sta py
        lda #0
        sta invuln
        sta cooldown
        sta shot_y
        sta shot_y+1
        sta flash
        sta border
        jsr clear_objects
        jsr clear_screen
        lda #<msg_hud
        ldx #>msg_hud
        jsr print
        jsr draw_score
        lda #<msg_hud2
        ldx #>msg_hud2
        jsr print
        jsr draw_shield
        jsr wave_start
        lda #sidwave_fx_start
        jsr sfx
        rts

wave_start:
        lda #ST_PLAY
        sta state
        lda #SONG_FLIGHT
        sta song_req
        lda #0
        sta spawned
        sta timer
        sta timer+1
        lda #70
        sta spawn_wait
        lda #<msg_wave
        ldx #>msg_wave
        jsr print
        lda #11
        jsr set_row
        ldy #22
        lda wave_bcd
        jsr digits
        lda #120
        sta msg_timer
        jmp draw_wave

clear_objects:
        ldx #OBJS-1
        lda #T_FREE
.c:     sta otype,x
        dex
        bpl .c
        rts

play_update:
        jsr common_update
        lda state
        cmp #ST_PLAY
        bne .done
        lda spawned
        cmp #WAVE_SPAWNS
        bcc .spawn
        ; all spawned: wait until the sky is empty, then warn
        ldx #OBJS-1
.busy:  lda otype,x
        bne .done
        dex
        bpl .busy
        jmp warn_start
.spawn: dec spawn_wait
        bne .done
        jsr spawn
.done:  rts

WAVE_SPAWNS = 48

; common_update: player, shots, objects, collisions and messages; used by every state with a live ship
common_update:
        jsr move_player
        jsr fire
        jsr move_shots
        jsr move_objects
        jsr hit_shots
        jsr hit_player
        lda msg_timer
        beq .nomsg
        dec msg_timer
        bne .nomsg
        jsr erase_msg
.nomsg: lda invuln
        beq .noinv
        dec invuln
.noinv: lda #0
        ldx flash
        beq .border
        dec flash
        lda #2
.border:
        sta border
        rts

erase_msg:
        lda #11
        jsr draw_star_row
        lda #13
        jmp draw_star_row

move_player:
        lda joy
        and #4
        beq .nl
        lda px
        cmp #15
        bcc .nl
        dec px
        dec px
.nl:    lda joy
        and #8
        beq .nr
        lda px
        cmp #157
        bcs .nr
        inc px
        inc px
.nr:    lda joy
        and #1
        beq .nu
        lda py
        cmp #132
        bcc .nu
        dec py
        dec py
        dec py
.nu:    lda joy
        and #2
        beq .nd
        lda py
        cmp #218
        bcs .nd
        inc py
        inc py
        inc py
.nd:    rts

fire:   lda cooldown
        beq .ready
        dec cooldown
        rts
.ready: lda joy
        and #16
        beq .done
        ldx #1
.find:  lda shot_y,x
        beq .free
        dex
        bpl .find
        rts
.free:  lda px
        sta shot_x,x
        lda py
        sec
        sbc #14
        sta shot_y,x
        lda #9
        sta cooldown
        lda #sidwave_fx_shot
        jsr sfx
.done:  rts

move_shots:
        ldx #1
.s:     lda shot_y,x
        beq .n
        sec
        sbc #7
        cmp #46
        bcs .keep
        lda #0
.keep:  sta shot_y,x
.n:     dex
        bpl .s
        rts

; ---------------------------------------------------------------------------------------------------------------
; Objects.
free_slot:                      ; X = a free slot, carry clear; carry set if none (slots 0-1 are the boss)
        ldx #OBJS-1
.f:     lda otype,x
        beq .got
        dex
        bmi .none
        cpx first_slot
        bcs .f
.none:  sec
        rts
.got:   clc
        rts

spawn:  jsr free_slot
        bcc .ok
        lda #8
        sta spawn_wait
        rts
.ok:    inc spawned
        ; interval: shorter in later waves and towards the end of a wave
        lda spawned
        lsr
        sta tmp
        lda wave
        cmp #7
        bcc .w
        lda #6
.w:     asl
        asl
        clc
        adc tmp
        sta tmp
        lda #44
        sec
        sbc tmp
        cmp #18
        bcs .int
        lda #18
.int:   sta spawn_wait
        lda #34
        sta oy,x
        lda #0
        sta otimer,x
        sta oflash,x
        jsr random
        and #127
        clc
        adc #22
        sta ox,x
        sta obase,x
        lda #1
        sta ohp,x
        lda spawned
        and #7
        cmp #5
        bne .enemy
        lda #T_CELL
        sta otype,x
        rts
.enemy: lda spawned
        cmp #8
        bcc .drone
        jsr random
        cmp #110
        bcc .drone
        cmp #190
        bcc .moth
        lda wave
        cmp #2
        bcs .hunter
        lda spawned
        cmp #18
        bcc .moth
.hunter:
        lda #T_HUNTER
        sta otype,x
        lda #2
        sta ohp,x
        rts
.moth:  lda #T_MOTH
        sta otype,x
        lda #1
        sta odx,x
        lda ox,x
        cmp #86
        bcc .right
        lda #$ff
        sta odx,x
.right: rts
.drone: lda #T_DRONE
        sta otype,x
        rts

move_objects:
        ldx #OBJS-1
.o:     lda otype,x
        beq .next
        inc otimer,x
        lda oflash,x
        beq .nf
        dec oflash,x
.nf:    jsr move_one
        lda oy,x
        cmp #250
        bcc .next
        lda #T_FREE
        sta otype,x
.next:  dex
        bpl .o
        rts
move_one:                       ; calls the handler of the type of slot X
        lda otype,x
        asl
        tay
        lda move_table+1,y
        pha
        lda move_table,y
        pha
        rts
move_table:
        !word 0, mv_drone-1, mv_moth-1, mv_hunter-1, mv_cell-1, mv_bomb-1, mv_boom-1

mv_drone:
        inc oy,x
        lda wave
        cmp #2
        bcc .slow
        lda otimer,x
        and #1
        bne .slow
        inc oy,x
.slow:  lda otimer,x
        lsr
        lsr
        and #31
        tay
        lda obase,x
        clc
        adc sine,y
        sta ox,x
        lda otimer,x
        and #1
        bne .b
        inc oy,x
.b:     rts

mv_moth:
        inc oy,x
        lda otimer,x
        and #7
        bne .x
        inc oy,x
.x:     lda ox,x
        clc
        adc odx,x
        sta ox,x
        cmp #16
        bcs .l
        lda #1
        sta odx,x
.l:     lda ox,x
        cmp #156
        bcc .b
        lda #$ff
        sta odx,x
.b:     rts

mv_hunter:
        inc oy,x
        lda otimer,x
        and #1
        bne .y
        inc oy,x
        lda ox,x
        cmp px
        beq .y
        bcc .r
        dec ox,x
        jmp .y
.r:     inc ox,x
.y:     lda otimer,x
        cmp #36
        bne .b
        jsr drop_bomb
.b:     rts

; drop_bomb: from the object in slot X
drop_bomb:
        stx tmp2
        lda ox,x
        sta bomb_x
        lda oy,x
        clc
        adc #12
        sta bomb_y
        jsr new_bomb
        ldx tmp2
        rts

; new_bomb: at bomb_x/bomb_y, aimed at the ship
new_bomb:
        jsr free_slot
        bcs .none
        lda #T_BOMB
        sta otype,x
        lda bomb_x
        sta ox,x
        lda bomb_y
        sta oy,x
        lda #0
        sta otimer,x
        sta oflash,x
        ldy #0
        lda px
        sec
        sbc bomb_x
        bcs .pos
        eor #$ff
        cmp #12
        bcc .set
        ldy #$ff
        bne .set
.pos:   cmp #12
        bcc .set
        ldy #1
.set:   tya
        sta odx,x
        lda #sidwave_fx_bomb
        jsr sfx
.none:  rts

mv_cell:
        inc oy,x
        lda otimer,x
        and #3
        beq .b
        and #1
        bne .b
        inc oy,x
.b:     rts

mv_bomb:
        inc oy,x
        inc oy,x
        lda wave
        cmp #3
        bcc .s
        inc oy,x
.s:     lda otimer,x
        and #1
        bne .b
        lda ox,x
        clc
        adc odx,x
        sta ox,x
        cmp #12
        bcc .gone
        cmp #164
        bcc .b
.gone:  lda #251
        sta oy,x
.b:     rts

mv_boom:
        lda otimer,x
        cmp #20
        bcc .b
        lda #T_FREE
        sta otype,x
.b:     rts

explode:                        ; the object in slot X explodes
        lda #T_BOOM
        sta otype,x
        lda #0
        sta otimer,x
        sta oflash,x
        rts

; ---------------------------------------------------------------------------------------------------------------
; Shots against enemies and the boss.
hit_shots:
        ldy #1
.shot:  lda shot_y,y
        bne .live
        jmp .nexts
.live:
        ldx #OBJS-1
.obj:   lda otype,x
        beq .nexto
        cmp #T_CELL
        bcs .nexto              ; cells, bombs and explosions are not targets
        lda shot_x,y
        sec
        sbc ox,x
        clc
        adc #7
        cmp #15
        bcs .nexto
        lda shot_y,y
        sec
        sbc oy,x
        clc
        adc #13
        cmp #27
        bcs .nexto
        lda #0
        sta shot_y,y
        sty tmp2
        dec ohp,x
        beq .kill
        lda #6
        sta oflash,x
        lda #sidwave_fx_ping
        jsr sfx
        ldy tmp2
        jmp .nexts
.kill:  lda otype,x
        tay
        lda points_lo,y
        pha
        lda points_hi,y
        tay
        pla
        jsr add_score
        jsr explode
        lda #sidwave_fx_explode
        jsr sfx
        ldy tmp2
        jmp .nexts
.nexto: dex
        bpl .obj
        ; the boss
        lda state
        cmp #ST_BOSS
        bne .nexts
        lda shot_x,y
        sec
        sbc boss_x
        sbc #4
        cmp #40
        bcs .nexts
        lda boss_y
        clc
        adc #30
        cmp shot_y,y
        bcc .nexts
        lda #0
        sta shot_y,y
        sty tmp2
        lda #2
        sta boss_flash
        lda #$10
        ldy #$00
        jsr add_score
        dec boss_hp
        bne .alive
        jsr boss_kill
        rts
.alive: jsr draw_boss_bar
        lda #sidwave_fx_ping
        jsr sfx
        ldy tmp2
.nexts: dey
        bmi .done
        jmp .shot
.done:  rts

; hit_player: objects and the boss against the ship
hit_player:
        ldx #OBJS-1
.obj:   lda otype,x
        beq .next
        cmp #T_BOOM
        beq .next
        lda ox,x
        sec
        sbc px
        clc
        adc #8
        cmp #17
        bcs .next
        lda oy,x
        sec
        sbc py
        clc
        adc #14
        cmp #29
        bcs .next
        lda otype,x
        cmp #T_CELL
        bne .enemy
        lda #T_FREE
        sta otype,x
        lda #$50
        ldy #$00
        jsr add_score
        lda shield
        cmp #5
        bcs .full
        inc shield
        jsr draw_shield
.full:  lda #sidwave_fx_pickup
        jsr sfx
        jmp .next
.enemy: lda invuln
        bne .next
        jsr explode
        jsr damage
.next:  dex
        bpl .obj
        lda state
        cmp #ST_BOSS
        bne .done
        lda invuln
        bne .done
        lda px
        sec
        sbc boss_x
        clc
        adc #4
        cmp #52
        bcs .done
        lda boss_y
        clc
        adc #34
        cmp py
        bcc .done
        jsr damage
.done:  rts

damage: lda state
        cmp #ST_BDIE
        beq .safe
        cmp #ST_CLEAR
        bne .hit
.safe:  rts
.hit:   stx tmp2
        lda #100
        sta invuln
        lda #8
        sta flash
        lda shield
        beq .dead
        dec shield
        jsr draw_shield
        lda #sidwave_fx_hurt
        jsr sfx
        ldx tmp2
        rts
.dead:  lda #ST_DIE
        sta state
        lda #0
        sta timer
        sta border
        sta shot_y
        sta shot_y+1
        lda #sidwave_fx_blast
        jsr sfx
        ldx tmp2
        rts

; add_score: A = BCD tens and units, Y = BCD thousands and hundreds
add_score:
        sed
        clc
        adc score
        sta score
        tya
        adc score+1
        sta score+1
        lda score+2
        adc #0
        sta score+2
        cld
        stx score_x
        sty score_y
        jsr draw_score
        ldx score_x
        ldy score_y
        rts

draw_score:
        ; keep the high score up to date
        ldx #2
.cmp:   lda score,x
        cmp hiscore,x
        bcc .show
        bne .new
        dex
        bpl .cmp
        bmi .show
.new:   ldx #2
.cp:    lda score,x
        sta hiscore,x
        dex
        bpl .cp
.show:  lda #0
        jsr set_row
        ldy #7
        lda score+2
        jsr digits
        lda score+1
        jsr digits
        lda score
        jsr digits
        ldy #18
        lda hiscore+2
        jsr digits
        lda hiscore+1
        jsr digits
        lda hiscore
        jmp digits

draw_wave:
        lda #0
        jsr set_row
        ldy #35
        lda wave_bcd
        jmp digits

draw_shield:
        lda #24
        jsr set_row
        ldx #0
        ldy #8
.s:     cpx shield
        bcs .empty
        lda #CH_FULL
        sta (ptr),y
        lda #13
        cpx #0
        bne .c
        lda shield
        cmp #1
        bne .green
        lda #10                 ; the last segment turns red
        bne .c
.green: lda #13
.c:     sta (cptr),y
        jmp .n
.empty: lda #CH_EMPTY
        sta (ptr),y
        lda #11
        sta (cptr),y
.n:     iny
        inx
        cpx #5
        bne .s
        rts

; ---------------------------------------------------------------------------------------------------------------
; Boss.
warn_start:
        lda #ST_WARN
        sta state
        lda #SONG_BOSS
        sta song_req
        lda #0
        sta timer
        sta msg_timer
        ; the boss takes object slots 0 and 1
        lda #2
        sta first_slot
        ; hit points 48, 64, 80 and the amount one bar segment stands for
        lda wave
        cmp #3
        bcc .w
        lda #3
.w:     tax
        lda boss_hp_tab-1,x
        sta boss_hp
        lda boss_seg_tab-1,x
        sta boss_seg
        lda #74
        sta boss_x
        lda #2
        sta boss_y
        lda #1
        sta boss_dx
        lda #60
        sta boss_wait
        lda #0
        sta boss_flash
        sta boss_phase
        rts

warn_update:
        jsr common_update
        lda state
        cmp #ST_WARN
        bne .done
        inc timer
        lda timer
        cmp #20
        bne .a
        lda #sidwave_fx_alarm
        jsr sfx
.a:     lda timer
        and #15
        bne .b
        lda timer
        and #16
        bne .off
        lda #<msg_warn
        ldx #>msg_warn
        jsr print
        jmp .b
.off:   jsr erase_msg
.b:     lda timer
        cmp #85
        bne .c
        lda #sidwave_fx_alarm
        jsr sfx
.c:     lda timer
        cmp #170
        bcc .done
        jsr erase_msg
        lda #ST_BOSS
        sta state
        lda #<msg_boss
        ldx #>msg_boss
        jsr print
        jsr draw_boss_bar
.done:  rts

draw_boss_bar:
        stx tmp
        lda #24
        jsr set_row
        ldx #0
        ldy #23
        lda #0
        sta bar_acc
.s:     lda bar_acc
        cmp boss_hp
        bcs .empty
        lda #CH_FULL
        sta (ptr),y
        lda #10
        sta (cptr),y
        jmp .n
.empty: lda #CH_EMPTY
        sta (ptr),y
        lda #11
        sta (cptr),y
.n:     lda bar_acc
        clc
        adc boss_seg
        sta bar_acc
        iny
        inx
        cpx #16
        bne .s
        ldx tmp
        rts

boss_update:
        jsr common_update
        lda state
        cmp #ST_BOSS
        beq .go
        rts
.go:    inc timer
        lda boss_flash
        beq .nf
        dec boss_flash
.nf:    ; entrance
        lda boss_phase          ; 0 until the descent is over
        bne .move
        inc boss_y
        lda boss_y
        cmp #84
        bcc .wait
        inc boss_phase
        lda #0
        sta timer
.wait:  rts
.move:  ; the boss speeds up below half of its energy
        lda boss_seg
        asl
        asl
        asl
        cmp boss_hp
        bcs .fast
        lda timer
        and #1
        bne .bob
.fast:  lda boss_x
        clc
        adc boss_dx
        sta boss_x
        cmp #15
        bcs .l
        lda #1
        sta boss_dx
.l:     lda boss_x
        cmp #133
        bcc .bob
        lda #$ff
        sta boss_dx
.bob:   lda timer
        lsr
        lsr
        and #31
        tay
        lda sine,y
        clc
        adc sine,y
        clc
        adc #84
        sta boss_y
        dec boss_wait
        bne .done
        lda wave
        cmp #5
        bcc .w
        lda #4
.w:     asl
        asl
        asl
        sta tmp
        lda #54
        sec
        sbc tmp
        sta boss_wait
        lda boss_x
        clc
        adc #12
        sta bomb_x
        lda boss_y
        clc
        adc #34
        sta bomb_y
        jsr new_bomb
        ; below half energy the wings fire too
        lda boss_seg
        asl
        asl
        asl
        cmp boss_hp
        bcc .done
        lda boss_x
        sta bomb_x
        lda boss_y
        clc
        adc #20
        sta bomb_y
        jsr new_bomb
.done:  rts

boss_kill:
        lda #ST_BDIE
        sta state
        lda #0
        sta timer
        sta boss_flash
        jsr draw_boss_bar
        lda #$00
        ldy #$50
        jsr add_score
        lda #sidwave_fx_blast
        jsr sfx
        ; bombs in flight vanish
        ldx #OBJS-1
.c:     lda otype,x
        cmp #T_BOMB
        bne .n
        jsr explode
.n:     dex
        bpl .c
        rts

bdie_update:
        jsr common_update
        lda state
        cmp #ST_BDIE
        beq .go
        rts
.go:    inc timer
        lda timer
        and #7
        bne .no
        jsr free_slot
        bcs .no
        jsr explode
        jsr random
        and #31
        clc
        adc boss_x
        sta ox,x
        jsr random
        and #31
        clc
        adc boss_y
        sta oy,x
        lda timer
        and #15
        bne .no
        lda #sidwave_fx_explode
        jsr sfx
.no:    lda timer
        cmp #100
        bcs .over
        rts
.over:  ; wave clear
        lda #ST_CLEAR
        sta state
        lda #0
        sta timer
        sta first_slot
        lda #SONG_CLEAR
        sta song_req
        jsr erase_msg
        lda #24
        jsr draw_star_row
        lda #<msg_hud2
        ldx #>msg_hud2
        jsr print
        jsr draw_shield
        lda #<msg_clear
        ldx #>msg_clear
        jsr print
        lda #<msg_bonus
        ldx #>msg_bonus
        jsr print
        lda #$00
        ldy #$20
        jsr add_score
        lda #0
        sta msg_timer
.done:  rts

clear_update:
        jsr common_update
        lda state
        cmp #ST_CLEAR
        bne .done
        inc timer
        lda timer
        cmp #250
        bcc .done
        jsr erase_msg
        inc wave
        sed
        lda wave_bcd
        clc
        adc #1
        sta wave_bcd
        cld
        jsr wave_start
.done:  rts

; ---------------------------------------------------------------------------------------------------------------
die_update:
        jsr move_objects
        lda #0
        sta border
        inc timer
        lda timer
        and #8
        beq .q
        lda timer
        cmp #40
        bcs .q
        lda #2
        sta border
.q:     lda timer
        cmp #90
        bcc .done
        lda #ST_OVER
        sta state
        lda #0
        sta timer
        sta timer+1
        sta first_slot
        sta border
        lda #SONG_OVER
        sta song_req
        jsr clear_objects
        jsr erase_msg
        lda #<msg_over
        ldx #>msg_over
        jsr print
        lda #<msg_again
        ldx #>msg_again
        jsr print
.done:  rts

over_update:
        inc timer
        bne .n
        inc timer+1
.n:     lda timer+1
        bne .armed
        lda timer
        cmp #60
        bcc .done
.armed: lda joy_new
        and #16
        bne .title
        lda timer+1
        cmp #3                  ; back to the title after about 15 seconds
        bcc .done
.title: lda #SONG_TITLE
        sta song_req
        jmp title_enter
.done:  rts

; ---------------------------------------------------------------------------------------------------------------
; Fill the sprite shadow registers from the game state.
compose_sprites:
        lda state
        bne .game
        rts                     ; the title screen sets its sprites itself
.game:  lda #0
        sta en
        sta sh_exp
        ; ship
        lda px
        sta sh_x
        lda py
        sta sh_y
        lda #14
        sta sh_col
        lda frame
        lsr
        lsr
        and #1
        clc
        adc #spr_ship_a
        sta sh_ptr
        lda state
        cmp #ST_OVER
        beq .shots
        cmp #ST_DIE
        bne .alive
        lda timer               ; the ship burns
        cmp #64
        bcs .shots
        lsr
        lsr
        lsr
        lsr
        clc
        adc #spr_boom1
        sta sh_ptr
        lda #7
        sta sh_col
        lda #1                  ; one large explosion
        sta sh_exp
        lda sh_x
        sec
        sbc #6
        sta sh_x
        lda sh_y
        sec
        sbc #10
        sta sh_y
        jmp .on
.alive: lda invuln
        and #4
        bne .shots
.on:    lda #1
        sta en
.shots: ldx #1
.s:     lda shot_y,x
        beq .sn
        sta sh_y+1,x
        lda shot_x,x
        sta sh_x+1,x
        lda #spr_shot
        sta sh_ptr+1,x
        lda frame
        and #2
        beq .c1
        lda #7
        bne .c2
.c1:    lda #13
.c2:    sta sh_col+1,x
        lda en
        ora bit_tab+1,x
        sta en
.sn:    dex
        bpl .s
        ldx #OBJS-1
.o:     lda otype,x
        beq .on2
        tay
        lda ox,x
        sta sh_x+3,x
        lda oy,x
        sta sh_y+3,x
        lda frame
        lsr
        lsr
        lsr
        and #1
        clc
        adc type_ptr,y
        sta sh_ptr+3,x
        lda type_col,y
        sta sh_col+3,x
        cpy #T_BOOM
        bne .nb
        lda otimer,x
        lsr
        lsr
        cmp #4
        bcc .bf
        lda #3
.bf:    clc
        adc #spr_boom1
        sta sh_ptr+3,x
        lda otimer,x
        lsr
        lsr
        tay
        lda boom_col,y
        sta sh_col+3,x
        jmp .vis
.nb:    cpy #T_CELL
        bne .nc
        lda frame
        and #8
        beq .vis
        lda #3
        sta sh_col+3,x
        jmp .vis
.nc:    lda oflash,x
        beq .vis
        lda #1
        sta sh_col+3,x
.vis:   lda en
        ora bit_tab+3,x
        sta en
.on2:   dex
        bpl .o
        ; boss: two expanded sprites, side by side
        lda state
        cmp #ST_WARN
        beq .nob
        cmp #ST_BOSS
        beq .boss
        cmp #ST_BDIE
        bne .nob
        lda timer
        cmp #80
        bcs .nob
        and #2
        bne .nob
.boss:  lda boss_x
        sta sh_x+3
        clc
        adc #24
        sta sh_x+4
        lda boss_y
        sta sh_y+3
        sta sh_y+4
        lda frame
        lsr
        lsr
        lsr
        and #1
        asl
        clc
        adc #spr_boss_l_a
        sta sh_ptr+3
        clc
        adc #1
        sta sh_ptr+4
        lda wave
        and #3
        tax
        lda boss_col,x
        ldx boss_flash
        beq .bc
        lda #1
.bc:    ldx state
        cpx #ST_BDIE
        bne .bc2
        lda #7
.bc2:   sta sh_col+3
        sta sh_col+4
        lda en
        ora #%00011000
        sta en
        lda sh_exp
        ora #%00011000
        sta sh_exp
.nob:   lda en
        sta sh_en
        rts

; ---------------------------------------------------------------------------------------------------------------
; Data.
bit_tab:    !byte 1,2,4,8,16,32,64,128
type_ptr:   !byte 0, spr_drone_a, spr_moth_a, spr_hunter_a, spr_cell_a, spr_bomb_a, spr_boom1
type_col:   !byte 0, 5, 4, 2, 13, 7, 7
points_lo:  !byte 0, $00, $50, $00
points_hi:  !byte 0, $01, $01, $03
boom_col:   !byte 1,7,7,8,2,9
boss_col:   !byte 9, 10, 4, 5
boss_hp_tab:  !byte 48, 64, 80
boss_seg_tab: !byte 3, 4, 5
sine:       !byte 0,1,2,3,5,6,6,7,7,7,6,6,5,3,2,1,0,255,254,253,251,250,250,249,249,249,250,250,251,253,254,255
row_lo:     !byte $00,$28,$50,$78,$a0,$c8,$f0,$18,$40,$68,$90,$b8,$e0,$08,$30,$58,$80,$a8,$d0,$f8,$20,$48,$70,$98,$c0
row_hi:     !byte 4,4,4,4,4,4,4,5,5,5,5,5,5,6,6,6,6,6,6,6,7,7,7,7,7
; star columns: layer 0-2 or $ff for none, and the vertical phase of each column
star_layer: !byte 0,$ff,1,0,$ff,2,0,$ff,1,$ff,0,2,$ff,1,0,$ff,0,$ff,2,1,$ff,0,$ff,1,0,2,$ff,0,1,$ff,0,$ff,2,0,1,$ff,0,2,$ff,1
star_phase: !byte 0,0,5,3,0,1,6,0,2,0,7,4,0,0,1,0,5,0,6,3,0,2,0,7,4,0,0,6,1,0,3,0,5,0,4,0,7,2,0,6
layer_base: !byte CH_STAR, CH_STAR+8, CH_STAR+16
layer_col:  !byte 11, 12, 15

legend_x:   !byte 50, 70, 98, 128
legend_col: !byte 5, 4, 2, 13
legend_ptr: !byte spr_drone_a, spr_moth_a, spr_hunter_a, spr_cell_a

; title logo: PULSE on rows 3-9, GUARD on rows 11-17
logo_col:    !byte 5,11,17,23,29, 5,11,17,23,29
logo_top:    !byte 2,2,2,2,2, 10,10,10,10,10
logo_letter: !byte logo_P, logo_U, logo_L, logo_S, logo_E, logo_G, logo_U, logo_A, logo_R, logo_D
logo_colour: !byte 1,13,3,14,14,4,6
shine_rows:  !byte 2,3,4,5,6,7,8, 10,11,12,13,14,15,16

msg_head:   !byte 0,6,15
            !scr "c64bridge  +  sidwave showcase"
            !byte $ff
msg_joy:    !byte 18,3,12
            !scr "joystick in port 2   fire to shoot"
            !byte $ff
msg_points: !byte 22,10,1
            !scr "100  150    300   shield"
            !byte $ff
msg_press:  !byte 23,10,7
            !scr "press fire to start"
            !byte $ff
msg_blank:  !byte 23,10,7
            !scr "                   "
            !byte $ff
msg_hi:     !byte 24,13,14
            !scr "hi score"
            !byte $ff
msg_hud:    !byte 0,1,14
            !scr "score         hi            wave"
            !byte $ff
msg_hud2:   !byte 24,1,14
            !scr "shield"
            !byte $ff
msg_wave:   !byte 11,17,7
            !scr "wave"
            !byte $ff
msg_warn:   !byte 11,12,10
            !scr "warning  iron moth"
            !byte $ff
msg_boss:   !byte 24,18,10
            !scr "boss"
            !byte $ff
msg_clear:  !byte 11,13,13
            !scr "wave cleared!"
            !byte $ff
msg_bonus:  !byte 13,13,7
            !scr "bonus    2000"
            !byte $ff
msg_over:   !byte 11,15,10
            !scr "game  over"
            !byte $ff
msg_again:  !byte 13,15,15
            !scr "press fire"
            !byte $ff

; ---------------------------------------------------------------------------------------------------------------
; Variables (cleared at start; fewer than 256 bytes).
vars:
frame:      !byte 0
last_frame: !byte 0
overruns:   !byte 0
play_max:   !byte 0,0
song_req:   !byte 0
tmpirq:     !byte 0
border:     !byte 0
border_shown: !byte 0
star_div:   !byte 0
star0:      !byte 0
star1:      !byte 0
star2:      !byte 0
sh_x:       !fill 8, 0
sh_y:       !fill 8, 0
sh_ptr:     !fill 8, 0
sh_col:     !fill 8, 0
sh_en:      !byte 0
sh_exp:     !byte 0
en:         !byte 0
state:      !byte 0
timer:      !byte 0,0
shine:      !byte 0
bits:       !byte 0
ysave:      !byte 0
seed:       !byte 0
joy:        !byte 0
joy_old:    !byte 0
joy_new:    !byte 0
sfx_x:      !byte 0
score:      !byte 0,0,0
hiscore:    !byte 0,0,0
score_x:    !byte 0
score_y:    !byte 0
wave:       !byte 0
wave_bcd:   !byte 0
shield:     !byte 0
px:         !byte 0
py:         !byte 0
invuln:     !byte 0
cooldown:   !byte 0
flash:      !byte 0
shot_x:     !byte 0,0
shot_y:     !byte 0,0
spawned:    !byte 0
spawn_wait: !byte 0
msg_timer:  !byte 0
first_slot: !byte 0
otype:      !fill OBJS, 0
ox:         !fill OBJS, 0
oy:         !fill OBJS, 0
odx:        !fill OBJS, 0
obase:      !fill OBJS, 0
ohp:        !fill OBJS, 0
otimer:     !fill OBJS, 0
oflash:     !fill OBJS, 0
bomb_x:     !byte 0
bomb_y:     !byte 0
boss_x:     !byte 0
boss_y:     !byte 0
boss_dx:    !byte 0
boss_hp:    !byte 0
boss_seg:   !byte 0
boss_wait:  !byte 0
boss_flash: !byte 0
boss_phase: !byte 0
bar_acc:    !byte 0
vars_end:

        !source "artdata.acme"  ; title font, then the sprites at $3800
