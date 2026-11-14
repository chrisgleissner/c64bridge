# C64 Game References: Projects, Classic Games, Exemplars

**Summary:** Where to learn from existing code, by target. Part 1 lists Ultimate-specific projects (turbo, REU, UCI, Upic), part 2 stock-C64 games with public analysis, part 3 maps each technique to an exemplar and states what Ultimate games do differently. Facts come from READMEs and docs read on 2026-11-13 unless marked "(unverified)" (secondary or single source).
**Read when:** looking for a real implementation to study before writing a technique, or choosing between modern and authentic design.

Read for technique only. Write fresh code: c64bridge is GPL-2.0-only, so do not copy GPL-3.0, "none" or unknown-licence code. Technique recipes are in `c64://gamedev/techniques`; toolchain table in `c64://gamedev/toolchain`.

## 1. Modern Ultimate projects (MODERN target)
| Project, URL | Licence | Ultimate features | Study | Measured |
|---|---|---|---|---|
| Doom C64U, https://github.com/slesinger/doom | "other": read `LICENSE` | turbo 64 MHz, 16 MB REU, Ultimate Audio PCM, 1351 mouse | REU as data store with tiny resident core, block format (magic, CRC), frame pacing in whole raster frames, hardware-only timing | test map 0.83 fps at 1 MHz, 7.15 at 10 MHz, 16.78 at 24 MHz, 50.1 at 64 MHz (PAL, 1.1.0, vsync-locked); E1M1 25.05 fps (unverified, see below) |
| xahmol/ultimate-uci-oscar64, https://github.com/xahmol/ultimate-uci-oscar64 | GPL-3.0: read, do not copy | UCI, turbo, Audio DMA, MOD/Heartbeat players, Upic | `docs/TURBOCONTROL_MANUAL.md`, `docs/UPIC_MANUAL.md`, raster-based speed probe | 78 of 179 functions marked untested on hardware (v1.4.0) |
| mandelbrot-upic, https://github.com/xahmol/mandelbrot-upic | GPL-3.0 | turbo 48/64, Upic, palette | per-pixel border-colour renderer, `.upic` format, hardware e2e test | 16 CPU cycles per 2 pixels at 64 MHz |
| heartbeat-demo, https://github.com/xahmol/heartbeat-demo | GPL-3.0 | turbo, 16 MB REU, Audio, UCI | 8 SIDs + 7 PCM channels from one tick IRQ; turbo pays for per-tick modulation | none |
| Order: Omega Elite Edition, https://sedor.itch.io/order-omega | not stated | turbo regs, UCI, 16 MB REU picture file, Upic | normal and Elite edition from one engine; pictures preloaded from `.reu`; EasyFlash cartridge | 121 scenes, 94 pictures |
| c64u-radar, https://github.com/k6lcm/c64u-radar | GPL-3.0 | UCI TCP, REST mailbox | gateway server for TLS/JSON, binary record feed, host test harness with fake 64 KB RAM, build guard on memory block | 8 sprites, poll about 10 s |
| ReadyOS, https://github.com/ReadyOS-C64/ReadyOs | MIT | REU suspend/resume, UCI, Ultimate DOS | visible REU-missing state, whole-program stash/fetch, acceptance at 1, 16, 64 MHz | none |
| ultimate-uci-sdk, https://github.com/barryw/ultimate-uci-sdk | MIT | UCI, REU, Audio, network, palette, turbo | capability probing, asm/C/BASIC bindings; status "early" | none |
- Doom frame rate is disputed: README and a press article say 16.7 fps for E1M1, `pipeline.md` 25.05 fps (502 frames in 20.04 s); HEAD value unverified. Rates quantise to 50/25/16.7/12.5 fps (flips on raster frames).
- Also seen: UltimateDemo2026 (https://github.com/xahmol/UltimateDemo2026, start-up detection screen, one `.cfg` naming both Turbo Control values), UE2-C64U-Emulator (GPL-3.0, UCI tests without hardware), GordonOS binaries (derive time from CIA/raster, not CPU speed), Mappy REU port (1 MB REU overlays, article only, unverified); Carrion's "C64 Ultimate Game Engine" (Oscar64, 16 virtual sprites, 16 MB REU, about 2 MB PCM; no repo, press only, unverified); bbence84/VibeC64 (MIT, AI game creator, prior art for LLM-built games).
- Official configuration reference: https://1541u-documentation.readthedocs.io. Ultimate game projects with source are rare; libraries and demos above are the best primary documentation. Device facts: `c64://ultimate/hardware`, `c64://ultimate/reu`, `c64://ultimate/uci`, `c64://ultimate/upic`.

## 2. Stock-C64 games (AUTHENTIC target)
| Game (year) | Zzap!64 | Known for | Best source |
|---|---|---|---|
| Uridium (1986) | 94% | fake parallax: star chars shift against scroll | https://github.com/mwenge/UridiumFraktion (commented analysis, licence none) |
| Morpheus (1987) | n/a | 32 sprites by Y-sorted rows, double-buffered tables, 3-layer starfield | https://codetapper.com/c64/diary-of-a-game/morpheus/mental-procreation-part-1 |
| Turrican (1990) | 97% Gold Medal | centred 8-direction scroll, zone-split boss sprites | https://codebase64.net/doku.php?id=base:rant4 ; https://cadaver.github.io/rants/sprite.html |
| The Last Ninja (1987) | 94% | isometric path-restricted movement, flip screens | generationamiga.com scrolling article (2026-01-29) |
| Boulder Dash (1984) | n/a | compact cave data, documented RNG | https://elmerproductions.com/sp/peterb/insideBoulderdash.html (snippet only) |
| Mayhem in Monsterland (1993) | n/a | sprite splitting for 15 monsters, 4x4-char level blocks | https://codetapper.com/c64/diary-of-a-game/mayhem-in-monsterland/lets-make-a-monster-part-6 |
| Elite (1985) | n/a | multi-part loader, byte-accurate rebuild | https://github.com/markmoxon/elite-source-code-commodore-64 |
| Monty on the Run (1985) | n/a | full Kick Assembler reconstruction | https://github.com/Dave-Agent/monty-on-the-run (licence none) |
| Hessian (Cadaver) | n/a | 24-sprite mux, sprite cache and depacking, memory allocator, 50 Hz with NTSC support, NinjaTracker, Exomizer | https://github.com/cadaver/hessian (MIT code, assets not free) |
| Steel Ranger demo (Cadaver) | n/a | same engine plus relocatable code chunks | https://github.com/cadaver/steelranger-demo (MIT code) |
| Cadaver game framework | n/a | actors every 2nd frame with interpolation, colour per char/block, SD2IEC/EasyFlash/GMod2 mastering | https://github.com/cadaver/c64gameframework (MIT, per README) |
| Corescape (2024), Tetris, Tony, SquareDoom | n/a | see toolchain table | `c64://gamedev/toolchain` |
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
| CROSS-LIB, https://github.com/Fabrizio-Caruso/CROSS-LIB | none stated | portable game logic over platform shims, cc65 |
- Also: Paradroid (97%), Wizball (96% Sizzler), Maniac Mansion (https://github.com/pditincho/mm-explained script engine), Lode Runner (https://github.com/Piddewitt/Loderunner). No public source found for Turrican, Wizball, IK+, Armalyte, Last Ninja, Impossible Mission.
- Codebase64 pages (`https://codebase64.net/doku.php?id=<id>`): `base:rant4` scrolling and world, `base:rant9` frameskip/interpolation, `base:rant11` Metal Warrior 4 tricks, `base:4_ways_scroll`, `base:decoding_tile_based_maps`, `base:sprite_collision_detection`, `base:simple_parallax_shifting`, `base:high_score_detection`.

## 3. Technique, exemplar, where to read
| Technique | Exemplar | Read |
|---|---|---|
| Sprite multiplexing | Morpheus, Hessian, Corescape | Cadaver sprite page; Morpheus diary |
| Zone-split big sprites | Turrican boss, Mayhem | Cadaver sprite page; Mayhem diary |
| Split-over-frames char scroll, double buffer | Hessian, Metal Warrior 4 | `base:rant4`, `base:4_ways_scroll` |
| Colour-RAM scroll deferral | Metal Warrior 4 | `base:rant4`, `base:rant11` |
| Frameskip, interpolation, re-entrant IRQ | Metal Warrior 4, Steel Ranger | `base:rant9`; framework README |
| Memory manager, relocatable code chunks | Steel Ranger, Hessian | steelranger-demo README |
| Reproducible rebuild | Elite, Monty, Lode Runner, Gridrunner | their repos |
| REU world, checksummed blocks | Doom C64U, ReadyOS | Doom `docs/reu-format.md` |
| Turbo detect and measure | Doom C64U, mandelbrot-upic | TURBOCONTROL_MANUAL |
| Border-colour per-pixel picture | Upic, Order: Omega | UPIC_MANUAL |
| Hardware-in-the-loop tests | Doom C64U, UltimateDemo2026, ReadyOS | their READMEs |

### What modern Ultimate games do differently
- World in REU, fetched on demand (Doom C64U, ReadyOS); load by UCI or preload, not by disk.
- Turbo is detected, measured against the raster counter, and tolerates 48 MHz machines and the about 2 s forced 1 MHz window after reset.
- Turbo headroom buys software rendering and rich music engines (Doom, Heartbeat), not hardware tricks.
- Upic (border-colour per-pixel) suits stills and adventure graphics, not scrolling action; needs PAL, turbo registers, palette UCI (firmware 3.15 or later; older C64U firmware lacks it, unverified).
- PCM from REU through Ultimate Audio next to several SIDs.
- UCI for files and TCP; never wait on it inside a frame (palette writes measured at tens of ms).
- Program ships a `.cfg` that sets turbo and REU, listing both Turbo Control value names; normal edition plus Elite edition as fallback.
- Timing verified on hardware (frame hash, positive controls, tests at 1/16/64 MHz); VICE only for function.
