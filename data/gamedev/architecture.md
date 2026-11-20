# C64 Game Architecture: Frame Loop, Budgets, Memory Maps

**Summary:** A C64 game is a frame-synchronous state machine: a raster IRQ chain does the timing-critical display and sound work, the main loop does one frame of logic per frame and hands results over through a flag. Decide the memory map and the frame budget before writing code. Templates below cover a stock 64 KB game, a small single-screen game and an Ultimate game streaming from REU.
**Read when:** starting any game, before choosing addresses, VIC bank, loader or IRQ layout. Techniques (code) are in `c64://gamedev/techniques`.

Sources: Bauer's VIC-II article (Bauer), Mapping the Commodore 64 and the c64ref ROM disassembly (mist64/c64ref), VICE 3.10 source, and the turbo benchmark in `data/ultimate/bench/results/summary.md` (measured 2026-11-13 on an Ultimate 64 Elite, firmware 3.15a, and a C64 Ultimate, firmware 1.2.1; "bench" below). Targets: MODERN = Ultimate devices, AUTHENTIC = stock C64 (see `c64://gamedev/index`).

## 1. Frame structure
```
raster IRQ chain (per frame)           main loop (per frame)
  top    : scroll regs, $D018, music     wait frame flag
  mux N  : sprite re-use rows            read input
  status : charset/colour split          update state machine, objects, collisions
  bottom : sprite sort handoff, SFX      sort sprites (into back buffer), build next screen/colour data
                                         set "ready" flag; IRQ commits at next frame start
```
- Double buffer everything the IRQ reads: sorted sprite table, scroll values, screen pointer. The IRQ copies/uses the committed set only.
- Frame sync: a game without raster IRQs may poll `$D012` for one line per frame; once a raster IRQ chain or multiplexer exists, sync on a flag the IRQ sets.
- Missed frame: when the logic overruns, the IRQ keeps the previous committed set (the game slows down, the picture does not tear); the IRQ chain never waits for the main loop.
- Run music from the IRQ at a fixed line, so jitter from logic never changes tempo.

Frame loop that plays identically at 1 MHz and at turbo (assembled with 64tass; the IRQ at line 250 does `inc frame` and acknowledges `$D019`):
```
loop:   lda frame
        sec
        sbc seen            ; frames elapsed, wraps correctly
        beq loop            ; nothing new: idle (turbo only shortens this wait)
        cmp #4
        bcc +
        lda #4              ; never more than 4 catch-up steps
+       sta steps
        lda frame
        sta seen
-       jsr update          ; one fixed-size game step per elapsed frame
        dec steps
        bne -
        jsr render          ; once per loop: fill the back buffer, then set the ready flag
        jmp loop
```
Game speed then depends on frames, not on CPU speed. Turbo only raises how much `update` and `render` may do per frame (budgets in section 3).

## 2. State machine
- One byte `state`, jump table of `init/update/exit` per state: BOOT, TITLE (attract), MENU, PLAY, PAUSE, GAMEOVER, HISCORE.
- State change = set `next_state`; apply at frame start (never mid-frame): run `exit`, reset VIC/IRQ list for the new state, run `init`.
- Each state owns its screen layout and IRQ list; shared modules: input, sound, sprites, RNG, score/BCD.
- Keep entities in structure-of-arrays tables (`x_lo,x_hi,y,type,frame,state`), at most 256 entries each, so access is `lda tab,x`.
- Fixed-point positions (8.8) with velocities; screen position = high byte; do collisions on high bytes.

## 3. Frame budget
| | PAL (6569) | NTSC (6567R8) |
|---|---|---|
| CPU clock | 985,248 Hz | 1,022,727 Hz |
| Cycles per line x lines | 63 x 312 | 65 x 263 |
| Cycles per frame | 19,656 | 17,095 |
| Frame rate | 50.125 Hz | 59.826 Hz |
| Visible text rows | 25 badlines in lines `$30`-`$F7` | same |
- Older NTSC 6567R56A: 64 x 262 = 16,768 cycles (rare). Detect machine type at runtime (see techniques).
- A bad line stops the CPU for 40-43 cycles (Bauer 3.5). Measured: 25 bad lines cost 1,081 cycles per PAL frame, eight double-height sprites (42 lines each) a further 802 (bench).
- The 112 PAL lines outside the 200 display lines (312 - 200) have no bad lines; sprite DMA still stalls the CPU there.
- Free CPU cycles per frame at 1 MHz with a text screen and eight double-height sprites: PAL 17,783 (bench); NTSC 15,219 (measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20) (the value derived earlier from 17,095 minus 1,081 and 802 was 15,212). Budget for NTSC and let PAL idle, or scale movement by frame count.
- Measure each routine: set `$D020` to a colour on entry and restore it on exit; the height of the coloured border band is its cost in raster lines (63 cycles per PAL line, 65 per NTSC line). Capture the frame in VICE with `c64_graphics` `capture_frame`.

### MODERN budget
- Turbo raises only the CPU clock; VIC-II, SID and CIA keep C64 timing, so a frame still lasts 19,656 PHI2 cycles (PAL). Settings and registers: `c64://ultimate/hardware`.
- CPU cycles per PAL frame, RAM-only loop (bench):

| Setting | Screen blanked | Screen on | On + 8 dbl-height sprites | On + sprites, `$D031` bit 7 set |
|---|---|---|---|---|
| 1 MHz | 19,656 | 18,575 | 17,783 | 19,656 |
| U64 12 MHz | 235,883 | 222,906 | 213,429 | 235,883 |
| U64 48 MHz | 923,875 | 873,784 | 836,375 | 922,207 |
| C64U 14 MHz | 275,197 | 260,057 | 249,001 | 275,197 |
| C64U 64 MHz | 1,238,387 | 1,170,907 | 1,121,520 | 1,236,708 |

- At every speed bad lines cost 5.5 % and eight sprites a further 4.1 %; `$D031` bit 7 set removes both (at most 0.2 % remains). The 48 MHz and 64 MHz settings deliver 47 and 63 CPU cycles per PHI2 cycle. I/O access speed and REU DMA rates at turbo: `c64://ultimate/hardware`, `c64://ultimate/reu`; Upic frame budgets: `c64://ultimate/upic`.
- Design rule: game speed follows the frame count, never the instruction count, so the game plays the same at 1 MHz and at turbo. Turbo is headroom for effects, larger worlds and software rendering; it is a requirement only for a Upic design.
- UCI calls block until the firmware answers; run them as a state machine, one step per frame (`c64://ultimate/uci`).
- Detect turbo and REU at start, then enable turbo: `c64://gamedev/techniques` section 10. Several SIDs: `c64://ultimate/multisid`.

## 4. VIC bank and `$01` choices
| VIC bank | `$DD00` bits 0-1 | Range | Notes |
|---|---|---|---|
| 0 | `%11` | `$0000-$3FFF` | default; VIC sees the character ROM at `$1000-$1FFF` |
| 1 | `%10` | `$4000-$7FFF` | no ROM image |
| 2 | `%01` | `$8000-$BFFF` | VIC sees the character ROM at `$9000-$9FFF` |
| 3 | `%00` | `$C000-$FFFF` | no ROM image; leaves `$0800-$BFFF` contiguous for code |
- Keep other `$DD00` bits unchanged (read-modify-write). `$DD02` bits 0-1 must stay outputs. Inside the bank: `$D018` high nibble = screen (x `$400`), bits 1-3 = charset (x `$800`). Sprite pointers at `screen+$3F8`, value x 64 = offset in the bank.
- `$01`: `$37` BASIC+KERNAL+I/O (default), `$36` BASIC off, `$35` I/O only (RAM at `$A000-$BFFF` and `$E000-$FFFF`; templates A and C use it while the game runs), `$34` all RAM (I/O hidden; toggle to `$35` for hardware access; IRQ handler must set `$35` itself), `$31`, `$32` and `$33` expose char ROM at `$D000` for copying.
- `$01` low three bits (`$A000` / `$D000` / `$E000`, cartridge lines inactive): `%000` RAM/RAM/RAM; `%001` RAM/CHAR/RAM; `%010` RAM/CHAR/KERNAL; `%011` BASIC/CHAR/KERNAL; `%100` RAM/RAM/RAM; `%101` RAM/IO/RAM; `%110` RAM/IO/KERNAL; `%111` BASIC/IO/KERNAL.
- With KERNAL off the vectors at `$FFFA/$FFFE` are RAM: set NMI (point to an `rti`, or a handler) and IRQ yourself; the `$0314` vector is no longer used. Keep CIA IRQs off (`$DC0D=$7F`, `$DD0D=$7F`, then read both).
- RAM under I/O (`$D000-$DFFF`) is visible to the VIC in bank 3 (sprite shapes, second charset): write it once at boot with `$01=$34`. Colour RAM `$D800` is separate, 4-bit, CPU-visible only with I/O on.
- Safe zero page (Mapping the Commodore 64; the ROM disassembly was searched for every access):

| Situation | Free bytes | Why |
|---|---|---|
| BASIC still in use (program returns to BASIC, or BASIC code runs) | `$02`, `$FB-$FE`; `$F7-$FA` if RS-232 (device 2) is never opened | Mapping: `$02` unused, `$FB-$FE` "guaranteed that BASIC will not alter"; `$F7-$FA` are the RS-232 buffer pointers, used only by its OPEN, CLOSE and NMI code |
| Machine code only, BASIC no longer used, KERNAL on (IRQ, I/O calls) | `$02-$8F`, `$FF`, plus the bytes above | `$02-$8F` and `$FF` belong to BASIC; the KERNAL (`$E4D3-$FFFF`) never accesses them except the RAM clear at reset. `$90-$FA` stay KERNAL workspace (I/O, jiffy clock `$A0-$A2`, keyboard and screen editor `$C5-$F6`). Save and restore `$02-$8F` to return to BASIC (it also holds `CHRGET` code at `$73-$8A`) |
| KERNAL ROM off (`$01` = `$35`/`$34`), own IRQ and NMI | `$02-$FF` | `$00/$01` are the CPU port. Save `$90-$FF` first if KERNAL routines are called again later |

## 5. Memory-map templates
### A. Stock 64 KB game (AUTHENTIC; also valid MODERN), VIC bank 3, KERNAL off after boot
| Range | Use |
|---|---|
| `$0002-$008F` | zero page: hot variables, pointers, multiplexer order table (keep `$00/$01`; `$90-$FF` is free for the game once the KERNAL is off) |
| `$0100-$01FF` | stack |
| `$0200-$03FF` | small tables, IRQ trampolines, inter-program selector bytes (keep `$0314/5` untouched if KERNAL stays on) |
| `$0400-$07FF` | spare / loader scratch |
| `$0801` | BASIC stub `SYS` to start; code from `$0810` |
| `$0900-$8FFF` | code, tables, page-aligned hot data (34,560 bytes) |
| `$9000-$9FFF` | level data window / decompression buffer |
| `$A000-$BFFF` | music + player, or more code/data (needs LORAM=0: `$01` = `$36`/`$35`/`$34`) |
| `$C000-$C3FF` / `$C400-$C7FF` | screen 0 (pointers `$C3F8`) / screen 1 |
| `$C800-$CFFF` | game charset |
| `$D000-$DFFF` | RAM under I/O: sprite shapes (up to 64) and/or second charset |
| `$E000-$FFFF` | bitmap, or up to 127 sprite shapes, or tile data; vectors at `$FFFA-$FFFF` (inside shape 127) |
Check: sprite shape addresses must be multiples of 64 and pointer value (addr-bank)/64 <= 255.

### B. Small single-screen game (AUTHENTIC, easiest), VIC bank 0, KERNAL on
`$0801` stub; code at `$0810`-`$0FFF`; music at `$1000` (use a tune whose PSID header load address is `$1000`; the VIC sees character ROM at `$1000-$1FFF`, so no graphics there); screen `$0400`; sprite shapes at `$2000-$27FF`; charset `$2800` or `$3800`; extra code/data from `$4000`. Hook the KERNAL IRQ vector `$0314` and end with `jmp $EA31` (clock, cursor and keyboard scan) or `jmp $EA81` (restore registers and `RTI` only) (c64ref ROM disassembly).

### C. MODERN game with REU streaming
| Area | Placement |
|---|---|
| Resident code, IRQ chain, REU/overlay manager, hot tables | main RAM `$0801-$BFFF` (keep small) |
| VIC data (screen, charset, sprites) | VIC bank 3 as in A, refilled from REU between frames |
| Overlay window | fixed RAM window (for example `$D000-$DFFF`) filled by REU fetch; overlay never calls overlay |
| Levels, maps, tilesets, sprite sets, text, SID register streams, samples | REU, one frozen layout file with every offset |
| Config checks at start | UCI present, REU enabled and size sufficient (`c64://ultimate/reu`); show a message and halt otherwise |
- One header file/module (`reu_layout`) defines all REU offsets and sizes. First block carries magic, version, per-block CRC; check at boot, abort loudly on mismatch (stale or empty REU looks like valid data).
- Keep each DMA inside one 512 KB-aligned REU block: VICE increments only the low 19 address bits during a transfer and wraps to the block start (`src/c64/cart/reu.c:1085-1093`). A length register of 0 transfers 65,536 bytes (`reu.c:1534`); guard against it. One 256-byte fetch costs 256 PHI2 cycles at 1 MHz.
- An IRQ that touches REU registers must save and restore them if the main loop also uses REU. Register map, loading paths (UCI load, stash stub) and pitfalls: `c64://ultimate/reu`.
- The host can write at most the 64 KB C64 address space with one `machine:writemem` (measured); larger data reaches the REU through a UCI file load in the game or the REU preload. The preload runs once per firmware start, not on a C64 reset (`1541ultimate@700c7f2fa:software/io/c64/reu_preloader.cc:58-77`).

### D. Disk-based RPG / adventure (AUTHENTIC)
Resident engine `$0900-$4FFF`; text and data banks loaded on demand from disk into a fixed window (for example `$5000-$9FFF`), with a fastloader (toolchain section 4); the save game is one small file; a RAM table maps each bank to its file name. On MODERN, REU fetches replace the disk loads.

## 6. Architecture checklist
1. Target stated; features detected with a fallback message (MODERN) or absent (AUTHENTIC).
2. Memory map in one include file, build asserts on overlaps; VIC bank, `$01` play state, vectors and NMI decided.
3. IRQ list: lines, order, who acknowledges `$D019`, music line, no entry closer than the worst-case handler time; double-buffered hand-over to the main loop.
4. State machine with init/update/exit; hi-score and settings persistence designed up front (disk file or UCI file write).
5. Frame budget measured on NTSC timing (authentic) or independent of CPU speed (modern); PAL and NTSC both tested (VICE: set the machine model).
6. Loader/packer plan (single PRG, multipart, cartridge, REU preload), golden checksum per build; logic tested in VICE, then a hardware gate with a captured frame per milestone.
