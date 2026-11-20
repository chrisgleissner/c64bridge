# Ultimate Command Interface (UCI)

**Summary:** UCI is a polled register interface at `$DF1C-$DF1F` (`$DF1B` = IEC device number; a loaded EasyFlash `.crt` moves it to `$DE1C-$DE1F`) through which a C64 program asks the Ultimate to read/write files, open sockets, make HTTP requests, load files straight into RAM or REU, change the palette and reboot. It is off by default. Commands are `<target> <command> <args>`; replies are data bytes plus a status string. Targets: 1/2 DOS, 3 Network, 4 Control, 5 SoftwareIEC, 6 HTTP.
**Read when:** a game must load levels or data from the Ultimate's storage, save high scores, change the palette, use the network, or detect an Ultimate.

Sources: firmware `software/io/command_interface/`, `software/filemanager/dos.cc`, `software/io/network/network_target.cc` and the gateware `fpga/io/command_interface/vhdl_source/command_protocol.vhd` of GideonZ/1541ultimate master 700c7f2fa (2026-11-13). "Measured U64" = Ultimate 64 Elite, firmware 3.15a, 2026-11-20; "measured C64U" = C64 Ultimate, firmware 1.2.1, 2026-11-13. "Since YYYY-MM-DD" = commit date in the public master; a device can run older firmware. No UCI version command exists: send the command and check for `21,UNKNOWN COMMAND`. Docs: https://1541u-documentation.readthedocs.io/en/latest/uci/index.html. SDK (MIT): https://github.com/barryw/ultimate-uci-sdk. Enable with `c64_config` ("C64 and Cartridge Settings" / `Command Interface` = Enabled).

## Registers (all polled; I/O must be visible, `$01` bit 2 set)

Base `$DF1C`. A loaded `.crt` decides the location (c64://ultimate/hardware, I/O area): EasyFlash CRTs get `$DE1B-$DE1F` and have UCI switched on even when `Command Interface` is `Disabled`; C128 std-IO subtypes 1 and 2 get `$DF1C` switched on; other types with `PROHIBIT_DFXX` switch it off. A PRG sees `$DF1C`. A CRT program probes `$DE1D` and `$DF1D`. The firmware slot base values are `$47` = `$DF1C`, `$07` = `$DE1C`, `$7F` = `$DFFC` (no CRT type selects `$DFFC`) (`software/io/c64/c64.cc:1370-1386`).

| Addr | Read | Write |
|---|---|---|
| `$DF1B` | KERNAL device number of the SoftwareIEC drive: `Soft Drive Bus ID` (default 11), or 31 when `IEC Drive` = `Disabled` (`software/io/iec/iec_drive.cc:34,553`) | - |
| `$DF1C` | Status | Control (bits are commands) |
| `$DF1D` | Identification `$C9` (`$49` while UCI interrupt pending) | Command byte |
| `$DF1E` | Response data byte | - |
| `$DF1F` | Status data byte | - |

Control (write, literal values only): `$01` PUSH_CMD, `$02` DATA_ACC (release block), `$04` ABORT, `$08` CLR_ERR, `$20` IRQ on completion (gateware since 2026-03-08; latched only together with PUSH_CMD, so write `$21`; asserts IRQ, not NMI, while STATE is data-last or data-more; cleared by a read of `$DF1E` or `$DF1F` or by DATA_ACC; `$DF1D` reads `$49` while it is asserted), `$40` TRIGGER and `$80` DMA (freeze bus; latched only with PUSH_CMD; not a speed-up).
Status (read, `command_protocol.vhd:55-61,140-170`): bit0 CMD_BUSY, bit1 DATA_ACC, bit2 ABORT_P, bit3 ERROR (PUSH_CMD while STATE was not idle; cleared by writing `$08`), bits 4-5 STATE (`$00` idle, `$10` busy, `$20` data-last, `$30` data-more), bit6 STAT_AV (byte at `$DF1F`), bit7 DATA_AV (byte at `$DF1E`).

## Exchange

1. Wait STATE = idle. 2. Write command bytes to `$DF1D` (target first). 3. Write `$01` to `$DF1C`. 4. Poll until STATE leaves busy. 5. Read `$DF1E` while DATA_AV, then `$DF1F` while STAT_AV. 6. Write `$02`. data-last returns to idle; data-more returns to busy for another block (back to 4).

- Never read-modify-write `$DF1C` (reads return status, not control). No `inc`/`ora`/`asl` on it.
- Use absolute addressing for UCI/REU registers (indexed stores do a dummy read).
- Only a command whose first byte has bit 7 set (no-reply flag, e.g. `$84 $05`) has no data phase: the firmware returns STATE to idle (`software/io/command_interface/command_intf.cc:274-281`). A zero-length PUSH_CMD ends in data-last with no bytes; write `$02`. REBOOT (`04 06`) restarts the C64, so the program does not see the end of the exchange.
- Target = first byte `& $0F`. Second byte = command; `$01` is IDENTIFY on every target. Unimplemented targets answer IDENTIFY with `NO TARGET` and any other command with `21,UNKNOWN COMMAND`.
- Limits: command 895 bytes (further bytes overwrite the last one), response block 895 bytes, status 255 bytes (`command_protocol.vhd:144-147`, `command_target.h:79-86`). Bound every read loop by these sizes.
- Strings in network commands need no terminator (host names resolved with and without `$00`). The file name of LOAD_CONFIG (`04 50`) must end with `$00`: without it the C64U (1.2.1) and the U64 (3.15a) answered `88,CANNOT OPEN CONFIG FILE` for an existing file in 7 of 8 and 3 of 3 calls (measured on C64 Ultimate, firmware 1.2.1, 2026-11-20) (an earlier U64 session without `$00` got `00`/`89`; the cause, probably stale bytes in the command buffer, is not established). Names and URLs are ASCII: convert from PETSCII (cc65 literals arrive case-swapped).
- Stuck interface (data-more after an abandoned read): write `$02` until STATE < data-last, then `$04`, then `$08`. Do this at startup too (a crashed program can leave half-written command bytes).
- The firmware sets no timeout that the C64 can see. Bound every poll loop with a deadline from the jiffy clock (`$A0-$A2`, advanced 60 times per second by the KERNAL IRQ from CIA 1, which keeps C64 time under turbo); network and HTTP commands wait for the remote side.
- One command in flight; an IRQ handler may run but must not use UCI. During SoftwareIEC loads, REU DMA and U64_SAVEMEM the machine is halted (music and raster IRQs stop).
- A C64 reset aborts the command in flight, closes all network sockets and frees all HTTP header and body handles (`command_intf.cc:46-53,185-190`, `http_target.cc:1140-1143`). The DOS targets keep their open file and current directory. At startup send DOS CLOSE_FILE (`84` = nothing open is fine).

## Detection

- `$DF1D & $7F = $49`: UCI on (at `$DE1D` instead when running as an EasyFlash CRT). Anything else: absent or off (a real REU returns `$FF`). Tell the user to enable `Command Interface`.
- Then IDENTIFY (`<target> 01`) once per target used; `NO TARGET` = absent.

## Status strings

| Form | Used by | Success |
|---|---|---|
| `NN,TEXT` | DOS, Network, Control; SoftwareIEC OPEN, CLOSE, CHKOUT | `00,OK`; DOS READ_DATA blocks, FREEZE and REBOOT send no status bytes |
| `NNN TEXT` | HTTP target errors | `000 OK`; after an exchange: server response line plus headers (up to 255 bytes) |
| 1 binary byte (LOAD_EX: 3 bytes) | SoftwareIEC LOAD, SAVE, CHKIN, partition commands | `$00` |
| bare text (`DISK IS FULL`, `WRITE PROTECTED`, ...) | DOS filesystem failures | non-digit first char = failure |

Codes mean different things per target, so key on target plus code. `21` UNKNOWN COMMAND on every target.

| Target | Codes |
|---|---|
| DOS | `01` dir empty, `02` request truncated, `81` NOT IN DATA MODE, `82` file not found, `83` no such directory, `84` no file to close, `85` no file open, `86` can't read directory, `87` internal error, `88` no information, `89` not a disk image, `90` drive not present, `91` incompatible image, `98` function prohibited, `99` not implemented |
| Network | `01` connection closed by host, `02,NO DATA: <errno>`, `03` more data not supported, `04,DATAGRAM TRUNCATED: <n>`, `11,ERROR ON CONNECT: <errno>`, `12,SEND ERROR` / `ERROR ON CLOSE`, `81` invalid params, `82` parameter out of range (READ_SOCKET length above 1472), `83` interface not available, `84` unresolved host, `85` error opening socket, `86` internal error |
| Control | `81` invalid params, `82` errors on track, `83` not in data mode, `84` REU not enabled, `85` REU file cannot be opened, `86` REU offset > size (not saved), `87,DISK ERR: ...` (U64_SAVEMEM), `88` cannot open config file, `89` config file had errors |

## Target 1 and 2: DOS (files, directories, images, REU files, clock)

Instances 1 and 2 are independent (own current directory, own open file): use 2 for a second stream. `/Temp` is a RAM file system, lost at power-off. Volume names depend on the device and port (the measured U64 named its USB stick `USB2`): list the root with CHANGE_DIR `/`, OPEN_DIR, READ_DIR and use the names returned.

| Cmd | Name | Args | Reply |
|---|---|---|---|
| 01 | IDENTIFY | - | `ULTIMATE-II DOS V1.2` |
| 02 | OPEN_FILE | `<attrib> <name>` | status |
| 03 | CLOSE_FILE | - | status |
| 04 | READ_DATA | `<len:16>` little-endian | data in blocks of 512 bytes; the last block is shorter or ends `len`; no status bytes on success (`dos.cc:472-482,790-809`) |
| 05 | WRITE_DATA | `00 00 <data>` | data starts at byte 4 (`dos.cc:483-498`); up to 891 bytes per command |
| 06 | FILE_SEEK | `<pos:32>` little-endian | status |
| 07 | FILE_INFO | - | info record of open file |
| 08 | FILE_STAT | `<name>` | info record; `82` if missing |
| 09-0B | DELETE / RENAME / COPY_FILE | `<name>` / `<old> 00 <new>` / `<src> 00 <dst>` | status |
| 11 | CHANGE_DIR | `<dir>` | `.`/`..` work; also enters .D64 etc. so OPEN_FILE reads inside the image |
| 12 | GET_PATH | - | path |
| 13 | OPEN_DIR | - | `01` if empty; snapshots the directory |
| 14 | READ_DIR | - | one block per entry: `<attrib> <long name>`; last carries `00,OK` |
| 16 | CREATE_DIR | `<dir>` | status |
| 15 / 17 | COPY_UI_PATH / COPY_HOME_PATH | | 15 answers `99`; 17 copies the home path |
| 21 | LOAD_REU | `<addr:32> <len:32>` (little-endian) | file to REU from open file, no C64 involvement; text `$xxxxxx BYTES LOADED TO REU $xxxxxx` (space-padded hex, 35 bytes) |
| 22 | SAVE_REU | `<addr:32> <len:32>` (little-endian) | REU to open file; text `$xxxxxx BYTES SAVED FROM REU $xxxxxx` (36 bytes) |
| 23 | MOUNT_DISK | `<id> <image>` | id = IEC address of a powered drive, 0 = last mounted drive (drive A if none); no match: `90` (`dos.cc:69-83,325-336`) |
| 24 / 25 | UMOUNT / SWAP_DISK | `<id>` | |
| 26 | GET_TIME | `[fmt]` | 19 bytes `yyyy/mm/dd hh:mm:ss` (fmt 1: weekday prefix, 23 bytes) |
| 27 | SET_TIME | `<y-1900> <mon> <day> <h> <min> <s>` | message length 8, else status `21` and reply = the length as two digits; sets the Ultimate clock and the RTC chip, then replies weekday and time (23 bytes) (`dos.cc:531-576`) |
| 41 / 42 | LOAD_INTO_RAMDISK / SAVE_RAMDISK | | RAM disk image transfer (not for games) |
| F0 | ECHO | any bytes | returns the command bytes: liveness and throughput test |

- OPEN attrib bits: `$01` read, `$02` write, `$04` create new (truncates), `$08` create always. Read `$01`; write/overwrite `$0E`. Always CLOSE before opening another file.
- Info record: size:32, FAT date:16, FAT time:16, ext 3, attrib 1, name (reply length minus 12). READ_DIR attrib: `$01` read-only, `$02` hidden, `$04` system, `$08` volume, `$10` directory, `$20` archive.
- A directory walk is one live exchange: no other command until it ends, or abort.
- LOAD_REU/SAVE_REU (`dos.cc:255-323`): addr uses bits 23-0, len bits 24-0; `addr + len` above 16 MB is cut to the end with status `02,REQUEST TRUNCATED`. The command addresses a 16 MB REU whatever `REU Size` says. One command moves up to 16 MB minus addr. A load stops on ABORT (status `02`); a save always runs to the end. See c64://ultimate/reu.

## Target 3: Network (client only, reads never block)

| Cmd | Name | Args | Reply |
|---|---|---|---|
| 01 | IDENTIFY | - | `ULTIMATE-II NETWORK INTERFACE V1.0` |
| 02 | GET_INTERFACE_COUNT | - | count |
| 03 | SET_INTERFACE | `<if>` | select interface |
| 04-06 | GET_NETADDR / GET_IPADDR / SET_IPADDR | `<if> [12 bytes]` | MAC (6); IP, mask, gateway (4 each) |
| 07 | OPEN_TCP | `<port:16> <host or IP>` | socket handle |
| 08 | OPEN_UDP | `<port:16> <host or IP>` | handle (connected socket) |
| 09 | CLOSE_SOCKET | `<h>` | status |
| 10 | READ_SOCKET | `<h> <len:16>` | `<count:16>` then payload |
| 11 | WRITE_SOCKET | `<h> <data>` | 2-byte count sent |

- OPEN_TCP and OPEN_UDP resolve host names themselves. Interfaces are numbered from 0; query each with GET_IPADDR and use one whose IP is not `0.0.0.0`.
- READ_SOCKET answers at once; with nothing waiting the status is `02,NO DATA: <errno>`. Poll once per frame or less often. The source (since 2026-08-27) accepts up to 1472 bytes per read and returns them in several reply blocks; a longer request gives `82`; a UDP datagram longer than the request gives `04,DATAGRAM TRUNCATED: <n>` (`network_target.h:41`, `network_target.cc:540-556`). Request at most 512 bytes so that older firmware answers in one block.
- After `01,CONNECTION CLOSED BY HOST` the handle is already released.
- OPEN_TCP blocks until the connection is made or fails; open sockets before the game loop, behind a status screen. Never connect to the device's own address. Timing of the call, measured with the jiffy clock (measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20): `03 07 50 00 "192.0.2.1"` (TEST-NET-1, no host answers) returned `11,ERROR ON CONNECT: 113` after 18.02 to 18.35 s (3 runs: 1081, 1089 and 1101 jiffies, 1 jiffy = 1/60 s). `03 07 50 00 "h6-nohost.invalid"` returned `84,UNRESOLVED HOST` in 0 or 1 jiffy (17 ms or less).
- 16 sockets (`NET_MAX_SOCKETS`), all closed at a C64 reset. The public firmware has no inbound listener: multiplayer needs a relay server or UDP.
- Wire: `03 07 <portlo> <porthi> <host>`; `03 10 <h> 00 02` reads 512.

## Target 4: Control

| Cmd | Name | Args | Notes |
|---|---|---|---|
| 01 | IDENTIFY | - | `CONTROL TARGET V1.1` |
| 05 | FREEZE | - | opens the Ultimate menu; send as no-reply `84 05` |
| 06 | REBOOT | - | reboots the C64 (`MENU_C64_REBOOT`) |
| 03 | FINISH_CAPTURE | - | ends a tape capture (not for games) |
| 08 / 09 | LOAD_REU / SAVE_REU | `<3+ filler bytes>` | no filename is read: `08` loads the file set in `REU Preload Image` into the REU at `REU Preload Offset` (up to `REU Size` minus offset; needs `RAM Expansion Unit` Enabled, `REU Preload` may be Disabled); `09` writes the REU back to that file (an existing file is renamed `.bu`). Reply: 4-byte little-endian result (bytes moved; -1 file error, -2 REU disabled, -3 offset past `REU Size`) plus the upper-case log text; statuses `81` (command shorter than 5 bytes), `84`, `85`, `86` (`control_target.cc:345-378`, `software/io/c64/reu_preloader.cc:82-176`). DOS `21`/`22` take any file and offset |
| 0F | U64_SAVEMEM | `[<filename>]` | U64 family; saves the 64 KB RAM to the file (default `/temp/c64_memory.bin`) with the C64 halted; status `00,OK` or `87,DISK ERR: <text>` |
| 28 | GET_HWINFO | `[sub]` | 0 (or omitted) = product string; 1 = SID decoder list (count, 5 bytes each; c64://ultimate/multisid); other: `81` |
| 11 / 12 | DECODE_TRACK / ENCODE_TRACK | | disk track tools (not for games) |
| 20 | EASYFLASH | | EasyFlash sector tool (not for games) |
| 29 | GET_DRVINFO | `[mode]` | count, then 3 bytes per drive: type (`00` 1541, `01` 1571, `02` 1581, `0F` SoftwareIEC, `50` printer), IEC address (mode 1 or omitted: effective address; 0: configured address), power `00`/`01` (`control_target.cc:216-248`) |
| 30-35 | drive A/B power | - | `30` A on, `31` A off, `32` B on, `33` B off, `34`/`35` read power (`off`/`on `) |
| 40 | GET_RAMDISKINFO | | RAM disk info (not for games) |
| 50 | LOAD_CONFIG | `[<filename>]` | applies a `.cfg` (rule below); measured C64U and U64 |
| 51 | GET_PALETTE | - | 48 bytes: 16 x R,G,B; message length must be 2 |
| 52 | SET_PALETTE | 48 bytes | message length must be 50 |
| 53 | SET_PALETTE_COLOR | `<idx 0-15> <r> <g> <b>` | message length must be 6 |
| 54 | RESET_PALETTE | - | restores the built-in default colours (`default_colors`, `u64_config.cc:2881-2884`); message length must be 2 |

Not available: reset without reboot, run PRG, change CPU speed, single config get/set, SID/mixer control except by LOAD_CONFIG, input injection, power off. READ_RTC `02` answers `21`.

**Palette `$51-$54`** (U64 family only, `#ifdef U64` in `control_target.cc:250-301`; U2 family answers `21`; public master since 2026-09-03; a wrong length gives `81,INVALID PARAMS`): 8 bits per channel, applied to the whole display at once, kept in RAM only (nothing is saved). `04 53` and `04 54` measured U64. One blocking palette command took 12-58 ms on the measured C64U, so a program issues it as a non-blocking step (push the command, check the status once per frame, one command in flight) or under a fade, and never per raster line. Send `04 54` on exit. Raw: `04 53 02 FF FF FF` sets colour 2 to white. See also c64://ultimate/upic.

**LOAD_CONFIG** (`04 50 <name>`, default `/temp/uci_config.cfg`; `control_target.cc:559-609`, parser `software/userinterface/configio.cc:230-434`) is the only way a C64 program changes settings. Write the `.cfg` with the DOS target, then send the command.
- Format: `[Store Name]` line, then `Item=value` lines; lines starting with `#` or `;` are comments; at most 319 characters per line, item names at most 40. Only the listed items change. Enum values compare case-insensitively with spaces before and after ignored; string values are taken exactly; number items are read with `%d`. Stores: `[C64 and Cartridge Settings]` (`Command Interface`, REU items), `[U64 Specific Settings]` (`Turbo Control`, `CPU Speed`, `Badline Timing`, `System Mode`, `Palette Definition`), `[Audio Mixer]`, `[SID Addressing]`. A `.cfg` saved from the menu is a correct template.
- Status `00,OK`: every line applied and the changed stores effectuated. An unknown `[store]` or item is skipped, logged and still gives `00`.
- Status `89,CONFIG FILE HAD ERRORS` when any line has an invalid enum value, a non-number for a number item, no `=`, an empty item name, more than 319 characters, or stands outside a store section. Then no store is effectuated: the values of the valid lines are stored in RAM and take effect at the next apply of their store (a later successful LOAD_CONFIG or a menu change). Measured U64: one invalid line returned `89` with reply `Line 3: Value 'BOGUS' is not a valid choice for item Vol Drive 2`, and REST showed the valid line's new value. Fix the file and send it again. Turbo example: `CPU Speed=64` is invalid on a U64 / Elite MK1 and `CPU Speed=5` on an Elite II / C64U (c64://ultimate/hardware).
- Status `88,CANNOT OPEN CONFIG FILE` when the file is missing (measured U64) or when the name is not terminated by `$00`.
- Reply data = the parse log, at most 511 bytes.
- The file-browser load and the `run_prg` sidecar `.cfg` apply the valid lines even when other lines fail (c64://gamedev/toolchain).
- Changes stay in RAM: lost at power-off unless saved from the menu or with REST `configs:save_to_flash`. Example and SID use: c64://ultimate/multisid.

## Target 5: SoftwareIEC (fast load into C64 RAM)

| Cmd | Name | Args | Reply / status |
|---|---|---|---|
| 01 | IDENTIFY | - | `SOFTWARE IEC TARGET V1.0` |
| 10 | LOAD_SU | `<sec> <verify> <addr:16> 00 00 <name>` | 2 bytes: file load address; if sec = 0, `addr` is used |
| 11 | LOAD_EX | `<sec> <verify>` | copies into RAM; status `00` + end address:16 |
| 12 | SAVE | `<verify> <sec> <start:16> <end:16> <name>` | PRG file |
| 13 | OPEN | `<sec> <unused> <name>` | opens a channel of the SoftwareIEC drive; status `00,OK` |
| 14 | CLOSE | `<sec> <unused>` | status `00,OK` |
| 15 | CHKIN | `<sec> <unused>` | reply = bytes read from the channel; status `$00`, or `$03` without input channel. Measured U64: CHKIN 15 returned `73,U64HD ULTIMATE DOS V2.0,00,00`; the bytes arrive over several exchanges |
| 16 | CHKOUT | `<sec> <unused> <data>` | sends `<data>` to the channel; with `sec` = `$Fx` the data is a file name to open, with `$Ex` the channel is closed (`softiec_target.cc:305-333`); status `00,OK` |
| 20-23 | ADD_PARTITION / DEL_PARTITION / GET_FATNAME / GET_IECNAME | | partition and name mapping (not for games) |

Binary status (`softiec_target.cc:12-21,185`): `00` OK, `01` not found, `02` save error, `03` no input channel, `04` unknown command, `05` IEC drive not available, `06` invalid params, `07` invalid name, `08` invalid partition, `09` invalid dir, `80` verify error. The firmware stops the C64 during the copy, writes into the flat RAM view (RAM under I/O and ROM), and stops at 64 KB.
- `IEC Drive` (store `SoftIEC Drive Settings`, since 2026-09-23): `UCI Only` (default), `Enabled` or `Disabled` (`iec_drive.cc:31,37,165`); `Disabled` makes every command of this target answer `05`. Fall back to DOS OPEN/READ/CLOSE.

## Target 6: HTTP (firmware 3.15, 2026-05)

Header and body objects live in the Ultimate (16 slots each, `MAX_HTTP_HANDLES`, machine-wide). A C64 reset frees them all; a program that ends without a reset leaves them allocated, so send FREE_ALL at startup. An exchange keeps the command busy until name lookup, connect and transfer finish. HTTPS is not supported: an `https://` URL only selects port 443 (`http_target.h:77-86`) and the request goes out as plain HTTP over a TCP socket (`software/network/http_request.cc:6-40`; the application has no TLS code). Use `http://` or a relay you control. There are no range requests: the program reads the body in blocks and stops when its buffer is full.

| Cmd | Name | Args | Reply |
|---|---|---|---|
| 01 | IDENTIFY | - | `ULTIMATE HTTP TARGET V1.0` |
| 10 | FREE_ALL | - | |
| 11 / 12 | HEADER_CREATE / FREE | `<verb> <url>` / `<h>` | header handle; verbs GET 01 PUT 02 POST 03 PATCH 04 DELETE 05 HEAD 06 OPTIONS 07 CONNECT 08 TRACE 09 |
| 13 / 14 / 15 | HEADER_ADD / QUERY / LIST | `<h> "Key: value"` / `<h> <key>` / `<h> <index>` | |
| 21 / 22 | BODY_CREATE / FREE | `<fmt>` / `<h>` | formats: BINARY 01, JSON OBJECT 02, JSON ARRAY 03, URL ENCODED 04 |
| 23-27 | BODY_ADD_INT/BOOL/STRING/OBJECT/ARRAY | `<h> <keylen> <key> <value>` | |
| 2A | BODY_QUERY | `<h> <path>` | typed value; the Ultimate parses JSON, the C64 needs no parser |
| 28 / 29 / 2B | BODY_UP / REMOVE / MOVE | | edit the body tree |
| 2C-2E | BODY_ADD_BINARY / ADD / CLEAR | | binary: repeat to append |
| 31 | DO_EXCHANGE_OBJ | `<hdr> <body or FF>` | response header and body handles |
| 32 | DO_EXCHANGE_RAW | `<hdr> <body or FF>` | response body bytes in blocks; status = server response line plus headers |

HTTP errors: `400` bad command/index, `404` key/entry not found, `500` bad format, `503` service unavailable, `507` no free slot. Minimal GET: `06 11 01 <url>` then `06 32 <hdr> FF`, read body blocks, `06 12 <hdr>`. URL `http://host[:port]/path`; Content-Type/Length are added automatically for bodies.

## Game use

- Levels: DOS open/seek/read 512-byte blocks (pack levels in one indexed file), SoftwareIEC LOAD for whole PRGs, or LOAD_REU once then DMA per level (c64://ultimate/reu).
- High scores: open `$0E`, WRITE_DATA, CLOSE; read back with `$01`; FILE_STAT checks existence/size. Handle `DISK IS FULL`/`WRITE PROTECTED`. Do not use `/Temp` for persistence.
- Settings: write a `.cfg`, send LOAD_CONFIG, check for `00,OK` (any `89` applies nothing to the hardware; RAM only). Reload the REU at run time from the preload image with Control `04 08`. Network play: TCP/UDP relay or HTTP JSON; never block in the frame loop.

## Minimal 6502 routine (ca65 syntax, fresh example)

```
UCI_CTRL = $DF1C        ; write
UCI_STAT = $DF1C        ; read
UCI_CMD  = $DF1D
UCI_ID   = $DF1D
UCI_RESP = $DF1E
UCI_SDAT = $DF1F
; zp cmdp -> command bytes; rbuf, sbuf = reply buffers (255 bytes max)

; presence: lda UCI_ID / and #$7F / cmp #$49 (Z set = present)
uci_cmd:                ; X = command length (1..255); returns A = final STATE bits
@idle:  lda UCI_STAT    ;  add a timeout in real code
        and #$30
        bne @idle
        ldy #0
@send:  lda (cmdp),y
        sta UCI_CMD
        iny
        dex
        bne @send
        lda #$01        ; literal PUSH_CMD
        sta UCI_CTRL
@busy:  lda UCI_STAT
        and #$30
        cmp #$10
        beq @busy
        ldy #0          ; response bytes, bounded at 255
@rd:    lda UCI_STAT
        bpl @st         ; bit 7 clear: no data
        lda UCI_RESP
        sta rbuf,y
        iny
        bne @rd
@st:    ldx #0
@sd:    lda UCI_STAT
        and #$40
        beq @done
        lda UCI_SDAT
        sta sbuf,x
        inx
        bne @sd
@done:  lda UCI_STAT
        and #$30        ; $20 data-last, $30 data-more, $00 no data phase
        pha
        lda #$02        ; DATA_ACC
        sta UCI_CTRL
        pla
        rts
```
Y after `@rd` is the byte count (0 = none or 256). For `$30` (more blocks) repeat from `@busy`. Example: `01 01` (DOS IDENTIFY) gives `ULTIMATE-II DOS V1.2`, status `00,OK`. Further reading: ultimate-uci-sdk (MIT).

## Not verified

| Claim | What would settle it |
|---|---|
| On firmware 3.15 a READ_SOCKET of 800-1023 bytes takes the device off the network (reason for the 512-byte rule) | U64 request U-2 |
