# C64 Game Architecture: Frame Loop, Budgets, Memory Maps

**Summary:** A C64 game is a frame-synchronous state machine: a raster IRQ chain does the timing-critical display and sound work, the main loop does one frame of logic per frame and hands results over through a flag. Decide the memory map and the frame budget before writing code. Templates below cover a stock 64 KB game, a small single-screen game and an Ultimate game streaming from REU.
**Read when:** starting any game, before choosing addresses, VIC bank, loader or IRQ layout. Techniques (code) are in `c64://gamedev/techniques`.

Marks: "(unverified)" = not confirmed against a primary source. Targets: MODERN = Ultimate devices, AUTHENTIC = stock C64 (see `c64://gamedev/index`).

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
- Poll-based frame sync (`$D012` wait) is fine for small games; use an IRQ flag when a chain or multiplexer exists.
- Missed frame policy: if logic overruns, skip the commit (game slows) rather than tearing; never let the IRQ chain wait on the main loop.
- Run music from the IRQ at a fixed line, so jitter from logic never changes tempo.

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
- Badline: the VIC takes about 40 cycles, CPU keeps about 23 of 63. 25 badlines cost roughly 1,000 cycles per frame. Sprite DMA: about 2 cycles per active sprite per line (21 lines per sprite shape). Border/vblank lines are fully free (about 112 lines PAL).
- Practical free time for a 1 MHz game: PAL about 17,000-18,000 cycles after badlines and sprites; NTSC about 15,000. Budget the slower NTSC and let PAL idle, or scale by frame count.
- Typical per-frame costs (estimates, unverified): music player 500-1,500; 8-sprite update 800; software scroll column copy 1,500-3,000; 24-sprite multiplexer sort 1,000-2,500.
- Measure instead of guessing: set `$D020` to a colour when entering a routine, restore when leaving; the border band height is its cost in raster lines (1 line = 63 cycles PAL). Do this in VICE and capture the frame (`c64_graphics` `capture_frame`).

### MODERN budget
- Turbo speeds up the CPU only; VIC, SID and CIA stay on C64 time. Frame cycle count above is unchanged in real time, but the CPU can run many instructions per line. Settings and registers: `c64://ultimate/hardware`.
- Measured by others at 4 MHz: 3.99x work per frame for RAM-only code; suppressing badline timing adds roughly 6%. Access to cartridge-bus devices and external SID sockets stays at 1 MHz pace. REU DMA time does not shrink with turbo.
- A display-heavy Upic renderer at top speed left about 268,000 CPU cycles per frame for game logic (240 rows). Use that order of magnitude only for Upic designs; for ordinary VIC games turbo mostly buys software rendering, bigger worlds and pre-shifted data built at runtime.
- Design rule: make game speed depend on frame count, not on instruction count, so the game plays identically at 1 MHz and turbo. Offer turbo as headroom for effects, never as a requirement (unless the Upic target says so).
- Never do blocking UCI calls inside a frame; run them as a state machine (one step per frame). Details: `c64://ultimate/uci`.

## 4. VIC bank and `$01` choices
| VIC bank | `$DD00` bits 0-1 | Range | Notes |
|---|---|---|---|
| 0 | `%11` | `$0000-$3FFF` | default; char ROM seen at `$1000-$1FFF`; small games |
| 1 | `%10` | `$4000-$7FFF` | free of ROM images; good for bitmap games |
| 2 | `%01` | `$8000-$BFFF` | char ROM seen at `$9000-$9FFF` |
| 3 | `%00` | `$C000-$FFFF` | best for large games: code `$0800-$BFFF` stays contiguous |
- Keep other `$DD00` bits unchanged (read-modify-write). `$DD02` bits 0-1 must stay outputs. Inside the bank: `$D018` high nibble = screen (x `$400`), bits 1-3 = charset (x `$800`). Sprite pointers at `screen+$3F8`, value x 64 = offset in the bank.
- `$01`: `$37` BASIC+KERNAL+I/O (default), `$36` BASIC off, `$35` only I/O (typical game state: RAM `$A000-$BFFF`, `$E000-$FFFF`), `$34` all RAM (I/O hidden; toggle to `$35` for hardware access; IRQ handler must set `$35` itself), `$31`/`$33` expose char ROM for copying.
- With KERNAL off the vectors at `$FFFA/$FFFE` are RAM: set NMI (point to an `rti`, or a handler) and IRQ yourself; the `$0314` vector is no longer used. Keep CIA IRQs off (`$DC0D=$7F`, `$DD0D=$7F`, then read both).
- RAM under I/O (`$D000-$DFFF`) is visible to the VIC in bank 3 (sprite shapes, second charset): write it once at boot with `$01=$34`. Colour RAM `$D800` is separate, 4-bit, CPU-visible only with I/O on.

## 5. Memory-map templates
### A. Stock 64 KB game (AUTHENTIC; also valid MODERN), VIC bank 3, KERNAL off after boot
| Range | Use |
|---|---|
| `$0002-$008F` | zero page: hot variables, pointers, multiplexer order table (keep `$00/$01`; `$90-$FF` is free for the game once the KERNAL is off) |
| `$0100-$01FF` | stack |
| `$0200-$03FF` | small tables, IRQ trampolines, inter-program selector bytes (keep `$0314/5` untouched if KERNAL stays on) |
| `$0400-$07FF` | spare / loader scratch |
| `$0801` | BASIC stub `SYS` to start; code from `$0810` |
| `$0900-$8FFF` | code, tables, page-aligned hot data (about 32 KB) |
| `$9000-$9FFF` | level data window / decompression buffer |
| `$A000-$BFFF` | music + player, or more code/data (needs `$01<=$36`) |
| `$C000-$C3FF` / `$C400-$C7FF` | screen 0 (pointers `$C3F8`) / screen 1 |
| `$C800-$CFFF` | game charset |
| `$D000-$DFFF` | RAM under I/O: sprite shapes (up to 64) and/or second charset |
| `$E000-$FFFF` | bitmap, or 128 sprite shapes, or tile data; vectors at `$FFFA-$FFFF` |
Check: sprite shape addresses must be multiples of 64 and pointer value (addr-bank)/64 <= 255.

### B. Small single-screen game (AUTHENTIC, easiest), VIC bank 0, KERNAL on
`$0801` stub; code at `$0810`-`$0FFF`; music at `$1000` (typical PSID load address; `$1000-$1FFF` is not visible as RAM to the VIC, so no graphics there); screen `$0400`; sprite shapes at `$2000-$27FF`; charset `$2800` or `$3800`; extra code/data `$4000+`. Use the KERNAL IRQ at `$0314` and chain to `$EA31` for keyboard, or `$EA81` to skip it.

### C. MODERN game with REU streaming
| Area | Placement |
|---|---|
| Resident code, IRQ chain, REU/overlay manager, hot tables | main RAM `$0801-$BFFF` (keep small) |
| VIC data (screen, charset, sprites) | VIC bank 3 as in A, refilled from REU between frames |
| Overlay window | fixed RAM window (for example `$D000-$DFFF`) filled by REU fetch; overlay never calls overlay |
| Levels, maps, tilesets, sprite sets, text, SID register streams, samples | REU, one frozen layout file with every offset |
| Config checks at start | UCI present, REU enabled and size sufficient; show a message and halt otherwise |
- One header file/module (`reu_layout`) defines all REU offsets and sizes. First block carries magic, version, per-block CRC; check at boot, abort loudly on mismatch (stale or empty REU looks like valid data).
- Keep each DMA within one 512 KB-aligned REU block (VICE wraps at 512 KB) and guard length 0, which means 64 KB. Streaming one 256-byte scroll column per frame is cheap.
- An IRQ that touches REU registers must save and restore them if the main loop also uses REU. Register map, loading paths (UCI load, stash stub) and pitfalls: `c64://ultimate/reu`.
- Data delivery from the host is limited to 64 KB writes (`machine:writemem`); big data goes in via UCI file load inside the game or REU preload at boot. Preload does not re-run on reset.

### D. Disk-based RPG / adventure (AUTHENTIC)
Resident engine `$0900-$4FFF`, text/data banks loaded into a fixed window (for example `$5000-$9FFF`) on demand from disk (fastloader recommended, see toolchain); keep save game as one small file; keep a RAM copy of the directory map. On MODERN replace disk streaming by REU fetches.

## 6. Architecture checklist
1. Target chosen and stated; features detected with fallback message (MODERN) or absent (AUTHENTIC).
2. Memory map written first, all addresses in one include file, build asserts on overlaps.
3. VIC bank, `$01` play state, vector setup decided; NMI neutralised.
4. IRQ list designed: lines, order, who acknowledges `$D019`, music line, no two entries closer than the worst-case handler time.
5. Frame budget measured on NTSC timing (authentic) or by frame-count independence (modern).
6. Double-buffered hand-over between main loop and IRQ.
7. State machine with init/update/exit per state; hi-score and settings persistence (disk file or UCI file write) designed up front.
8. Loader/packer plan (single PRG, multipart, cartridge, REU preload); a golden checksum per release build.
9. Both PAL and NTSC tested (VICE: set machine model), music speed and gameplay tempo corrected.
10. Test tiers: logic in VICE, then hardware gate; capture a frame per milestone.
