# C64 Game Development: Entry Point

**Summary:** Start here when asked to develop a C64 game. Pick a target (MODERN = Ultimate devices, default; AUTHENTIC = stock PAL/NTSC C64), pick a reading plan by game type, load only the listed resources, then iterate with the dev loop below.
Code recipes are in the resources named in the task table below; Ultimate-only facts live in `c64://ultimate/*` and are not repeated here.
**Read when:** the task is "write/port/extend a game" in any language, before reading anything else.

## Target decision
Default MODERN. Switch to AUTHENTIC if the request says authentic, stock, real C64, original hardware, VICE-compatible, cartridge/disk release for any C64, or "no turbo/REU".
State the chosen target in your first reply.

| | MODERN (C64U, Ultimate 64, Elite II) | AUTHENTIC (stock C64, VICE) |
|---|---|---|
| CPU | turbo via `$D031` if enabled by config; probe, never assume | 1 MHz, count cycles |
| RAM | 64 KB + REU up to 16 MB (must be enabled in config) | 64 KB (+ optional REU only if asked) |
| Loading | PRG, D64, CRT, UCI file load, REU preload | PRG/D64/CRT, KERNAL or fastloader |
| SID | C64U: 8 SIDs (UltiSIDs), 10 with real chips in both sockets, placed by config (`c64://ultimate/multisid`); default is one audible set at `$D400` | one SID at `$D400` |
| Extras | UCI, runtime palette, Upic (software hi-colour) | none |
| Forbidden | assuming any feature without detection and fallback message | `$D030/$D031`, UCI, REU, SIDs above `$D400`, turbo-timed loops |
| Test | VICE (logic, REU only) then hardware | VICE `x64sc`, then hardware at 1 MHz |
A stock-C64 version of a MODERN design: drop the detection and `.cfg`, budget 17,783 cycles per PAL frame (`c64://gamedev/architecture` section 3) and about 15,000 on NTSC, one SID, no REU (levels from disk or RAM, `c64://gamedev/architecture` template A or D), 1 MHz timing, test in VICE.

## Reading plan (in order; stop when you have enough)
| Game type | Read |
|---|---|
| Single-screen action (Pac-Man, Space Invaders style) | architecture, techniques (sections 1, 4, 5, 6), `c64://graphics/sprite-charset/best-practices` |
| Scrolling shooter / platformer | architecture, techniques (all), `c64://graphics/vic/spec`, toolchain. MODERN adds `c64://ultimate/hardware` (turbo), `c64://ultimate/reu` (levels), `c64://ultimate/multisid` (music on several SIDs) |
| Puzzle / board / card | architecture (state machine), techniques (input, RNG), `c64://graphics/sprite-charset/best-practices` |
| RPG / adventure, lots of data | architecture (REU and loader sections), toolchain (crunching, REU image), `c64://ultimate/reu`, `c64://ultimate/uci` |
| Hi-colour Upic game | `c64://ultimate/upic`, `c64://ultimate/hardware`, `c64://ultimate/reu`, architecture, toolchain; no hardware sprites |
| Music/sound-heavy | techniques (section 6), `c64://sound/sid/spec`, `c64://sound/sid/file-format`; MODERN adds `c64://ultimate/multisid` (8 SIDs / 24 voices, 10 / 30 with two socket chips) |

## Task finder
| Task | Where |
|---|---|
| Frame loop that plays the same at 1 MHz and turbo; cycle budget per frame | architecture sections 1 and 3 |
| Detect and enable turbo; speed probe | techniques section 10, `c64://ultimate/hardware` |
| Detect REU and its size; load a level from REU to `$4000` | `c64://ultimate/reu` (Recipes, Size detection) |
| Raster IRQ chain, stable raster | techniques section 1 |
| Sprite multiplexer, collision, scrolling, input | techniques sections 2, 4, 3, 5 |
| Music and SFX, several SIDs, NTSC speed | techniques section 6, `c64://ultimate/multisid` |
| Memory map and VIC bank | architecture sections 4 and 5 |
| Build, `.cfg`, REU image, crunch | toolchain |
| Real code to study, licences | references |

## Resource table (KB, bytes/1000)
| URI | Content | KB |
|---|---|---|
| `c64://gamedev/index` | this page | 6.6 |
| `c64://gamedev/architecture` | frame loop, state machine, cycle budgets, memory-map templates | 12.4 |
| `c64://gamedev/techniques` | raster IRQ, multiplexer, scrolling, collision, input, music, RNG, PAL/NTSC, start-up checks | 18.9 |
| `c64://gamedev/toolchain` | assemblers, build, crunchers, test loop, `.cfg` and REU image | 7.5 |
| `c64://gamedev/references` | projects and games to learn from, licences | 10.0 |
| `c64://ultimate/hardware` | turbo, SIDs, video, detection, LEDs, config | 12.9 |
| `c64://ultimate/multisid` | 8-10 SIDs: limit, address map, split, mixer, LOAD_CONFIG, detection | 10.9 |
| `c64://ultimate/reu` | REU registers, recipes, loading paths, streaming | 13.4 |
| `c64://ultimate/uci` | UCI commands, DOS, safe use in a game | 16.3 |
| `c64://ultimate/upic` | Upic technique, framebuffer, palette, limits | 12.0 |
| `c64://ultimate/bench` | benchmark programs and method (measured figures: hardware, reu, architecture) | 13.7 |
| `c64://graphics/vic/spec` | VIC-II registers, banks, bad lines, timing | 16.1 |
| `c64://graphics/sprite-charset/best-practices` | sprites, charsets, tool use | 10.6 |
| `c64://memory/map`, `c64://memory/zero-page-and-workspace` | address map, free zero page | 9.3, 13.0 |
| `c64://io/cia/spec`, `c64://io/spec` | CIA timers, keyboard/joystick; I/O area overview | 9.5, 6.1 |
| `c64://sound/sid/spec`, `.../file-format`, `.../best-practices` | SID registers, PSID header, note tables | 4.9, 4.9, 8.0 |
| `c64://assembly/6510-spec` | opcodes, cycles, addressing | 21.9 |
| `c64://vice/binary-monitor-spec` | VICE debugger protocol (read before c64_debug) | 24.4 |
| `c64://kernal/rom-routines` | KERNAL entry points (load/save, file I/O) | 21.6 |

## Dev loop with c64bridge
1. Choose backend: `c64_select_backend` (`vice` for fast logic/debug, `c64u` for turbo, UCI, Upic, real timing, REU preload).
2. Small code: `c64_program` `upload_run_asm` (built-in assembler, basic directives only: `* =`, `.byte`, `.word`, `.text`, `.fill`, `.align`). Larger projects: build a PRG with an external assembler (see toolchain), then `c64_program` `run_prg` (path must be host-local on VICE, device-visible on Ultimate devices) or `run_crt`.
3. Verify: `c64_memory` `read_screen`, `wait_for_text`, `read`; `c64_graphics` `capture_frame` (`format: "png"`) for screenshots; `c64_input` `joystick`/`key` to drive the game.
4. Debug (VICE only): `c64_debug` `create_checkpoint` (breakpoint), `wait_for_state`, `get_registers`, `step`. Read `c64://vice/binary-monitor-spec` first.
5. Hardware-only checks: turbo, UCI, Upic, SID layout, REU timing (VICE REU DMA timing differs from the Ultimate), real raster stability. Do not accept VICE timing for modern targets.
6. Capture a frame after every hardware run.
