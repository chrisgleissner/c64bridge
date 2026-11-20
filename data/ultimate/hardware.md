# Ultimate Devices: Hardware Features Visible to a C64 Program

**Summary:** Ultimate 64 (U64), Ultimate 64 Elite (MK1), Ultimate 64 Elite II and C64 Ultimate (C64U) add a CPU turbo, several SIDs, an REU, a command interface (UCI), an Ultimate Audio sampler, UDP streams and a runtime palette. VICE and a stock C64 have none of them, so a program detects each feature and falls back. Upic is a software technique, not hardware (c64://ultimate/upic). Ultimate II, II+ and II+L (U2 family) have the REU, UCI and ACIA but no turbo, UltiSID or palette commands.
**Read when:** designing or detecting turbo, SID layout, REU/UCI, Ultimate Audio sampler, streams, host REST, model-dependent code, Ultimate-only game features.

Sources. Firmware and FPGA: GideonZ/1541ultimate master 700c7f2fa (2026-11-13), cited as `software/<path>:<line>` or `fpga/<path>`. The top-level FPGA design of the U64 family is not in that repository, so the decode of `$D030`, `$D031`, `$D07A/$D07B`, `$D0BC` and of the C64U LED registers comes from measurements. "Measured U64" = Ultimate 64 Elite, firmware 3.15a, core 1.50, PAL (2026-11-20 unless dated 2026-11-13). "Measured C64U" = C64 Ultimate, firmware 1.2.1, PAL, 2026-11-13. Dates "since YYYY-MM-DD" are the commit date in the public master; a device can run older firmware, so a program tests for the feature (UCI error `21,UNKNOWN COMMAND`) instead of checking a version.

## Models

| | U64 / U64 Elite (MK1) | U64 Elite II | C64U |
|---|---|---|---|
| Firmware build | `U64 == 1` | `U64 == 2` | `U64 == 2` in the public source; measured C64U answers product `C64 Ultimate` |
| Product string (`getProductString`, `software/system/product.cc:12-18`) | `Ultimate 64` or `Ultimate 64 Elite` | `Ultimate 64-II` | `C64 Ultimate` (measured C64U; not in public source) |
| `CPU Speed` top entry | 48 MHz | 64 MHz | 64 MHz (measured C64U) |
| `Speaker Enable` / `Speaker Volume (SpkDat)` items | yes | no | no (`software/u64/u64_config.cc:381-384`) |
| LED registers for programs | none | `LedStrip Mode` = `Programmatic` maps `$D200-$D2FF` to the LED strip (`software/u64/led_strip.cc:420-423`) | `$D200-$D3FF` after `$D037` = `$11` (measured C64U, section "Case light and keyboard LEDs") |

`System Mode` (store `U64 Specific Settings`, default `NTSC`, `software/u64/u64_config.cc:278,351`; timing from `software/u64/color_timings.cc:6-29`):

| Value | Cycles per line | Field rate | Colour encoding |
|---|---|---|---|
| `PAL` | 63 | 50 Hz | PAL |
| `NTSC` | 65 | 60 Hz | NTSC |
| `PAL-60` | 65 | 60 Hz | PAL, free-running carrier |
| `NTSC-50` | 63 | 50 Hz | NTSC, free-running carrier |
| `PAL-60/L` | 65 | 60 Hz | PAL, carrier locked to the CPU clock |
| `NTSC-50/L` | 63 | 50 Hz | NTSC, carrier locked to the CPU clock |

A program detects line timing from the raster counter (63 or 65 cycles per line; 312 or 263 lines; c64://graphics/vic/spec), because the colour encoding does not determine it.

## Turbo (CPU speed)

Items in store `U64 Specific Settings` (`software/u64/u64_config.cc:390-397`). A C64 program cannot change them; the host uses `c64_config`, or a program sends UCI LOAD_CONFIG (rule below).

| Item | Accepted values | Default |
|---|---|---|
| `Turbo Control` | `Off`, `Manual`, `U64 Turbo Registers`, `TurboEnable Bit` | `Off` |
| `CPU Speed` | U64 / Elite MK1: ` 1` ` 2` ` 3` ` 4` ` 5` ` 6` ` 8` `10` `12` `14` `16` `20` `24` `32` `40` `48`; Elite II / C64U: ` 1` ` 2` ` 3` ` 4` ` 6` ` 8` `10` `12` `14` `16` `20` `24` `32` `40` `48` `64` (one-digit values carry a leading space; the menu shows them with ` MHz`) | ` 1` |
| `Badline Timing` | `Disabled`, `Enabled` | `Enabled` |
| `SuperCPU Detect (D0BC)` | `Disabled`, `Enabled` | `Disabled` |

`Turbo Control` = `Off` disables the other three items (`software/u64/u64_config.cc:1681-1695`).

| Turbo Control | Value the firmware writes to the core (`setCpuSpeed`, `software/u64/u64_config.cc:1696-1708`) | Effect for a program |
|---|---|---|
| `Off` | turbo enable `$00`, speed `$80` (index 0) | 1 MHz; `$D030`/`$D031` read `$FF` |
| `Manual` | `$00` | `CPU Speed` applies; `$D031` reads `$FF`; `$D07A`/`$D07B` have no effect (measured U64) |
| `U64 Turbo Registers` | `$01` | starts at `CPU Speed`; `$D031`, `$D07A`, `$D07B` change it |
| `TurboEnable Bit` | `$05` | as `U64 Turbo Registers`, plus `$D030` bit 0 (0 = 1 MHz, 1 = selected speed) |

`SuperCPU Detect (D0BC)` = `Enabled` adds `$02` to the turbo enable value in every mode except `Off`.

**Rule for a `.cfg` file (UCI LOAD_CONFIG, file-browser load, sidecar `.cfg`).** Write exactly one `Turbo Control` line and one `CPU Speed` line, each with a value from the table above for the target model. The parser compares an enum value case-insensitively and ignores spaces before and after it (`software/userinterface/configio.cc:343-350,415-431`), so `CPU Speed=4` and `CPU Speed= 4` both select ` 4`, while `CPU Speed=4 MHz` is invalid. A value outside the list makes that line invalid: `CPU Speed=64` on a U64 / Elite MK1, `CPU Speed=5` on an Elite II or C64U, and any `Turbo Control` label other than the four above (for example `C64U Turbo Registers`). The consequence depends on how the file is loaded:

| Loader | Invalid line | Valid lines |
|---|---|---|
| UCI LOAD_CONFIG (`04 50`) | status `89,CONFIG FILE HAD ERRORS`; reply data = log line `Line N: Value '...' is not a valid choice for item ...` | values are stored in RAM but no store is applied to the hardware (`software/io/command_interface/control_target.cc:577-608`); they take effect at the next apply of that store (a later successful LOAD_CONFIG or a menu configuration change) |
| File browser "Load Settings", sidecar `.cfg` of `run_prg`/`load_prg` | skipped | applied (`software/userinterface/configio.cc:445-467`) |

Measured U64: a LOAD_CONFIG file with one invalid line returned `89` and the log line, and REST then showed the valid line's value. A line naming an unknown item or a `[store]` that the device lacks is skipped with a log line and does not cause `89` (`configio.cc:280-297,381-389`). REST `PUT /v1/configs/...` matches the value exactly apart from case (`software/api/route_configs.cc:79-89`), so it needs the leading space: `value=%204`.

Registers in the VIC-II area (read `$FF` when the mode does not enable them, on a stock C64 and in VICE):

| Address | Use |
|---|---|
| `$D031` | read/write. Bits 3-0 = speed index (table below). Bit 7 = 1 removes badline and sprite CPU stalls; 0 = stock stall timing. Measured U64: `Badline Timing` `Enabled` reads `$03` at index 3, `Disabled` reads `$83`; a 1 MHz loop with bit 7 set ran 1151 iterations against 1088 with bit 7 clear. Write bits 6-4 as 0. |
| `$D030` | bit 0 = turbo enable, only in `TurboEnable Bit` mode |
| `$D07A` / `$D07B` | write-only. A write to `$D07A` selects 1 MHz (`$D031` then reads `$00`), a write to `$D07B` selects `CPU Speed`; reads of `$D07A` return `$FF`. They act only in `U64 Turbo Registers` and `TurboEnable Bit` modes (measured U64). |
| `$D0BC` | read-only SuperCPU detection byte, present when `SuperCPU Detect (D0BC)` = `Enabled` |

Speed index to MHz (index 15 = top speed of the model; the register does not report the model):

| Index | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| U64 / Elite MK1 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 14 | 16 | 20 | 24 | 32 | 40 | 48 |
| Elite II / C64U | 1 | 2 | 3 | 4 | 6 | 8 | 10 | 12 | 14 | 16 | 20 | 24 | 32 | 40 | 48 | 64 |

Code: `lda $d031 / cmp #$ff / beq no_turbo` (Off, Manual or no Ultimate); `lda #$0f / sta $d031` = top speed with stock stalls; `lda #$8f / sta $d031` = top speed without stalls; `lda #0 / sta $d031` = 1 MHz.

Timing (measured U64 and C64U 2026-11-13, PAL; rerun: c64://ultimate/hardware#rerun):
- The CPU gets one sub-slot per phi2 less than the nominal factor at the two top entries: 47 cycles per phi2 at 48 MHz (2,961 per line), 63 at 64 MHz (3,969 per line). Up to 32 MHz the count equals the nominal factor. The VIC-II keeps priority, and CIA timers, raster and SID run in C64 time.
- Cycles per PAL frame at 48 / 64 MHz: screen blanked 923,875 / 1,238,387; screen on 873,784 / 1,170,907; screen on plus 8 double-height sprites 836,375 / 1,121,520. At 1 MHz: 19,656 / 18,575 / 17,783. Badlines cost 5.5 % at every speed and 8 sprites a further 4.1 %. With `$D031` bit 7 set the screen-on loss is below 0.2 %. In `U64 Turbo Registers` mode the `Badline Timing` item did not change the loop counts.
- I/O reads are slower than RAM at high speed: a `lda $D012` loop ran at 42 of 47 cycles per phi2 at 48 MHz and 56.5 of 63 at 64 MHz. `sta $D020` runs at RAM speed. A CIA read loop reached 8.8 cycles per phi2 at most (7.5 at 8-12 MHz). `sta abs,x` to I/O adds a dummy read.
- Accesses to the cartridge port and to real SID chips in the sockets run at 1 MHz; UltiSID writes stay inside the FPGA.
- IEC bit-banging and cycle-counted 1 MHz raster code fail under turbo. KERNAL `LOAD` from a 1541 (IEC) worked at 16 and 48 MHz (measured U64).
- After `run_prg` the core keeps 1 MHz for 2.55 s (U64) and 2.57 s (C64U) after program start, whatever `$D031` holds (measured 2026-11-13). Wait until two consecutive timing loops agree before timing-critical code.
- Measuring the speed: no register reports MHz. Disable interrupts, time a fixed-cycle loop against `$D012` or a CIA2 timer, accept when two consecutive results agree, else rewrite `$D031` and retry a bounded number of times. The benchmark programs (c64://ultimate/bench) do this.
- A program that uses turbo also has a 1 MHz path and prints the setting that enables turbo.

## Multiple SIDs

Recipe, address map, mixer and detection: c64://ultimate/multisid.

- Two UltiSIDs (in the FPGA) and two SID sockets. `UltiSID Range Split` = `1/4 (A7,A8)` gives 8 UltiSID windows (24 voices); each socket adds one SID (10 SIDs), or two with a dual-SID chip (12). Items in store `SID Addressing`: `SID Socket 1 Address`, `SID Socket 2 Address`, `UltiSID 1 Address`, `UltiSID 2 Address`, `UltiSID Range Split`, `Ext DualSID Range Split`, `Auto Address Mirroring` (default `Enabled`) (`software/u64/u64_config.cc:416-426`).
- Addresses: `Unmapped`, `$D400` to `$D7E0` and `$DE00` to `$DFE0` in steps of `$20`. SIDs in `$DE00-$DFFF` collide with the REU and UCI.
- Mixer store `Audio Mixer`: `Vol`/`Pan` for UltiSID 1, UltiSID 2, Socket 1, Socket 2; split parts share their UltiSID's pan. The UDP audio stream carries the mixer output.
- Run-time setup from the C64: UCI LOAD_CONFIG. Detection: UCI `GET_HWINFO` sub 1 lists the two UltiSIDs and each enabled socket (not split parts); test each mapped window with ENV3.

## Detecting an Ultimate and its model

1. UCI: `lda $DF1D / and #$7F / cmp #$49`. Needs `Command Interface` = `Enabled` (default `Disabled`); with it off the C64 sees no Ultimate. An EasyFlash or C128 std-IO subtype 1/2 `.crt` switches UCI on by itself (section I/O area).
2. Turbo: `$D031` not `$FF` = turbo registers enabled; `$FF` does not exclude an Ultimate.
3. Model: UCI `04 28 00` (GET_HWINFO sub 0) returns the product string of the table in "Models". Compare case-insensitively on `ultimate`, then tell 48 from 64 MHz with the speed probe.
4. Host: `GET /v1/info` returns `product`, `firmware_version`, `git_commit_hash`, `fpga_version`, `hostname`, `unique_id`, `ethernet_mac`, `wifi_mac` (if fitted) and, on the U64 family, `core_version` (measured U64). `c64://platform/status` reports the active backend.
5. Features: send the command; `21,UNKNOWN COMMAND` means the firmware lacks it.

## I/O area `$DE00-$DFFF`

| Range | Device |
|---|---|
| `$DF00-$DF0A` | REU (c64://ultimate/reu). Reads of `$DF0B` and `$DF10-$DF17` return `$FF` (`fpga/cart_slot/vhdl_source/reu.vhd:429-483`). `$DF0C-$DF0F` exist only in FPGA builds with the extended REU: measured U64 core 1.50 reads `$FF` there; every public U2-family top level sets `g_extended_reu => false`. |
| `$DF1B-$DF1F` | UCI (`$DF1C-$DF1F`; `$DF1B` = IEC device number); at `$DE1B-$DE1F` under an EasyFlash `.crt`; c64://ultimate/uci |
| `$DF20-$DFFF` | Ultimate Audio sampler, when `Map Ultimate Audio $DF20-DFFF` = `Enabled` (default `Disabled`) |
| `$DE00`, `$DF00` or `$DF80` | ACIA 6551 (SwiftLink), item `ACIA (6551) Mapping`: `Off`, `DE00/IRQ`, `DE00/NMI`, `DF00/IRQ`, `DF00/NMI`, `DF80/IRQ`, `DF80/NMI` (default `Off`, `software/io/acia/modem.cc:46,69`) |
| `$DE00-$DFE0` | optional SID placements |

A loaded `.crt` decides which Ultimate devices stay on (`software/io/c64/c64.h:243-258`, `c64_crt.cc:468-648`, `c64.cc:1358-1430`):

| CRT class | Switched off | Forced on |
|---|---|---|
| `PROHIBIT_DEXX` | ACIA at `$DE00` | - |
| `PROHIBIT_DFXX` | ACIA at `$DF00`, REU, UCI at `$DF1C`, sampler | - |
| `PROHIBIT_IO` | all of the above | - |
| EasyFlash subtype 1 | ACIA, sampler | UCI at `$DE1C`; REU follows its setting |
| EasyFlash other subtypes | ACIA, REU, sampler | UCI at `$DE1C` |
| C128 std-IO subtype 1 / Final Cartridge III subtype 1 | ACIA, sampler | C128 subtype 1: UCI at `$DF1C` |
| C128 std-IO subtype 2 | ACIA at `$DF00`/`$DF80`, sampler | UCI at `$DF1C` |

"Forced on" applies even when `Command Interface` is `Disabled`. A CRT game uses the REU, sampler or ACIA only if its type leaves them on.
- The ACIA's Turbo232 register sets the modem baud rate, not the CPU speed.
- Real-time clock: UCI DOS `GET_TIME`; there are no memory-mapped RTC registers.

## Ultimate Audio sampler (`$DF20-$DFFF`)

A sample player that reads from Ultimate memory (normally the REU area). Enable `Map Ultimate Audio $DF20-DFFF` (store `C64 and Cartridge Settings`, default `Disabled`, `software/io/c64/c64.cc:96`). The FPGA has 8 voices of 32 registers; the C64 window starts at voice 0, so voice n is at `$DF20 + 32*n` for n = 0 to 6 and voice 7 is not reachable (`fpga/cart_slot/vhdl_source/slot_server_v4.vhd:953-958`, `fpga/ip/busses/vhdl_source/slot_to_io_bridge.vhd:61-65`). Register map from `fpga/io/sampler/vhdl_source/sampler_regs.vhd` and `sampler_pkg.vhd`:

| Offset | Write |
|---|---|
| `+$00` | control: bit 0 enable, bit 1 repeat, bit 2 IRQ at end, bits 5-4 `00` = 8-bit mono, other = 16-bit, bit 6 interleave |
| `+$01` | volume, bits 5-0 |
| `+$02` | pan, bits 3-0: 0 = left, 15 = right |
| `+$04` / `+$05` / `+$06` / `+$07` | start address bits 25-24 (bits 1-0 of `+$04`), 23-16, 15-8, 7-0 |
| `+$09` / `+$0A` / `+$0B` | length bits 23-16, 15-8, 7-0 |
| `+$0E` / `+$0F` | rate divider high, low |
| `+$11..$13` / `+$15..$17` | repeat-A / repeat-B position, high byte first |
| `+$1F` | bit 0 = 1 clears this voice's IRQ; `$FF` clears all voices' IRQs |

- Reads: even offsets return the IRQ status bits of all voices, odd offsets `$10`.
- The FPGA registers have no reset input: at power-up volume is 32, pan 8, rate 0, start 0, length 0. On every C64 reset the firmware writes control 0 and volume 0 to all 8 voices (`software/io/audio/sampler.h:35-42`, called from `command_intf.cc:130`); pan, rate, addresses and lengths keep their values. Write every register of a voice before setting the enable bit.
- The start address is an SDRAM address; the REU begins at `$1000000`, so REU offset X is start address `$1000000 + X` (`reu.vhd:19`).
- Sample rate = 6.25 MHz / (rate + 1): `sampler2.vhd` normalises its clock to 50 MHz and serves the 8 voices in turn. Measured U64: 21,949 Hz at rate 283, 43,517 Hz at 141, 10,909 Hz at 567, all within 1.2 % below the formula.
- Clearing the enable bit stops the voice but keeps its last sample as a constant output level (`sampler2.vhd`, state `idle` and `finished` keep `sample_out`); write volume 0 as well to silence it.
- Mixer items `Vol Sampler L`, `Vol Sampler R`, `Pan Sampler L`, `Pan Sampler R` (c64://ultimate/multisid).
- REST `runners:modplay` loads a MOD into REU offset 0 and plays it through this sampler; it answers 501 when the FPGA has no sampler (`software/api/route_runners.cc:230-266`).

## Data streams (U64 family and C64U; not U2 family)

UDP streams to a host. Store `Data Streams`: `Stream VIC to` (default `239.0.1.64:11000`), `Stream Audio to` (`239.0.1.65:11001`), `Stream Debug to` (`239.0.1.66:11002`), `Debug Stream Mode` (`6510 Only`, `VIC Only`, `6510 & VIC`, `1541 Only`, `6510 & 1541`, `6510 w/IEC`, `6510 & VIC w/IEC`).
- REST `PUT /v1/streams/{video|audio|debug}:start?ip=<addr[:port]>` and `:stop` (`software/api/route_streams.cc:20-115`). Without a port: 11000 video, 11001 audio, 11002 debug. `ip` is an address, a host name or a multicast group 232.0.0.0-239.255.255.255. Errors: 404 for an unknown stream name or an unresolvable host, 500 when the wired Ethernet link is down or has no IP. `:stop` on a stopped stream returns 200.
- The streams leave through the wired Ethernet port even when WiFi carried the request. Video and debug share hardware: starting video stops debug.
- `palette=1` (video only; otherwise 400): the device also sends 60-byte palette packets, twice per second: video header with line 239, 384 pixels, 1 line, 4 bpp, encoding 1, 16 RGB triples from byte 12, bytes 0-1 a counter. The setting is device-wide; the most recent `start` sets it. A video parser skips or decodes packets with encoding 1.
- Video header (12 bytes, little-endian): sequence u16, frame u16, line u16 (bit 15 = last packet of the frame), pixels per line u16, lines per packet u8, bits per pixel u8, encoding u16. Measured U64: 384x272 pixels, 4 bpp, 68 packets of 4 lines (780 bytes), 50 frames per second, encoding 0.
- Audio packet: 2-byte sequence, then 192 stereo frames of signed 16-bit samples, 47,982.89 Hz on PAL (measured U64).
- After each video or audio start the device sends one 2-byte datagram `00 00` from another source port (measured U64); a receiver ignores datagrams shorter than a header.
- The U2 family builds do not contain these routes (`target/u64*/.../Makefile` list `route_streams.cc`; the U2 makefiles do not), so they answer 404.

## Host REST and network

- `X-Password` header: when `Network Password` (store `Network Settings`) is not empty, every REST request needs it; a wrong or missing header gives 403 `Forbidden.`.
- U64 family only: `PUT machine:poweroff` and `machine:input` (U2 family: 501, `software/api/route_machine.cc:186-216`, `route_input.cc:718-747`); `machine:debugreg` (read/write the FPGA debug register `$D7FF`) and the `streams` routes (U2 family: route absent, 404). All products: `machine:reset|reboot|pause|resume|menu_button|menu_screen|readmem|writemem|measure|heap`, `runners:*`, `drives`, `configs`, `files/{path}:info|create_d64|create_d71|create_d81|create_dnp`, `GET /v1/help?command=`, `GET /v1/version` (returns `0.1`), `GET /v1/info`.
- `GET machine:readmem`: `length` 1-65536, default 256; length 0 or 65537 gives 400 `Invalid length`; a range past `$FFFF` gives 400 `Memory read exceeds location $FFFF` (measured U64). The read is a DMA read in the current bank configuration: `$A000` and `$E000` return ROM when ROM is banked in, and a read of `$DD0D` clears the CIA2 interrupt flags as a CPU read does (measured U64).
- `PUT machine:writemem?address=<hex>&data=<hex>`: 1-128 bytes; 129 bytes give 400 `Maximum length of 128 bytes exceeded...` and write nothing. `POST machine:writemem?address=<hex>` with the bytes as body: a start plus length past `$FFFF` gives 400, but a 65,537-byte body at `$0000` returned 200 `0000-FFFF` and dropped the last byte (measured U64). Writes go through the current bank configuration, so `$D020` reaches the VIC while I/O is mapped.
- Route names are matched before percent-decoding: `machine%3Areadmem` and `inf%6F` answer 404. Escapes inside a parameter segment are decoded (`files/%2FTemp:info` = path `/Temp`), and `..` is not normalised (`configs/%2E%2E` = category `..`) (measured U64). The bridge rejects dot segments before sending.
- `files/{path}:info` with a wildcard returns the first match only; `**` behaves as `*`; no match: 404 `FILE DOESN'T EXIST`; missing root: 404 `PATH DOESN'T EXIST` (measured U64).
- `configs` GET and PUT accept `*` and `?` in category and item, case-insensitive; PUT changes the first match; POST `/v1/configs` matches names exactly. REST changes live in RAM until `PUT configs:save_to_flash`.
- `runners:run_prg` and `runners:load_prg` with `file=` apply a sidecar `.cfg` of the same name; `run_crt` and the POST upload variants do not (measured U64).
- UDP port 64 ("Ultimate Ident Service", item `Ultimate Ident Service` in `Network Settings`): a datagram is answered with product, firmware and host name; a datagram starting with `json` gets a JSON reply (`software/network/socket_dma.cc:650`; measured U64 with unicast datagrams).

## Other features

- Runtime palette: UCI control commands `$51-$54` (U64 family; public master since 2026-09-03; c64://ultimate/uci). `Palette Definition` selects a `.vpl` file as the fixed palette.
- HDMI scan lines, `Analog Video Mode` and `Adjust Color Clock` change the video output only, not C64 timing. There is no second VIC, no extra video mode and no extended VIC register.
- `Joystick Swapper`, `Mouse Mode`, `DMA Load Mimics ID:`, `Fast Reset` and `Burst Mode Patch` are launch and input settings; a program cannot read them.

## Case light and keyboard LEDs (C64U)

All statements in this section are measured C64U (camera stills and video); the public source does not contain the C64U LED controller, `$D037` or the `Keyboard Lighting` category. Settings change at once through `c64_config` and are lost at power-off unless saved.

| Group | Category | LEDs |
|---|---|---|
| Case light | `LED Strip Settings` | 84: 0-29 bottom, 30-59 top, 60-83 between the key rows (from the left end of the keyboard to the function keys) |
| Keyboard | `Keyboard Lighting` | 71 under the keys: 0-4 space bar, 70 shift lock, the rest row by row in alternating direction |

- Items in both categories: `LedStrip Mode` (`Off`, `Fixed Color`, `SID Music`, `Rainbow`, `Rainbow Sparkle`, `Sparkle` (case light only), `Default`, `Programmatic`), `LedStrip Pattern`, `Strip Intensity` 0-31, `Fixed Color` (25 hues `Red` to `White`), `Color tint`, `LedStrip SID Select`, `LedStrip Auto SID Mode`. Per-LED colour needs `Programmatic`.
- Per-LED colour with mode `Programmatic` in that category, from a C64 program or REST `writemem`:
  1. Write `$11` to `$D037`: `$D200-$D3FF` switch from VIC mirrors to the LED controllers (`$D2xx` case light, `$D3xx` keyboard). Without this write the LED writes have no effect; a C64 reset clears it.
  2. In each window, LED n uses 3 bytes at offset 3n (`$xx00-$xxFB`); `$xxFE` = global intensity; any write to `$xxFF` latches and shows the colours, so write it last.
  3. Byte order: keyboard G, R, B; case light R, G, B.
- REST: `PUT /v1/machine:writemem?address=D037&data=11`, then `address=D300&data=<hex>` for colours and `address=D3FE&data=3000` for intensity and latch. A PUT took 17 ms; a POST with a body took 195 ms regardless of size. Each request stalls the C64 CPU for the DMA. Moving one LED (6 bytes plus latch, 2 requests) reached 30 updates per second; a full frame (213 or 252 bytes, 3 requests) 13 per second. A 6502 loop wrote 600 colour-plus-latch sequences in at most 4 jiffies.
- The colours stay until overwritten, also after the program ends or the C64 resets. Groups in `Programmatic` mode are not animated.
- Keyboard hazard: after a session with the keyboard in `Programmatic`, the firmware stopped updating the keyboard LEDs; mode, pattern, colour and intensity changes, a C64 reset and clearing `$D037` had no effect, while direct register writes still worked. No action short of an Ultimate restart restored the firmware updates. The case light did not show this. Games use `Fixed Color` or `Rainbow` for the keyboard.
- UCI and the config API have no per-LED control and no LED read-back.

## VICE versus an Ultimate

| Feature | VICE |
|---|---|
| Turbo `$D030/$D031` | not emulated (reads `$FF`) |
| UCI `$DF1B-$DF1F`, palette commands, HTTP/network | not emulated |
| REU | emulated; 1 byte per cycle (VICE 3.10, measured); a transfer wraps inside a 512 KB block |
| UltiSID split and mirroring, Ultimate Audio, LEDs | not emulated |

Test program logic in VICE; test timing, turbo, REU rates and palette on hardware.

## Rerun the benchmark {#rerun}

Every "measured" figure here, in c64://ultimate/reu and in c64://gamedev/architecture comes from `data/ultimate/bench/` (c64://ultimate/bench; `results/summary.md`).
With c64bridge: `c64_config` `get`/`set` `Turbo Control` (never `save_flash`), `c64_program` `upload_run_asm` with the edited program, wait, one `c64_memory` `read` of `$C000` length 3840, decode, restore the settings. From a shell: `npm run bench:turbo -- --host <ip> --suite full`.

## Pitfalls

1. Turbo is optional: check `$D031` and keep a 1 MHz path.
2. `$D030-$D03F` and `$D07A-$D0BC` are not free RAM. Only speed indexes 0-3 mean the same MHz on every model.
3. REST memory access (`c64_memory`) stalls the CPU and disturbs timing-critical code.
4. Fastloaders under turbo: KERNAL IEC LOAD works at 16 and 48 MHz (measured U64); test each fastloader.
5. Code that matches product strings accepts unknown names.

## Not verified

| Claim | What would settle it |
|---|---|
| A C64 Ultimate firmware other than 1.2.1 offers a `Turbo Control` label other than `U64 Turbo Registers` | `GET /v1/configs/U64%20Specific%20Settings/Turbo%20Control` on each C64U firmware |
| C64U: `$DF0C-$DF0F` extended REU registers present or absent | `readmem DF0C length 4` on a C64U with REU enabled |
| Elite II `Programmatic` LED byte layout in `$D200-$D2FF` | camera test as in the C64U section on an Elite II |
| An Ultimate restart ends the keyboard LED hazard | C64U: reproduce the hazard, restart the Ultimate, change `Fixed Color` |
