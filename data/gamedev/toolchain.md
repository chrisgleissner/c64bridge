# C64 Game Toolchain, Build, Test and Reference Games

**Summary:** Pick one assembler or compiler, keep every address in one include file, build PRG/D64/CRT with a Makefile, pack with Exomizer, test in VICE first and on hardware second through c64bridge. MODERN releases add a `.cfg` and an REU image.
**Read when:** setting up a game project, choosing a language, producing release files (PRG, D64, CRT, `.cfg`, `.reu`).

Marks: "(unverified)" = flag or command not confirmed against current docs here; check `--help`.

## 1. Assemblers and compilers
| Tool | Language | Trade-off | Source |
|---|---|---|---|
| KickAssembler | asm + scripting | richest macros/segments, `.errorif`, SID/Charpad loaders; needs Java; binary-only download | https://theweb.dk/KickAssembler |
| ACME | asm | small, fast, simple; no scripting | https://sourceforge.net/projects/acme-crossass/ |
| 64tass | asm | macros, listings, labels file | https://tass64.sourceforge.net |
| ca65/cc65 | asm + C | mature linker configs; cc65 C code is slow | https://cc65.github.io |
| Oscar64 (GPL-3.0 repo) | C/C++ | best C64 libraries (raster IRQ chain, virtual sprites, memory-map control, overlays); good optimiser; hazards: reordered constant I/O stores, DMA targets invisible to the optimiser (use inline asm/volatile) | https://github.com/drmortalwombat/oscar64 |
| llvm-mos | C/C++ (LLVM) | modern codegen, `mos-c64-clang`; fewer game libraries | https://github.com/llvm-mos/llvm-mos-sdk |
| c64bridge `upload_run_asm` | asm (basic subset) | zero setup, good for snippets and tests; no macros/segments | built in |
Rule of thumb: IRQ chains, multiplexer, scroll copy and music glue in assembly; game logic, data tables and tools in assembly or Oscar64. Pin tool versions; check KickAssembler redistribution terms before bundling.

## 2. Project layout
```
game/
  Makefile
  src/main.asm  src/irq.asm  src/sprites.asm  src/scroll.asm  src/music.asm  src/states/*.asm
  src/memmap.inc          ; every address, size and ROM/RAM choice; build asserts on overlaps
  assets/  charset.ctm  sprites.spd  tune.sid  level*.tmx
  tools/   convert.py     ; asset -> .bin/.asm at build time
  build/   game.prg game.d64 game.crt game.sym game.map
```
- Print a memory report at build time (`-showmem` in Kick, link map elsewhere); fail on overlap.
- Write the symbol/label file (Kick `-symbolfile`, 64tass `-l`) and pass it as `symbolsFile` to `c64_program` `run_prg`/`load_prg` so debug output shows labels.

## 3. Makefile skeleton (64tass + Exomizer + c1541; tabs required)
```
AS   = 64tass
FLAGS = -Wall --cbm-prg -l build/game.sym -L build/game.lst
build/game.prg: src/*.asm src/memmap.inc | build
	$(AS) $(FLAGS) -o $@ src/main.asm
build/game.x.prg: build/game.prg
	exomizer sfx sys -o $@ $<
build/game.d64: build/game.x.prg
	c1541 -format "game,01" d64 $@ -write $< game
build:
	mkdir -p build
run: build/game.prg
	x64sc -autostart build/game.prg
```
- Kick: `java -jar KickAss.jar src/main.asm -o build/game.prg -symbolfile`. ACME: `acme -f cbm -o build/game.prg src/main.asm`. cc65: `cl65 -t c64 -o build/game.prg src/main.c`. llvm-mos: `mos-c64-clang -Os -o build/game.prg src/main.c`. Oscar64: `oscar64 -O2 -g src/main.c` (output flags: see its README).
- `sfx sys` packs the whole PRG; multipart games use `exomizer mem -l none part.bin@0xADDR` plus the in-game decruncher (see Tony).
- BASIC start stub at `$0801`: `10 SYS 2064` bytes `0B 08 0A 00 9E 32 30 36 34 00 00 00`; code starts at `$0810`. Kick: `BasicUpstart2(start)`.

## 4. Formats and packaging
| Output | How | Notes |
|---|---|---|
| `.prg` | assembler output | 2-byte load address first; runs on all targets |
| `.d64` | `c1541` (VICE) or `cc1541` (unverified) | one PRG autostarts; multipart needs a loader |
| `.crt` | `cartconv` (VICE) from a binary (Magic Desk, EasyFlash types) | cartridge conflicts: EasyFlash/FC-III vs REU at `$DF00` (MODERN) |
| `.sid` | tracker export | input for the player, not an output |
- Loaders: KERNAL `LOAD` (slow, always works, safe with IRQs off only with care); Krill's Loader and other fastloaders for real drives (never call `IOINIT` while the drive code is installed; set `$01=$35` around loader calls when ROMs are off); Ultimate devices: REU preload or UCI file load is far faster (`c64://ultimate/reu`, `c64://ultimate/uci`). Disk handling: `c64_disk`, `c64_drive`.
- Release set: `.prg` + `.d64` (+ `.crt`), `.cfg` and `.reu` for MODERN (section 7), checksums, README naming target and Ultimate settings.

## 5. Asset tools
CharPad (charsets, maps), SpritePad (sprites), GoatTracker or SID-Wizard (music, `.sid` export), Python scripts (PNG to charset/tiles, TMX to map bytes). Convert at build time; commit sources.

## 6. Test loop with c64bridge
1. Build, then VICE: `c64_select_backend` `vice`, `run_prg` the PRG. `x64sc` is cycle-exact; use warp mode for long loads; PAL and NTSC models both (`-pal`/`-ntsc`).
2. Assert state: `c64_memory` `read`/`wait_for_text`/`read_screen`; `c64_graphics` `capture_frame` PNG; `c64_input` `joystick`.
3. Debug: `c64_debug` `create_checkpoint` on a label address from the symbol file, `wait_for_state` for PC, `get_registers`, `step`. Remove checkpoints before timing runs.
4. Hardware gate (MODERN or authentic release): `c64_select_backend` `c64u`, `run_prg` from device storage; compare a captured frame with VICE; check raster effects, turbo, SID layout, REU/UCI.
5. VICE gaps for MODERN: no UCI, no turbo, no Ultimate audio, REU DMA costs about 1 cycle per byte (Ultimate rates differ), REU image must match the configured size exactly.
6. Keep a hardware log: firmware/core version, result, frame capture.
7. Do not interrupt another user's running program or flash on a shared device; power operations need explicit user authorisation.

## 7. MODERN packaging: `.cfg` and REU image
A `.cfg` beside the PRG (same base name, started from the file browser) applies settings before the program runs; sections the machine lacks are skipped. Values are the labels shown by `c64_config get`; check them on the target.
```
[U64 Specific Settings]
Turbo Control=U64 Turbo Registers
CPU Speed=64
[C64 and Cartridge Settings]
RAM Expansion Unit=Enabled
REU Size=16 MB
```
- Other machines may use a different label for registers mode (`C64U Turbo Registers`, unverified) or lack `64`: list both Turbo Control lines only if the loader tolerates the unknown one, and always keep the 1 MHz path.
- REU image: `REU Preload=Enabled` and `REU Preload Image=/Usb0/preload.reu` are read at firmware boot only (`c64://ultimate/reu`); games that must work without a reboot load the same file with UCI LOAD_REU. Build it from level files:
```python
import struct, zlib
blocks = [open(f, "rb").read() for f in ("level1.bin", "level2.bin")]  # each at most 64 KB
img = bytearray(256)                     # header: magic, version, count, table (20 rows fit)
img[0:6] = b"GREU\x01" + bytes([len(blocks)])
for i, b in enumerate(blocks):           # row: offset, crc32, length (little endian)
    img[8 + 12*i : 20 + 12*i] = struct.pack("<III", len(img), zlib.crc32(b), len(b))
    img += b + bytes(-len(b) % 256)      # next block on a page boundary
open("preload.reu", "wb").write(img)
```
- Emit the same offsets as an include file for the game (`reu_layout`); the game checks magic and CRCs after loading.

## 8. Reference projects
Open-source games, libraries and licences (read for technique, never copy GPL-3.0 or unlicensed code): `c64://gamedev/references`.
