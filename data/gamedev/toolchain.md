# C64 Game Toolchain, Build, Test and Reference Games

**Summary:** Pick one assembler or compiler, keep every address in one include file, build PRG/D64/CRT with a Makefile, pack with Exomizer, test in VICE first and on hardware second through c64bridge. Includes open-source games to study.
**Read when:** setting up a game project, choosing a language, producing release files, or looking for reference code.

Marks: "(unverified)" = flag or command not confirmed against current docs here; check `--help`.

## 1. Assemblers and compilers
| Tool | Language | Trade-off | Source |
|---|---|---|---|
| KickAssembler | asm + scripting | richest macros/segments, `.errorif`, SID/Charpad loaders; needs Java; binary-only download | https://theweb.dk/KickAssembler |
| ACME | asm | small, fast, simple; no scripting | https://sourceforge.net/projects/acme-crossass/ |
| 64tass | asm | macros, listings, labels file | https://tass64.sourceforge.net |
| ca65/cc65 | asm + C | mature linker configs; cc65 C code is slow | https://cc65.github.io |
| Oscar64 | C/C++ | best C64 libraries (raster IRQ chain, virtual sprites, memory-map control, overlays); good optimiser; hazards: reordered constant I/O stores, DMA targets invisible to the optimiser (use inline asm/volatile) | https://github.com/drmortalwombat/oscar64 |
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
- Release set: `.prg` + `.d64` (+ `.crt`), `.cfg` for MODERN (`c64://ultimate/hardware`), checksums, README naming target and Ultimate settings.

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

## 7. Games and projects to study
Licences vary (MIT, GPL, unknown): read for technique, write fresh code; never copy GPL-3.0 or unlicensed code.
| Title | Target | URL | What to study |
|---|---|---|---|
| Oscar64 samples (hscrollshmup, breakout, lander, maze3d, snake) | authentic | https://github.com/drmortalwombat/oscar64 | IRQ chain library, virtual sprites, memory map and overlay pragmas, scroll game in C |
| Corescape | authentic | https://github.com/drmortalwombat/corescape | complete vertical shooter: parallax scroll, 24 virtual sprites, waves/levels as data |
| Tony: Born for Adventure | authentic | https://github.com/maciejmalecki/tony-demo | flip-screen platformer (MIT): Gradle+Kick build, Exomizer parts, VIC bank 3 map, raster lists |
| Tetris C64 | authentic | https://github.com/wiebow/tetris.c64 | small game (MIT): one file per state, SID tune at `$1000`, hi-score file I/O |
| SquareDoom | authentic | https://github.com/Kweepa/SquareDoom | per-kilobyte memory map, `$01=$34` play state, IRQ trampolines, disk streaming, ACME |
| Cadaver sprite multiplexer | authentic | https://github.com/AlanPBourke/CadaverSpriteMultiplexer ; https://cadaver.github.io/rants/sprite.html | 24-sprite multiplexer, insertion sort, double-buffered table |
| Gridrunner (llamaSource) | authentic | https://github.com/mwenge/gridrunner | classic arcade loop, 64tass rebuild with md5 against the original |
| Elite C64 source (commented) | authentic | https://github.com/markmoxon/elite-source-code-commodore-64 | multi-part disk layout, reproducible byte-accurate build |
| CROSS-LIB | authentic | https://github.com/Fabrizio-Caruso/CROSS-LIB | portable game logic over platform shims, cc65 across many targets |
| Doom C64U | modern | https://github.com/slesinger/doom | 64 MHz plus 16 MB REU streaming, block-oriented REU format with CRC, hardware measurements |
| Mandelbrot Upic | modern | https://github.com/chrisgleissner/mandelbrot-upic | Upic renderer, turbo probe, palette via UCI, Oscar64 build |
| ultimate-uci-oscar64 | modern | https://github.com/xahmol/ultimate-uci-oscar64 | UCI, turbo and Upic helper library (Oscar64 C) |
| Ultimate docs | modern | https://1541u-documentation.readthedocs.io | official config reference |
