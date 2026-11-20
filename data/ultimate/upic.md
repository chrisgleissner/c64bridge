# Upic: 384x256 16-Colour Graphics by Border Racing

**Summary:** Upic is a software technique by Aleksi Eeben, not a hardware mode and not a register. With the VIC display disabled (`$D011` bit 4 = 0) the whole screen is border, and the CPU, running at Ultimate turbo speed, stores a colour to `$D020` once per pixel, cycle-exact against the raster beam. Result: 384x256, 16 colours (from the runtime palette), no colour clash, no hardware sprites, no text. It needs an Ultimate 64 / Elite / Elite II / C64U at top turbo speed, PAL. At 64 MHz game code gets 16.5 % (256 rows) to 26.7 % (224 rows) of the CPU cycles of a frame (measured C64U).
**Read when:** a request mentions Upic, a full-screen 16-colour bitmap without attribute clash on an Ultimate, or a game that scrolls and animates by palette cycling.

Sources: the public implementations below (renderer, file format, layout); turbo and palette rules from c64://ultimate/hardware and c64://ultimate/uci (GideonZ/1541ultimate master 700c7f2fa). "Measured C64U" = C64 Ultimate, firmware 1.2.1, PAL, 2026-11-13; "measured U64" = Ultimate 64 Elite, firmware 3.15a. Credit: Upic by Aleksi Eeben (https://csdb.dk/release/?id=263889). Public implementations: https://github.com/xahmol/mandelbrot-upic (Xander Mol, Christian Gleissner; Oscar64, GPL-3.0) and https://github.com/xahmol/ultimate-uci-oscar64 (library with Upic renderer, GPL-3: read for reference, do not paste its code into other-licensed projects). Cross-references: c64://ultimate/hardware (turbo), c64://ultimate/uci (palette commands), c64://ultimate/reu (REU data), c64://graphics/vic/spec.

## Requirements

| Need | Detail |
|---|---|
| Machine | Ultimate 64, Elite (48 MHz), Elite II, C64U (64 MHz). Not U2 cartridges, not a stock C64, not VICE (logic and buffers can be tested in VICE; the picture cannot). |
| Video | PAL (the renderer timing assumes 63 cycles per line and 312 lines) |
| Turbo | `Turbo Control` = the registers mode (`U64 Turbo Registers` on U64, `C64U Turbo Registers` on C64U, measured) and `CPU Speed` = top entry (`48` or `64`); the program then writes `$D031` = `$8F` (index 15). Index 15 is 64 MHz on the C64U (measured on C64 Ultimate, firmware 1.2.1, 2026-11-20), so a program that must run at 48 MHz there writes `$8E` (index 14: probe 201, 48 MHz measured); on U64 index 15 is 48 MHz. Set them with `c64_config` or with a `.cfg` named like the PRG (same folder, started from the Ultimate file browser; c64://gamedev/toolchain). Write exactly one `Turbo Control` line: a value the firmware does not list makes UCI LOAD_CONFIG answer `89` and apply nothing (rule in c64://ultimate/hardware). |
| UCI | `Command Interface` = Enabled, for palette commands (c64://ultimate/uci) |
| Firmware | palette commands `04 51`-`04 54`: U64 family, public master since 2026-09-03; present on the measured C64U (1.2.1). `21,UNKNOWN COMMAND` means they are missing. |

- Index 15 gives 48 MHz or 64 MHz depending on model; the register cannot tell. Probe (c64://ultimate/hardware).
- After a start the CPU runs at 1 MHz whatever `$D031` holds: 2.6 s after `run_prg` program start, 3.9 s after `load_prg` and a typed `SYS` (`upload_run_asm`), 4.17 s after a reset (measured on U64 3.15a) (measured on C64 Ultimate, firmware 1.2.1, 2026-11-20). Probe until two loop results agree before the first frame.

## Display model

- 384x256 pixels = 192 "byte columns" x 256 rows. Column c holds pixel x = 2c in the low nybble and x = 2c+1 in the high nybble, row = offset inside the column (column-major, 256 bytes per column, 49,152 bytes). Same as Upic `.upic` files.
- Pixel address: `col_base(x >> 1) + y`; even x = low nybble mask `$0F`, odd x = high nybble mask `$F0`.
- The buffer is ordinary C64 RAM (default `$1000-$CFFF`). Common layout: first 8 columns relocated to `$E000` (under KERNAL, needs `$01 = $35`), the rest at `$1800 + (c-8)*256`, generated renderer page-aligned at `$E800` up. Resident code and data then fit in `$0800-$17FF` (4 KB) and the RAM above the renderer; large programs use REU overlays.
- A bare 49,152-byte bitmap or v1.3 `.upic` file (256-byte header "Upic1.3" + `$AE`, size fields, text, 48-byte palette at `$D0`, bitmap at `$100`) holds pictures; older converters write a separate `.pal`.
- There is no framebuffer register, blitter or double buffer. Pixels are written by CPU stores, REU DMA or UCI DMA loads into the columns. A second 48 KB buffer does not fit in RAM.
- Palette: pixel values are VIC colour indices 0-15 written to `$D020`; their RGB comes from the Ultimate palette (UCI `04 51-54`; `04 53` set and `04 54` reset of the palette verified on Ultimate 64 Elite, firmware 3.15a, 2026-11-20; the Upic program itself was not run on it). A palette change recolours the whole display at once with no pixel redraw.

## Renderer and CPU budget

- Per picture line: wait for the raster line, resync turbo by writing `$D031` = `$80` then `$8F` (so the CPU resumes at the same sub-slot on every line), then call a generated, page-aligned routine: patch-list loads, a delay loop, then per byte column: load byte, store to `$D020` (low nybble), table lookup `nyb[i] = i >> 4`, store to `$D020` (high nybble). End with two NOPs (without them pixel 383 is lost) and `$D020` = 0.
- 64 MHz: 63 CPU cycles per phi2 (VIC takes one of 64 sub-slots), 3,969 per PAL line; two pixels per 16 cycles, 16 pixels in 126 cycles; all 384 pixels one dot wide.
- 48 MHz: 47 cycles per phi2, 2,961 per line; free CPU time 0.75 of the 64 MHz figure (2,961 against 3,969 cycles per PAL line, screen blanked, measured 2026-11-13). The mandelbrot-upic picture is shown at 48 MHz (measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20). The number of pixels shown per line at 48 MHz is in Not verified.
- Never use indexed stores to I/O in the renderer (extra dummy read changes timing); a VIC register read costs one extra sub-slot, a write none.
- Free CPU cycles per 64 MHz frame (1,238,387 cycles), measured C64U (50 samples, status marker row on); at 256 rows the renderer takes 83.5 % of the frame:

| Visible rows | Free cycles / frame |
|---|---|
| 256 | 204,800 |
| 240 | 268,300 |
| 224 | 331,000 |

- Frame rate is the display refresh (50 Hz) as long as per-frame work fits the free time. If it overruns, raster lines shift and rows glitch; polled loops that call "show frame" between work chunks show the picture only on some frames (flicker). Interrupt-driven display (a raster IRQ that starts before the first displayed row, a hook at the end of the frame) keeps it steady.
- Each row not shown returns one raster line, 3,969 cycles at 64 MHz (the table: 16 rows = 63,500 cycles).
- Per-frame cost of a ring-buffer scroller at 64 MHz (cycle count of the code): one new column 3.8k cycles (scrolling left 4.2k), one new row 51k, diagonal 53k.
- A full-screen clear is 49,152 stores: 196,608 cycles with unrolled `sta abs` (4 cycles) and 245,760 with `sta abs,y` (5 cycles), the whole free time of a 256-row frame. Do not clear the screen per frame.

## What is impossible

- Hardware sprites (invisible while DEN = 0, tested on hardware), text mode, bitmap/multicolour modes, colour RAM, raster bars by IRQ, any second raster interrupt, stable KERNAL IRQ chain. Anything that moves must be drawn into the buffer by software.
- Per-line palette tricks (UCI is far too slow). VICE preview of the picture.
- Interrupts and stalls inside the picture: CIA timer IRQs must be off; KERNAL/BASIC IRQ handlers must be bypassed (own vectors with ROMs out, `$01 = $35`; NMI to an RTI). **Host-side REST access (`c64_memory` read, screen capture) stalls the CPU** through DMA: in a measurement, 29 REST reads over 1500 frames produced 19 glitched frames, none without. Avoid it while Upic runs.

## Game architecture on Upic

1. **Display IRQ plus main loop.** The raster IRQ draws the picture; the main loop runs in the remaining time. A commit hook at the end of the IRQ (after the picture) applies everything the main loop prepared (scroll offsets), so nothing tears. Main loop writes only rows/columns that are currently hidden.
2. **Frame schedule with cycle allowances.** Example budget out of 268,300 free cycles (240 rows): scroll and exposed terrain 60k, objects 30k, one palette update 3k, one UCI state-machine step 2k, simulation 15k, background work up to 40k. Defer any step that does not fit to the next frame; never delay the picture.
3. **Ring-buffer scrolling.** Vertical: each column is exactly 256 bytes, so starting the renderer's row index at `row0` scrolls by wrapping for free; only the newly exposed row (192 stores) is written. Horizontal: re-point the renderer's column operands (high bytes only, since columns are page-aligned): one new column is one 256-byte REU fetch. Granularity: 2 pixels per step horizontally, 1 row vertically. Keep a margin (for example 8 hidden rows and 2 hidden byte columns) where new content is written. Patching generated renderer code is tied to the library version.
4. **Software sprites.** 8x8 tile = 4 byte columns x 8 rows = 32 bytes, stored column-major so a byte column copies straight into a picture column. Shapes: data plus mask (a nybble of `$F` = transparent), save-under buffers, a cap on shapes per frame. Horizontal positions move in whole byte columns (2 pixels); an odd x needs a second copy of the shape shifted by one nybble.
5. **Palette animation.** Reserve palette slots by role (ink, rotating water shimmer, sky, accent...) and animate by rewriting RGB, no pixel redraw: day/night keyframes, shimmer, flash. Never signal gameplay state by colour alone.
6. **Non-blocking palette writes.** A blocking UCI palette write took 12-58 ms (one colour) and up to 51 ms (all 16) on the measured C64U, up to 3 frames. Use a small state machine: queue one command, advance it once per frame (2k cycles per step in the budget above), at most one command in flight, timeout in frames, prefer one-slot updates. Never wait on UCI inside the displayed part of a frame; use absolute addressing for UCI registers. Measured C64U: 199 palette updates over 500 frames took at most 3 frames each, with no glitched frame.
7. **REU-fed data.** Map chunks, tiles, pictures, overlays and level data live in the REU and are fetched into hidden columns in the free time (c64://ultimate/reu). One 256-byte fetch per frame ran 500 frames without glitches (measured C64U). A 49,152-byte fetch stalls the CPU for 11.4 ms at 64 MHz (4.3 B/us) and 13.7 ms at 48 MHz (3.6 B/us), over half a 20 ms frame, and 49.6 ms at 1 MHz (0.99 B/us): only under a fade or in the free part of the frame.
8. **Overlays.** With the resident layout above, put code in REU overlays copied through a bounce buffer into a RAM window (including RAM under I/O run with `$01 = $34`); verify checksums on load; overlays call resident services rather than each other.
9. **Audio.** Compose the SID register image in the main loop, copy it in the frame IRQ hook (very short). Digis and CIA-driven music are not compatible with the display IRQ. Several SIDs: `c64://ultimate/multisid` (one register image per window).
10. **Load.** A launcher PRG checks requirements, loads data into the REU through UCI (c64://ultimate/uci) using a manifest with checksums, then starts the main PRG.

## Detection and fallback

- Run all checks on the normal text screen BEFORE setting DEN = 0 and print a plain message naming the setting to change: Command Interface off (`$DF1D & $7F != $49`), turbo registers missing (`$D031 = $FF`: `Turbo Control` is `Off` or `Manual`), speed not 64 MHz (the 48 MHz pixel count is in Not verified), palette commands missing (GET_PALETTE `04 51` answers `21,UNKNOWN COMMAND` on a U2-family cartridge or firmware without them), REU too small (size probe in c64://ultimate/reu).
- Speed probe and model: c64://ultimate/hardware. The speed probe, not the product string, decides 48 versus 64 MHz.
- No graphical fallback exists in the libraries: without turbo the renderer produces garbage. Offer a normal VIC mode path or refuse to start.
- Exit: undo every change the program made: stop the raster IRQ, set DEN = 1 in `$D011`, write `$D031` = 0, restore `$01`, the vectors and `$D020`, and send `04 54` to reset the palette.

## Pitfalls

1. Upic is a technique: do not generate code expecting a mode register or a second VIC.
2. Wait out the 1 MHz window; a PRG started without its turbo `.cfg` never reaches speed (probe gives up).
3. No indexed addressing on I/O, no interrupts or DMA stalls mid-frame, no REST memory reads.
4. UCI discipline: write literal control values, bound all loops, do not send the unlock sequence if UCI already answers.
5. Compiler pitfalls with Oscar64 seen in these projects: reordered constant I/O stores (use inline asm for DMA), dropped reads of `$DC0D` (do it in asm), globals shared with the IRQ must be volatile, a data region below `$0801` moves the PRG load address.
6. `.upic` file saving needs a real UCI directory; after reset the current directory can be virtual and creation fails.
7. 240 rows instead of 256 give 31 % more free time (268,300 against 204,800 cycles).

## Not verified

| Claim | What would settle it |
|---|---|
| The 48 MHz pixel count on an Ultimate 64 Elite: 288 of 384 pixels per line, and some pixels 2 dots wide or off by one dot | U64 request U-5 (picture shown on firmware 3.15a, 2026-11-20). The four captured frames did not confirm a fixed dropped pixel per group of four: colour changes fell on all four x mod 4 phases (1480, 1454, 1680 and 2000 changes per phase), and runs of length 1 are common (1846). The count cannot be read from the picture content. |
| NTSC operation | not supported by the public implementations; would need an NTSC renderer |
