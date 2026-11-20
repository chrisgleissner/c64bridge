# C64 Game Toolchain, Build, Test and Reference Games

**Summary:** Pick one assembler or compiler, keep every address in one include file, build PRG/D64/CRT with a Makefile, pack with Exomizer, test in VICE first and on hardware second through c64bridge. MODERN releases add a `.cfg` and an REU image.
**Read when:** setting up a game project, choosing a language, producing release files (PRG, D64, CRT, `.cfg`, `.reu`).

Sources: the tools' own files (versions named per row), firmware `1541ultimate@700c7f2fa` (GideonZ/1541ultimate master, 2026-11-13; paths below `software/`), VICE 3.10 source, and measurements on an Ultimate 64 Elite, firmware 3.15a, 2026-11-20.

## 1. Assemblers and compilers
| Tool | Language | Trade-off | Source |
|---|---|---|---|
| KickAssembler 5.25 | asm + script language | macros, segments, `.errorif`, `LoadSid()`, `BasicUpstart2`; runs on Java; distributed as a jar | https://theweb.dk/KickAssembler |
| ACME | asm | macros, no script language; `-f cbm` writes a PRG with load address | https://sourceforge.net/projects/acme-crossass/ |
| 64tass 1.60 | asm | macros, `-l` label file, `-L` listing | https://tass64.sourceforge.net |
| ca65/cc65 | asm + C | linker configurations per target (`cfg/c64.cfg`) | https://cc65.github.io |
| Oscar64 (GPL-3.0) | C/C++ | C64 libraries in `include/c64`: `rasterirq.h` (IRQ chain), `sprites.h` (`vspr_*` virtual sprites), `memmap.h`, `reu.h`, `joystick.h`; overlays. Declare hardware registers and variables shared with interrupts `volatile`, a `$01` bank switch `volatile __memmap`; `__asm volatile {}` stops the optimiser changing that block (`oscar64.md` "volatile", "inline assembler") | https://github.com/drmortalwombat/oscar64 |
| llvm-mos | C/C++ (LLVM) | `mos-c64-clang`; writes an ELF file beside the PRG (README example `hello.elf`) | https://github.com/llvm-mos/llvm-mos-sdk |
| c64bridge `upload_run_asm` | asm subset | no installation; directives `* =`, `.byte`, `.word`, `.text`, `.fill`, `.align`; no macros or segments | built in |
Write IRQ chains, the multiplexer, the scroll copy and the music call in assembly; game logic may be assembly or C. Pin tool versions in the build. KickAssembler is a separate download: read its licence before bundling the jar.

### C compiler runtime facts (cc65, Oscar64, llvm-mos)
Read from each project's own files (cc65 `eebf54a`: `doc/cc65-intern.sgml`, `doc/c64.sgml`, `cfg/c64.cfg`, `libsrc/c64/crt0.s`, `libsrc/runtime/zeropage.s`; Oscar64 `08b01c9`: `oscar64.md`, `include/crt.c`; llvm-mos-sdk `555253f`: `mos-platform/c64/link.ld`, `c64/clang.cfg`, `commodore/commodore.ld`, `commodore/save-basic.S`; llvm-mos `ae72e49`: `MOSCallingConv.td`). Re-check after a version change.
| | cc65 (`-t c64`) | Oscar64 (`.prg` target) | llvm-mos (`mos-c64-clang`) |
|---|---|---|---|
| Zero page | Runtime uses `$02-$1B` (26 bytes: `c_sp`, `sreg`, `regsave`, `ptr1-4`, `tmp1-4`, 6-byte `regbank`), the whole `ZP` area of `c64.cfg`; extra `.zeropage` data needs a `.cfg` with a larger `ZP` | `$02` Y spill, `$03-$0C` mul/div/float work, `$0D-$1A` leaf-function arguments, `$1B-$1E` accumulator, `$1F-$22` pointers, `$23-$24` stack pointer, `$25-$26` frame pointer, `$43-$52` caller-saved, `$53-$8F` callee-saved (manual: "not yet final"). `__zeropage` globals go to region `zeropage`, `$00F7-$00FF` by default and `$0080-$00FF` with `-xz` (`oscar64/Compiler.cpp:575-582`); they are not initialised. `-xz`: more zero page, no return to BASIC | Imaginary registers `__rc0-__rc31` at `$02-$21`; zero-page variables `$22-$8F` (`-mlto-zp=110`); `$90-$FF` (KERNAL) untouched |
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
- Label file per tool (each output format checked against `src/tools/translation/symbolRegistry.ts`): cc65 `cl65 -Ln build/game.sym` (VICE format); 64tass 1.60 `-l build/game.sym` (lines `start\t\t= $0810`); KickAssembler 5.25 `-symbolfile` (writes `<source>.sym`, lines `.label start=$810`); ACME `--vicelabels build/game.sym` (lines `al C:0810 .start`, ACME `src/symbol.c`; its `-l` list adds `+2`/`+3` suffixes and `!addr` prefixes that the parser skips); Oscar64 writes `<name>.lbl` (`al 0801 .startup`); llvm-mos writes no label file: convert the ELF with `llvm-nm game.elf | awk '{print $3 " = $" substr($1,5)}'`.

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
- Exomizer (`exo20info.txt`, `exo31info.txt`): `sfx sys` makes a self-decrunching PRG that jumps to the address of the `SYS` line it finds at the BASIC start; `mem -l none part.bin@0xADDR -o part.exo` writes plain crunched data (no load address) for the in-game decruncher `exodecrs/exodecrunch.s` (decrunches backwards by default).
- BASIC start stub at `$0801`: `10 SYS 2064` bytes `0B 08 0A 00 9E 32 30 36 34 00 00 00`; code starts at `$0810`. Kick: `BasicUpstart2(start)`.

## 4. Formats and packaging
| Output | How | Notes |
|---|---|---|
| `.prg` | assembler output | 2-byte load address first; runs on all targets |
| `.d64` | `c1541` (VICE) or `cc1541 -f game -w game.prg game.d64` (cc1541 README; MIT; also sets sector interleave with `-s`) | one file for a single-part game; multipart needs a loader |
| `.crt` | `cartconv -t <type> -i game.bin -o game.crt` (VICE 3.10; `cartconv --types` lists the types, for example Magic Desk and EasyFlash) | MODERN: cartridges that use `$DF00-$DFFF` collide with the REU registers at `$DF00` (`c64://ultimate/reu`) |
| `.sid` | tracker export | input for the player, not an output |
- Loaders: KERNAL `LOAD` (`$FFD5`) needs the KERNAL ROM and I/O banked in (`$01` = `$36` or `$37`); a fastloader (for example Krill's) replaces it for real or emulated drives, per its own documentation. On Ultimate devices, UCI file reads and REU loads bypass the serial bus (`c64://ultimate/uci`, `c64://ultimate/reu`). Disk handling from the bridge: `c64_disk`, `c64_drive`.
- Release set: `.prg` + `.d64` (+ `.crt`), `.cfg` and `.reu` for MODERN (section 7), checksums, README naming target and Ultimate settings.

## 5. Asset tools
CharPad (charsets, maps), SpritePad (sprites), GoatTracker or SID-Wizard (music, `.sid` export), Python scripts (PNG to charset/tiles, TMX to map bytes). Convert at build time; commit sources.

## 6. Test loop with c64bridge
1. Build on the host, then VICE: `c64_select_backend` `vice`, `run_prg` the PRG with `symbolsFile` (the same call works on Ultimate with `location: "host"`, see step 4). Use `x64sc` (the cycle-based C64 emulator), `-warp` for long loads, and test both video standards with `-pal` and `-ntsc` (VICE 3.10 `doc/vice.texi`).
2. Assert state: `c64_memory` `read`/`wait_for_text`/`read_screen`; `c64_graphics` `capture_frame` PNG; `c64_input` `joystick`.
3. Debug: `c64_debug` `create_checkpoint` on a label name (`address: "game_loop"`), `wait_for_state` for PC, `get_registers`, `step`. Remove checkpoints before timing runs.
4. Hardware gate (MODERN or authentic release): `c64_select_backend` `c64u`, `run_prg` with `location: "host"` and `symbolsFile` (the host PRG is uploaded, 2 to 65,538 bytes; no device storage needed; `location: "device"` runs a PRG already on device storage such as `/Usb0/`); compare a captured frame with VICE; check raster effects, turbo, SID layout, REU/UCI.
5. VICE gaps for MODERN: no UCI, no turbo (`$D030`/`$D031` are unused VIC-II addresses and read `$FF`, Bauer 3.2), no Ultimate Audio. VICE REU DMA moves one byte per CPU cycle plus VIC stalls (`src/c64/cart/reu.c:819-849`); Ultimate rates at turbo speeds are in `c64://ultimate/reu`. VICE loads an REU image (`-reuimage`) only when the file size equals `-reusize` exactly; otherwise it logs "Reading REU image ... failed" and starts with an empty REU (`src/util.c:373`, `reu.c:694`).
6. Keep a hardware log per run: product, firmware and core version (`GET /v1/info`), result, captured frame.
7. Do not interrupt another user's running program or flash on a shared device; power operations need explicit user authorisation.

## 7. MODERN packaging: `.cfg` and REU image
A sidecar `.cfg` has the program's file name with the extension `.cfg`, in the same directory. Firmware `1541ultimate@700c7f2fa` loads it as follows:

| Start path | Sidecar applied | Source |
|---|---|---|
| File browser Run or Load of a PRG; `.usr` of the same name when there is no `.cfg` | yes | `filetypes/filetype_prg.cc:164-168` |
| REST `PUT runners:run_prg` / `load_prg` with `file=` (c64_program `run_prg`, `location: "device"`) | yes | `filetype_prg.cc:188-190`; measured |
| File browser CRT start; TAP Run; D64/D81/G64 "Run Disk" | yes | `filetype_crt.cc:72`, `filetype_tap.cc:235`, `filetype_d64.cc:118`, `filetype_g64.cc:87` |
| "Mount Disk"; REST `run_crt`; any host upload (POST, `location: "host"`, stored as `upload.prg`) | no | measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20 |

File format (`userinterface/configio.cc:230-440`): `[Store Name]` starts a section; `Item=value` lines; `#` or `;` starts a comment; at most 319 characters per line. Store and item names match case-insensitively; a store also matches its alternate name, so `[U64 Specific Settings]` and `[C64U Specific Settings]` are the same store (`components/config.cc:196-207`, `u64/u64_config.cc:948`). An enum value matches one label of the item case-insensitively, ignoring leading and trailing spaces, and without the unit: `CPU Speed=48`, not `48 MHz`.

| Line | Result |
|---|---|
| Section the machine does not have, or item the store does not have | line skipped, not an error |
| Enum value not in the item's list, number that does not parse, no `=`, item outside a section | line skipped, error |
| Valid line | value changed in RAM and marked unsaved; it reaches flash only when the user leaves the configuration menu with `Auto Save Config` = `Yes`, or `Ask` and answers Yes (`userinterface/config_menu.cc:169-200`); otherwise a power cycle restores the flash values |

What an error does depends on the path:
- Sidecar and file browser: every valid line takes effect even when other lines are errors; a sidecar load shows no message (`configio.cc:436-506`).
- UCI `LOAD_CONFIG` (`04 50 <path>`): valid lines change the stored values, but when any line is an error no store is effectuated, so nothing takes effect until a later successful load. Status `89,CONFIG FILE HAD ERRORS`, data `Line 3: Value 'BOGUS' is not a valid choice for item Vol Drive 2`; success `00,OK`; missing file `88,CANNOT OPEN CONFIG FILE` (`io/command_interface/control_target.cc:559-610`; status texts measured). Details: `c64://ultimate/uci`.

```
[U64 Specific Settings]
Turbo Control=U64 Turbo Registers
CPU Speed=48
[C64 and Cartridge Settings]
RAM Expansion Unit=Enabled
REU Size=16 MB
```
Accepted values in `1541ultimate@700c7f2fa` (`u64/u64_config.cc:324-394`, `io/c64/c64.cc:61-95`):

| Item | Ultimate 64 / Elite (MK1) | Ultimate 64 Elite II |
|---|---|---|
| `Turbo Control` | `Off`, `Manual`, `U64 Turbo Registers`, `TurboEnable Bit` | same |
| `CPU Speed` (index 0-15) | 1 2 3 4 5 6 8 10 12 14 16 20 24 32 40 48 | 1 2 3 4 6 8 10 12 14 16 20 24 32 40 48 64 |
| `RAM Expansion Unit` | `Disabled`, `Enabled`, `GeoRAM Mode` | same |
| `REU Size` | `128 KB` ... `16 MB` (8 steps) | same |

Rules for a game `.cfg`:
- Write only values from this table. `CPU Speed=48` is valid on both products; `64` is an error on MK1. A second `Turbo Control` line with a label the firmware lacks (for example `C64U Turbo Registers`) is an error: the sidecar path skips it and keeps the valid line, `LOAD_CONFIG` applies nothing.
- The same index means different speeds: index 4 is 5 MHz on MK1 and 6 MHz on Elite II. Choose by label in the `.cfg`; read the speed at run time (`c64://gamedev/techniques` section 10).
- Keep the 1 MHz path: the `.cfg` is not applied on the paths marked "no" above, and a game started that way runs with the user's settings.
- REU image: when `REU Preload` is `Enabled` at firmware start, the firmware loads `REU Preload Image` (default `/Usb0/preload.reu`) once, when that volume is mounted, at `REU Preload Offset`, up to the REU size (`io/c64/reu_preloader.cc:14-115`). A game that must not depend on that loads the file itself: UCI commands and recipes in `c64://ultimate/reu`. Build the image from level files:
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

## Not verified
- `Turbo Control` labels on the C64 Ultimate. Public firmware has no C64 Ultimate build (`system/product.cc:91-104`), so its value list cannot be read from source. UltimateDemo2026 (`config/UltimateDemo2026.cfg`) ships both `Turbo Control=U64 Turbo Registers` and `Turbo Control=C64U Turbo Registers`. Settles it: `GET /v1/configs/C64U%20Specific%20Settings/Turbo%20Control` on a C64 Ultimate. Until then a `.cfg` for `LOAD_CONFIG` on a C64 Ultimate cannot be written error-free for both products in one file.
