# Ultimate Devices: Hardware Features Visible to a C64 Program

**Summary:** Ultimate 64 (U64), Elite (MK1), Elite II and C64 Ultimate (C64U) add a CPU turbo, several SIDs, an REU, a command interface (UCI), an Ultimate Audio sampler, UDP streams and a runtime palette, all absent in VICE and on a stock C64: detect, then fall back. Upic is a software technique, not hardware (c64://ultimate/upic). Ultimate II/II+/II+L (U2) share REU/UCI/ACIA I/O but have no turbo, UltiSID or palette commands.
**Read when:** designing or detecting turbo, SID layout, REU/UCI, Ultimate Audio sampler, streams, host REST, model-dependent code, Ultimate-only game features.

Checked against GideonZ/1541ultimate 700c7f2 (2026-11-13); the public source has no U64 / C64 Ultimate FPGA core, so core register behaviour is device-measured or marked unverified.
Marks: "(unverified)" = secondary or inferred; "measured" = 2026-11-13, Ultimate 64 Elite fw 3.15a, C64U fw 1.2.1, PAL. Firmware dates: entry into the public master; released firmware may be older, so probe, not version-check. Docs: 1541u-documentation.readthedocs.io; firmware: GideonZ/1541ultimate.

## Models

| | U64 / U64 Elite (MK1) | U64 Elite II | C64U |
|---|---|---|---|
| FPGA | Cyclone V | Artix-7 | Artix-7 |
| Turbo top speed | 48 MHz | 64 MHz | 64 MHz (measured) |
| Turbo Control value for registers | `U64 Turbo Registers` | `U64 Turbo Registers` | `U64 Turbo Registers` (measured, C64U fw 1.2.1; public source has only this name) |
| Internal speaker | yes | no | no |
| Programmatic LED (`$D2xx`/`$D3xx`) | no | yes (2026-05) | yes, fw 1.2.1 (measured) |

- `System Mode` has six values: `PAL`, `NTSC`, `PAL-60`, `NTSC-50`, `PAL-60/L`, `NTSC-50/L` (code default `NTSC`). PAL-60 runs 65 cycles/line at the NTSC clock; hybrid modes decouple colour encoding from line timing. Detect with the raster counter (63 vs 65 cycles/line, 312 vs 263 lines; c64://graphics/vic/spec), never from the mode name.
- The Elite II and the C64U are the same firmware build in the public source (product string `Ultimate 64-II`, store alias `C64U Specific Settings`); the REST and `.cfg` store name is `U64 Specific Settings`.

## Turbo (CPU speed)

Configuration (category "U64 Specific Settings"; `c64_config` only, not a program):

| Item | Values | Default |
|---|---|---|
| `Turbo Control` (value names may differ by model/firmware; read with `c64_config`; `Off` hides the three items below) | `Off`, `Manual`, `U64 Turbo Registers` / `C64U Turbo Registers`, `TurboEnable Bit` | Off |
| `CPU Speed` | 16 entries, strings space-padded (`" 1"`, `" 6"`, `"10"`) | 1 MHz |
| `Badline Timing` | Disabled / Enabled | Enabled |
| `SuperCPU Detect (D0BC)` | Disabled / Enabled | Disabled |

| Turbo Control | Effect |
|---|---|
| Off | `$D030`/`$D031` read `$FF`; 1 MHz |
| Manual | `CPU Speed`; registers cannot change it, read `$FF` |
| Turbo Registers | `CPU Speed` default; `$D031`, `$D07A`/`$D07B` can change it |
| TurboEnable Bit | As Registers, plus `$D030` bit 0 (0 = 1 MHz with badlines, 1 = menu speed) |

Source check: config values written to the core are `Off` regs 0, `Manual` regs 0, `U64 Turbo Registers` `$01`, `TurboEnable Bit` `$05`, plus `$02` with SuperCPU detect; `$D030`, `$D031` (bit 7 `0` = badline timing enabled, `1` = disabled), `$D0BC` match the official page. Badline bit polarity inside the core is not in the public source; measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20: `Badline Timing` Enabled gives `$D031` = `$03`, Disabled gives `$83`, so bit 7 set means badline stalls are suppressed. `$D07A/$D07B` are not in the public source either (measured behaviour in the register table).

Registers (VIC-II space; `$FF` when unavailable, also on stock C64 and VICE):

| Addr | Use |
|---|---|
| `$D031` | bits 3-0 speed index; bit 7 = 1 suppresses badline and sprite CPU stalls, 0 = stock timing (measured). Bits 4-6: write 0, no readback reliance. Read back after writing. |
| `$D030` | bit 0 enable (TurboEnable Bit mode only) |
| `$D07A` / `$D07B` | SuperCPU soft switches, write-only: normal / turbo (menu speed) (not in the public source or official page; measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20: they act only in `U64 Turbo Registers` and `TurboEnable Bit` modes, `$D07A` writes select 1 MHz and `$D07B` writes select menu speed, and `$D07A` reads `$FF`; Off and Manual ignore them) |
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

Full control recipe, address map, mixer and detection: c64://ultimate/multisid (verified on a C64U, fw 1.2.1).

- Two UltiSID (FPGA) and two sockets; `UltiSID Range Split` `1/4 (A7,A8)` makes 8 UltiSID parts (24 voices), sockets add 1 each (10, or 12 with dual-SID chips). Items: `SID Socket 1/2 Address`, `UltiSID 1/2 Address`, `Ext DualSID Range Split`, `Auto Address Mirroring` (default Enabled: every decoder at `$D400` answers all of `$D400-$D7FF`, so all chips hear every write).
- Addresses: `Unmapped`, `$D400`..`$D7E0`, `$DE00`..`$DFE0`, steps `$20`. Keep SIDs out of `$DE00-$DFFF` (REU, UCI). Access only to mapped windows: an undecoded `$D400-$D7FF` address hangs the CPU or the device (Elite fw 3.15; assume the same on the C64U).
- Mixer: Vol/Pan per UltiSID 1, UltiSID 2, Socket 1, Socket 2; split parts share their parent's pan. The UDP audio stream carries the mixer output, so pan and volume are in it. Per-UltiSID: filter curve, resonance, combined waveforms, digi level.
- Run-time setup: UCI `LOAD_CONFIG` (fw 1.2.1 verified). Detection: UCI `GET_HWINFO` sub 1 lists the two UltiSIDs and each enabled socket (not parts); test each mapped window with ENV3. Host: REST `GET /v1/configs/SID Addressing`, `SID Sockets Configuration`.

## Detecting an Ultimate and its model

1. UCI: read `$DF1D`, mask `$7F`, compare `$49` (`$C9` when no interrupt pending). Needs `Command Interface` enabled (default Disabled); when off it looks like no Ultimate.
2. Turbo probe: `$D031` not `$FF` = turbo registers on; `$FF` proves nothing.
3. Model: UCI IDENTIFY on target 4 answers `CONTROL TARGET V1.1`; GET_HWINFO (deprecated, `$04 $28`) returns a mixed-case product string (fold case). The string comes from `getProductString()`: "C64 Ultimate" on a C64U fw 1.2.1 (measured), "Ultimate 64" / "Ultimate 64 Elite" on a U64. The public source differs: its product names are `Ultimate`, `Ultimate II`, `Ultimate II+`, `Ultimate II+L`, `Ultimate 64`, `Ultimate 64 Elite`, `Ultimate 64-II` (u64ii build, also used for the C64U) and has no "C64 Ultimate"; a device check decides. Match on "ultimate" and tell 48 from 64 MHz by the speed probe.
4. Host: `GET /v1/info` returns `product`, `firmware_version`, `git_commit_hash`, `fpga_version`, `hostname`, `unique_id` (if set), `ethernet_mac`, `wifi_mac` (when present) and, on U64-class only, `core_version`; `c64://platform/status` reports the active backend.
5. Probe features by trying them (unknown UCI command: `21,UNKNOWN COMMAND`).

## I/O area `$DE00-$DFFF`

| Range | Device |
|---|---|
| `$DF00-$DF0A` | REU (1750 set; extras at `$DF0C-$DF0F` absent on the U64 Elite core 1.50 (read `$FF`, writes not kept; measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20), absent on public U2 builds; unverified on other cores); c64://ultimate/reu |
| `$DF1B-$DF1F` | UCI at `$DF1C-$DF1F` (`$DF1B` device number); `$DE1B-$DE1F` under an EasyFlash CRT; see c64://ultimate/uci |
| `$DF20-$DFFF` | Ultimate Audio sampler, if `Map Ultimate Audio $DF20-DFFF` enabled (default Disabled); register map below |
| `$DE00`/`$DF00`/`$DF80` | ACIA 6551 SwiftLink, when `ACIA (6551) Mapping` is not Off (each IRQ or NMI) |
| `$DE00-$DFE0` | optional SID placements |

- A loaded `.crt` makes the internal cartridge own I/O; each CRT type declares what it prohibits and the firmware switches those Ultimate devices off for that run: `PROHIBIT_DEXX` = ACIA at `$DE00`; `PROHIBIT_DFXX` = ACIA at `$DF00`, REU, UCI, Ultimate Audio; `PROHIBIT_IO` = all of them; `ALL_BUT_REU` = all but REU (EasyFlash subtype 1, C128 IO subtype 1, GeoRAM mode). EasyFlash keeps UCI, relocated to `$DE1C`; C128 std-IO CRT subtypes 1 and 2 keep UCI at `$DF1C`. A CRT game cannot rely on REU, UCI, Audio or ACIA unless its type allows them (confirmed in source).
- ACIA "turbo" (Turbo232 register) is modem baud, not CPU turbo.
- RTC: UCI DOS GET_TIME; no memory-mapped RTC registers.

## Ultimate Audio sampler (`$DF20-$DFFF`)

Sample player reading from Ultimate memory (usually the REU). Enable `Map Ultimate Audio $DF20-DFFF` (store `C64 and Cartridge Settings`, default `Disabled`); a loaded `.crt` type may switch it off. Hardware has 8 voices of 32 bytes; the C64 window reaches voice n at `$DF20 + 32*n` for n = 0..6 (7 voices; the 8th is firmware-only). Register map confirmed in the public FPGA source (not on a build without the sampler option).

| Offset | Meaning |
|---|---|
| `+$00` | control: b0 enable, b1 repeat, b2 IRQ at end, b5-4 format (`00` 8-bit mono, else 16-bit), b6 interleave (16-bit builds) |
| `+$01` | volume, 6 bits (reset 63) |
| `+$02` | pan, 4 bits, 0 left ... 15 right (reset 7) |
| `+$04..$07` | start address, high byte first; `+$04` holds bits 25-24 |
| `+$09..$0B` | length (24 bit, high byte first) |
| `+$0E/$0F` | rate, high then low (reset 283) |
| `+$11..$13` / `+$15..$17` | repeat A / repeat B position (24 bit) |
| `+$1F` | write: b0 clears this voice's IRQ; `$FF` clears all |

- Start address is an absolute SDRAM address; the REU starts at `$1000000`, so REU offset X is `$1000000 + X` (reset default start = REU offset 0).
- Read: even offsets return the 8-bit IRQ status vector, odd offsets `$10`. Writing control 0 does not mute a voice that keeps its last sample: also write volume 0.
- Output: mixer channels `Vol Sampler L/R`, `Pan Sampler L/R` (c64://ultimate/multisid).
- Sample rate is about 6.25 MHz / (rate + 1), about 22 kHz at the reset value 283 (derived from the VHDL; measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20: roughly 6.2 MHz / (rate + 1), 21.95 kHz at 283, 43.5 kHz at 141, 10.9 kHz at 567, within 1.2 % of 6.25 MHz / (rate + 1)). Byte order of the 24-bit fields and the interleave and 16-bit modes are read from VHDL, not device-tested (unverified).
- `runners:modplay` loads a MOD into REU offset 0 and plays it through this sampler (501 without it).

## Data streams (U64 / Elite / Elite II / C64 Ultimate; not Ultimate II+)

UDP streams to a host. Store `Data Streams`: `Stream VIC to` (default `239.0.1.64:11000`), `Stream Audio to` (`239.0.1.65:11001`), `Stream Debug to` (`239.0.1.66:11002`), `Debug Stream Mode` (`6510 Only`, `VIC Only`, `6510 & VIC`, `1541 Only`, `6510 & 1541`, `6510 w/IEC`, `6510 & VIC w/IEC`). UDP source ports: 53248 video, 54272 audio, 6510 debug, 1541 drive debug.
- REST: `PUT /v1/streams/{video|audio|debug}:start?ip=<addr[:port]>` and `:stop` (stop is safe when not running). Without a port: 11000 video, 11001 audio, 11002 debug. `ip` may be a host name or a multicast group 232.0.0.0-239.255.255.255. Errors: 404 unknown stream or name not resolvable, 500 no wired Ethernet link with an IP.
- Streams leave only through the wired Ethernet port, even if WiFi carried the request. Video and debug share hardware: starting video stops debug.
- `palette=1` (video only; 400 otherwise): the device also sends 60-byte palette packets (video header with line field 239, 384 pixels, 1 line, 4 bpp, type 1 in header bytes 10-11, 16 RGB triples from byte 12; bytes 0-1 carry a palette generation counter). The setting is device-wide: the most recent `start` sets it for every receiver. A video parser must skip or decode packets with type 1.
- Video header (12 bytes): sequence u16, frame u16, line u16 (bit 15 = last packet), pixels per line u16, lines per packet u8, bits per pixel u8, encoding u16. Audio: 2-byte sequence then S16 stereo (192 frames per packet, 47982.89 Hz PAL / 47940.34 Hz NTSC: from the client code and device, payload format not in the public source, unverified). Measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20: after each video or audio stream start the device sends one 2-byte datagram `00 00` from an ephemeral source port (receivers must tolerate it); the video frame was 384x272, 4 bpp, 68 packets of 4 lines, 50 fps, encoding 0 only (encoding 1 with `palette=1`); the audio capture limit of the bridge is 65536 sample pairs. Ultimate II+ has a debug streamer started from the menu only.

## Host REST and network (U64 / Elite / Elite II / C64 Ultimate; Ultimate II+ differs where noted)

- `X-Password` header: when `Network Password` (store `Network Settings`, string, 3-31 characters) is non-empty, every REST call (and FTP and the socket services) needs it; a wrong or missing header on an existing route gives HTTP 403 `Forbidden.`.
- U64-class only (501 on Ultimate II+): `PUT machine:poweroff`, `GET/POST machine:input` (keyboard, joystick, mouse injection), `machine:debugreg` (debug register `$D7FF`, diagnostics), the `streams` routes. Everywhere: `machine:reset|reboot|pause|resume|menu_button|menu_screen|readmem|writemem|measure|heap`, `runners:*`, `drives`, `configs`, `files/{path}:info|create_d64|create_d71|create_d81|create_dnp`, `GET /v1/help?command=`, `GET /v1/version` (`0.1`), `GET /v1/info`.
- `machine:readmem` returns up to 65536 bytes (length 0 or 65537: 400 `Invalid length`; no length: 256 bytes; a range past `$FFFF`: 400). `PUT machine:writemem` data is limited to 128 bytes (400 beyond that, nothing written); `POST` takes up to 64 KB, and a body past `$FFFF` is silently truncated to the 64 KB that fit (a 65537-byte POST at `$0000` returned 200 `0000-FFFF`), while a start address plus length past `$FFFF` is a 400 (all measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20). A DMA read of `$DD0D` clears the CIA2 ICR flags like a CPU read.
- Route matching: the firmware does not decode `%3A` or other escapes in the route name (`machine%3Areadmem` and `inf%6F` answer 404), while escapes inside a parameter segment are decoded (`files/%2FTemp:info` gives path `/Temp`, `configs/%2E%2E` gives category `..`) and `..` is not normalised (measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20). The bridge rejects dot segments and encoded variants before sending as defence.
- `files/{path}:info` with a wildcard returns only the first match; `**` behaves like `*`; no match: 404 `FILE DOESN'T EXIST`, missing root: 404 `PATH DOESN'T EXIST` (measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20).
- `configs` GET and PUT take category and item as wildcard patterns (`*`, `?`, case-insensitive); PUT uses the first match; POST `/v1/configs` matches exactly. REST changes are RAM only until `configs:save_to_flash`.
- `runners:run_prg` and `load_prg` (PUT, `file=`) apply a sidecar `.cfg` / `.usr` (c64://gamedev/toolchain); `run_crt` and the POST upload variants do not.
- A UDP "Ultimate Ident Service" on port 64 answers a broadcast, for finding a device (controlled by the Network Settings item `Ultimate Ident Service`, Enabled on the measured device; a unicast `h6probe` or `jsonh6probe` datagram to port 64 is answered, measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20; the broadcast form was not sent).

## Other features

- Runtime palette: UCI control commands `$51-$54` (U64-class, firmware 2026-09; check for error 21); `.vpl` fixed palette since 3.10 (c64://ultimate/uci).
- Other video items (HDMI scanlines, analog mode, `Adjust Color Clock`) are post-processing, not C64 timing. No second VIC, extra video mode or extended VIC registers; sprites, multicolour, ECM, bitmap are standard.
- `Joystick Swapper`, `Mouse Mode`, `DMA Load Mimics ID`, `Fast Reset`, `Burst Mode Patch` are config/launch settings, not program features.

## Case light and keyboard LEDs (C64U)

Measured 2026-11-13, C64U fw 1.2.1, by camera (stills and video). The public source differs and cannot confirm this section: it has `LED Strip Settings` modes `Off`, `Fixed Color`, `SID Music`, `Rainbow`, `Programmatic`, `LedStrip Length` 1-40, and for `Programmatic` only enables `$D200-$D2FF` as LED window; `$D037`, the `Keyboard Lighting` category, `Rainbow Sparkle`/`Sparkle`/`Default` and the LED counts below are device-measured, not in public source (UNRESOLVED; a device check decides). Set with `c64_config` (immediate; lost at power-off unless saved):

| Group | Category | LEDs |
|---|---|---|
| Case light | `LED Strip Settings` | 84: 0-29 bottom, 30-59 top, 60-83 between key rows (keyboard left end to function keys) |
| Keyboard | `Keyboard Lighting` | 71 under the keys (0-4 space bar, 70 shift lock; the rest snake row by row) |

- Both have `LedStrip Mode` (`Off`, `Fixed Color`, `SID Music`, `Rainbow`, `Rainbow Sparkle`, `Sparkle` (case), `Default`, `Programmatic`), `LedStrip Pattern`, `Strip Intensity` 0-31, `Fixed Color` (25 hues `Red`..`White`), `Color tint`, `LedStrip SID Select`, `LedStrip Auto SID Mode`. Free RGB needs `Programmatic`.
- Per-LED colour: mode `Programmatic` in that category, then in C64 address space (a program, or REST DMA, see below):
  1. `$D037` <- `$11` once: `$D200-$D3FF` switches from VIC mirrors to the LED controllers (`$D2xx` case, `$D3xx` keyboard). Without it writes do nothing; a C64 reset clears it.
  2. Per window: `$xx00-$xxFB` LED n at 3n, 3 bytes; `$xxFE` global intensity; `$xxFF` any write latches and refreshes, send it after the colours.
  3. Byte order: keyboard **G, R, B**; case **R, G, B** (verified with `FF 00 00` and `00 FF 00`).
- No resident program needed (verified): `PUT /v1/machine:writemem?address=D037&data=11`, then `address=D300&data=<hex>` for colours and `address=D3FE&data=3000` for intensity and latch. PUT with hex in the URL takes about 17 ms and works up to 128 bytes (200 failed; the firmware documents exactly this limit); POST with a body (raw or multipart, up to 65536 bytes) takes about 195 ms whatever the size. The write may not pass `$FFFF` and is decoded through the live bank configuration. Each request pauses the C64 briefly. Measured: moving one LED (6 bytes plus latch, 2 requests) 30 updates/s; full frame (213 or 252 bytes, 3 requests) 13/s. A 6502 loop wrote 600 colour-plus-latch sequences in at most 4 jiffies; LED refresh rate not measured.
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
4. IEC or fastloader code under a Manual speed: test first. KERNAL IEC LOAD worked at 16 and 48 MHz on Ultimate 64 Elite, firmware 3.15a, 2026-11-20; fastloaders were not tested (unverified).
5. Unknown product names must not fail.
