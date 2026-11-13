# Ultimate Command Interface (UCI)

**Summary:** UCI is a polled register interface at `$DF1B-$DF1F` through which a C64 program asks the Ultimate to read/write files, open sockets, make HTTP requests, load files straight into RAM or REU, change the palette and reboot. It is off by default. Commands are `<target> <command> <args>`; replies are data bytes plus a status string. Targets: 1/2 DOS, 3 Network, 4 Control, 5 SoftwareIEC, 6 HTTP.
**Read when:** a game must load levels or data from the Ultimate's storage, save high scores, change the palette, use the network, or detect an Ultimate.

Marks: "(unverified)" = inferred. Dates = when added to public firmware master (github.com/GideonZ/1541ultimate); a device may be older. No UCI version command exists: try the command, check for `21,UNKNOWN COMMAND`. Docs: https://1541u-documentation.readthedocs.io/en/latest/uci/index.html. SDK (MIT): https://github.com/chrisgleissner/ultimate-uci-sdk. Enable with `c64_config` ("C64 and Cartridge Settings" / `Command Interface` = Enabled).

## Registers (all polled; I/O must be visible, `$01` bit 2 set)

| Addr | Read | Write |
|---|---|---|
| `$DF1B` | SoftwareIEC device number (0 unset) | - |
| `$DF1C` | Status | Control (bits are commands) |
| `$DF1D` | Identification `$C9` (`$49` while UCI interrupt pending) | Command byte |
| `$DF1E` | Response data byte | - |
| `$DF1F` | Status data byte | - |

Control (write, literal values only): `$01` PUSH_CMD, `$02` DATA_ACC (release block), `$04` ABORT, `$08` CLR_ERR, `$20` IRQ on completion (firmware 3.15+; asserts the IRQ line, not NMI, per the VHDL), `$40` TRIGGER and `$80` DMA (freeze bus; latched only with PUSH_CMD; not a speed-up).
Status (read): bit0 CMD_BUSY, bit1 DATA_ACC, bit2 ABORT_P, bit3 ERROR (command pushed while not idle), bits 4-5 STATE (`$00` idle, `$10` busy, `$20` data-last, `$30` data-more), bit6 STAT_AV (byte at `$DF1F`), bit7 DATA_AV (byte at `$DF1E`).

## Exchange

1. Wait STATE = idle. 2. Write command bytes to `$DF1D` (target first). 3. Write `$01` to `$DF1C`. 4. Poll until STATE leaves busy. 5. Read `$DF1E` while DATA_AV, then `$DF1F` while STAT_AV. 6. Write `$02`. data-last returns to idle; data-more returns to busy for another block (back to 4).

- Never read-modify-write `$DF1C` (reads return status, not control). No `inc`/`ora`/`asl` on it.
- Use absolute addressing for UCI/REU registers (indexed stores do a dummy read).
- No data phase (state goes busy then idle): REBOOT, a zero-length command, and any command whose first byte has bit 7 set (no-reply flag, e.g. `$84 $05`). Do not wait for a data state.
- Target = first byte `& $0F`. Second byte = command; `$01` is IDENTIFY on every target. Unimplemented targets answer IDENTIFY with `NO TARGET` and any other command with `21,UNKNOWN COMMAND`.
- Limits: command 895 bytes, response block 895, status 255. A reply that exactly fills a queue leaves DATA_AV set forever: bound every read loop.
- Strings need no terminator. Names and URLs are ASCII: convert from PETSCII (cc65 literals arrive case-swapped).
- Stuck interface (data-more after an abandoned read): write `$02` until STATE < data-last, then `$04`, then `$08`. Do this at startup too (a crashed program can leave half-written command bytes).
- Nothing is timed: use bounded poll loops (200x256 polls is about 1.5 s at 1 MHz; network/HTTP need far longer; scale with turbo).
- One command in flight; an IRQ handler may run but must not use UCI. During SoftwareIEC loads, REU DMA and U64_SAVEMEM the machine is halted (music and raster IRQs stop).
- A C64 reset releases network sockets but not HTTP handles or (probably) the DOS file: on startup ABORT, close the DOS file, FREE_ALL HTTP.

## Detection

- `$DF1D & $7F = $49`: UCI on. Anything else: absent or off (a real REU returns `$FF`). Tell the user to enable `Command Interface`.
- Then IDENTIFY (`<target> 01`) once per target used; `NO TARGET` = absent.

## Status strings

| Form | Used by | Success |
|---|---|---|
| `NN,TEXT` | DOS, Network, Control | `00,OK`; some commands return no status bytes |
| `NNN TEXT` | HTTP target errors | `000 OK`; after exchange: server response line plus headers (<=255 bytes) |
| 1 binary byte | SoftwareIEC | `$00` |
| bare text (`DISK IS FULL`, `WRITE PROTECTED`, ...) | DOS filesystem failures | non-digit first char = failure |

Codes mean different things per target, so key on target plus code. Common: `01` dir empty / connection closed by host, `02` request truncated / no data, `04` datagram truncated, `11` connect error, `12` send/close error, `21` UNKNOWN COMMAND, `81` INVALID PARAMS, `82` DOS file not found, `83` DOS no such directory / net interface not available, `84` DOS no file to close / net unresolved host / control REU not enabled, `85` DOS no file open / net socket error, `88`/`89` config file cannot open / had errors (control), `89` not a disk image (DOS), `90` drive not present, `98` prohibited.

## Target 1 and 2: DOS (files, directories, images, REU files, clock)

Instances 1 and 2 are independent (own current dir, own open file): use 2 for a second stream. Start dir = root of primary storage. `/Temp` is a RAM file system (lost at power off); persistent: `/USB1/...`, `/SD/...` (check names with GET_PATH/READ_DIR).

| Cmd | Name | Args | Reply |
|---|---|---|---|
| 01 | IDENTIFY | - | `ULTIMATE-II DOS V1.2` |
| 02 | OPEN_FILE | `<attrib> <name>` | status |
| 03 | CLOSE_FILE | - | status |
| 04 | READ_DATA | `<len:16>` | bytes in 512-byte blocks; shorter block = EOF; silent success |
| 05 | WRITE_DATA | `00 00 <data>` | data starts at byte 4; use 512 per command |
| 06 | FILE_SEEK | `<pos:32>` | status |
| 07 | FILE_INFO | - | info record of open file |
| 08 | FILE_STAT | `<name>` | info record; `82` if missing |
| 09-0B | DELETE / RENAME / COPY_FILE | `<name>` / `<old> 00 <new>` / `<src> 00 <dst>` | status |
| 11 | CHANGE_DIR | `<dir>` | `.`/`..` work; also enters .D64 etc. so OPEN_FILE reads inside the image |
| 12 | GET_PATH | - | path |
| 13 | OPEN_DIR | - | `01` if empty; snapshots the directory |
| 14 | READ_DIR | - | one block per entry: `<attrib> <long name>`; last carries `00,OK` |
| 16 | CREATE_DIR | `<dir>` | status |
| 21 | LOAD_REU | `<addr:32> <len:32>` | file to REU from open file, no C64 involvement; text `$xxxxxx BYTES LOADED TO REU $xxxxxx` |
| 22 | SAVE_REU | `<addr:32> <len:32>` | REU to open file |
| 23 | MOUNT_DISK | `<id> <image>` | id = IEC device (8, 9); 0 = last mounted drive |
| 24 / 25 | UMOUNT / SWAP_DISK | `<id>` | |
| 26 | GET_TIME | `[fmt]` | 19 bytes `yyyy/mm/dd hh:mm:ss` (fmt 1: weekday prefix, 23 bytes) |
| 27 | SET_TIME | `<y-1900> <mon> <day> <h> <min> <s>` | echo; since 2026-09 no longer sets the system clock |

- OPEN attrib bits: `$01` read, `$02` write, `$04` create new (truncates), `$08` create always. Read `$01`; write/overwrite `$0E`. Always CLOSE before opening another file.
- Info record: size:32, FAT date:16, FAT time:16, ext 3, attrib 1, name (reply length minus 12). READ_DIR attrib: `$01` read-only, `$02` hidden, `$04` system, `$08` volume, `$10` directory, `$20` archive.
- A directory walk is one live exchange: no other command until it ends, or abort.
- LOAD_REU/SAVE_REU: addr 24 bits, len up to 16 MB; assumes a 16 MB REU regardless of `REU Size`, truncating with `02` beyond it. Chunk calls to 32 KB or less (largest safe length is unverified). See c64://ultimate/reu.

## Target 3: Network (client only, reads never block)

| Cmd | Name | Args | Reply |
|---|---|---|---|
| 01 | IDENTIFY | - | `ULTIMATE-II NETWORK INTERFACE V1.0` |
| 02 | GET_INTERFACE_COUNT | - | count |
| 04-06 | GET_NETADDR / GET_IPADDR / SET_IPADDR | `<if> [12 bytes]` | MAC (6); IP, mask, gateway (4 each) |
| 07 | OPEN_TCP | `<port:16> <host or IP>` | socket handle |
| 08 | OPEN_UDP | `<port:16> <host or IP>` | handle (connected socket) |
| 09 | CLOSE_SOCKET | `<h>` | status |
| 10 | READ_SOCKET | `<h> <len:16>` | `<count:16>` then payload |
| 11 | WRITE_SOCKET | `<h> <data>` | 2-byte count sent |

- DNS is implicit in OPEN_*. Interface numbering starts at 0 and may include an idle interface (zero IP): find the one with non-zero IP.
- READ_SOCKET answers at once; nothing waiting gives status `02,NO DATA` (older firmware: count `$FFFF`). Poll every few frames, not every line. Request at most 512 bytes (on firmware 3.15 reads of 800-1023 bytes took the device off the network; reads up to 1472 in several blocks, with UDP truncation status `04`, entered 2026-08-27).
- After `01,CONNECTION CLOSED BY HOST` the handle is already released.
- A connect to a dead address blocks the C64 for up to about 31 s; unknown name fails in about 30 ms. Connect before the game loop with a status screen. Never connect to the device's own address.
- 16 sockets, closed at C64 reset. No inbound listener in public firmware: multiplayer needs a relay server or UDP.
- Wire: `03 07 <portlo> <porthi> <host>`; `03 10 <h> 00 02` reads 512.

## Target 4: Control

| Cmd | Name | Args | Notes |
|---|---|---|---|
| 01 | IDENTIFY | - | `CONTROL TARGET V1.1` |
| 05 | FREEZE | - | opens Ultimate menu; use no-reply `84 05` |
| 06 | REBOOT | - | full C64 reboot, UCI reset, no reply |
| 08 / 09 | LOAD_REU / SAVE_REU | `<filename>` | wedged the interface on firmware 3.14d; prefer DOS 21/22 |
| 0F | U64_SAVEMEM | `[<filename>]` | U64-class; saves 64 KB RAM to `/temp/c64_memory.bin`; C64 halted |
| 28 | GET_HWINFO | `[sub]` | deprecated; 0 = model string, 1 = SID frames |
| 29 | GET_DRVINFO | `[1]` | count, then 3 bytes per drive: type (`00` 1541, `01` 1571, `02` 1581, `0F` SoftwareIEC, `50` printer), IEC addr, power |
| 30-35 | drive A/B power | - | `30` A on, `31` A off, `32` B on, `33` B off, `34`/`35` read power (`off`/`on `) |
| 50 | LOAD_CONFIG | `[<filename>]` | applies a `.cfg`; firmware 2026-08 on |
| 51 | GET_PALETTE | - | 48 bytes: 16 x R,G,B |
| 52 | SET_PALETTE | 48 bytes | length 50 total |
| 53 | SET_PALETTE_COLOR | `<idx 0-15> <r> <g> <b>` | length 6 |
| 54 | RESET_PALETTE | - | built-in colours |

Not available: reset without reboot, run PRG, change CPU speed, single config get/set, SID/mixer control, input injection, power off. READ_RTC `02` answers `21`.

**Palette `$51-$54`** (U64-class only; U2 answers `21`; firmware 2026-09-03 on; wrong length gives `81`): 8 bits per channel, takes effect on the whole display at once, live only (reset restores defaults; nothing saved). Whole palette costs about a quarter of a frame at 1 MHz, one colour about an eighth; per-frame changes are fine, per-raster-line are not. A blocking write can take 12-58 ms (measured on a C64U), so in a time-critical display issue it as a non-blocking step per frame (push command, poll status once per frame, finish later, one command in flight) or under a fade. Send `04 54` on exit. Raw: `04 53 02 FF FF FF` colour 2 to white. See also c64://ultimate/upic.

**LOAD_CONFIG** (`04 50 <name>`, default `/temp/uci_config.cfg`): the only config entry point. Write a `.cfg` via DOS, then send. Format: `[Store Name]` then `Item=value` lines; `#`/`;` comments; only listed items change; unknown stores skipped; stores are applied immediately. Stores: `[C64 and Cartridge Settings]` (`Command Interface`, REU items), `[U64 Specific Settings]` (`Turbo Control`, `CPU Speed`, `Badline Timing`, `System Mode`, `Palette Definition`, video items), `[Audio Mixer]` (`Vol ...`, `Pan ...`), SID address items. Value strings must match the menu exactly; use a `.cfg` saved from the menu as template. Flash persistence is unverified (assume session only). The reply holds a parse log on errors.

## Target 5: SoftwareIEC (fast load into C64 RAM)

| Cmd | Name | Args | Reply / status |
|---|---|---|---|
| 01 | IDENTIFY | - | `SOFTWARE IEC TARGET V1.0` |
| 10 | LOAD_SU | `<sec> <verify> <addr:16> 00 00 <name>` | 2 bytes: file load address; if sec = 0, `addr` is used |
| 11 | LOAD_EX | `<sec> <verify>` | copies into RAM; status `00` + end address:16 |
| 12 | SAVE | `<verify> <sec> <start:16> <end:16> <name>` | PRG file |

Status: `00` OK, `01` not found, `02` save error, `05` IEC module not loaded, `06` invalid params, `80` verify error. The firmware stops the C64 during the copy, writes into the flat RAM view (RAM under I/O/ROM), and stops at 64 KB.
- Firmware from 2026-09-23: `IEC Drive` = `UCI Only` (default), `Enabled` or `Disabled`; `Disabled` turns this target off (answers `05`). Fall back to DOS OPEN/READ/CLOSE.

## Target 6: HTTP (firmware 3.15, 2026-05)

Header and body objects live in the Ultimate (16 slots each, machine-wide; a crashed program leaks them: FREE_ALL at startup). One exchange takes seconds to tens of seconds (DNS, connect, transfer). HTTPS works (certificate validation unverified). No ranges: a reply larger than your buffer is truncated.

| Cmd | Name | Args | Reply |
|---|---|---|---|
| 01 | IDENTIFY | - | `ULTIMATE HTTP TARGET V1.0` |
| 10 | FREE_ALL | - | |
| 11 / 12 | HEADER_CREATE / FREE | `<verb> <url>` / `<h>` | header handle; verbs GET 01 PUT 02 POST 03 PATCH 04 DELETE 05 HEAD 06 OPTIONS 07 |
| 13 / 14 / 15 | HEADER_ADD / QUERY / LIST | `<h> "Key: value"` / `<h> <key>` / `<h> <index>` | |
| 21 / 22 | BODY_CREATE / FREE | `<fmt>` / `<h>` | formats: BINARY 01, JSON OBJECT 02, JSON ARRAY 03, URL ENCODED 04 |
| 23-27 | BODY_ADD_INT/BOOL/STRING/OBJECT/ARRAY | `<h> <keylen> <key> <value>` | |
| 2A | BODY_QUERY | `<h> <path>` | typed value; the Ultimate parses JSON, the C64 needs no parser |
| 2C-2E | BODY_ADD_BINARY / ADD / CLEAR | | binary: repeat to append |
| 31 | DO_EXCHANGE_OBJ | `<hdr> <body or FF>` | response header and body handles |
| 32 | DO_EXCHANGE_RAW | `<hdr> <body or FF>` | response body bytes in blocks; status = server response line plus headers |

HTTP errors: `400` bad command/index, `404` key/entry not found, `500` bad format, `503` service unavailable, `507` no free slot. Minimal GET: `06 11 01 <url>` then `06 32 <hdr> FF`, read body blocks, `06 12 <hdr>`. URL `http://host[:port]/path`; Content-Type/Length are added automatically for bodies.

## Game use

- Levels: DOS open/seek/read 512-byte blocks (pack levels in one indexed file), SoftwareIEC LOAD for whole PRGs, or LOAD_REU once then DMA per level (c64://ultimate/reu).
- High scores: open `$0E`, WRITE_DATA, CLOSE; read back with `$01`; FILE_STAT checks existence/size. Handle `DISK IS FULL`/`WRITE PROTECTED`. Do not use `/Temp` for persistence.
- Settings: write `.cfg`, LOAD_CONFIG. Network play: TCP/UDP relay or HTTP JSON; never block in the frame loop.

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
