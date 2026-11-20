# Ultimate fact check against GideonZ/1541ultimate

Source: clone of https://github.com/GideonZ/1541ultimate at
`700c7f2fab0b7d52da418d21f0c2e65e99725805` (2026-11-13), plus the official page
https://1541u-documentation.readthedocs.io/en/latest/config/turbo_mode.html for `$D030/$D031/$D0BC`.
Limit: the public FPGA tree has no Ultimate 64 / C64 Ultimate core (only U2/U2+ tops), so core
register behaviour and stream payload formats cannot be proven from source. Paths below are
relative to the firmware repository. Classes: WRONG, IMPRECISE, OUTDATED, MISSING, SETTLED (an
"(unverified)" mark the source confirms), UNRESOLVED. All items were applied to `data/ultimate/`,
`data/gamedev/toolchain.md` and the game-development and stream-control skills (HARD05-010).

| ID | Class | Subject | Result | Evidence |
|---|---|---|---|---|
| U1 | WRONG | UCI HTTP target and HTTPS | `https://` only selects port 443; no TLS in the public firmware, the request goes out in clear text | `software/io/command_interface/http_target.h:64-89`, `http_target.cc:921` |
| U2 | WRONG | DOS SET_TIME | sets the RTC (length must be 8); the "no longer sets the clock" claim is not in the source | `software/filemanager/dos.cc:531-575` |
| U3 | OUTDATED | Control `08/09` LOAD_REU/SAVE_REU | wedge fixed; loads/saves the configured `REU Preload Image` at `REU Preload Offset`, filename in the message unused | `control_target.cc:345-378`, `reu_preloader.cc:90-111` |
| U4 | IMPRECISE | UCI address | `$DF1C` by default, `$DE1C` for EasyFlash CRTs, `$DFFC` possible | `software/io/c64/c64.cc:1380-1395`, `c64_crt.cc:503-508` |
| U5 | SETTLED | CRT and Ultimate I/O | each CRT type prohibits colliding devices (REU, UCI, sampler, ACIA) for that run | `c64.h:243-259`, `c64.cc:1356-1450`, `c64_crt.cc:470-640` |
| U6 | IMPRECISE | UCI completion IRQ | enable bit `$20` counts only when written with PUSH (`$21`); cleared by reading `$DF1E/$DF1F` or DATA_ACC | `fpga/io/command_interface/vhdl_source/command_protocol.vhd:148-182` |
| U7 | IMPRECISE | LOAD_CONFIG | one rejected value (status `89`) leaves the whole file unapplied; the file-browser path applies valid lines | `control_target.cc:576-600`, `software/userinterface/configio.cc:262-330, 441-455` |
| U8 | SETTLED | LOAD_CONFIG persistence | RAM only; flash needs an explicit save | `configio.cc` (`staleFlash`) |
| U9 | IMPRECISE | sidecar `.cfg` | applied by file-browser Run/Load of PRG (also `.usr`), CRT, Run Disk, G64, TAP and by REST `run_prg`/`load_prg` with `file=`; not by REST `run_crt` or uploads | `configio.cc:480-505`, `filetype_prg.cc:165-192`, `route_runners.cc:180-190` |
| U10 | SETTLED (partly) | `Turbo Control` labels | `Off`, `Manual`, `U64 Turbo Registers`, `TurboEnable Bit`; `C64U Turbo Registers` not in product source; store name is `U64 Specific Settings` | `software/u64/u64_config.cc:328, 390, 910, 948` |
| U11 | SETTLED | Ultimate Audio sampler | register map confirmed (see `data/ultimate/hardware.md`) | `fpga/io/sampler/vhdl_source/*.vhd`, `software/io/audio/sampler.h` |
| U12 | IMPRECISE | product string | public source has `Ultimate 64-II` for the Elite II / C64U build; "C64 Ultimate" is device-measured | `software/system/product.cc:11-19` |
| U13 | IMPRECISE | `System Mode` | six values including PAL-60, NTSC-50 and `/L` variants; detect timing by raster | `u64_config.cc:278, 351`, `color_timings.cc:7-9` |
| U14 | IMPRECISE | `/v1/info` fields | also `git_commit_hash`, `hostname`, `unique_id`, MAC addresses | `software/api/routes.cc:171-186` |
| U15, U16 | IMPRECISE | UCI status codes | differ per target; lists corrected | `network_target.cc:20-27`, `dos.cc:16-31`, `control_target.cc:27-35` |
| U17 | IMPRECISE + SETTLED | DOS LOAD_REU/SAVE_REU | little-endian, no 32 KB limit, truncation at 16 MB, ABORT stops load only | `dos.cc:255-324` |
| U18 | IMPRECISE | GET_HWINFO bytes 3-4 | unreachable branch; stay 0 | `control_target.cc:380-478` |
| U19 | SETTLED | SID range split | decoder arithmetic confirmed | `u64_config.cc:1236-1258` |
| U20 | IMPRECISE | storage names | `/Usb0/`, `/Usb1/`, `/SD/`, case-insensitive | `c64.cc:94`, `io/usb/usb_device.cc:415` |
| U21, U22 | MISSING | UCI commands | ECHO, SET_INTERFACE, ramdisk, SoftwareIEC channel commands and others added | `dos.h`, `control_target.h`, `network_target.h`, `softiec_target.h` |
| U23 | UNRESOLVED | extended REU registers | meaning confirmed; absent on public U2/U2+ tops, presence on U64 cores unknown | `fpga/cart_slot/vhdl_source/reu.vhd`, `reu_pkg.vhd` |
| U24, U25 | SETTLED | REU status bit 4, boot preload | as documented | `reu.vhd:436`, `reu_preloader.cc:14-80` |
| U26 | SETTLED | turbo items and speed tables | match; `$D07A/$D07B` and badline bit polarity unresolved | `u64_config.cc:324-397, 1675-1708` |
| U27 | IMPRECISE | `machine:writemem` / `readmem` | PUT 128 bytes, POST 65536, read 1..65536 | `software/api/route_machine.cc:218-345` |
| U28 | UNRESOLVED | LEDs | `$D037`, keyboard lighting and extra modes are not in the public source; section stays device-measured | `software/u64/led_strip.cc:53-68, 415-423` |

Client-side notes: video `palette=1` adds 60-byte palette packets with encoding field 1
(`route_streams.cc:39-50`, `data_streamer.cc:403-445`); the capture now ignores them (HARD05-001).
Streams leave only through wired Ethernet. Route set, verbs and parameter names of the server's
REST calls match the firmware; `machine:heap` and `machine:measure` are unused.

Not checked: DOS directory and file-info layouts, SoftwareIEC argument layouts, HTTP target body
handling, `data/gamedev/techniques.md`, `architecture.md`, `references.md`, the Upic performance
claims, and all behaviour on hardware.
