# Ultimate Devices: Hardware Features Visible to a C64 Program

**Summary:** Ultimate 64 (U64), Ultimate 64 Elite (MK1), Ultimate 64 Elite II and C64 Ultimate (C64U) add a CPU turbo, several SIDs, an REU, a command interface (UCI) and a runtime palette to a C64-compatible machine. All of it is off or absent in VICE and on a stock C64, so detect, then fall back. Upic is a software technique, not a hardware mode (see c64://ultimate/upic). Ultimate II/II+/II+L cartridges (U2) share the REU/UCI/ACIA I/O but have no turbo, no UltiSID, no palette commands.
**Read when:** designing or detecting turbo, SID layout, REU/UCI presence, model-dependent code, or Ultimate-only features for a game.

Marks: "(unverified)" = secondary or inferred. Firmware dates are when the feature entered the public 1541ultimate master; released firmware may be older, so probe instead of checking versions. Official docs: https://1541u-documentation.readthedocs.io, firmware: https://github.com/GideonZ/1541ultimate.

## Models

| | U64 / U64 Elite (MK1) | U64 Elite II | C64U |
|---|---|---|---|
| FPGA | Cyclone V | Artix-7 | Artix-7 |
| Turbo top speed | 48 MHz | 64 MHz | 64 MHz (one SDK doc says 48; measure) |
| Speed table | MK1 table | 64 MHz table | 64 MHz table |
| Turbo Control value for registers | `U64 Turbo Registers` | `U64 Turbo Registers` | `C64U Turbo Registers` (config dumps; the public source has only the U64 name) |
| Internal speaker | yes | no | no |
| Programmatic LED ($D2xx) | no | yes (2026-05) | not applicable |

- PAL and NTSC both exist (`System Mode`): detect with the raster counter, never assume (63 vs 65 cycles/line, 312 vs 263 lines). See c64://graphics/vic/spec.
- Only the models above have palette (UCI) and turbo registers. VICE and U2 cartridges do not.

## Turbo (CPU speed)

Configuration (category "U64 Specific Settings"; set with `c64_config`, a program cannot set it):

| Item | Values | Default |
|---|---|---|
| `Turbo Control` (name of the Turbo Control item; value names differ by model/firmware, read it with `c64_config`) | `Off`, `Manual`, `U64 Turbo Registers` / `C64U Turbo Registers`, `TurboEnable Bit` | Off |
| `CPU Speed` | 16 entries, strings space-padded (`" 1"`, `" 6"`, `"10"`) | 1 MHz |
| `Badline Timing` | Disabled / Enabled | Enabled |
| `SuperCPU Detect (D0BC)` | Disabled / Enabled | Disabled |

| Turbo Control | Effect |
|---|---|
| Off | `$D030`/`$D031` read `$FF`; 1 MHz |
| Manual | Speed from `CPU Speed`; registers cannot change it, still read `$FF` |
| Turbo Registers | `CPU Speed` is the default; `$D031` and `$D07A`/`$D07B` can change it |
| TurboEnable Bit | As Registers, plus `$D030` bit 0 (0 = 1 MHz with badlines, 1 = menu speed) |

Registers (in the VIC-II space; `$FF` when unavailable, also on stock C64 and VICE):

| Addr | Use |
|---|---|
| `$D031` | bits 3-0 speed index; bit 7 = 1 suppresses badline CPU stalls (0 = stock timing). Bits 4-6: write 0, do not rely on readback. Read back after writing. |
| `$D030` | bit 0 enable (TurboEnable Bit mode only) |
| `$D07A` / `$D07B` | SuperCPU-compatible soft switches, write-only: normal / turbo (turbo = menu speed, not 20 MHz) |
| `$D0BC` | SuperCPU detect, read-only, only if `SuperCPU Detect` enabled |

Speed index to MHz (only indices 0-3 are portable; index 15 = hardware maximum on every model):

| Idx | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| U64 / Elite | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 14 | 16 | 20 | 24 | 32 | 40 | 48 |
| Elite II / C64U | 1 | 2 | 3 | 4 | 6 | 8 | 10 | 12 | 14 | 16 | 20 | 24 | 32 | 40 | 48 | 64 |

The 64 MHz table entered the public firmware 2025-05; older firmware lacks it.

Code (6502, ACME/ca65 compatible):
```
        lda $d031
        cmp #$ff
        beq no_turbo      ; off/manual/not an Ultimate
        lda #$0f          ; max speed, normal badlines ($8f = badlines off)
        sta $d031
        lda #$00          ; back to 1 MHz
        sta $d031
```

Timing facts:
- CPU and memory run at 48/64 MHz; the index chooses how many sub-slots per phi2 the CPU gets. VIC-II keeps priority, so graphics stay correct at any speed. CIA, VIC raster and SID stay in C64 time.
- Measured: with the VIC taking one sub-slot, the CPU gets 63 cycles per phi2 at 64 MHz (3,969 per PAL line) and 47 at 48 MHz (2,961 per PAL line). A read of a VIC register costs one extra sub-slot, a write does not; `sta abs,x` to I/O performs a dummy read and costs extra.
- Badline Timing Enabled: CPU halts while BA is low (stock). Disabled: CPU may run during BA low for internal addresses. Measured on an Ultimate 64 Elite: a RAM loop ran 3.99x faster at 4 MHz, and suppressing badlines added about 6.3%.
- Accesses to the external bus (cartridge port, real SID sockets) go through a 1 MHz bridge and wait for BA high even with badlines disabled. UltiSID writes are internal and fast.
- IEC bit-banging code and cycle-counted raster tricks tuned for 1 MHz break under turbo; stable-raster code must be re-tuned per speed.
- Forced 1 MHz window: after every reset or program start the CPU runs at 1 MHz for about 2 seconds whatever `$D031` says (measured on Elite and Elite II, firmware 3.15a; can recur briefly with IEC activity). Wait for it before timing-critical code.
- Measuring real speed (no register reports MHz): with interrupts off, time a fixed-cycle loop against `$D012`. A loop of 64,764 CPU cycles with no I/O inside spans about 16 raster lines at 64 MHz and about 22 at 48 MHz (1 MHz: about 92 lines more). Accept only when two consecutive loops agree, rewrite `$D031` and retry during the 1 MHz window, give up after a bounded number of tries.
- Registers are not UCI. Turbo Control may also be loaded from a `.cfg` named like the PRG (same folder, run from the Ultimate file browser); a program can also write a `.cfg` and apply it with UCI LOAD_CONFIG (c64://ultimate/uci).
- Do not require turbo unless the game cannot work without it; provide a 1 MHz path and a clear text message naming the setting.

## Multiple SIDs

- Two UltiSID (FPGA) plus two physical sockets (SID Socket 1/2; user-accessible sockets on the C64U are unverified). Items: `SID Socket 1/2 Address`, `UltiSID 1/2 Address`.
- Address options: `Unmapped`, `$D400`..`$D7E0` in steps of `$20`, `$DE00`..`$DEE0`, `$DF00`..`$DFE0` (steps of `$20`). Default: all four at `$D400`.
- `Auto Address Mirroring` (default Enabled) mirrors the available SIDs over all of `$D400-$D7FF`. A write to "the second SID" at `$D420` can hit the same chip on a mono setup. Real stereo needs distinct addresses and distinct panning.
- Range split (`UltiSID Range Split`, up to 8 SIDs / 24 voices): `1/2 (A5)` second half at +`$20`, A6 +`$40`, A7 +`$80`, A8 +`$100`; `1/4 (A5,A6)`, `(A5,A8)`, `(A7,A8)`. Both UltiSIDs share the split. Sockets: `Ext DualSID Range Split` Off, A5..A9.
- SIDs at `$DE00`/`$DF00` collide with REU, UCI, Ultimate Audio and ACIA (how the core arbitrates is unverified).
- Per UltiSID (config only, not C64-visible): filter curve (8580 Lo/Hi, 6581, 6581 Alt, U2 Low/Mid/High), resonance, combined waveforms 6581/8580, digi level Off/Low/Medium/High. Analog behaviour is user-selectable; do not rely on exact 6581/8580 digi level.
- Mixer (volume, panning per source) affects HDMI/analog out only. A running built-in SID player may override the SID config (`SID Player Autoconfig`).
- Detection: no Ultimate-specific SID count register for C64 code. Use ordinary SID probing at each candidate base (see c64://sound/sid/spec), bounded. Deprecated UCI GET_HWINFO sub 1 lists configured SID bases (c64://ultimate/uci). Host side: REST `GET /v1/configs/SID Addressing` and `SID Sockets Configuration`.

## Detecting an Ultimate and its model

1. UCI: read `$DF1D`, mask `$7F`, compare `$49` (`$C9` when no interrupt pending). Needs `Command Interface` enabled (default Disabled); when off the Ultimate looks like no Ultimate.
2. Turbo probe: `$D031` not `$FF` means turbo registers are on; `$FF` proves nothing.
3. Model: UCI IDENTIFY on target 4 answers `CONTROL TARGET V1.1`; GET_HWINFO (deprecated, `$04 $28`) returns a product string, mixed case (fold case before printing). Public firmware strings: "Ultimate 64", "Ultimate 64 Elite", "Ultimate 64-II". Measured on a C64U: GET_HWINFO reported plain "Ultimate 64", same as an original 48 MHz U64, so the string cannot tell C64U from U64. Tell 48 from 64 MHz by the speed probe.
4. Host side: `GET /v1/info` returns `product`, `firmware_version`, `fpga_version`, `core_version`; `c64://platform/status` reports the active backend.
5. Probe features by trying them (unknown UCI command answers `21,UNKNOWN COMMAND`), not by version number.

## I/O area `$DE00-$DFFF`

| Range | Device |
|---|---|
| `$DF00-$DF0A` | REU (1750 set; Ultimate extras at `$DF0C-$DF0F` unverified on U64 cores); see c64://ultimate/reu |
| `$DF1B-$DF1F` | UCI; see c64://ultimate/uci |
| `$DF20-$DFFF` | Ultimate Audio sampler, only if `Map Ultimate Audio $DF20-DFFF` enabled (default Disabled); register layout not verified here |
| `$DE00`/`$DF00`/`$DF80` (+1 NMI variant) | ACIA 6551 SwiftLink, when `ACIA (6551) Mapping` is not Off (DE00/IRQ, DE00/NMI, DF00/IRQ, DF00/NMI, DF80/IRQ, DF80/NMI) |
| `$DE00-$DFE0` | optional SID placements |

- An active REU disables cartridges that need `$DF00-$DFFF` (EasyFlash, Final Cartridge III). A loaded .crt makes the internal cartridge own `$DE00-$DFFF`; REU/UCI/Audio/ACIA availability then is unverified.
- ACIA "turbo" (Turbo232 register) is modem baud, unrelated to CPU turbo.
- RTC: read it through UCI DOS GET_TIME; there are no memory-mapped RTC registers.

## Other features

- Runtime palette: UCI control commands `$51-$54` (U64-class, firmware from 2026-09; check for error 21). Fixed palette by `.vpl` file since firmware 3.10. See c64://ultimate/uci.
- Programmable LEDs: LED strip mode `Programmatic` (Elite II, firmware from 2026-05-14, marked untested upstream) lets a program write colours through `$D200-$D2FF`; byte layout not verified. Not listed in the C64U 1.1.0 config dump. The name `C64_VIC_SPLIT` is misleading: it only gates this LED window.
- Other video items (HDMI scanlines, scan resolution, analog mode, `Adjust Color Clock`) are post-processing and do not change C64 timing.
- No second VIC, no extra video mode, no extended VIC registers exist. Sprites, multicolour, ECM, bitmap are standard VIC-II.
- `Joystick Swapper`, `Mouse Mode` (USB mouse as 1351-style) are config only.
- `DMA Load Mimics ID`, `Fast Reset`, `Burst Mode Patch` are launch-time settings, not program features.

## VICE versus an Ultimate

| Feature | VICE |
|---|---|
| Turbo `$D030/$D031` | not emulated (read `$FF`) |
| UCI `$DF1B-$DF1F`, palette, HTTP/network | not emulated |
| REU | emulated; DMA stalls the CPU about 1 cycle per byte (VICE 3.10, measured) and a transfer wraps inside a 512 KB block; Ultimate rates differ |
| UltiSID extras, multi-SID mirroring, Ultimate Audio, programmable LEDs | not emulated |

Test logic and buffers in VICE; test timing, turbo, REU speed and palette on hardware.

## Pitfalls

1. Never assume turbo: check `$D031`, keep a 1 MHz path, wait out the post-reset window.
2. Do not hard-code "index N = X MHz" beyond index 3.
3. `$D030-$D03F` and `$D07A-$D0BC` are not scratch locations.
4. Set `$D031` bit 7 only knowingly; follow the documented sense (1 = badlines off). The firmware's internal preference bit appears inverted (unverified); read back.
5. Host-side REST memory access (`c64_memory` read/write) stalls the CPU through DMA; it can glitch timing-critical code.
6. Do not poll `$DF1D` without checking the Command Interface is enabled; mask bit 7.
7. Do not place SIDs at `$DE00/$DF00` if REU, UCI or Audio are in use.
8. IEC or fastloader code must not run under a user-set Manual speed unless tested (unverified).
9. Unknown or new product names must not fail hard.
