# C64 Game Techniques: IRQ, Sprites, Scrolling, Input, Sound

**Summary:** Compact recipes for the techniques almost every C64 game needs, with fresh minimal 6502 snippets. Snippets use 64tass/KickAssembler-compatible syntax (`* = addr`, `.byte`, `<label`, `>label`, `;` comments); the bridge's built-in assembler (`upload_run_asm`) accepts the basic subset. Anonymous `+` branch labels are 64tass style; rename for other assemblers. Snippets for IRQ setup, joystick edge, NTSC skip, LFSR, PAL detect and the turbo speed probe assembled with 64tass and ran in VICE 3.10 x64sc; the multiplexer assembled but was not run; the stable-raster text is a sketch.
**Read when:** implementing display timing, sprites, scrolling, collision, input, music/SFX (also several SIDs), random numbers, PAL/NTSC handling or Ultimate start-up checks (section 10). Frame structure and budgets: `c64://gamedev/architecture`. Register detail: `c64://graphics/vic/spec`, `c64://io/cia/spec`, `c64://sound/sid/spec`.

Sections 1-3, 6 and 9 end with **Seen in** (open-source projects to study; URLs and licences in `c64://gamedev/references`). Marks: "(unverified)" = not confirmed against a primary source.

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
- With KERNAL on use `$0314/$0315` and exit via `jmp $ea81` (skips keyboard scan) or `jmp $ea31`.
- Lines above 255: set `$D011` bit 7 for that entry (the 9th raster bit). Always rewrite `$D011` with bit 7 matching the next line.
- Chain rules: entries sorted by line; handler worst-case time shorter than the gap to the next entry; if the next line has already passed when you program `$D012`, run the next handler directly instead of waiting a whole frame; acknowledge `$D019` first; save `$01` if the main loop changes it. NMI must have a vector (RESTORE key).
- Decimal flag is not cleared on interrupt on the NMOS 6510: use `cld` in any handler that touches arithmetic.
- Latency: IRQ entry takes 7 cycles plus the instruction in progress (0-7 more); bad lines add up to 40 stall cycles (architecture).
- Stable raster (cycle-exact bars, border opening): double IRQ. IRQ 1 on line N installs IRQ 2 for line N+1, saves SP (`tsx`), runs `cli` and a NOP sled; IRQ 2 hits during a NOP (jitter 0-1 cycles), restores SP (`txs`), waits out the line and compares `$D012` twice to remove the last cycle. Tune with a border-colour change and `capture_frame`. Sketch only (unverified).
- MODERN: raster-exact code tuned for 1 MHz cycle counts is not cycle-exact in real time under turbo; keep cycle-critical effects at 1 MHz or measure on hardware. Prefer effects that need only line accuracy (scroll split, charset switch, colour changes).
- Sprites reused below another sprite, status-bar splits, `$D018`/`$D016` switches all hang on this chain.
**Seen in:** Oscar64 `rasterirq.h` library (IRQ chain with register-write lists), Tony (raster "copper" list), Cadaver multiplexer (hand-rolled precomputed chain).

## 2. Sprite multiplexing (more than 8 sprites)
Algorithm (standard, from Cadaver's write-up):
1. Keep up to ~24 virtual sprites: x (9-bit), y, frame, colour. Sort by Y each frame, ascending.
2. Map sorted sprite k to hardware sprite `k mod 8` (rotation).
3. A raster IRQ rewrites Y/X/pointer/colour of the hardware sprite when its previous occupant has finished: IRQ line for sprite k = `Y(k-8) + 21` (first line below a 21-line shape; the code below uses +22), and the new Y must be at least that far down. Otherwise the sprite cannot be shown this frame (flicker policy: skip the lowest priority one).
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
- Cost counted from the code (not measured): about 75 cycles per sprite placed back to back, about 120 plus the IRQ entry and exit (about 45) when it arms its own IRQ. 16-24 virtual sprites are practical at 1 MHz.
- Hardware collision registers are unreliable once multiplexed: use software tests on the virtual list.
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
- Double-buffer screen RAM (two screens at `$C000`/`$C400`, flip `$D018` and sprite pointers on the wrap). Do the shift in parts across the 8 fine steps (for example 3 rows per frame) so no frame overruns. Cost: an unrolled `lda abs,x / sta abs,x` copy is about 9 cycles per byte; one full screen (960-1000 bytes) is ~9,000 cycles.
- Colour RAM `$D800` is one copy and cannot be double-buffered. Options: (a) one colour per tile type via multicolour chars (colour 8-15, same colour across the map region), best when the art allows; (b) copy it row-wise just behind the raster beam; (c) shift it in the same split steps while fine scroll hides the seam; (d) bitmap mode with colour in screen RAM.
- Vertical: same with `$D011` and a row shift; Y scroll moves the badline, which disturbs stable-raster code. A HUD band sets its own `$D016`/`$D018` at a raster IRQ.
- Parallax: split the screen with raster IRQs and set different `$D016` values per band; far bands scroll slower (every 2nd or 4th frame). Multicolour text mode: OR bit 4 (`$10`) into the `$D016` value.
- MODERN: turbo can do the full shift in the frame; a world map can live in REU and deliver one new column or row per frame (one 256-byte fetch). `c64://ultimate/reu`. Upic scrolls by re-pointing byte columns (2 pixels per step), see `c64://ultimate/upic`.
**Seen in:** Corescape and Oscar64 `hscrollshmup` (character-mode parallax, two screens, 8 px fine scroll), Tony (flip-screen alternative, no scroll), Upic projects (ring buffer scroll).

## 4. Collision
| Method | Use | Limits |
|---|---|---|
| `$D01E` sprite-sprite, `$D01F` sprite-background | coarse prefilter, 8 hardware sprites | latched, cleared on read: read once per frame and keep the copy; bit = hardware sprite, not virtual (a multiplexed bit may belong to either user); multicolour data counts only pairs `%10`/`%11` as foreground; pixel-exact, so small hitboxes need software |
| Software bounding box | player vs enemies, bullets | compare high bytes or use tables |
| Tile lookup | player vs walls/platforms | cell = ((x-24)>>3, (y-50)>>3) for sprite coordinates on a 40x25 screen; read the map/screen byte, look up a flag table (solid, ladder, deadly) |
- 8-bit overlap trick: a 256-byte table `ok[d]` indexed by `(x1-x2)` (unsigned wrap) returns 1 when |dx| < width; page-aligned. Test dx then dy.
- Sprite coordinates: X 24-343 is the 320-pixel text area, Y 50-249 the 200 lines; X needs the MSB in `$D010`.
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
- Port 1 (`$DC01`) shares lines with keyboard scanning; a pressed key shows up as joystick-1 input. Prefer port 2 for play; for port 1 write `$FF` to `$DC00` before reading and accept the conflict.
- Keyboard in games: scan the matrix (write a column mask to `$DC00`, read rows from `$DC01`) at a fixed time; the KERNAL's current-key byte `$CB` (64 = none) works only while the KERNAL IRQ runs. Use KERNAL `GETIN` (`$FFE4`) only in menus and name entry. Ghosting limits simultaneous keys.
- Accept joystick and keyboard together.
- Testing: `c64_input` `joystick` drives the game from the bridge; physical matrix injection (`machine:input`) is availability-dependent, check `c64://platform/status`.
- Paddles and the 1351 mouse (SID `$D419/$D41A`) are unverified here; keep them optional.

## 6. Music and sound effects
- PSID files (GoatTracker, SID-Wizard, other trackers export them) carry load, init and play addresses (`c64://sound/sid/file-format`). Place the player at its load address (often `$1000`); call `init` with the song number in A once; call `play` once per frame from the raster IRQ at a fixed line. If play address is 0 the tune installs its own interrupt: do not call it.
- Reserve the player's zero page and RAM range in the memory map first. A player at `$A000-$BFFF` needs `$01<=$36`.
- Speed: a tune written for 50 Hz runs 20% fast at 60 Hz. On NTSC skip one call in six:
```
        dec tick
        bpl +
        lda #5
        sta tick
        bne skip          ; skip this frame's play call
+       jsr play          ; (tick counts 5..0, so one in six frames is skipped)
skip:
```
  Multi-speed tunes call `play` 2-4 times per frame: use a CIA timer IRQ (unverified for each player).
- SFX on one SID: dedicate voice 3. After `jsr play` each frame, if an effect is active write its frequency/pulse/ADSR/control to `$D40E-$D414` from a table (one step per frame); at its end write control with gate off and the player retakes the voice at its next note. A priority byte stops a weak effect cutting a strong one. Or use a player with built-in SFX.
- Volume `$D418` is shared and also holds filter mode: write it once per frame in one place.
- MODERN, several SIDs: a C64U has 8 to 10 (24 to 30 voices); read `c64://ultimate/multisid` first. It says: the default map has every chip answering at `$D400` with mirroring on, so nothing extra plays until a `.cfg` applied by UCI `LOAD_CONFIG` places the chips at their own 32-byte windows (`$D420`, `$D440`, ...); touch only mapped windows (an undecoded address in `$D400-$D7FF` hangs the CPU or the device); verify each window with the ENV3 test; without UCI play as one SID at `$D400`. Design (unverified): give each extra tune its own copy of the player built for its window, or let it write a RAM image of `$D400-$D418` that the IRQ copies to the window; one `play` call per tune per frame; pan and level come from the mixer, and the summed level can clip. Put SFX on a second SID only after the ENV3 test passes. Digitised audio can come from REU (`c64://ultimate/reu`).
- SID writes during bad lines: fine, but avoid long write bursts mid-frame under turbo when SID sockets are used (accesses run at 1 MHz).
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
- SID noise as a hardware source: voice 3 frequency `$D40E/$D40F = $FFFF`, control `$D412 = $80` (noise, gate off), read `$D41B` (voice 3 oscillator). Voice 3 then cannot play music; mute it in the mix.

## 8. PAL / NTSC timing
- Detect once at start. Quick: KERNAL flag `$02A6` (1 = PAL) set at KERNAL reset, valid if you did not overwrite it. Robust (derived from the line counts, test both models in VICE): PAL has 312 lines (max `$D012` seen above 255 is `$37`), NTSC 262 or 263 lines (max `$06`).
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
- MODERN: the Ultimate "System Mode" setting can select PAL, NTSC, PAL-60 or NTSC-50; detect at run time, never from the product name. `c64://ultimate/hardware`.

## 9. Compression
- Exomizer 3: `sfx sys` packs a whole PRG, `mem` packs raw streams with the in-game `exodecrunch` routine. Alternatives (Pucrunch, ByteBoozer, Doynax LZ, TSCrunch, Subsizer): pick by measured decrunch time per frame (unverified comparisons). RLE or tile dictionaries suit maps and screens (instant).
- Compress level maps, title bitmap, music, text; never per-frame data or hot-path code. Decrunching takes seconds at 1 MHz: show a screen, or unpack the next level while the current one plays.
- MODERN: REU preload or UCI loads avoid decrunch time; compress only for disk or cartridge release. Commands: `c64://gamedev/toolchain`.
**Seen in:** Tony (Exomizer `mem` parts plus `sfx sys`), SquareDoom (disk loader and packed parts).

## 10. MODERN start-up checks (Ultimate only)
Run on the text screen before any raster trick; on failure print a message naming the setting to change and fall back (1 MHz path or refuse). Never decide from the product name.
1. Turbo registers: `lda $d031 / cmp #$ff / beq no_turbo` (`$FF`: Off or Manual, stock C64, VICE; `$FF` proves nothing about being an Ultimate). Then `lda #$0f / sta $d031` (`$8f` also removes badline and sprite stalls; speeds: `c64://ultimate/hardware`).
2. After a program start or reset the CPU stays at 1 MHz for about 2.6 s (measured 2.55 s and 2.57 s): rewrite `$D031` and measure, at most every 0.2 s, bounded (about 15 tries), until two probes agree; if it never gets fast, run at 1 MHz.
3. Speed probe: passes of a fixed loop in one badline-free raster line, interrupts off. It returns 4 at stock 1 MHz (measured in VICE 3.10); 8 or more means 2 MHz or faster. It does not give MHz: time a longer loop against CIA2 (`c64://ultimate/hardware`, "Measuring speed").
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
4. UCI: `$DF1D & $7F == $49` (needs Command Interface enabled). REU: `reu_present`, size probe and level load in `c64://ultimate/reu`. SIDs: `c64://ultimate/multisid`.
