# MOS 6567/6569 VIC-II Quick Reference

Source: <https://www.zimmers.net/cbmpics/cbm/c64/vic-ii.txt>

## System Overview

- Core chips: 6510 CPU (NMOS, ~1.02 MHz NTSC / ~0.985 MHz PAL), VIC-II (6567 NTSC / 6569 PAL, later 8562/8565), SID 6581, two CIA 6526, 64 KB DRAM, 1 KB colour SRAM, 16 KB Kernal/BASIC ROM, 4 KB character ROM.
- VIC-II features: 40x25 text matrix, 320x200 or 160x200 bitmap, eight 24x21 sprites, 16 fixed colours, DMA/refresh master, light-pen input, IRQ generation.

## Key 6510 Signals

- `phi2`: Two-phase system clock; VIC drives phase 1 (low), CPU drives phase 2 (high).
- `R/W`: Bus direction (1 read, 0 write).
- `IRQ`, `NMI`: Interrupt inputs (VIC connects to IRQ).
- `RDY`: Halts CPU on reads when low (asserted via VIC BA).
- `AEC`: Tri-states CPU address bus when low (driven by VIC).
- `P0..P5`: On-chip port (DDR $0000, data $0001) controlling LORAM, HIRAM, CHAREN, cassette lines.

## Key VIC-II Signals

- `A0..A13`: 14-bit multiplexed video address bus (CIA2 bank bits extend reach to 64 KB).
- `D0..D11`: 12-bit data bus; lower 8 bits share CPU bus, upper 4 hit colour RAM.
- `IRQ`: Output to 6510 IRQ pin.
- `BA`: Bus Available; low three cycles before VIC steals phase-2 slots.
- `AEC`: Mirrors CPU AEC; low means VIC drives the bus.
- `LP`: Light-pen input (wired into keyboard matrix).
- `phi_in` / `phi0`: Pixel clock input (8.18 MHz NTSC, 7.88 MHz PAL) and derived 1 MHz system clock output.

## Memory Maps

### CPU View (6510)

| Range | Content | Notes |
| --- | --- | --- |
| $0000 | I/O port DDR | Writes normally isolated; VIC leakage can touch RAM. |
| $0001 | I/O port data | Controls ROM/I/O mapping. |
| $0002-$9FFF | RAM | Always writable even when ROM overlays. |
| $A000-$BFFF | BASIC ROM or RAM | Toggled by LORAM/HIRAM. |
| $C000-$CFFF | RAM | |
| $D000-$D3FF | VIC registers (mirrored every $40) | |
| $D400-$D7FF | SID | |
| $D800-$DBFF | Colour RAM (4-bit, open upper nybble) | Visible when CHAREN=1. |
| $DC00-$DCFF | CIA1 | |
| $DD00-$DDFF | CIA2 | |
| $DE00-$DFFF | Expansion I/O (open bus) | Often returns last VIC fetch. |
| $E000-$FFFF | Kernal ROM or RAM | Controlled by HIRAM/external lines. |

### VIC View

| Bank | CPU Range | VIC Range | Contents |
| --- | --- | --- | --- |
| 0 | $0000-$3FFF | $0000-$3FFF | RAM; char ROM at $1000-$1FFF. |
| 1 | $4000-$7FFF | $0000-$3FFF | RAM. |
| 2 | $8000-$BFFF | $0000-$3FFF | RAM; char ROM at $1000-$1FFF. |
| 3 | $C000-$FFFF | $0000-$3FFF | RAM. |

- CIA2 port A bits 0-1 (inverted) choose the active 16 KB bank.
- Colour RAM (10-bit address) appears as upper nybble on every VIC read regardless of bank.

## Character ROM

The **Character ROM** (*chargen*) for the C64 is **4 KB at $D000–$DFFF (53248–57343)**, consisting of **two 2 KB sets** (each 256×8-byte glyphs):

- **Set 1 (uppercase/graphics):** $D000–$D7FF (53248–55295), 256 entries
- **Set 2 (lowercase/uppercase):** $D800–$DFFF (55296–57343), 256 entries

**Screen codes** index glyphs; **PETSCII codes** are logical character codes used by BASIC/KERNAL. Screen memory at **$0400–$07E7** stores screen codes that the **VIC-II** uses to fetch 8-byte bitmaps from the active character set.

### Screen/PETSCII Code Mapping and Character Bitmaps

The file `data/graphics/character-set.csv` contains the screen codes, PETSCII codes, and exact bitmaps of the first 256 entries. Its columns are **screen_code**, **petscii_code**, **Unicode/name**, and **byte1–byte8** (the 8×8 bitmap rows).

### Switching character sets

- Via control codes: `CHR$(142)` (set 1), `CHR$(14)` (set 2)
- Via register: **$D018 (53272)** selects screen base (upper nybble, ×1 KB) and character base (lower nybble, ×2 KB; bit 0 ignored). Typical values: **21** (set 1) and **23** (set 2).
- Keyboard: **SHIFT + Commodore** toggles sets.

### Rendering rules

- Each glyph = **8 rows × 1 byte/row**, **MSB = leftmost pixel**. Bit **1 = foreground** (per-cell color at **$D800–$DBE7**), **0 = background**.
- **Reverse-video:** characters **128–255** are reverse images of **0–127** in ROM sets.
- **Multicolor char mode:** pixels are **bit-pairs** (4 wide pixels/row). Colors: `00`=background ($D021), `01`=$D022, `10`=$D023, `11`=per-character color ($D800–$DBE7, colors 0–7). Enable multicolor via **$D016 bit 4** (MCM; $D011 bit 4 is DEN, display enable); hires/multicolor can mix per cell (color RAM bit 3).

### Custom character sets in RAM

- **Alignment:** base address must be **2 KB-aligned** and within the **same 16 KB VIC bank** as screen RAM.
- **ROM-shadowed gaps:** VIC cannot see RAM charsets at **$1000, $1800, $9000, $9800** (ROM overlays).
- **Accessing ROM by CPU:** clear **CHAREN** (I/O port at **$01**, bit 2 = 0) while LORAM or HIRAM stays set, to map the character ROM at **$D000–$DFFF** for copying to RAM. Disable interrupts (`SEI`) while I/O is switched out.

## Bus Arbitration

- VIC issues a read every phase-1 slot (c/g/p/s/refresh/idle access types).
- Character pointer fetches cost 40 extra phase-2 cycles during bad lines; sprite data consumes 2 phase-2 cycles per active sprite line.
- BA drops three cycles before takeover; AEC follows low three cycles later so CPU finishes up to three writes.
- CPU stalls only on reads; writes continue until RDY is sampled on the next read.

## Register Map ($D000-$D02E, mirrors every $40)

| # | Addr | Bits | Purpose |
| --- | --- | --- | --- |
| 0 | $d000 | M0X[7:0] | Sprite 0 X (LSB). |
| 1 | $d001 | M0Y[7:0] | Sprite 0 Y. |
| 2 | $d002 | M1X[7:0] | Sprite 1 X (LSB). |
| 3 | $d003 | M1Y[7:0] | Sprite 1 Y. |
| 4 | $d004 | M2X[7:0] | Sprite 2 X (LSB). |
| 5 | $d005 | M2Y[7:0] | Sprite 2 Y. |
| 6 | $d006 | M3X[7:0] | Sprite 3 X (LSB). |
| 7 | $d007 | M3Y[7:0] | Sprite 3 Y. |
| 8 | $d008 | M4X[7:0] | Sprite 4 X (LSB). |
| 9 | $d009 | M4Y[7:0] | Sprite 4 Y. |
| 10 | $d00a | M5X[7:0] | Sprite 5 X (LSB). |
| 11 | $d00b | M5Y[7:0] | Sprite 5 Y. |
| 12 | $d00c | M6X[7:0] | Sprite 6 X (LSB). |
| 13 | $d00d | M6Y[7:0] | Sprite 6 Y. |
| 14 | $d00e | M7X[7:0] | Sprite 7 X (LSB). |
| 15 | $d00f | M7Y[7:0] | Sprite 7 Y. |
| 16 | $d010 | M7X8..M0X8 | Sprite X MSBs. |
| 17 | $d011 | RST8 ECM BMM DEN RSEL YSCROLL[2:0] | Control 1: raster MSB, mode flags, display enable, 25/24 rows, vertical scroll. |
| 18 | $d012 | RASTER[7:0] | Raster counter LSB / compare value. |
| 19 | $d013 | LPX[7:0] | Light-pen X (bits 8-1). |
| 20 | $d014 | LPY[7:0] | Light-pen Y (bits 8-1). |
| 21 | $d015 | M7E..M0E | Sprite enable bits. |
| 22 | $d016 | -- RES MCM CSEL XSCROLL[2:0] | Control 2: multicolour, 40/38 columns, horizontal scroll (RES unused on 6567/6569). |
| 23 | $d017 | M7YE..M0YE | Sprite Y expansion toggles. |
| 24 | $d018 | VM13..VM10 CB13..CB11 _ | Video matrix and character/bitmap base pointers. |
| 25 | $d019 | IRQ ILP IMMC IMBC IRST | Interrupt latch (write 1 to clear, bit 7 mirrors IRQ). |
| 26 | $d01a | ---- ELP EMMC EMBC ERST | Interrupt enable mask. |
| 27 | $d01b | M7DP..M0DP | Sprite priority (0 in front of foreground, 1 behind). |
| 28 | $d01c | M7MC..M0MC | Sprite multicolour enable. |
| 29 | $d01d | M7XE..M0XE | Sprite X expansion. |
| 30 | $d01e | M7M..M0M | Sprite-sprite collision flags (read clears). |
| 31 | $d01f | M7D..M0D | Sprite-data collision flags (read clears). |
| 32 | $d020 | ---- EC[3:0] | Border colour. |
| 33 | $d021 | ---- B0C[3:0] | Background colour 0. |
| 34 | $d022 | ---- B1C[3:0] | Background colour 1. |
| 35 | $d023 | ---- B2C[3:0] | Background colour 2. |
| 36 | $d024 | ---- B3C[3:0] | Background colour 3. |
| 37 | $d025 | ---- MM0[3:0] | Sprite multicolour 0. |
| 38 | $d026 | ---- MM1[3:0] | Sprite multicolour 1. |
| 39 | $d027 | ---- M0C[3:0] | Sprite 0 colour. |
| 40 | $d028 | ---- M1C[3:0] | Sprite 1 colour. |
| 41 | $d029 | ---- M2C[3:0] | Sprite 2 colour. |
| 42 | $d02a | ---- M3C[3:0] | Sprite 3 colour. |
| 43 | $d02b | ---- M4C[3:0] | Sprite 4 colour. |
| 44 | $d02c | ---- M5C[3:0] | Sprite 5 colour. |
| 45 | $d02d | ---- M6C[3:0] | Sprite 6 colour. |
| 46 | $d02e | ---- M7C[3:0] | Sprite 7 colour. |

Notes: unused bits read as 1; writes to $d01e/$d01f ignored; registers repeat every $40 bytes; $d02f-$d03f read $ff.

## Palette

| Code | Colour |
| --- | --- |
| 0 | Black |
| 1 | White |
| 2 | Red |
| 3 | Cyan |
| 4 | Pink |
| 5 | Green |
| 6 | Blue |
| 7 | Yellow |
| 8 | Orange |
| 9 | Brown |
| 10 | Light red |
| 11 | Dark gray |
| 12 | Medium gray |
| 13 | Light green |
| 14 | Light blue |
| 15 | Light gray |

## Display Geometry

- Screen rendered line by line; 8 pixels per CPU cycle.
- Display window fixed centrally while borders mask surrounding area.
- `RSEL` (bit 3 of $d011): 24 rows (192 px, raster $37-$f6) or 25 rows (200 px, raster $33-$fa).
- `CSEL` (bit 3 of $d016): 38 columns (304 px, X $1f-$14e) or 40 columns (320 px, X $18-$157).
- `XSCROLL[2:0]` and `YSCROLL[2:0]`: fine scroll 0-7 pixels.
- Cycle/line metrics: 6569 PAL (63 cycles, 312 lines, 284 visible, IRQ reference X=$194, visible X $1e0-$17c); 6567R56A NTSC (64 cycles, 262 lines, 234 visible, IRQ X=$19c, visible X $1e8-$184); 6567R8 NTSC (65 cycles, 263 lines, 235 visible, IRQ X=$19c, visible X $1e9-$18c).

## Bad Lines and Counters

- Bad line condition: during a phi0 falling edge, raster between $30 and $f7 inclusive, low three bits equal `YSCROLL`, and `DEN` was set at least once in raster line $30.
- On a bad line the VIC pulls BA low from cycle 12, keeps AEC low from cycle 15, and performs 40 c-fetches in cycles 15-54 (phase 2).
- Internal counters: `VC` (10-bit), `VCBASE` (10-bit), `RC` (3-bit), `VMLI` (6-bit index into the 40x12 buffer).
  - Cycle 14 phase 1: `VC <- VCBASE`, `VMLI` reset; if bad line, `RC <- 0`.
  - Each g-fetch in display state increments `VC` and `VMLI`.
  - Cycle 58 phase 1: if `RC == 7`, sequencer idles and `VCBASE <- VC`; otherwise `RC++`.
- Idle state fetches from $3fff (or $39ff when ECM=1) with video matrix bits forced to 0.

## Memory Access Types per Raster Line

- `c`: video matrix + colour RAM  (12-bit).
- `g`: character/bitmap byte (8-bit) or idle fetch ($3fff/$39ff).
- `p`: sprite pointer (one per sprite each line).
- `s`: sprite data (three bytes per active sprite line, immediately after pointer).
- `r`: DRAM refresh (five accesses using REF counter).
- `i`: idle access to $3fff.
- Order is hard-wired; bad lines insert 40 consecutive `c` slots, and active sprites add `s` slots right after their pointer cycle.

## Graphics Modes (ECM/BMM/MCM)

Graphics mode is selected by the following bits in $d011 and $d016:

- `ECM` (bit 6 of $d011): Extended Colour Mode.
- `BMM` (bit 5 of $d011): Bit Map Mode.
- `MCM` (bit 4 of $d016): Multi Colour Mode.

| Mode | Bits (ECM/BMM/MCM) | Memory interpretation | Pixel output |
| --- | --- | --- | --- |
| Standard text | 0/0/0 | `c`: char code + colour nybble; `g`: CB bits + RC | 8x8 pixels; bit 1 uses `c[11:8]`, bit 0 uses B0C ($d021$). |
| Multicolour text | 0/0/1 | `c[11]` selects multi flag | Flag 0: standard text; flag 1: 4x8 pixels, 00->B0C, 01->B1C, 10->B2C, 11->`c[10:8]`. |
| Standard bitmap | 0/1/0 | `c`: foreground/background nybbles; `g`: bitmap byte | 8x8 pixels; bit 0 -> `c[3:0]`, bit 1 -> `c[7:4]`. |
| Multicolour bitmap | 0/1/1 | `c`: colours for 01/10/11 | 4x8 pixels; 00->B0C, 01->`c[7:4]`, 10->`c[3:0]`, 11->`c[11:8]`. |
| ECM text | 1/0/0 | Upper char bits select B0C..B3C (char set reduced to 64) | Foreground uses `c[11:8]`; background chosen via `c[7:6]`. |
| Invalid text | 1/0/1 | Same addressing as ECM multi; outputs black | Useful for collision tricks; no visible pixels. |
| Invalid bitmap 1 | 1/1/0 | Bitmap with A9/A10 forced low | Displays black; repeats sections; collisions still occur. |
| Invalid bitmap 2 | 1/1/1 | Multicolour bitmap with A9/A10 forced low | Black output; collisions possible; 4x8 grouping. |
| Idle state | any (when sequencer idle) | `g` fetch at $3fff/$39ff, video matrix treated as zero | Outputs backgrounds per mode (typically B0C or black). |

## Sprites

- Data layout: 63 bytes (21 rows x 3 bytes), pointer table = last 8 bytes of video matrix ($03f8-$03ff in bank).
- Each sprite has counters `MC` (6-bit) and `MCBASE`, plus a Y expansion flip-flop.
- DMA enable: in cycles 55-56 the VIC tests `MxE` and `Y == RASTER`; if true, DMA turns on, `MCBASE <- 0`, Y expansion flip-flop cleared when `MxYE` set.
- Cycle 58: `MC <- MCBASE`; sprite becomes visible if DMA on and Y matches raster.
- Sprite fetches: after pointer (`p`) cycle, three `s` cycles read data bytes into a 24-bit shift register; `MC` increments each `s`.
- Display: shift register outputs bits once X matches register; multicolour groups two bits; X expansion halves shift rate; toggling `MxYE` repeats lines for Y expansion.
- Reuse: change Y mid-frame after DMA completes to display same sprite later; horizontal reuse impossible after 24 pixels (shift register empty).
- Priority: sprites ordered 0 highest to 7 lowest; `MxDP=0` places sprite in front of foreground graphics, `1` behind; overall order background < foreground < sprite (subject to `MxDP`) < border.
- Collisions: $d01e (sprite-sprite) and $d01f (sprite-graphics) latch bits until read; only first collision while register clear raises IRQ if enabled.

## Border Logic

- Two flip-flops: main border (controls border colour) and vertical border (gates sequencer output).
- Comparators per axis use RSEL/CSEL thresholds: horizontal $1f/$14f (38 cols) or $18/$158 (40 cols); vertical $37/$f7 (24 rows) or $33/$fb (25 rows).
- Rules: reaching right edge sets main border; left edge clears it if vertical flip-flop reset; vertical flip-flop set at bottom or when left edge meets top/bottom; DEN must be 1 to clear vertical flip-flop.

## Display Enable (DEN)

- Clearing bit 4 of $d011 suppresses bad lines and keeps vertical border set (screen becomes full border colour).
- Re-enabling mid-frame (with YSCROLL=0) can cause DMA Delay when line $30 becomes a late bad line.

## Light-Pen

- Negative edge on `LP` latches beam into $d013/$d014 (8-bit each; horizontal resolution is two pixels).
- Only first trigger per frame is captured; reset occurs during vertical blank.
- `LP` shares CIA1 keyboard matrix bit (port B bit 4), permitting software-triggered latching for timing.

## Interrupts

| Bit | Latch ($d019) | Enable ($d01a) | Trigger |
| --- | --- | --- | --- |
| 0 | IRST | ERST | Raster compare hits programmed line (checked cycle 0, cycle 1 for line 0). |
| 1 | IMBC | EMBC | Sprite pixel overlaps foreground graphics pixel. |
| 2 | IMMC | EMMC | Two or more sprites output non-transparent pixels simultaneously. |
| 3 | ILP | ELP | Negative edge on light-pen input. |

- Write 1 to any asserted latch bit to clear; bit 7 mirrors IRQ line state.
- VIC asserts IRQ while any enabled latch bit remains set; CPU must clear before exiting handler (level-sensitive).

## DRAM Refresh

- Five refresh reads per raster line via 8-bit REF counter (reset to $ff in line 0, decremented each refresh access).
- Refresh addresses: $3fff, $3ffe, $3ffd, $3ffc, $3ffb in line 0, then continue downward, wrapping every 256 refreshes.

## Notable Effects

- Hyperscreen: toggle CSEL/RSEL so comparisons never match (e.g. switch RSEL at raster 248-250) to disable borders and expose idle graphics or sprites.
- FLD (Flexible Line Distance): adjust YSCROLL to delay bad lines; controls line spacing and enables large downward scroll without memory moves.
- FLI (Flexible Line Interpretation): force bad line each raster (write YSCROLL after cycle 14) to reload colour data per line; requires cycling VM bits; first three fetches read $ff causing left-side stripes.
- Linecrunch: clear bad line condition before cycle 14 so RC stays 7 and `VCBASE` jumps by 40; collapses a text line into one raster and speeds upward scroll.
- Doubled lines: assert bad line late (cycles 54-57) so RC wraps to 0 and same line renders twice.
- DMA Delay: create bad line while sequencer idle (cycle 15-53). Initial three fetches see $ff or CPU opcode low nibble; VC misalignment shifts display horizontally without copying data.
- Sprite stretching: toggle `MxYE` around cycle 16 to repeat or skip line increments; manipulating `MCBASE` permits arbitrary vertical scaling or double rendering.
