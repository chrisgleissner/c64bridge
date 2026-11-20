# C64 Game Techniques: IRQ, Sprites, Scrolling, Input, Sound

**Summary:** Compact recipes for the techniques almost every C64 game needs, with fresh minimal 6502 snippets. Snippets use 64tass/KickAssembler-compatible syntax (`* = addr`, `.byte`, `<label`, `>label`, `;` comments); the bridge's built-in assembler (`upload_run_asm`) accepts the basic subset. Anonymous `+` branch labels are 64tass style; rename for other assemblers. The IRQ setup, joystick edge, NTSC skip, LFSR, PAL detect and speed probe snippets were assembled with 64tass and run in VICE 3.10 x64sc; the multiplexer was assembled and its cycles counted from the c64ref cycle table; the open-border steps are Bauer's (Bauer 3.14.1).
**Read when:** implementing display timing, sprites, scrolling, collision, input, music/SFX (also several SIDs), random numbers, PAL/NTSC handling, Ultimate start-up checks (section 10) bitmap and multicolour modes (section 11) or multiply and divide (section 12). Frame structure and budgets: `c64://gamedev/architecture`. Register detail: `c64://graphics/vic/spec`, `c64://io/cia/spec`, `c64://sound/sid/spec`.

Sections 1-3, 6 and 9 end with **Seen in** (open-source projects to study; URLs and licences in `c64://gamedev/references`). Sources: Bauer's VIC-II article (Bauer), Mapping the Commodore 64 and the c64ref ROM disassembly and 6502 tables (mist64/c64ref), the PSID file format (`SID_file_format.txt`), firmware `1541ultimate@700c7f2fa`.

## 1. Raster IRQ and IRQ chains
Setup with KERNAL off (`$01=$35`; hardware vectors used):
```
        sei
        lda #$35
        sta $01
        lda #$7f          ; CIA IRQ sources off
        sta $dc0d
        sta $dd0d
        lda $dc0d         ; acknowledge pending
        lda $dd0d
        lda #<nmi
        sta $fffa
        lda #>nmi
        sta $fffb
        lda #<irq_top
        sta $fffe
        lda #>irq_top
        sta $ffff
        lda #$1b          ; bit 7 = raster line bit 8 = 0
        sta $d011
        lda #50
        sta $d012
        lda #$01          ; VIC raster IRQ on (enable last)
        sta $d01a
        lda #$ff
        sta $d019
        cli
main:   jmp main          ; main loop; never fall through into nmi
nmi:    rti
irq_top: pha
        txa
        pha
        tya
        pha
        lda #$ff          ; ack all VIC sources
        sta $d019
        ; ... work ...
        lda #<irq_next    ; chain: next vector and line
        sta $fffe
        lda #>irq_next
        sta $ffff
        lda #200
        sta $d012
        pla
        tay
        pla
        tax
        pla
        rti
```
- With the KERNAL on, use the vector `$0314/$0315` and exit with `jmp $ea31` (clock, cursor, keyboard scan) or `jmp $ea81` (registers and `RTI` only).
- Lines above 255: set `$D011` bit 7 for that entry (the 9th raster bit). Always rewrite `$D011` with bit 7 matching the next line.
- Chain rules: entries sorted by line; handler worst-case time shorter than the gap to the next entry; if the next line has already passed when you program `$D012`, run the next handler directly instead of waiting a whole frame; acknowledge `$D019` first; save `$01` if the main loop changes it. NMI must have a vector (RESTORE key).
- The NMOS 6510 does not clear the decimal flag on an interrupt: start a handler that does `ADC`/`SBC` with `cld`.
- Latency: the IRQ sequence takes 7 cycles and starts after the instruction in progress; when the IRQ arrives during a taken branch that does not cross a page, the CPU first runs one more instruction (`nesdev-irq.html` "Interrupts during branches"). Bad lines stall the CPU for 40-43 cycles (Bauer 3.5).
- Raster timing (Bauer VIC-II article 3.5, 3.6.3, 3.12): a line has 63 cycles (6569 PAL), 65 (6567R8 NTSC) or 64 (6567R56A). The raster compare is tested in cycle 1 of each line (cycle 2 for line 0) and fires at most once per line. A bad line stops the CPU for 40-43 cycles; each sprite with DMA on takes 2 cycles, and BA goes low 3 cycles before the first VIC access. The handler start therefore varies by the remaining cycles of the interrupted instruction (the longest documented instruction takes 7 cycles, c64ref `cpu_6502.txt`), plus bad-line and sprite stalls. Put cycle-critical IRQ lines where no bad line or sprite DMA falls.
- Stable raster by double IRQ (cycle-exact colour bars, side border): IRQ 1 on line N installs IRQ 2 for line N+1, saves SP (`tsx`), runs `cli` and a NOP sled; IRQ 2 arrives during a 2-cycle NOP (0 or 1 cycle jitter), restores SP (`txs`), runs a delay loop of 8 iterations (WAIT = 8), then reads `$D012` twice (`lda $d012 / cmp $d012 / beq +`) so the branch time absorbs the last cycle. With the screen off (`$D011` = `$0B`), the black-to-white edge stayed at the same x on all 8 lines in all 8 frames (spread 0 pixels). The single-IRQ control program spread 16 pixels (2 cycles) over the same lines and frames. (measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20).
- Open top/bottom border (line accuracy is enough; Bauer 3.14.1). The VIC turns the vertical border on at line 251 with RSEL=1 and at line 247 with RSEL=0; switching to RSEL=0 in lines 248-250 skips both. Two IRQ entries:
```
        lda #$13          ; IRQ at line 249: $D011 = RST8 0, DEN, RSEL 0, YSCROLL 3
        sta $d011
        ; ... IRQ at a line below 52 (for example 30): back to RSEL 1
        lda #$1b
        sta $d011
```
  Never switch RSEL from 0 to 1 in lines 52-54 (the border then stays on over the whole screen). Only sprites and the idle-state byte show in the opened area: the VIC repeats the byte at bank offset `$3FFF` (`$39FF` with ECM), set bits in black; write 0 there for a clean border. Keep RSEL=1 in every other `$D011` write of the chain.
- Open side border: clear CSEL (`$D016` bit 3) exactly in cycle 56 of each line and set it again before the next line's cycle 56 (Bauer 3.14.1); needs a stable raster and exact cycle counts including bad lines and sprite DMA. To open it inside the top/bottom border area, open that border too (the main border flip-flop is only reset while the vertical flip-flop is clear).
- MODERN: under turbo an instruction no longer lasts its 1 MHz cycle count in PHI2 time, so cycle-counted raster code changes timing. Run cycle-exact effects at 1 MHz, or use effects that need only line accuracy (scroll split, charset switch, colour change at a raster IRQ).
- Sprites reused below another sprite, status-bar splits, `$D018`/`$D016` switches all hang on this chain.
**Seen in:** Oscar64 `rasterirq.h` library (IRQ chain with register-write lists), Tony (raster "copper" list), Cadaver multiplexer (hand-rolled precomputed chain).

## 2. Sprite multiplexing (more than 8 sprites)
Algorithm (standard, from Cadaver's write-up):
1. Keep a list of virtual sprites (24 in Cadaver's and Corescape's multiplexers): x (9-bit), y, frame, colour. Sort by Y each frame, ascending.
2. Map sorted sprite k to hardware sprite `k mod 8` (rotation).
3. A hardware sprite with Y coordinate Y is displayed in lines Y+1 to Y+21 and its DMA ends in line Y+22; a new Y starts a new display only while the DMA is off (Bauer 3.8.1 rules 2, 4, 7). So virtual sprite k reuses hardware sprite `k mod 8` only if `Y(k) >= Y(k-8) + 22`, and the raster IRQ at line `Y(k-8) + 22` rewrites its Y, X, pointer and colour. Otherwise the sprite is not shown this frame (flicker policy: drop the lowest priority one).
4. After the last sprite, park unused hardware sprites at Y = 255 (or clear `$D015`); precompute `$D010` bit masks per sprite.
5. Reject sprites outside the visible area and if more than 8 would sit on one raster line (hardware limit); the 9th simply does not appear.
- Sorting: insertion sort over a persistent order table (Y order changes little per frame), in zero page. Zones instead of sorting: fixed horizontal bands each owning a fixed sprite subset (HUD, boss); cheapest, limited layout.
- Placement code (64tass; entered from the raster IRQ after the acknowledge, frame start sets `slot = 0`; a sprite closer than 21 lines below its hardware predecessor is shown late, so drop it in the sort stage):
```
; Sorted tables, ascending sy, written by the main loop into the back copy and swapped (eor #MAX flag):
; sy,sx(low 8 bits),sp(pointer),sc(colour),msb(0 or the $D010 bit of the hardware sprite when x>=256),
; hw2 (slot -> 2*(slot and 7)), clr (slot -> $FF minus that $D010 bit), 32 bytes each; zero page: slot, nspr, nline.
mux:    ldy slot
place:  ldx hw2,y         ; X = 2 * hardware sprite
        lda sy,y
        sta $d001,x
        lda sx,y
        sta $d000,x
        lda $d010
        and clr,y
        ora msb,y
        sta $d010
        txa
        lsr
        tax               ; X = hardware sprite
        lda sp,y
        sta $07f8,x
        lda sc,y
        sta $d027,x
        iny
        cpy nspr
        bcs done          ; all placed: next IRQ is the frame-start entry
        cpy #8
        bcc place         ; the first 8 sprites are placed back to back
        lda sy-8,y        ; the hardware sprite used 8 slots ago ends 21 lines below its Y
        clc
        adc #22
        sta nline
        lda $d012
        clc
        adc #3
        bcs place         ; raster is near the bottom
        cmp nline
        bcs place         ; line passed or too close to arm an IRQ: place now
        sty slot
        lda nline
        sta $d012         ; (Y+22 < 256 assumed: clamp sprites that reuse a slot to Y < 234)
        rts
done:   rts
```
- Cost counted from the c64ref cycle table, tables not crossing a page: 74 cycles per sprite placed back to back, 115 for a sprite after which the routine arms the next IRQ, plus 3 for `ldy slot` and the caller's IRQ entry and exit. 24 virtual sprites need at most 24 x 115 = 2,760 cycles per frame.
- A collision bit names the hardware sprite, so with multiplexing it cannot tell which virtual sprite collided: test collisions in software on the virtual list.
- Hardware priority: `$D01B` per sprite (behind/in front of foreground chars), `$D01C` multicolour, `$D017/$D01D` expand (expanded sprites occupy more lines: use their real height in rule 3).
- MODERN: turbo gives time for a bigger virtual list and software sprite compositing; the 8-per-line hardware limit stays. Upic has no hardware sprites at all (`c64://ultimate/upic`).
**Seen in:** Cadaver sprite multiplexer (24 sprites, insertion sort, double-buffered table), Oscar64 `vspr_*` virtual sprites, Corescape (24 virtual sprites).

## 3. Smooth scrolling
- Hardware fine scroll: `$D016` bits 0-2 (X), `$D011` bits 0-2 (Y). Use 38-column mode (`$D016` bit 3 = 0) and 24-row mode (`$D011` bit 3 = 0) so new data enters under the border.
- Horizontal loop: fine X goes 7 down to 0 (scrolling left); when it wraps, shift screen RAM left by one character and set X back to 7 (or reverse). Keep the new column prepared in advance from the tile map (a 2x2 or 4x4 character metatile per map cell).
- Fine-scroll step, once per frame from the top IRQ (content moves left one pixel per frame; `shift_left` copies screen RAM one column left into the other screen and writes the new column, spread over the 8 steps):
```
scroll: lda $d016
        and #$07
        beq wrap            ; fine X reached 0
        dec $d016           ; 7..1: one pixel left
        rts
wrap:   lda $d016
        ora #$07            ; back to 7
        sta $d016
        jmp shift_left      ; then flip $D018 to the other screen at the next top IRQ
```
- Double-buffer screen RAM (two screens at `$C000`/`$C400`, flip `$D018` and sprite pointers on the wrap). Spread the shift over the 8 fine steps (for example 3 rows per frame) so no frame overruns. An unrolled `lda abs,x / sta abs,x` copy costs 9 cycles per byte (4 + 5; 1 more when the load crosses a page): 24 rows (960 bytes) cost 8,640 cycles.
- Colour RAM `$D800` exists once and cannot be double-buffered. Options: (a) give the whole scrolling area one colour RAM value and take the other colours from `$D021-$D023` in multicolour mode, so colour RAM never moves; (b) copy it row by row just behind the raster beam; (c) shift it in the same split steps; (d) bitmap mode, where screen RAM holds two of the colours.
- Vertical: same with `$D011` bits 0-2 and a row shift; YSCROLL selects which lines are bad lines (Bauer 3.5), so it moves the CPU stalls that cycle-exact code depends on. A HUD band sets its own `$D016`/`$D018` at a raster IRQ.
- Parallax: split the screen with raster IRQs and set different `$D016` values per band; far bands scroll slower (every 2nd or 4th frame). Multicolour text mode: OR bit 4 (`$10`) into the `$D016` value.
- MODERN: turbo can do the full shift in the frame; a world map can live in REU and deliver one new column or row per frame (one 256-byte fetch). `c64://ultimate/reu`. Upic scrolls by re-pointing byte columns (2 pixels per step), see `c64://ultimate/upic`.
**Seen in:** Corescape and Oscar64 `hscrollshmup` (character-mode parallax, two screens, 8 px fine scroll), Tony (flip-screen alternative, no scroll), Upic projects (ring buffer scroll).

## 4. Collision
| Method | Use | Limits |
|---|---|---|
| `$D01E` sprite-sprite, `$D01F` sprite-background | prefilter for the 8 hardware sprites | bits stay set until the register is read, and the read clears them: read once per frame and keep the copy; bit = hardware sprite, not virtual; in multicolour text and bitmap modes, background pixels `%01` do not collide (Bauer 3.8.2); collisions are pixel-exact, so hitboxes smaller than the shape need software |
| Software bounding box | player vs enemies, bullets | compare high bytes or use tables |
| Tile lookup | player vs walls/platforms | cell = ((x-24)>>3, (y-50)>>3) for sprite coordinates on a 40x25 screen; read the map/screen byte, look up a flag table (solid, ladder, deadly) |
- 8-bit overlap trick: a 256-byte table `ok[d]` indexed by `(x1-x2)` (unsigned wrap) returns 1 when |dx| < width; page-aligned. Test dx then dy.
- Sprite coordinates: X 24-343 covers the 320 pixels of the text area, Y 50-249 its 200 lines (a sprite with Y = 50 starts in line 51, the first text line with RSEL = 1; Bauer 3.8.1, 3.9); X above 255 needs the sprite's bit in `$D010`.
- Check collisions in the main loop after movement, not in the IRQ; use the hardware flags only to prefilter.

## 5. Input
Joystick port 2: `$DC00`, port 1: `$DC01`; bits 0-4 = up, down, left, right, fire; 0 = pressed.
```
        lda $dc00         ; port 2
        eor #$ff          ; 1 = pressed
        and #$1f
        sta joy_cur
        eor joy_prev      ; changed bits
        and joy_cur       ; newly pressed this frame (edge)
        sta joy_edge
        lda joy_cur
        sta joy_prev
```
- Read once per frame at a fixed point (frame start). Use `joy_edge` for menu moves and jumps, `joy_cur` for movement; for auto-repeat count frames held.
- Port 1 (`$DC01`) shares lines with the keyboard matrix: a pressed key reads as joystick-1 input, and joystick 1 reads as key presses. Use port 2 for the main player; before reading port 1, write `$FF` to `$DC00` so no keyboard column is selected.
- Keyboard in games: scan the matrix (write a column mask to `$DC00`, read rows from `$DC01`) once per frame; the KERNAL's current-key byte `$CB` (64 = no key) is updated only while the KERNAL IRQ runs. Use KERNAL `GETIN` (`$FFE4`) in menus and name entry. With three keys pressed at the corners of a rectangle in the matrix, the fourth corner also reads as pressed.
- Accept joystick and keyboard together.
- Testing: `c64_input` `joystick` drives the game from the bridge; physical matrix injection (`machine:input`) is availability-dependent, check `c64://platform/status`.
- Paddles: `$D419` (POTX) and `$D41A` (POTY) read 0-255 for the pair selected by `$DC00` bits 7-6 (`%01` port 1, `%10` port 2); stop the KERNAL keyboard IRQ while reading; fire buttons are bits 2 and 3 of `$DC00`/`$DC01` (Mapping `$D419`).

## 6. Music and sound effects
- PSID files (GoatTracker and SID-Wizard export them) carry load, init and play addresses (`c64://sound/sid/file-format`). Load the player at its load address; call `init` once with the song number minus one in A (`$00` = song 1); call `play` once per frame from the raster IRQ at a fixed line. A play address of `$0000` means the tune installs its own interrupt: do not call it (`SID_file_format.txt` "initAddress", "playAddress").
- Reserve the player's zero page and RAM range in the memory map first. A player at `$A000-$BFFF` needs LORAM=0: `$01` = `$36`/`$35`/`$34`.
- Speed: a tune written for PAL runs 19.4 % fast on NTSC (59.826 / 50.125 frames per second). On NTSC skip one call in six (49.86 calls per second, 0.5 % slow):
```
        dec tick
        bpl +
        lda #5
        sta tick
        bne skip          ; skip this frame's play call
+       jsr play          ; (tick counts 5..0, so one in six frames is skipped)
skip:
```
  A song whose PSID `speed` bit is 1 expects `play` from a CIA 1 timer A interrupt at the rate its `init` sets (60 Hz default); call it from that interrupt, not from the raster IRQ (`SID_file_format.txt` "speed").
- SFX on one SID: dedicate voice 3. After `jsr play` each frame, if an effect is active write its frequency/pulse/ADSR/control to `$D40E-$D414` from a table (one step per frame); at its end write control with gate off and the player retakes the voice at its next note. A priority byte stops a weak effect cutting a strong one. Or use a player with built-in SFX.
- Volume `$D418` is shared and also holds filter mode: write it once per frame in one place.
- MODERN, several SIDs: the address map, the `.cfg` that places the chips, detection and mixing are in `c64://ultimate/multisid`; read it before writing to any address above `$D41F`. Without that setup play one SID at `$D400`. Digitised audio from the REU: `c64://ultimate/reu`.
**Seen in:** Tetris C64 (`LoadSid`, init/play from frame code), Tony (player in `$A000-$BFFF`), Oscar64 `sidfx` sound effects.

## 7. Random numbers
```
rnd:    lda seed          ; 8-bit Galois LFSR, period 255; seed must not be 0
        asl
        bcc +
        eor #$1d
+       sta seed
        rts
```
- Seed from something unpredictable at the first fire press: `$D012` XOR a free-running CIA timer low byte, or the frame counter when the player pressed a key.
- SID noise as a hardware source: voice 3 frequency `$D40E/$D40F = $FFFF`, control `$D412 = $80` (noise, gate off), read `$D41B` (upper 8 bits of oscillator 3). Voice 3 then cannot play music; set `$D418` bit 7 to disconnect it from the output (Mapping `$D41B`).

## 8. PAL / NTSC timing
- Detect once at start. Quick: KERNAL byte `$02A6` (1 = PAL, 0 = NTSC), set by the KERNAL at reset (Mapping `$02A6`). From the line count: PAL 6569 has 312 lines (highest line `$137`, so `$D012` reaches `$37` with bit 8 set); NTSC 6567R8 263 lines (`$106`), 6567R56A 262 lines (`$105`) (Bauer 3.4).
```
detect: lda $d011
        bpl detect        ; wait until raster line >= 256
chk:    lda $d012
        cmp #$10
        bcs is_pal        ; saw a line number >= 272
        bit $d011
        bmi chk           ; still above line 255
        lda #0            ; wrapped to line 0: NTSC
        rts
is_pal: lda #1
        rts
```
- Consequences: frame budget (architecture), music speed (above), bottom-border IRQ lines, sprite Y ranges, colours, game speed (frame counters scaled by a speed table).
- MODERN: the Ultimate setting `System Mode` takes `PAL`, `NTSC`, `PAL-60`, `NTSC-50`, `PAL-60/L`, `NTSC-50/L` (`u64/u64_config.cc:278`; measured): detect at run time, never from the product name. `c64://ultimate/hardware`.

## 9. Compression
- Exomizer 3: `sfx sys` packs a whole PRG, `mem` packs raw streams with the in-game `exodecrunch` routine. Other packers: Pucrunch, ByteBoozer, Doynax LZ, TSCrunch, Subsizer; compare them by measuring decrunch time and size on your own data. RLE and tile dictionaries decode in a single pass over the output.
- Compress level maps, title bitmap, music, text; never per-frame data or hot-path code. Show a screen while a large file decrunches, or unpack the next level while the current one plays.
- MODERN: REU preload or UCI loads avoid decrunch time; compress only for disk or cartridge release. Commands: `c64://gamedev/toolchain`.
**Seen in:** Tony (Exomizer `mem` parts plus `sfx sys`), SquareDoom (disk loader and packed parts).

## 10. MODERN start-up checks (Ultimate only)
Run on the text screen before any raster trick; on failure print a message naming the setting to change and fall back (1 MHz path or refuse). Never decide from the product name. Register details: `c64://ultimate/hardware`.
1. Turbo registers: `lda $d031 / cmp #$ff / beq no_turbo`. After a reset and before any write, `$D031` reads `$00` when `Turbo Control` is `U64 Turbo Registers` or `TurboEnable Bit`, also with Badline Timing Disabled; `$D030` reads `$FF` in `U64 Turbo Registers` and `$FE` in `TurboEnable Bit`; `$D031` reads `$FF` in `Off` and `Manual` (measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20). `$FF` also comes from a stock C64 or VICE, where `$D031` is an unused VIC-II address (Bauer 3.2). Then `lda #$0f / sta $d031` selects speed index 15: 48 MHz on Ultimate 64 / Elite (MK1), 64 MHz on Elite II (`u64/u64_config.cc:324-325`); `$8f` also suppresses bad line and sprite stalls (measured).
2. After the reset that `run_prg` performs, a `$D031` write took effect only 2.55 s (Ultimate 64 Elite 3.15a) and 2.57 s (C64 Ultimate 1.2.1) after program start (`data/ultimate/bench/results/summary.md`). Rewrite `$D031` and run the probe every 0.2 s, at most 15 times (3 s), until two probes in a row agree on a fast result; if it never gets fast, run at 1 MHz.
3. Speed probe: counts passes of a 14-cycle loop through one line without bad lines, interrupts off. It returned 4 at 1 MHz in VICE 3.10. On Ultimate 64 Elite it returned 4 in 20 of 20 runs at 1 MHz, 8 or 9 at 2 MHz, 17 or 18 at 4 MHz and 196 or 197 at 48 MHz (measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20), so the probe never reaches its `$FF` saturation value at 48 MHz. More than 4 means a faster CPU. It does not give MHz: time a longer loop against CIA2 (`c64://ultimate/hardware`, "Measuring speed").
```
speed:  lda #$fa
-       cmp $d012           ; line $FA: below the last badline ($F7)
        bne -
w:      cmp $d012           ; wait until the line changes: line $FB starts
        beq w
        tax
        inx                 ; X = $FB
        lda #0
        sta cnt             ; cnt: one zero-page byte
l:      inc cnt
        beq full            ; wrapped: saturate
        cpx $d012
        beq l
        lda cnt
        rts
full:   lda #$ff
        rts
```
4. UCI: `lda $df1d / and #$7f / cmp #$49`: the command interface returns `$C9`, or `$49` while its IRQ is active, only when `Command Interface` is enabled (`fpga/io/command_interface/vhdl_source/command_protocol.vhd:99`). REU: presence, size probe and level load in `c64://ultimate/reu`. SIDs: `c64://ultimate/multisid`.

## 11. Bitmap and multicolour modes
Mode bits: `$D011` bit 5 BMM, `$D016` bit 4 MCM, `$D011` bit 6 ECM = 0 (Bauer 3.7.3).
| Mode | BMM, MCM | Pixels | Colour of bit pattern |
|---|---|---|---|
| Multicolour text | 0, 1 | 4x8 per character whose colour RAM bit 3 is 1; others stay hires in colours 0-7 | `00` `$D021`, `01` `$D022`, `10` `$D023`, `11` colour RAM bits 0-2 |
| Standard bitmap | 1, 0 | 320x200, colours per 8x8 cell | `0` screen byte bits 0-3, `1` screen byte bits 4-7 |
| Multicolour bitmap | 1, 1 | 160x200, pixels twice as wide | `00` `$D021`, `01` screen bits 4-7, `10` screen bits 0-3, `11` colour RAM bits 0-3 |
- Memory: the bitmap is 8 KB at bank offset `$0000` or `$2000` (`$D018` bit 3); the screen matrix (cell colours) at `$D018` bits 4-7 x `$400`. In banks 0 and 2 the character ROM image at offset `$1000-$1FFF` hides that RAM, so the bitmap goes to `$2000` there.
- Setup, bank 0, colours at `$0400`, bitmap at `$2000`:
```
        lda #$3b          ; $D011: BMM, DEN, RSEL, YSCROLL 3 (RST8 0)
        sta $d011
        lda #$18          ; $D016: MCM, CSEL (use #$08 for hires bitmap)
        sta $d016
        lda #$18          ; $D018: screen $0400 (1 x $400), bitmap $2000 (bit 3)
        sta $d018
```
- Layout: 8 consecutive bytes form one 8x8 cell, cells run left to right, 40 per row (320 bytes per cell row). Hires byte for (x, y): `base + 40 * (y AND 248) + (y AND 7) + (x AND 504)`, bit `7 - (x AND 7)` (leftmost pixel = bit 7). Multicolour (x = 0-159): byte `base + 40 * (y AND 248) + (y AND 7) + 2 * (x AND 252)`, bit pair `(3 - (x AND 3)) * 2` upwards.
- Clear the bitmap (8000 bytes) and set the 1000 screen bytes (and colour RAM for multicolour) before turning the mode on, or blank the screen (`$D011` bit 4 = 0) while you do.

## 12. Multiply and divide (unsigned, shift-and-add)
All operands are zero-page bytes (`f1`, `f2`; 16-bit `m1`, `m2`, `dvd`, `dvs`, `rem`; 32-bit `prod`), low byte first; choose free bytes from `c64://gamedev/architecture` section 4. Decimal mode must be off (`cld`). X is used as the loop counter and ends at 0; Y is not touched. Local labels `_x` are 64tass style.
| Routine | Bytes | Cycles (with `rts`, without `jsr`) | Divide by zero |
|---|---|---|---|
| `mul8` 8x8 -> 16 | 18 | 134-166 | - |
| `mul16` 16x16 -> 32 | 39 | 623-927 | - |
| `div8` 8/8 | 19 | 158-174 | quotient `$FF`; test the divisor first |
| `div16` 16/16 | 44 | 655-1007 | quotient `$FFFF`; test the divisor first |
Verified: assembled with 64tass 1.60 and run in a 6502 interpreter built from the c64ref opcode and cycle tables, against exact results for all 65,536 input pairs of `mul8` and `div8` and for 350,144 pairs of `mul16` and `div16` (all pairs of 12 edge values plus random pairs). Removing a `clc` or a `cmp` makes the check fail. Alternative for many 8x8 products: a table of squares, a*b = f(a+b) - f(a-b) with f(n) = floor(n*n/4) (arithmetic identity; no routine given).
```
; 8 x 8 -> 16 unsigned. In: f1, f2. Out: A = high byte, f1 = low byte. f2 kept.
mul8    lda #0
        ldx #8
        lsr f1
_m8     bcc _m8n
        clc
        adc f2
_m8n    ror a
        ror f1
        dex
        bne _m8
        rts
; 16 x 16 -> 32 unsigned. In: m1, m2. Out: prod..prod+3. m1 destroyed, m2 kept.
mul16   lda #0
        sta prod+2
        sta prod+3
        ldx #16
_m16    lsr m1+1
        ror m1
        bcc _m16n
        lda prod+2
        clc
        adc m2
        sta prod+2
        lda prod+3
        adc m2+1
        sta prod+3
_m16n   ror prod+3
        ror prod+2
        ror prod+1
        ror prod
        dex
        bne _m16
        rts
; 8 / 8 unsigned. In: f1 = dividend, f2 = divisor. Out: f1 = quotient, A = remainder.
div8    lda #0
        ldx #8
        asl f1
_d8     rol a          ; partial remainder < 128 before ROL: no carry out
        cmp f2
        bcc _d8n
        sbc f2          ; C = 1 here: quotient bit 1
_d8n    rol f1
        dex
        bne _d8
        rts
; 16 / 16 unsigned. In: dvd, dvs. Out: dvd = quotient, rem = remainder. dvs kept.
div16   lda #0
        sta rem
        sta rem+1
        ldx #16
_d16    asl dvd
        rol dvd+1
        rol rem
        rol rem+1      ; remainder < $8000 before ROL: no carry out
        lda rem
        cmp dvs
        lda rem+1
        sbc dvs+1
        bcc _d16n
        lda rem
        sbc dvs
        sta rem
        lda rem+1
        sbc dvs+1
        sta rem+1
        inc dvd
_d16n   dex
        bne _d16
        rts
```
