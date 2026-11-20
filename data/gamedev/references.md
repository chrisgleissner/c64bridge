# C64 Game References: Projects, Classic Games, Exemplars

**Summary:** Where to learn from existing code, by target. Part 1 lists Ultimate-specific projects (turbo, REU, UCI, Upic), part 2 stock-C64 games with public analysis, part 3 maps each technique to an exemplar and states what Ultimate games do differently. Facts come from the projects' own READMEs, docs and pages, read on 2026-11-13 and re-checked on 2026-11-20 (licences through the GitHub API and the repositories' LICENSE/README files).
**Read when:** looking for a real implementation to study before writing a technique, or choosing between modern and authentic design.

Read for technique only. Write fresh code: c64bridge is GPL-2.0-only, so do not copy GPL-3.0, "none" or unknown-licence code. Technique recipes are in `c64://gamedev/techniques`; toolchain table in `c64://gamedev/toolchain`.

## 1. Modern Ultimate projects (MODERN target)
| Project, URL | Licence | Ultimate features | Study | Measured |
|---|---|---|---|---|
| Doom C64U, https://github.com/slesinger/doom | CC BY-NC-SA 4.0 (`LICENSE`): read, do not copy | turbo 64 MHz, 16 MB REU, Ultimate Audio PCM, 1351 mouse | REU as data store with tiny resident core, block format (magic, CRC), frame pacing in whole raster frames, hardware-only timing | test map 0.83 fps at 1 MHz, 7.15 at 10 MHz, 16.78 at 24 MHz, 50.1 at 64 MHz (PAL, vsync-locked; `pipeline.md`); E1M1 16.7 fps at 64 MHz (README) |
| xahmol/ultimate-uci-oscar64, https://github.com/xahmol/ultimate-uci-oscar64 | GPL-3.0: read, do not copy | UCI, turbo, Audio DMA, MOD/Heartbeat players, Upic | `docs/TURBOCONTROL_MANUAL.md`, `docs/UPIC_MANUAL.md`, raster-based speed probe | 78 of 179 functions marked untested on hardware (v1.4.0) |
| mandelbrot-upic, https://github.com/xahmol/mandelbrot-upic | GPL-3.0 | turbo 48/64, Upic, palette | per-pixel border-colour renderer, `.upic` format, hardware e2e test | 16 CPU cycles per 2 pixels at 64 MHz |
| heartbeat-demo, https://github.com/xahmol/heartbeat-demo | GPL-3.0 | turbo, 16 MB REU, Audio, UCI | 8 SIDs + 7 PCM channels from one tick IRQ; turbo pays for per-tick modulation | none |
| Order: Omega, https://sedor.itch.io/order-omega | not stated | "Ultimate Elite Edition" for Ultimate 64 Elite and Elite II: Turbo Control `U64 Turbo Registers`, Command Interface, 16 MB REU, Upic pictures (16 colours each) | one EasyFlash cartridge `omega.crt` that runs as the normal C64 edition elsewhere; picture file for the REU | 121 scenes, 94 illustrations |
| c64u-radar, https://github.com/k6lcm/c64u-radar | GPL-3.0 | UCI TCP, REST mailbox | gateway server for TLS/JSON, binary record feed, host test harness with fake 64 KB RAM, build guard on memory block | up to 8 aircraft as hardware sprites; one TCP connection per poll cycle ("~10s", README) |
| ReadyOS, https://github.com/ReadyOS-C64/ReadyOs | MIT | REU suspend/resume, UCI, Ultimate DOS | visible REU-missing state, whole-program stash/fetch, acceptance at 1, 16, 64 MHz | none |
| ultimate-uci-sdk, https://github.com/barryw/ultimate-uci-sdk | MIT | UCI, REU, Audio, network, palette, turbo | capability probing, asm/C/BASIC bindings; status "early" | none |
- Doom E1M1 frame rate by milestone: 25.05 fps flat-shaded (Milestone 1, `IMPLEMENTATION_PLAN.md`, `pipeline.md`), 16.7 fps (59.85 ms) with textures (Milestone 2, README, measured on a C64U at 64 MHz). Rates quantise to 50/25/16.7/12.5 fps (flips on raster frames).
- Also seen: UltimateDemo2026 (https://github.com/xahmol/UltimateDemo2026; start-up screen probes UCI, 16 MB REU, turbo and Ultimate Audio; `config/UltimateDemo2026.cfg` has both `Turbo Control=U64 Turbo Registers` and `Turbo Control=C64U Turbo Registers`, which works only on the sidecar path: `c64://gamedev/toolchain` section 7), Jondalar/UE2-C64U-Emulator (GPL-3.0; Elite II / C64 Ultimate target environment running unmodified firmware, UCI, turbo up to 64 MHz, REU), bbence84/VibeC64 (MIT, AI-powered C64 game creator).
- Official configuration reference: https://1541u-documentation.readthedocs.io. Ultimate game projects with source are rare; libraries and demos above are the best primary documentation. Device facts: `c64://ultimate/hardware`, `c64://ultimate/reu`, `c64://ultimate/uci`, `c64://ultimate/upic`.

## 2. Stock-C64 games (AUTHENTIC target)
| Game (year) | What the source covers | Source |
|---|---|---|
| Uridium (1986) | commented disassembly | https://github.com/mwenge/UridiumFraktion (licence none) |
| Morpheus (1987) | 32 sprites by Y-sorted rows, double-buffered tables, 3-layer starfield | https://codetapper.com/c64/diary-of-a-game/morpheus/mental-procreation-part-1 |
| Boulder Dash (1984) | cave data, random number generator | https://elmerproductions.com/sp/peterb/insideBoulderdash.html |
| Mayhem in Monsterland (1993) | sprite splitting for 15 monsters, 4x4-character level blocks | https://codetapper.com/c64/diary-of-a-game/mayhem-in-monsterland/lets-make-a-monster-part-6 |
| Elite (1985) | multi-part loader, byte-accurate rebuild | https://github.com/markmoxon/elite-source-code-commodore-64 |
| Monty on the Run (1985) | Kick Assembler reconstruction | https://github.com/Dave-Agent/monty-on-the-run (licence none) |
| Hessian (Cadaver) | 24-sprite multiplexer, sprite cache and depacking, memory allocator, NTSC support, NinjaTracker, Exomizer | https://github.com/cadaver/hessian (MIT code, assets not free) |
| Steel Ranger demo (Cadaver) | same engine plus relocatable code chunks | https://github.com/cadaver/steelranger-demo (MIT code) |
| Cadaver game framework | actors every 2nd frame with interpolation, SD2IEC/EasyFlash/GMod2 mastering | https://github.com/cadaver/c64gameframework (MIT, per README) |
| Corescape (2024), Tetris, Tony, SquareDoom | see the next table | below |
Open-source projects used as "Seen in" examples in `c64://gamedev/techniques` (licences from the repositories on 2026-11-13):
| Project, URL | Licence | Study |
|---|---|---|
| Oscar64 (samples hscrollshmup, breakout, lander, maze3d, snake), https://github.com/drmortalwombat/oscar64 | GPL-3.0 | raster IRQ chain library, virtual sprites, memory-map and overlay pragmas, scroll game in C |
| Corescape, https://github.com/drmortalwombat/corescape | GPL-3.0 | complete vertical shooter: parallax, 24 virtual sprites, waves and levels as data |
| Tony: Born for Adventure, https://github.com/maciejmalecki/tony-demo | MIT | flip-screen platformer, Gradle+Kick build, Exomizer parts, VIC bank 3, raster lists |
| Tetris C64, https://github.com/wiebow/tetris.c64 | MIT (README) | one file per state, SID tune at `$1000`, hi-score file I/O |
| SquareDoom, https://github.com/Kweepa/SquareDoom | none stated | per-kilobyte memory map, `$01=$34` play state, IRQ trampolines, disk streaming, ACME |
| Cadaver sprite multiplexer, https://github.com/AlanPBourke/CadaverSpriteMultiplexer ; https://cadaver.github.io/rants/sprite.html | GPL-3.0 | 24-sprite multiplexer, insertion sort, double-buffered table |
| Gridrunner (llamaSource), https://github.com/mwenge/gridrunner | none stated | classic arcade loop, 64tass rebuild checked by md5 |
| CROSS-LIB, https://github.com/Fabrizio-Caruso/CROSS-LIB | README: zlib-style terms, non-commercial use only | portable game logic over platform shims, cc65 |
- Also: Maniac Mansion script engine (https://github.com/pditincho/mm-explained), Lode Runner (https://github.com/Piddewitt/Loderunner).
- Cadaver's articles (https://cadaver.github.io/rants.html): `rants/sprite.html` sprite multiplexing, `rants/scroll.html` multidirectional scrolling and the game world, `rants/interp.html` frameskipping, interpolation and re-entrant IRQ code, `rants/mw4trick.html` Metal Warrior 4 tricks, `rants/sprcache.html` sprite caching, `rants/relocation.html` runtime code relocation, `rants/tilemap.html` tilemap compression.

## 3. Technique, exemplar, where to read
| Technique | Exemplar | Read |
|---|---|---|
| Sprite multiplexing | Morpheus, Hessian, Corescape | Cadaver sprite page; Morpheus diary |
| Zone-split big sprites | Mayhem | Cadaver sprite page; Mayhem diary |
| Split-over-frames char scroll, double buffer | Hessian, Metal Warrior 4 | `rants/scroll.html` |
| Colour-RAM scroll deferral | Metal Warrior 4 | `rants/scroll.html`, `rants/mw4trick.html` |
| Frameskip, interpolation, re-entrant IRQ | Metal Warrior 4, Steel Ranger | `rants/interp.html`; framework README |
| Memory manager, relocatable code chunks | Steel Ranger, Hessian | steelranger-demo README |
| Reproducible rebuild | Elite, Monty, Lode Runner, Gridrunner | their repos |
| REU world, checksummed blocks | Doom C64U, ReadyOS | Doom `docs/reu-format.md` |
| Turbo detect and measure | Doom C64U, mandelbrot-upic | TURBOCONTROL_MANUAL |
| Border-colour per-pixel picture | Upic, Order: Omega | UPIC_MANUAL |
| Hardware-in-the-loop tests | Doom C64U, UltimateDemo2026, ReadyOS | their READMEs |

### What modern Ultimate games do differently
- World in REU, fetched on demand (Doom C64U, ReadyOS); load by UCI or preload, not by disk.
- Turbo is detected and measured against the raster counter; the code accepts a 48 MHz maximum (Ultimate 64 MK1) and waits out the forced 1 MHz window after the `run_prg` reset (2.55-2.57 s measured, `c64://gamedev/techniques` section 10).
- Turbo headroom buys software rendering and rich music engines (Doom, Heartbeat), not hardware tricks.
- Upic (border colour changed per pixel) is used for still pictures (Order: Omega, mandelbrot-upic); it needs turbo registers and the UCI palette commands `04 53`/`04 54` (measured on Ultimate 64 Elite 3.15a). Requirements and limits: `c64://ultimate/upic`.
- PCM from REU through Ultimate Audio next to several SIDs.
- UCI for files and TCP, run as a state machine with one step per frame (`c64://ultimate/uci`).
- The program ships a sidecar `.cfg` that sets turbo and REU (rules: `c64://gamedev/toolchain` section 7), and a normal C64 edition runs where those settings are missing (Order: Omega).
- Timing verified on hardware (frame hash, positive controls, tests at 1/16/64 MHz); VICE only for function.
