# Ultimate Devices: Hardware Features Visible to a C64 Program

**Summary:** Ultimate 64 (U64), Elite (MK1), Elite II and C64 Ultimate (C64U) add a CPU turbo, several SIDs, an REU, a command interface (UCI) and a runtime palette, all absent in VICE and on a stock C64: detect, then fall back. Upic is a software technique, not hardware (c64://ultimate/upic). Ultimate II/II+/II+L (U2) share REU/UCI/ACIA I/O but have no turbo, UltiSID or palette commands.
**Read when:** designing or detecting turbo, SID layout, REU/UCI, model-dependent code, Ultimate-only game features.

Marks: "(unverified)" = secondary or inferred; "measured" = 2026-11-13, Ultimate 64 Elite fw 3.15a, C64U fw 1.2.1, PAL. Firmware dates: entry into the public master; released firmware may be older, so probe, not version-check. Docs: 1541u-documentation.readthedocs.io; firmware: GideonZ/1541ultimate.

## Models

| | U64 / U64 Elite (MK1) | U64 Elite II | C64U |
|---|---|---|---|
| FPGA | Cyclone V | Artix-7 | Artix-7 |
| Turbo top speed | 48 MHz | 64 MHz | 64 MHz (measured) |
| Turbo Control value for registers | `U64 Turbo Registers` | `U64 Turbo Registers` | `C64U Turbo Registers` (config dumps; public source: U64 name only) |
| Internal speaker | yes | no | no |
| Programmatic LED (`$D2xx`/`$D3xx`) | no | yes (2026-05) | yes, fw 1.2.1 (measured) |

- PAL and NTSC both exist (`System Mode`): detect with the raster counter (63 vs 65 cycles/line, 312 vs 263 lines; c64://graphics/vic/spec).

## Turbo (CPU speed)

Configuration (category "U64 Specific Settings"; `c64_config` only, not a program):

| Item | Values | Default |
|---|---|---|
| `Turbo Control` (value names differ by model/firmware; read with `c64_config`) | `Off`, `Manual`, `U64 Turbo Registers` / `C64U Turbo Registers`, `TurboEnable Bit` | Off |
| `CPU Speed` | 16 entries, strings space-padded (`" 1"`, `" 6"`, `"10"`) | 1 MHz |
| `Badline Timing` | Disabled / Enabled | Enabled |
| `SuperCPU Detect (D0BC)` | Disabled / Enabled | Disabled |

| Turbo Control | Effect |
|---|---|
| Off | `$D030`/`$D031` read `$FF`; 1 MHz |
| Manual | `CPU Speed`; registers cannot change it, read `$FF` |
| Turbo Registers | `CPU Speed` default; `$D031`, `$D07A`/`$D07B` can change it |
| TurboEnable Bit | As Registers, plus `$D030` bit 0 (0 = 1 MHz with badlines, 1 = menu speed) |

Registers (VIC-II space; `$FF` when unavailable, also on stock C64 and VICE):

| Addr | Use |
|---|---|
| `$D031` | bits 3-0 speed index; bit 7 = 1 suppresses badline and sprite CPU stalls, 0 = stock timing (measured). Bits 4-6: write 0, no readback reliance. Read back after writing. |
| `$D030` | bit 0 enable (TurboEnable Bit mode only) |
| `$D07A` / `$D07B` | SuperCPU soft switches, write-only: normal / turbo (menu speed) |
| `$D0BC` | SuperCPU detect, read-only, if `SuperCPU Detect` enabled |

Speed index to MHz (only 0-3 portable; 15 = hardware maximum on every model; 64 MHz table public since 2025-05):
Index: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
- U64/Elite: 1 2 3 4 5 6 8 10 12 14 16 20 24 32 40 48
- Elite II/C64U: 1 2 3 4 6 8 10 12 14 16 20 24 32 40 48 64

Code: `lda $d031 / cmp #$ff / beq no_turbo` (off, manual or not an Ultimate); `lda #$0f / sta $d031` = top speed, normal badlines (`$8f` = stalls off); `lda #0 / sta $d031` = 1 MHz.

Timing facts:
- CPU and memory run at 48/64 MHz; the index sets how many sub-slots per phi2 the CPU gets. VIC-II keeps priority, so graphics stay correct. CIA, VIC raster and SID stay in C64 time.
- Measured (PAL, screen blanked, RAM loop; rerun: c64://ultimate/hardware#rerun): the CPU gets the setting minus one VIC sub-slot at the top entries: 47 cycles per phi2 at 48 MHz (2,961/line), 63 at 64 MHz (3,969/line); exact to 32 MHz. Cycles per PAL frame at 48 / 64 MHz: blanked 923,875 / 1,238,387; screen on 873,784 / 1,170,907; plus 8 double-height sprites 836,375 / 1,121,520. At 1 MHz: 19,656 / 18,575 / 17,783. Badlines cost 5.5% at every speed, 8 sprites 4.1% more. With `$D031` bit 7 set the screen-on loss is below 0.2%. `Badline Timing` had no effect in registers mode.
- I/O is slower than RAM at high speed: `lda $D012` gives 42 of 47 at 48 MHz, 56.5 of 63 at 64 MHz; `sta $D020` runs at RAM speed; a CIA read loop is capped near 8.8 (7.5 at 8-12 MHz). `sta abs,x` to I/O does a dummy read (extra cost).
- External bus accesses (cartridge port, real SID sockets) go through a 1 MHz bridge and wait for BA high; UltiSID writes are internal and fast.
- IEC bit-banging and 1 MHz cycle-counted raster tricks break under turbo.
- Forced 1 MHz window: after `run_prg` reset a `$D031` request took effect 2.55 s (Elite 3.15a), 2.57 s (C64U 1.2.1) after program start (measured); can recur briefly with IEC activity; wait before timing-critical code.
- Measuring speed (no register reports MHz): interrupts off, time a fixed-cycle loop against `$D012` or CIA2 timers. Accept when two consecutive loops agree; rewrite `$D031` and retry in the 1 MHz window, bounded. The benchmark programs do this.
- Registers are not UCI. Turbo Control may come from a `.cfg` named like the PRG (same folder, run from file browser) or UCI LOAD_CONFIG.
- Do not require turbo: provide a 1 MHz path and a message naming the setting.

## Multiple SIDs

- Two UltiSID (FPGA), two sockets (SID Socket 1/2; user-accessible on the C64U unverified). Items: `SID Socket 1/2 Address`, `UltiSID 1/2 Address`.
- Address options: `Unmapped`, `$D400`..`$D7E0`, `$DE00`..`$DEE0`, `$DF00`..`$DFE0` (steps of `$20`). Default: all four `$D400`.
- `Auto Address Mirroring` (default Enabled) mirrors the available SIDs over `$D400-$D7FF`, so a write to "the second SID" at `$D420` can hit the same chip on mono setups. Real stereo needs distinct addresses and panning.
- Range split (`UltiSID Range Split`, up to 8 SIDs): `1/2 (A5)` second half at +`$20` (A6 +`$40`, A7 +`$80`, A8 +`$100`), `1/4 (A5,A6)`, `(A5,A8)`, `(A7,A8)`. Sockets: `Ext DualSID Range Split` Off, A5..A9.
- SIDs at `$DE00`/`$DF00` collide with REU, UCI, Audio, ACIA (arbitration unverified).
- Per UltiSID (config only): filter curve, resonance, combined waveforms, digi level; user-selectable, so no exact 6581/8580 digi level.
- Mixer settings affect HDMI/analog out only; a built-in SID player may override SID config (`SID Player Autoconfig`).
- Detection: no SID count register for C64 code; probe each candidate base with ordinary SID probing (c64://sound/sid/spec), bounded. Deprecated UCI GET_HWINFO sub 1 lists configured SID bases (c64://ultimate/uci). Host: REST `GET /v1/configs/SID Addressing`, `SID Sockets Configuration`.

## Detecting an Ultimate and its model

1. UCI: read `$DF1D`, mask `$7F`, compare `$49` (`$C9` when no interrupt pending). Needs `Command Interface` enabled (default Disabled); when off it looks like no Ultimate.
2. Turbo probe: `$D031` not `$FF` = turbo registers on; `$FF` proves nothing.
3. Model: UCI IDENTIFY on target 4 answers `CONTROL TARGET V1.1`; GET_HWINFO (deprecated, `$04 $28`) returns a mixed-case product string (fold case). Measured on a C64U: GET_HWINFO reported plain "Ultimate 64", same as a 48 MHz U64; tell 48 from 64 MHz by the speed probe.
4. Host: `GET /v1/info` returns `product`, `firmware_version`, `fpga_version`, `core_version`; `c64://platform/status` reports the active backend.
5. Probe features by trying them (unknown UCI command: `21,UNKNOWN COMMAND`).

## I/O area `$DE00-$DFFF`

| Range | Device |
|---|---|
| `$DF00-$DF0A` | REU (1750 set; extras at `$DF0C-$DF0F` unverified on U64 cores); c64://ultimate/reu |
| `$DF1B-$DF1F` | UCI; see c64://ultimate/uci |
| `$DF20-$DFFF` | Ultimate Audio sampler, if `Map Ultimate Audio $DF20-DFFF` enabled (default Disabled); registers not verified |
| `$DE00`/`$DF00`/`$DF80` | ACIA 6551 SwiftLink, when `ACIA (6551) Mapping` is not Off (each IRQ or NMI) |
| `$DE00-$DFE0` | optional SID placements |

- An active REU disables cartridges needing `$DF00-$DFFF` (EasyFlash, Final Cartridge III). A loaded .crt makes the internal cartridge own `$DE00-$DFFF`; REU/UCI/Audio/ACIA then unverified.
- ACIA "turbo" (Turbo232 register) is modem baud, not CPU turbo.
- RTC: UCI DOS GET_TIME; no memory-mapped RTC registers.

## Other features

- Runtime palette: UCI control commands `$51-$54` (U64-class, firmware 2026-09; check for error 21); `.vpl` fixed palette since 3.10 (c64://ultimate/uci).
- Other video items (HDMI scanlines, analog mode, `Adjust Color Clock`) are post-processing, not C64 timing. No second VIC, extra video mode or extended VIC registers; sprites, multicolour, ECM, bitmap are standard.
- `Joystick Swapper`, `Mouse Mode`, `DMA Load Mimics ID`, `Fast Reset`, `Burst Mode Patch` are config/launch settings, not program features.

## Case light and keyboard LEDs (C64U)

Measured 2026-11-13, C64U fw 1.2.1, by camera (stills and video). Set with `c64_config` (immediate; lost at power-off unless saved):

| Group | Category | LEDs |
|---|---|---|
| Case light | `LED Strip Settings` | 84: 0-29 bottom, 30-59 top, 60-83 between key rows (keyboard left end to function keys) |
| Keyboard | `Keyboard Lighting` | 71 under the keys (0-4 space bar, 70 shift lock; the rest snake row by row) |

- Both have `LedStrip Mode` (`Off`, `Fixed Color`, `SID Music`, `Rainbow`, `Rainbow Sparkle`, `Sparkle` (case), `Default`, `Programmatic`), `LedStrip Pattern`, `Strip Intensity` 0-31, `Fixed Color` (25 hues `Red`..`White`), `Color tint`, `LedStrip SID Select`, `LedStrip Auto SID Mode`. Free RGB needs `Programmatic`.
- Per-LED colour: mode `Programmatic` in that category, then in C64 address space (a program, or REST DMA, see below):
  1. `$D037` <- `$11` once: `$D200-$D3FF` switches from VIC mirrors to the LED controllers (`$D2xx` case, `$D3xx` keyboard). Without it writes do nothing; a C64 reset clears it.
  2. Per window: `$xx00-$xxFB` LED n at 3n, 3 bytes; `$xxFE` global intensity; `$xxFF` any write latches and refreshes, send it after the colours.
  3. Byte order: keyboard **G, R, B**; case **R, G, B** (verified with `FF 00 00` and `00 FF 00`).
- No resident program needed (verified): `PUT /v1/machine:writemem?address=D037&data=11`, then `address=D300&data=<hex>` for colours and `address=D3FE&data=3000` for intensity and latch. PUT with hex in the URL takes about 17 ms and works up to 128 bytes (200 failed); POST with a body takes about 195 ms whatever the size. Each request pauses the C64 briefly. Measured: moving one LED (6 bytes plus latch, 2 requests) 30 updates/s; full frame (213 or 252 bytes, 3 requests) 13/s. A 6502 loop wrote 600 colour-plus-latch sequences in at most 4 jiffies; LED refresh rate not measured.
- Verified by camera: LED 5 red, 20 green, 40 blue, 60 white, rest off in one update; a single LED raced through all 71 keyboard and all 84 case indices in order with colours red, green, blue, yellow, cyan, magenta, white cycling; every index lit one position. Keyboard index 35 was too dim to see. Amber case plastic tints case colours.
- Data persists until overwritten, also after the program ends or the C64 is reset; power-off not tested. `Programmatic` groups are not animated.
- Hazard (fw 1.2.1): after a keyboard session in `Programmatic`, the firmware stopped changing the keyboard LEDs. Config changes (mode, pattern, colour, intensity), C64 reset and clearing `$D037` had no effect, but direct register writes still worked, so the firmware's updates no longer reach the controller. No recovery without an Ultimate restart was found; config values restore, key LEDs keep the last write. The case light had no such problem. Avoid keyboard `Programmatic` on shared or unattended machines; for games prefer `Fixed Color` or `Rainbow`.
- Not possible: per-LED control through UCI or the config API, LED read-back, per-key brightness except via colour bytes.

## VICE versus an Ultimate

| Feature | VICE |
|---|---|
| Turbo `$D030/$D031` | not emulated (read `$FF`) |
| UCI `$DF1B-$DF1F`, palette, HTTP/network | not emulated |
| REU | emulated; 1 byte per cycle (VICE 3.10, measured), a transfer wraps in a 512 KB block; Ultimate rates differ |
| UltiSID extras, SID mirroring, Ultimate Audio, LEDs | not emulated |

Test logic in VICE; timing, turbo, REU, palette on hardware.

## Rerun the benchmark {#rerun}

Every "measured" figure here, in c64://ultimate/reu and c64://gamedev/architecture comes from `data/ultimate/bench/` (c64://ultimate/bench; `results/summary.md`).
With c64bridge: `c64_config` `get`/`set` Turbo Control (never `save_flash`), `c64_program` `upload_run_asm` with the edited program, wait, one `c64_memory` `read` of `$C000` length 3840, decode, restore settings. Humans: `npm run bench:turbo -- --host <ip> --suite full`.

## Pitfalls

1. Never assume turbo: check `$D031`, keep a 1 MHz path.
2. `$D030-$D03F`, `$D07A-$D0BC` are not scratch; no "index N = X MHz" beyond index 3.
3. REST memory access (`c64_memory`) stalls the CPU; can glitch timing-critical code.
4. IEC or fastloader code under a Manual speed: test first (unverified).
5. Unknown product names must not fail.
