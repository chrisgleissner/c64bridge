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

### C compiler runtime facts (cc65, Oscar64, llvm-mos)
Read from each project's own files (cc65 `eebf54a`: `doc/cc65-intern.sgml`, `doc/c64.sgml`, `cfg/c64.cfg`, `libsrc/c64/crt0.s`, `libsrc/runtime/zeropage.s`; Oscar64 `08b01c9`: `oscar64.md`, `include/crt.c`; llvm-mos-sdk `555253f`: `mos-platform/c64/link.ld`, `c64/clang.cfg`, `commodore/commodore.ld`, `commodore/save-basic.S`; llvm-mos `ae72e49`: `MOSCallingConv.td`). Re-check after a version change.
| | cc65 (`-t c64`) | Oscar64 (`.prg` target) | llvm-mos (`mos-c64-clang`) |
|---|---|---|---|
| Zero page | Runtime uses `$02-$1B` (26 bytes: `c_sp`, `sreg`, `regsave`, `ptr1-4`, `tmp1-4`, 6-byte `regbank`), the whole `ZP` area of `c64.cfg`; extra `.zeropage` data needs a `.cfg` with a larger `ZP` | `$02` Y spill, `$03-$0C` mul/div/float work, `$0D-$1A` leaf-function arguments, `$1B-$1E` accumulator, `$1F-$22` pointers, `$23-$24` stack pointer, `$25-$26` frame pointer, `$43-$52` caller-saved, `$53-$8F` callee-saved (manual: "not yet final"). `__zeropage` globals go to the zero-page segment (usually `$80-$FF`, only when the KERNAL is not used; not initialised). `-xz`: more zero page, no return to BASIC | Imaginary registers `__rc0-__rc31` at `$02-$21`; zero-page variables `$22-$8F` (`-mlto-zp=110`); `$90-$FF` (KERNAL) untouched |
| Calling convention | Default `fastcall`: rightmost argument in A (low), X (high), `sreg` (bytes 2-3); the others pushed on the C stack (`c_sp`) left to right. Return in A/X/`sreg`; an 8-bit return must also set X to the high byte. Callee removes its arguments. Free in asm: Y, `tmp1-4`, `ptr1-4`, `regsave`, unused `sreg`; keep `regbank`. Variadic = `cdecl`, Y = bytes pushed | Chosen per function by the global analyser; parameters and locals on a static stack built from the call graph (recursion forces the dynamic stack). Inline asm reads locals and parameters by name but cannot change them. `__interrupt` saves the zero-page registers it uses; `__hwinterrupt` also saves A/X/Y and ends with `RTI` | Bytes go to A, X, then `__rc2-__rc15`; pointers first to `__rs1-__rs7` (register pairs); the rest on the soft stack. Return values use the same order. Caller-saved: A, X, Y, flags, `__rs1-__rs9`; callee-saved: `__rs0` (soft stack pointer), `__rs10-__rs15`. Variadic arguments always on the soft stack; structs passed by pointer |
| Linker configuration | `c64.cfg`: load address `$0801`, 13-byte `HEADER` (BASIC `SYS` stub), `MAIN` up to `__HIMEM__` = `$D000`, C stack `__STACKSIZE__` = `$800` below it. Assembly only: `-C c64-asm.cfg` (`--start-addr $C000`; `-u __EXEHDR__` adds the stub). Label file: `cl65 -Ln` | `#pragma region(name, start, end, flags, bank, {sections})`, `section`, `code()/data()/bss()`, `stacksize` (default 4 KB), `heapsize` (1 KB). Default regions `startup` `$0801-$0900`, `bytecode` `$0900-$0A00`, `main` `$0A00-$A000`; up to `$D000` with `#pragma region(main, 0x0a00, 0xd000, , , {code, data, bss, heap, stack})` and `mmap_set(MMAP_NO_BASIC)`. Writes `.map`, `.asm`, VICE `.lbl` (`al 0801 .startup`, accepted as `symbolsFile`); `-d64=` builds a disk | GNU-ld script `link.ld`: RAM from `$0801`, length `$C7FF`; soft stack `__stack = $D000` growing down; `.basic_header` = `SYS` to `_start` |
| Startup and exit | `crt0.s`: saves `$01`, sets `$01` to (`$01` AND `$F8`) OR `$06` (BASIC off, KERNAL and I/O on), saves SP and the 26 zero-page bytes, sets `c_sp` to the end of `MAIN`, prints `CHR$(14)` (lower-case set), runs constructors, clears BSS, calls `main`. Exit restores zero page, SP and `$01` and returns to BASIC with the exit code in ST. IRQ: chains the `$0314` vector to `.interruptor` routines | `crt.c` `startup` (region `$0801-$0900`): saves SP, clears BSS (`-dNOBSSCLEAR` skips) and zero-page BSS (`-dNOZPCLEAR`), calls `main` | `.init.010`: `$00 = $2F`, `$01 = $3E` (BASIC off); soft stack from `__stack`; `main`. Default exit loops forever; link `-l:save-basic.o` to save `$02-$8F` and SP and return to BASIC (`$01 = $3F` at exit) |

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
- Write a label file and pass it as `symbolsFile` to `c64_program` `run_prg`/`load_prg`; `c64_memory` (`read`, `write`, `disassemble`) and `c64_debug` (`create_checkpoint`, `wait_for_state`) then accept label names as addresses. Accepted formats: VICE `al C:0810 .name`, `name = $0810` (64tass, ACME; bare digits are decimal), KickAssembler `.label name=$0810`.
- Label file per tool: cc65 `cl65 -Ln build/game.sym` (VICE format); 64tass `-l build/game.sym`; KickAssembler `-symbolfile` (writes `.sym`; format unverified); ACME `-l build/game.sym` (unverified); Oscar64 writes `<name>.lbl` (`al 0801 .startup`, accepted as is); llvm-mos (unverified; check its documentation and convert to one of the formats above if needed).

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
- Kick: `java -jar KickAss.jar src/main.asm -o build/game.prg -symbolfile`. ACME: `acme -f cbm -o build/game.prg src/main.asm`. cc65: `cl65 -t c64 -o build/game.prg src/main.c`. llvm-mos: `mos-c64-clang -Os -o build/game.prg src/main.c`. Oscar64: `oscar64 -O2 -o=build/game.prg src/main.c` (`-d64=build/game.d64` adds a disk image).
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
1. Build on the host, then VICE: `c64_select_backend` `vice`, `run_prg` the PRG with `symbolsFile` (the same call works on Ultimate with `location: "host"`, see step 4). `x64sc` is cycle-exact; use warp mode for long loads; PAL and NTSC models both (`-pal`/`-ntsc`).
2. Assert state: `c64_memory` `read`/`wait_for_text`/`read_screen`; `c64_graphics` `capture_frame` PNG; `c64_input` `joystick`.
3. Debug: `c64_debug` `create_checkpoint` on a label name (`address: "game_loop"`), `wait_for_state` for PC, `get_registers`, `step`. Remove checkpoints before timing runs.
4. Hardware gate (MODERN or authentic release): `c64_select_backend` `c64u`, `run_prg` with `location: "host"` and `symbolsFile` (the host PRG is uploaded, 2 to 65,538 bytes; no device storage needed; `location: "device"` runs a PRG already on device storage such as `/Usb0/`); compare a captured frame with VICE; check raster effects, turbo, SID layout, REU/UCI.
5. VICE gaps for MODERN: no UCI, no turbo, no Ultimate audio, REU DMA costs about 1 cycle per byte (Ultimate rates differ), REU image must match the configured size exactly.
6. Keep a hardware log: firmware/core version, result, frame capture.
7. Do not interrupt another user's running program or flash on a shared device; power operations need explicit user authorisation.

## 7. MODERN packaging: `.cfg` and REU image
A sidecar `.cfg` (same path, extension `.cfg`; for a PRG also `.usr` if there is no `.cfg`) applies settings before the program starts. Applied by file-browser Run/Load of PRG, CRT, "Run Disk" (not "Mount Disk"), G64 and TAP, and by REST `run_prg` / `load_prg` with `file=` (c64_program `run_prg` with `location: "device"`). NOT applied by REST `run_crt`, the upload (host) variants or raw load. Sections or items the machine lacks are skipped; a rejected value is skipped and the valid lines still apply (no popup). Through UCI LOAD_CONFIG the same file is all-or-nothing (status `89`, nothing applied). Settings are RAM only (lost at power cycle). Values are the labels shown by `c64_config get`, matched case-insensitively; check them on the target.
```
[U64 Specific Settings]
Turbo Control=U64 Turbo Registers
CPU Speed=64
[C64 and Cartridge Settings]
RAM Expansion Unit=Enabled
REU Size=16 MB
```
- The public firmware and official docs know only `U64 Turbo Registers` (`Off`, `Manual`, `U64 Turbo Registers`, `TurboEnable Bit`); `C64U Turbo Registers` is reported by one test script, not in source (unverified). `CPU Speed=64` is invalid on U64 / Elite MK1 (max `48`). A second `Turbo Control` line with the other label works from the file browser (the unknown value is skipped) but makes LOAD_CONFIG reject the whole file; always keep the 1 MHz path.
- REU image: `REU Preload=Enabled` and `REU Preload Image=/Usb0/preload.reu` are read at firmware boot only (`c64://ultimate/reu`); games that must work without a reboot load the same file with UCI Control `04 08` (loads `REU Preload Image` at `REU Preload Offset`) or DOS `21` (any file). Build it from level files:
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
