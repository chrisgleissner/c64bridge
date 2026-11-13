# C64 Game Techniques: IRQ, Sprites, Scrolling, Input, Sound

**Summary:** Compact recipes for the techniques almost every C64 game needs, with fresh minimal 6502 snippets. Snippets use 64tass/KickAssembler-compatible syntax (`* = addr`, `.byte`, `<label`, `>label`, `;` comments); the bridge's built-in assembler (`upload_run_asm`) accepts the basic subset. Anonymous `+` branch labels are 64tass style; rename for other assemblers. Snippets (IRQ setup, joystick edge, NTSC skip, LFSR, PAL detect) assembled with 64tass and ran in VICE 3.10 x64sc; the stable-raster text is a sketch.
**Read when:** implementing display timing, sprites, scrolling, collision, input, music/SFX, random numbers or PAL/NTSC handling. Frame structure and budgets: `c64://gamedev/architecture`. Register detail: `c64://graphics/vic/spec`, `c64://io/cia/spec`, `c64://sound/sid/spec`.

Each section ends with **Seen in** (open-source projects to study; URLs in `c64://gamedev/toolchain`). Marks: "(unverified)" = not confirmed against a primary source.

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
- Latency: IRQ entry takes 7 cycles plus the instruction in progress (0-7 more), so the first line of a handler jitters by up to 7 cycles. Bad lines add up to 40 cycles of CPU stall (see architecture).
- Stable raster (needed for cycle-exact colour bars, border opening, hi-res tricks): the double-IRQ method. IRQ 1 fires on line N, installs IRQ 2 for line N+1, saves SP (`tsx`), enables interrupts (`cli`) and runs a NOP sled; IRQ 2 fires during a NOP, so jitter drops to 0-1 cycles; it restores SP (`txs`), burns cycles to the end of the line, and compares `$D012` twice to remove the last cycle (`lda $d012; cmp $d012; beq +`). Exact cycle counts depend on sprites and bad lines on that line; tune with a border-colour change and capture (`capture_frame`). Sketch only (unverified).
- MODERN: raster-exact code tuned for 1 MHz cycle counts is not cycle-exact in real time under turbo; keep cycle-critical effects at 1 MHz or measure on hardware. Prefer effects that need only line accuracy (scroll split, charset switch, colour changes).
- Sprites reused below another sprite, status-bar splits, `$D018`/`$D016` switches all hang on this chain.
**Seen in:** Oscar64 `rasterirq.h` library (IRQ chain with register-write lists), Tony (raster "copper" list), Cadaver multiplexer (hand-rolled precomputed chain).

## 2. Sprite multiplexing (more than 8 sprites)
Algorithm (standard, from Cadaver's write-up):
1. Keep up to ~24 virtual sprites: x (9-bit), y, frame, colour. Sort by Y each frame, ascending.
2. Map sorted sprite k to hardware sprite `k mod 8` (rotation).
3. A raster IRQ rewrites Y/X/pointer/colour of the hardware sprite when its previous occupant has finished: IRQ line for sprite k = `Y(k-8) + 21` (shape height) minus setup margin, and the new Y must be at least that far down. Otherwise the sprite cannot be shown this frame (flicker policy: skip the lowest priority one).
4. After the last sprite, park unused hardware sprites at Y = 255 (or clear `$D015`); precompute `$D010` bit masks per sprite.
5. Reject sprites outside the visible area and if more than 8 would sit on one raster line (hardware limit); the 9th simply does not appear.
- Sorting: insertion sort over a persistent order table (Y order changes little per frame), in zero page for speed (table at `$40`-style location, end mark). Double-buffer the sorted table: main loop sorts and writes the back copy while the IRQ draws the front; swap with a flag (`eor #MAX`).
- Zones instead of sorting: fixed horizontal bands each owning a fixed sprite subset (HUD, boss); cheapest, limited layout.
- Practical: 16-24 virtual sprites; with a 1 MHz 6510 the per-slot IRQ costs ~30-60 cycles; a 25th sprite adds sort cost.
- Hardware collision registers are unreliable once multiplexed: use software tests on the virtual list.
- Hardware priority: `$D01B` per sprite (behind/in front of foreground chars), `$D01C` multicolour, `$D017/$D01D` expand (expanded sprites occupy more lines: use their real height in rule 3).
- MODERN: turbo gives time for a bigger virtual list and software sprite compositing; the 8-per-line hardware limit stays. Upic has no hardware sprites at all (`c64://ultimate/upic`).
**Seen in:** Cadaver sprite multiplexer (24 sprites, insertion sort, double-buffered table), Oscar64 `vspr_*` virtual sprites, Corescape (24 virtual sprites).

## 3. Smooth scrolling
- Hardware fine scroll: `$D016` bits 0-2 (X), `$D011` bits 0-2 (Y). Use 38-column mode (`$D016` bit 3 = 0) and 24-row mode (`$D011` bit 3 = 0) so new data enters under the border.
- Horizontal loop: fine X goes 7 down to 0 (scrolling left); when it wraps, shift screen RAM left by one character and set X back to 7 (or reverse). Keep the new column prepared in advance from the tile map (a 2x2 or 4x4 character metatile per map cell).
- Double-buffer screen RAM (two screens at `$C000`/`$C400`, flip `$D018` and sprite pointers on the wrap). Do the shift in parts across the 8 fine steps (for example 3 rows per frame) so no frame overruns. Cost: an unrolled `lda abs,x / sta abs,x` copy is about 9 cycles per byte; one full screen (960-1000 bytes) is ~9,000 cycles.
- Colour RAM problem: colour RAM `$D800` is a single copy and cannot be double-buffered or re-pointed. Options: (a) use one colour per tile type and a charset where colour comes from the character (multicolour chars with colour 8-15, same colour for the whole map region); (b) copy colour RAM row-wise just behind the raster beam; (c) shift colour RAM in the same split steps while the fine-scroll hides the seam; (d) use a bitmap mode and draw colour into screen RAM instead. Pick (a) when the art allows it.
- Vertical: same with `$D011` and a row shift; changing Y scroll moves the badline, which disturbs stable-raster code.
- Parallax: split the screen with raster IRQs and set different `$D016` values per band; far bands scroll slower (every 2nd or 4th frame). Multicolour text mode: OR bit 4 (`$10`) into the `$D016` value.
- HUD: bottom or top band with its own `$D016`/`$D018` set at a raster IRQ.
- MODERN: turbo can do the full shift in the frame; a world map can live in REU and deliver one new column or row per frame (one 256-byte fetch). `c64://ultimate/reu`. Upic scrolls by re-pointing byte columns (2 pixels per step), see `c64://ultimate/upic`.
**Seen in:** Corescape and Oscar64 `hscrollshmup` (character-mode parallax, two screens, 8 px fine scroll), Tony (flip-screen alternative, no scroll), Upic projects (ring buffer scroll).

## 4. Collision
| Method | Use | Limits |
|---|---|---|
| `$D01E` sprite-sprite, `$D01F` sprite-background | cheap coarse test, 8 hardware sprites | bits are latched, cleared on read: read once per frame and keep the copy; bit = hardware sprite, not virtual; after multiplexing a bit may belong to either user; in multicolour char/sprite data only bit pairs `%10`/`%11` count as foreground for background collision (standard); pixel-exact, so small hitboxes need software |
| Software bounding box | player vs enemies, bullets | compare high bytes or use tables |
| Tile lookup | player vs walls/platforms | cell = ((x-24)>>3, (y-50)>>3) for sprite coordinates on a 40x25 screen; read the map/screen byte, look up a flag table (solid, ladder, deadly) |
- 8-bit overlap trick: a 256-byte table `ok[d]` indexed by `(x1-x2)` (unsigned wrap) returns 1 when |dx| < width; page-aligned. Test dx then dy.
- Sprite coordinates: X 24-343 is the 320-pixel text area, Y 50-249 the 200 lines; X needs the MSB in `$D010`.
- Check collisions in the main loop after movement, not in the IRQ; use the hardware flags only to prefilter.
**Seen in:** Oscar64 `hscrollshmup` (page-aligned overlap table), Tetris C64 (tile checks only).

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
- Paddles and the 1351 mouse use SID `$D419/$D41A` and the port-select bits of `$DC00` (unverified details); keep them optional.
**Seen in:** Tetris C64 (controlled-input module), Oscar64 samples (per-frame joystick polling and debounce), SquareDoom (1351 mouse option).

## 6. Music and sound effects
- PSID files (GoatTracker, SID-Wizard, other trackers export them) carry load, init and play addresses (`c64://sound/sid/file-format`). Place the player at its load address (often `$1000`); call `init` with the song number in A once; call `play` once per frame from the raster IRQ at a fixed line. If play address is 0 the tune installs its own interrupt: do not call it.
- Reserve the player's zero-page bytes and RAM range in the memory map before you write code. A player at `$A000-$BFFF` works when `$01<=$36`.
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
  Multi-speed tunes call `play` 2-4 times per frame from a CIA timer: handle with a timer IRQ instead of the frame IRQ (unverified for each player).
- SFX: SID has 3 voices. Common approach: dedicate voice 3 to SFX; after `jsr play` each frame, if an effect is active write its frequency/pulse/ADSR/control into voice 3 (`$D40E-$D414`) from an effect table (one step per frame); when the effect ends write control with gate off and let the music player take the voice again at its next note. Alternative: a player with built-in SFX support. Keep a priority byte so a weak effect never cuts a strong one.
- Volume `$D418` is shared and also holds filter mode: write it once per frame in one place.
- MODERN: more SIDs may exist at other addresses: put SFX on a second SID only after detecting that it is distinct and audible (`c64://ultimate/hardware`), with voice-stealing fallback. Digitised audio can come from REU (`c64://ultimate/reu`).
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
**Seen in:** common practice; CIA/SID sources recommended in `c64://io/cia/spec`, `c64://sound/sid/spec`.

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
- Consequences: frame budget (architecture), music speed (above), IRQ lines for the bottom border and the maximum visible lines, sprite Y ranges (visible area differs by a few lines), colour palette differences, game speed (use frame counters scaled by a speed table; PAL 50 Hz vs NTSC about 60 Hz).
- MODERN: the Ultimate "System Mode" setting can select PAL, NTSC, PAL-60 or NTSC-50; detect at run time, never from the product name. `c64://ultimate/hardware`.
**Seen in:** common practice; see `c64://graphics/vic/spec` for line and cycle numbers.

## 9. Compression and crunchers
| Tool | Use |
|---|---|
| Exomizer 3 (`sfx sys` for a self-extracting PRG, `mem` for raw streams) | best documented; PRG crunch and in-game decrunch (`exodecrunch` routine) |
| Pucrunch, ByteBoozer, Doynax LZ, TSCrunch, Subsizer | alternatives: faster decrunch or smaller depacker; pick by measured decrunch time per frame (unverified comparisons) |
| RLE or tile dictionaries | maps, screens: cheapest and instant |
- Data to compress: level maps, title bitmap, music, text. Do not compress per-frame data. Keep code uncompressed in the hot path; pack the whole PRG with `sfx sys` for release.
- Decrunching takes seconds at 1 MHz: show a screen while loading; a streaming decruncher can unpack one level during the previous one's play.
- MODERN: REU preload or UCI loads avoid decrunch time; compress only for disk/cartridge distribution. Commands and layout: `c64://gamedev/toolchain`.
**Seen in:** Tony (Exomizer `mem` parts plus `sfx sys`), SquareDoom (disk loader and packed parts).
