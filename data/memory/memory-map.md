# C64 Memory Map (Quick Reference)

All addresses are shown as `hex` / `dec`. Group related entries to minimise token usage while keeping lookup simple.

## Memory Map Reference Routing

Use this quick map to select the narrowest reference before coding or patching memory.

| Need | MCP resource | File |
| --- | --- | --- |
| Whole 64 KB layout, RAM/ROM/I/O banks, VIC/SID/CIA ranges | `c64://memory/map` | `data/memory/memory-map.md` |
| Zero page, stack, page-2 buffers, page-3 vectors, cassette buffer | `c64://memory/zero-page-and-workspace` | `data/memory/low-memory-map.md` |
| BASIC ROM routines, parser/evaluator helpers, variables, strings, token dispatch | `c64://basic/rom-routines` | `data/basic/rom-routines.md` |
| KERNAL ROM routines, jump table, vectors, serial/tape/screen services | `c64://kernal/rom-routines` | `data/kernal/rom-routines.md` |
| Hardware register map for VIC-II, SID, CIA, colour RAM, expansion I/O | `c64://io/spec` | `data/io/io-spec.md` |
| CIA timer, keyboard, serial, TOD, IRQ/NMI register details | `c64://io/cia/spec` | `data/io/cia-spec.md` |

## Zero Page ($0000-$00FF)

| Label | Address | Purpose |
| --- | --- | --- |
| D6510 | $0000 / 0 | 6510 data direction register. |
| R6510 | $0001 / 1 | 6510 on-chip I/O bits (LORAM, HIRAM, CHAREN, cassette). |
| TEMP | $0002 / 2 | Free. |
| ADRAY1 | $0003-$0004 / 3-4 | FAC → integer jump vector ($B1AA). |
| ADRAY2 | $0005-$0006 / 5-6 | Integer → FAC jump vector ($B391). |
| CHARAC | $0007 / 7 | Search char / temp integer. |
| ENDCHR | $0008 / 8 | Quote scan flag (string end). |
| TRMPOS | $0009 / 9 | TAB column. |
| VERCK | $000A / 10 | Load (0) / verify (1). |
| COUNT | $000B / 11 | Input buffer pointer / subscript count. |
| DIMFLG | $000C / 12 | Default array dimension flag. |
| VALTYP | $000D / 13 | Data type: $00 numeric, $FF string. |
| INTFLG | $000E / 14 | $00 float, $80 integer. |
| GARBFL | $000F / 15 | DATA scan / list quote / GC flags. |
| SUBFLG | $0010 / 16 | Subscript ref / user function call flag. |
| INPFLG | $0011 / 17 | INPUT/GET/READ selector. |
| TANSGN | $0012 / 18 | TAN sign / compare result. |
| CHANNL | $0013 / 19 | Current input file number. |
| LINNUM | $0014-$0015 / 20-21 | Temporary integer value. |
| TEMPPT | $0016 / 22 | Temp string stack pointer. |
| LASTPT | $0017-$0018 / 23-24 | Last temp string address. |
| TEMPST | $0019-$0021 / 25-33 | Temp string stack. |
| INDEX1/2 | $0022-$0025 / 34-37 | Utility pointers. |
| RESHO | $0026-$002A / 38-42 | FP multiply/divide product. |
| TXTTAB | $002B-$002C / 43-44 | BASIC text start ($0801). |
| VARTAB | $002D-$002E / 45-46 | BASIC variables start. |
| ARYTAB | $002F-$0030 / 47-48 | BASIC arrays start. |
| STREND | $0031-$0032 / 49-50 | BASIC arrays end + 1. |
| FRETOP | $0033-$0034 / 51-52 | String heap bottom. |
| FRESPC | $0035-$0036 / 53-54 | Utility string pointer. |
| MEMSIZ | $0037-$0038 / 55-56 | BASIC memory top ($A000). |
| CURLIN | $0039-$003A / 57-58 | Current BASIC line. |
| OLDLIN | $003B-$003C / 59-60 | Previous BASIC line. |
| OLDTXT | $003D-$003E / 61-62 | CONT statement pointer. |
| DATLIN | $003F-$0040 / 63-64 | Current DATA line. |
| DATPTR | $0041-$0042 / 65-66 | Current DATA item address. |
| INPPTR | $0043-$0044 / 67-68 | INPUT pointer temp. |
| VARNAM | $0045-$0046 / 69-70 | Variable name lookup. |
| VARPNT | $0047-$0048 / 71-72 | Pointer to variable value/descriptor. |
| FORPNT | $0049-$004A / 73-74 | FOR/NEXT index pointer. |
| VARTXT | $004B-$004C / 75-76 | TXTPTR temp for READ/INPUT/GET. |
| OPMASK | $004D / 77 | FRMEVL mask. |
| TEMPF1-3 | $004E-$0060 / 78-96 | FP temporaries. |
| FAC / AFAC | $0061-$006E / 97-110 | FP accumulators, exponent, mantissa, sign. |
| ARISGN | $006F / 111 | Arithmetic result sign. |
| FACOV | $0070 / 112 | Rounding byte. |
| FBUFPT | $0071-$0072 / 113-114 | CRUNCH/ASCII pointers. |
| CHRGET | $0073-$008A / 115-138 | BASIC text fetch routine. |
| CHRGOT | $0079 / 121 | Re-read current char entry. |
| TXTPTR | $007A-$007B / 122-123 | BASIC text pointer. |
| RNDX | $008B-$008F / 139-143 | RND seed. |
| STATUS | $0090 / 144 | Kernal I/O status (ST). |
| STKEY | $0091 / 145 | STOP key flag ($7F). |
| SVXT | $0092 / 146 | Tape timing constant. |
| VERCKK | $0093 / 147 | Load/verify flag. |
| C3PO / BSOUR | $0094-$0095 / 148-149 | Serial bus buffers. |
| SYNO | $0096 / 150 | Cassette sync number. |
| TEMPX/Y | $0097 / 151 | X/Y register temp (CHRIN/RS232). |
| LDTND | $0098 / 152 | Open files count / index. |
| DFLTN/O | $0099-$009A / 153-154 | Default input/output devices. |
| PRTY / DPSW | $009B-$009C / 155-156 | Tape parity & state. |
| MSGFLG | $009D / 157 | Error message mode. |
| FNMIDX / PTR1 / PTR2 | $009E-$009F / 158-159 | Tape filename/error log. |
| TIME | $00A0-$00A2 / 160-162 | Jiffy clock (UDTIMK). |
| TSFCNT / TBTCNT / CNTDN | $00A3-$00A5 / 163-165 | Tape counters. |
| BUFPNT | $00A6 / 166 | Tape buffer pointer. |
| INBIT-ROPRTY | $00A7-$00BD / 167-189 | RS232/tape temporaries. |
| FSBLK | $00BE / 190 | Tape block count. |
| MYCH | $00BF / 191 | Serial word buffer. |
| CAS1 | $00C0 / 192 | Tape motor switch. |
| STAL/EAL | $00C1-$00C2 / 193-194 | Load start/end. |
| MEMUSS | $00C3-$00C4 / 195-196 | Tape type 3/general pointer. |
| LSTX | $00C5 / 197 | Last key matrix value. |
| Keyboard/editor | $00C6-$00F2 / 198-242 | Buffer, cursor, quote, insert, link table. |
| USER | $00F3-$00F4 / 243-244 | Colour RAM pointer. |
| KEYTAB | $00F5-$00F6 / 245-246 | Keyboard decode vector ($EB81). |
| RIBUF / ROBUF | $00F7-$00FA / 247-250 | RS232 buffer pointers. |
| FREKZP | $00FB-$00FE / 251-254 | Free ZP workspace. |
| BASZPT | $00FF / 255 | BASIC temp / FP→ASCII area. |

## Page $0100-$03FF Highlights

- $0100-$01FF: CPU stack ($0100-$01FF), BASIC stack overlay.
- $0200-$0258: Screen input buffer.
- $0259-$0276: Kernal file tables (LAT/FAT/SAT).
- $0277-$0280: Keyboard FIFO.
- $0281-$0284: OS memory bounds.
- $0285-$029E: Keyboard repeat, shift flags, RS232 state.
- $029F-$02A6: IRQ/tape temporaries.
- $02A7-$02FF: Unused block (sprite data when remapped).
- $0300-$0333: BASIC + Kernal vectors (errors, LIST, LOAD/SAVE, IRQ/NMI, USR).
- $0334-$033B: Unused.
- $033C-$03FB: Tape buffer.
- $0340-$03FE: Sprite data areas (#13-15).
- $0400-$07E7: Screen RAM; $07F8-$07FF sprite pointers.

## Main RAM / ROM Banks

| Range | Decimal | Notes |
| --- | --- | --- |
| $0800-$9FFF | 2048-40959 | BASIC program RAM. |
| $8000-$9FFF | 32768-40959 | Cartridge ROM (optional). |
| $A000-$BFFF | 40960-49151 | BASIC ROM or banked RAM. |
| $C000-$CFFF | 49152-53247 | RAM. |
| $D000-$DFFF | 53248-57343 | I/O, Colour RAM, or char ROM (banked). |
| $E000-$FFFF | 57344-65535 | BASIC/Kernal ROM or RAM (banked). |

## Control Bits

- `$0000`: DDR (1 = output, 0 = input). Default `xx101111`.
- `$0001`: `/LORAM`, `/HIRAM`, `/CHAREN`, cassette data, sense, motor.
- `$DD00` bits 0-1: VIC bank select.

## VIC-II ($D000-$D02E)

| Address | Meaning |
| --- | --- |
| $D000-$D00F | Sprite 0-7 X/Y (with $D010 MSBs). |
| $D011 | Control: 25-row, bitmap, Y scroll, raster bit 8. |
| $D012 | Raster compare. |
| $D013-$D014 | Light-pen latch X/Y. |
| $D015 | Sprite enable bits. |
| $D016 | Control: 40-column, X scroll, multicolour bit. |
| $D017 | Sprite Y expand. |
| $D018 | Matrix/charset base select. |
| $D019 | IRQ flags (raster, s-sprite, s-bg, light pen). |
| $D01A | IRQ mask. |
| $D01B | Sprite/background priority. |
| $D01C | Sprite multicolour enable. |
| $D01D | Sprite X expand. |
| $D01E-$D01F | Sprite collision flags. |
| $D020-$D024 | Border + background colours 0-3. |
| $D025-$D026 | Sprite shared multicolours. |
| $D027-$D02E | Sprite colours 0-7. |

## SID ($D400-$D41C)

- Voices 1-3: freq ($D400/$01, $D407/$08, $D40E/$0F), pulse width ($D402-$D403 etc.), control ($D404,$D40B,$D412), ADSR ($D405-$D406 etc.).
- Filter: cutoff ($D415-$D416), resonance/mix ($D417), mode+volume ($D418).
- Extras: paddles ($D419-$D41A), noise/LFSR ($D41B), envelope 3 output ($D41C).
- Mirrors: $D500-$D7FF (SID image), colour RAM $D800-$DBFF.

## CIA #1 ($DC00-$DC0F)

| Address | Role |
| --- | --- |
| $DC00 | Port A: keyboard columns, joystick A, paddles select. |
| $DC01 | Port B: keyboard rows, joystick B, timer outputs. |
| $DC02-$DC03 | DDR for ports. |
| $DC04-$DC07 | Timers A/B low/high. |
| $DC08-$DC0B | Time-of-day clock (tenths, sec, min, hour). |
| $DC0C | Serial buffer. |
| $DC0D | IRQ control (FLAG1, serial, TOD alarm, timers). |
| $DC0E-$DC0F | Timer control (frequency, one-shot, toggle, start). |

## CIA #2 ($DD00-$DD0F)

| Address | Role |
| --- | --- |
| $DD00 | Port A: serial bus lines, VIC bank select, user port. |
| $DD01 | Port B: user/RS-232 control lines. |
| $DD02-$DD03 | DDR for ports. |
| $DD04-$DD07 | Timers A/B. |
| $DD08-$DD0B | Time-of-day clock. |
| $DD0C | Serial buffer. |
| $DD0D | NMI control (serial, timers). |
| $DD0E-$DD0F | Timer control (same layout as CIA1). |

## Miscellaneous

- $DE00-$DFFF: Reserved expansion I/O.
- Sprite pointers: `$07F8-$07FF`, value × 64 (+ bank) gives sprite data address.
- To map sprite 0 to `$02C0`: `POKE 1024+1016,11` (pointer 11 ⇒ `$02C0`).
- Colour RAM: `$D800-$DBFF`, lower nybble only.

---

This layout keeps the essential Commodore 64 addresses compact for LLM consumption while retaining full coverage of the supplied map.
