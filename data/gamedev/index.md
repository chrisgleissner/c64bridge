# C64 Game Development: Entry Point

**Summary:** Start here when asked to develop a C64 game. Pick a target (MODERN = Ultimate devices, default; AUTHENTIC = stock PAL/NTSC C64), pick a reading plan by game type, load only the listed resources, then iterate with the dev loop below.
Architecture, techniques and toolchain are separate resources; Ultimate-only facts live in `c64://ultimate/*` and are never repeated here.
**Read when:** the task is "write/port/extend a game" in any language, before reading anything else.

## Target decision
Default MODERN. Switch to AUTHENTIC if the request says authentic, stock, real C64, original hardware, VICE-compatible, cartridge/disk release for any C64, or "no turbo/REU".
State the chosen target in your first reply.

| | MODERN (C64U, Ultimate 64, Elite II) | AUTHENTIC (stock C64, VICE) |
|---|---|---|
| CPU | turbo via `$D031` if enabled by config; probe, never assume | 1 MHz, count cycles |
| RAM | 64 KB + REU up to 16 MB (must be enabled in config) | 64 KB (+ optional REU only if asked) |
| Loading | PRG, D64, CRT, UCI file load, REU preload | PRG/D64/CRT, KERNAL or fastloader |
| SID | several, address-mapped; stereo not guaranteed | one SID at `$D400` |
| Extras | UCI, runtime palette, Upic (software hi-colour) | none |
| Forbidden | assuming any feature without detection and fallback message | `$D030/$D031`, UCI, REU, `$D420` SID, turbo-timed loops |
| Test | VICE (logic, REU only) then hardware | VICE `x64sc`, then hardware at 1 MHz |

## Reading plan (in order; stop when you have enough)
| Game type | Read |
|---|---|
| Single-screen action (Pac-Man, Space Invaders style) | architecture, techniques (IRQ, input, collision, sound), `c64://graphics/sprite-charset/best-practices` |
| Scrolling shooter / platformer | architecture, techniques (all), `c64://graphics/vic/spec`, toolchain; MODERN adds `c64://ultimate/reu` |
| Puzzle / board / card | architecture (state machine), techniques (input, RNG), `c64://graphics/sprite-charset/best-practices` |
| RPG / adventure, lots of data | architecture (REU and loader sections), toolchain (crunching), `c64://ultimate/reu`, `c64://ultimate/uci` |
| Hi-colour Upic game | `c64://ultimate/upic`, `c64://ultimate/hardware`, `c64://ultimate/reu`, architecture, toolchain; no hardware sprites |
| Music/sound-heavy | techniques (music), `c64://sound/sid/spec`, `c64://sound/sid/file-format` |

## Resource table (KB, decimal; other rows approximate)
| URI | Content | KB |
|---|---|---|
| `c64://gamedev/index` | this page | 4.9 |
| `c64://gamedev/architecture` | frame loop, state machine, cycle budgets, memory-map templates | 10.3 |
| `c64://gamedev/techniques` | raster IRQ, multiplexer, scrolling, collision, input, music, RNG, PAL/NTSC | 16.0 |
| `c64://gamedev/toolchain` | assemblers, build, crunchers, test loop, games to study | 8.0 |
| `c64://gamedev/references` | Games to learn from | 8.9 |
| `c64://ultimate/hardware` | turbo, SIDs, video, detection, config | 11.9 |
| `c64://ultimate/reu` | REU registers, loading paths, streaming | 12.0 |
| `c64://ultimate/uci` | UCI commands, DOS, safe use in a game | 16.0 |
| `c64://ultimate/upic` | Upic technique, framebuffer, palette, limits | 11.7 |
| `c64://graphics/vic/spec` | VIC-II registers, banks, bad lines, timing | 16 |
| `c64://graphics/sprite-charset/best-practices` | sprites, charsets, tool use | 11 |
| `c64://memory/map`, `c64://memory/zero-page-and-workspace` | address map, free zero page | 9, 13 |
| `c64://io/cia/spec` | CIA timers, keyboard/joystick | 9 |
| `c64://io/spec` | I/O area overview | 6 |
| `c64://sound/sid/spec`, `.../file-format`, `.../best-practices` | SID registers, PSID header, note tables | 5, 5, 8 |
| `c64://assembly/6510-spec` | opcodes, cycles, addressing | 22 |
| `c64://vice/binary-monitor-spec` | VICE debugger protocol (read before c64_debug) | 24 |
| `c64://kernal/rom-routines` | KERNAL entry points (load/save, file I/O) | 22 |

## Dev loop with c64bridge
1. Choose backend: `c64_select_backend` (`vice` for fast logic/debug, `c64u` for turbo, UCI, Upic, real timing, REU preload).
2. Small code: `c64_program` `upload_run_asm` (built-in assembler, basic directives only: `* =`, `.byte`, `.word`, `.text`, `.fill`, `.align`). Larger projects: build a PRG with an external assembler (see toolchain), then `c64_program` `run_prg` (path must be host-local on VICE, device-visible on Ultimate devices) or `run_crt`.
3. Verify: `c64_memory` `read_screen`, `wait_for_text`, `read`; `c64_graphics` `capture_frame` (`format: "png"`) for screenshots; `c64_input` `joystick`/`key` to drive the game.
4. Debug (VICE only): `c64_debug` `create_checkpoint` (breakpoint), `wait_for_state`, `get_registers`, `step`. Read `c64://vice/binary-monitor-spec` first.
5. Hardware-only checks: turbo, UCI, Upic, SID layout, REU timing (VICE REU DMA timing differs from the Ultimate), real raster stability. Do not accept VICE timing for modern targets.
6. Capture a frame after every hardware run.
