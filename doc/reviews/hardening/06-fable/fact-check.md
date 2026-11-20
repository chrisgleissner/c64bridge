# Hardening 06 - fact check of the C64 knowledge documents

Scope: `data/**/*.md` except `data/ultimate/`, plus `.github/skills/*/SKILL.md`. Date: 2026-11-19.
Rule (decision D8): a fact is changed only with a primary source recorded here; what cannot be
sourced is marked "(unverified)" or removed. Line numbers refer to the documents at 44822528.

## Sources

- mist64/c64ref, commit `7cae8b91d5317d1d18ae8cdcaac03533389e6032` (https://github.com/mist64/c64ref):
  - `src/c64disasm/c64disasm_en.txt`: commented C64 BASIC and KERNAL ROM disassembly (901227-03).
  - `src/c64mem/c64mem_mapc64.txt`, `src/c64io/c64io_mapc64.txt`: Mapping the Commodore 64 (Leemon).
  - `src/c64io/c64io_prg.txt`, `src/kernal/kernal_prg.txt`: C64 Programmer's Reference Guide (I/O map, KERNAL chapter).
  - `src/c64mem/c64mem_sta.txt`: Joe Forster/STA memory map.
  - `src/6502/cpu_6502.txt`: 6502 opcode, addressing-mode and cycle tables.
  - `src/charset/C64IPRI.TXT`, `C64IALT.TXT`, `control_codes_c64.txt`: PETSCII to Unicode maps and control codes.
- Christian Bauer, "The MOS 6567/6569 video controller (VIC-II)": https://www.cebix.net/VIC-Article.txt (read via WebFetch).
- HVSC SID file format: https://www.hvsc.c64.org/download/C64Music/DOCUMENTS/SID_file_format.txt (WebFetch).
- Peter Schepers, D64 and D81 formats: https://ist.uwaterloo.ca/~schepers/formats/D64.TXT, https://ist.uwaterloo.ca/~schepers/formats/D81.TXT (WebFetch).
- Commodore 1581 User's Guide: https://mirrors.archeobits.com/commodore/www.zimmers.net/anonftp/pub/cbm/manuals/drives/1581-manual.txt (WebFetch).
- VICE manual, binary monitor: https://vice-emu.sourceforge.io/vice_13.html (WebFetch).
- 6502 interrupt timing: https://nesdev.org/wiki/Visual6502wiki/6502_Timing_of_Interrupt_Handling (WebFetch).
- Calculations: scripts under /tmp/h6/factcheck (`freq.py` SID table, `tok.py`/`cmp.py` token table and
  abbreviations by simulating CRUNCH over the ROM keyword table, `ops.py` opcode matrix and decode table,
  `hdr.py` ROM address cross-check).

Not reachable: c64-wiki "Bank_Switching", VICE manual chapter 17. "(WF)" marks quotes produced through WebFetch.

## Part A - corrections proposed by the first reviewer

| Item | file:line | Verdict | Corrected wording | Source |
|---|---|---|---|---|
| A1a | sound/sid-spec.md:41,53,109 | CONFIRMED-ERROR | `FREQ = round(f * 2^24 / clock)` is the 16-bit register value (no `>>8`, no "upper 16 bits") | Mapping $D400: "FREQUENCY=(REGISTER VALUE*CLOCK/16777216)Hz"; freq.py |
| A1b | sound/sid-spec.md:117-124 | CONFIRMED-ERROR | PAL/NTSC: C4 $1167/$10C4, D4 $1389/$12D1, E4 $15ED/$151F, F4 $173B/$1661, G4 $1A13/$191F (fact check had $191E; 392 x 2^24 / 1022727 = 6430.52, rounds to 6431 = $191F), A4 $1D45/$1C32, B4 $20DA/$1FA6, C5 $22CE/$2188 | freq.py (PAL 985248 Hz, NTSC 1022727 Hz) |
| A1c | sound/sid-spec.md:30-31 | CONFIRMED-ERROR | $D415 bits 0-2 = low 3 bits of cutoff; $D416 = high 8 bits | Mapping: "0-2 Low portion of filter cutoff frequency"; PRG: "Filter Cutoff Frequency: High-Byte" |
| A2a | sound/sid-programming-best-practices.md:31,66-75,84-85 | CONFIRMED-ERROR | 54273 = $D401 frequency HIGH byte; 54274 = $D402 pulse width LOW. High byte 30..60 = 451-902 Hz PAL | PRG: "$D401 Voice 1: Frequency Control - High-Byte"; calculation |
| A2b | same:28-32,91-94,183-185 | CONFIRMED-ERROR | "Ultra-low frequency" diagnosis is wrong; the quoted table value 0x113E is wrong (C4 PAL = $1167) | as A1b, A2a |
| A2c | same:42,82 | CONFIRMED-ERROR | AD=17 ($11) = attack 1 (8 ms), decay 1 | PRG: "7-4 Select Attack ... 3-0 Select Decay"; Mapping: "1 = 8 milliseconds" |
| A2d | same:48,55,58 | IMPRECISE | FOR-loop iterations, not CPU cycles; durations unverified | - |
| A3a | context/bootstrap.md:58 | CONFIRMED-ERROR | $D011: bit 7 RST8, 6 ECM, 5 BMM, 4 DEN, 3 RSEL (1 = 25 rows), 0-2 YSCROLL | Bauer: "$d011 \|RST8\| ECM\| BMM\| DEN\|RSEL\|"; Mapping $D011 |
| A3b | context/bootstrap.md:60,68,69,75,108,109 | CONFIRMED-ERROR | $D016: bit 4 MCM, bit 3 CSEL (1 = 40 columns) | Mapping: "4 Enable multicolor text or multicolor bitmap mode" |
| A3c | context/bootstrap.md:61 | CONFIRMED-ERROR | $D018: bits 4-7 screen base x1K; bits 1-3 character/bitmap base x2K | Mapping: "4-7 Video matrix base address" |
| A3d | context/bootstrap.md:74 | CONFIRMED-ERROR | Screen $0400 + bitmap $2000: `$D018 = $18` | from A3c |
| A3e | context/bootstrap.md:64 | CONFIRMED-ERROR | $D01E/$D01F cleared by reading | Mapping: "Reading these registers clears them" |
| A3f | context/bootstrap.md:41 | CONFIRMED-ERROR | $0314/5 IRQ, $0316/7 BRK, $0318/9 NMI | ROM $FD30 table |
| A3g | context/bootstrap.md:84 | CONFIRMED-ERROR | $1C = RED, $12 = RVS ON; PETSCII $5C is the pound sign in both sets, no backslash; lower case: `CHR$(14)` or `POKE 53272,23` | control_codes_c64: "1C COL_RED", "12 RVS_ON"; C64IALT: "0x5C ... POUND SIGN" |
| A3h | context/bootstrap.md:51 | CONFIRMED-ERROR | All RAM = %x00 ($34/$30) | STA $0001: "%x00: RAM visible in all three areas" |
| A3i | context/bootstrap.md:63,70 | CONFIRMED-ERROR | Backgrounds 0-3 = $D021-$D024; multicolour text uses $D021-$D023 + colour RAM; $D024 only in ECM | Mapping $D022-$D024 |
| A3j | context/bootstrap.md:156 | CONFIRMED-ERROR | No `(zp)` mode on the 6510; `(abs)` for JMP only | cpu_6502.txt addmodes |
| A4a | graphics/vic-spec.md:83 | CONFIRMED-ERROR | Multicolour enable = $D016 bit 4 (MCM); $D011 bit 4 is DEN | A3a, A3b |
| A4b | graphics/vic-spec.md:129,231 | CONFIRMED-ERROR | MxDP = 1 sprite behind foreground, 0 in front | Mapping $D01B: "If that bit is set to 1, the foreground data will be displayed in front"; Bauer |
| A4c | graphics/vic-spec.md:89 | IMPRECISE | Clear CHAREN (bit 2 of $01 = 0) with LORAM or HIRAM set; IRQs off | Mapping $0001 |
| A5 | gamedev/architecture.md:90,105; gamedev/techniques.md:180 | IMPRECISE (reviewer wrong about $31) | Character ROM at $D000 for $31, $32, $33. Table below. "needs LORAM=0 ($36/$35/$34)" instead of "$01<=$36" | STA $0001: "%0xx: Character ROM visible at $D000-$DFFF. (Except for the value %000" |
| A6 | api/kernal-api-spec.md:67; kernal/rom-routines.md:54 | CONFIRMED-ERROR | PLOT: C=1 read returns X = row, Y = column; C=0 sets from X = row, Y = column | ROM $E50C "STX $D6 save the cursor row"; PRG: "X is the row number" |
| A7 | assembly/assembly-spec.md:157 | CONFIRMED-ERROR | JMP: ABS ($4C) and IND ($6C) only; all other matrix rows and all 256 decode rows match | cpu_6502.txt; ops.py |
| A8a | graphics/sprite-charset-best-practices.md:39 | CONFIRMED-ERROR | $C000-$CFFF is 4 KB free RAM under no ROM; VIC sees it only in bank 3 | Mapping: "4K of unused RAM above the BASIC ROM at 49152 ($C000)" |
| A8b | same:13 | CONFIRMED-ERROR | $0340-$03FF (blocks 13-15); $0400-$07FF is screen RAM | Mapping TBUFFR $033C-$03FB |
| A8c | same:94-97 | CONFIRMED-ERROR | Bank 0 offsets equal addresses ($2000...) | arithmetic |
| A8d | same:219 | CONFIRMED-ERROR | Visible window: sprite X 24-343, Y 50-249 | Bauer display window X $18-$157; sprites $1f8-$1ff invisible |
| A8e | same:192-196 | CONFIRMED-ERROR | Upper/lower border: RSEL=1 earlier, clear RSEL in lines 248-250, set again after line 251 | Bauer 3.14.1 (WF): "Wait until RASTER reaches 248-250" |
| A8f | same:201 | CONFIRMED-ERROR | Bad line + 8 sprites (PAL): at most 7 cycles (63-40-16), 6 of them BA-lead, writes only | Bauer: "40-43 cycles", "2 cycles per sprite", BA "three cycles before" |
| A8g | same:186-187 | IMPRECISE | 16 DMA cycles plus up to 3 BA-lead cycles; X has no effect on DMA | Bauer: s-accesses only when DMA is on |
| A8h | same:105 | CONFIRMED-ERROR | `POKE 53272,(PEEK(53272)AND240)OR8`; no `<<` in BASIC V2 | ROM operator table $A080 |
| A9a | sound/sid-file-structure.md:41 | CONFIRMED-ERROR | Data offset $0076 (118) for v1, $007C (124) for v2+; offsets are hex | HVSC: "0x0076 (Version 1)" |
| A9b | same:57-58 | CONFIRMED-ERROR | Byte $xy = SID at $Dxy0 ($42 = $D420); even values, $42-$FE excluding $80-$DF | HVSC: "0x42 for $D420" |
| A9c | same:30,82,84; gamedev/techniques.md:179 | CONFIRMED-ERROR | A = song number - 1 | HVSC: "$00 for song 1 through $FF for song 256" |
| A9d | same:23 | IMPRECISE | Versions 1-4; v5 also defined | HVSC: "For version 5, offset +7A and +7B are differently defined" |
| A10a | memory/low-memory-map.md:16 | IMPRECISE | Default $2F (KERNAL); Mapping's $EF differs only in unused bits 6-7 | ROM $FDD9 "LDA #$2F", $FDDB "STA $00"; STA "Default: $2F" |
| A10b | io/cia-spec.md:38 | CONFIRMED-ERROR | Light pen = control port 1 trigger = CIA1 PRB bit 4 ($DC01) + VIC LP | Mapping $D013 "Control Port #1"; $DC01 bit 4 "joystick 1 fire" |
| A10c | graphics/petscii-style-guide.md:73 | CONFIRMED-ERROR | PETSCII 160 = shifted space; full block = `CHR$(18)+" "` or screen code 160 | C64IPRI "0xA0 ... NO-BREAK SPACE" |
| A10d | same:90 | CONFIRMED-ERROR | 66-82 are letters B-R; block elements 161-191 | C64IPRI 0x42, 0xA1 |
| A10e | same:74-75 | CONFIRMED-ERROR | Lower/upper set: 65-90 lowercase, 193-218 uppercase | C64IALT "0x41 0x0061" |
| A10f | drive/drive-spec.md:13 | CONFIRMED-ERROR | Directory track 18 sectors 1-18 | D64: "Sectors 1-18 contain the entries" |
| A10g | drive/drive-spec.md:184,200,211 | CONFIRMED-ERROR | 1581: 80 x 40 x 256 B = 3200 blocks = 819200 B; 3160 free | D81: "80 tracks, 40 sectors each"; 1581 manual: "3160" |
| A10h | drive/drive-spec.md:185,192-193,199-201 | CONFIRMED-ERROR | No MD/CD on the 1581; partitions with `/0:name,...,C`, select `/0:name`, root `/` | 1581 manual 6.8 |
| A10i | io/io-spec.md:122 | CONFIRMED-ERROR | Remove stray "citeturn0search0" | file text |
| A10j | io/io-spec.md:73 | REVIEWER-WRONG | Port 1 Right reads as "2" (document right) | SCNKEY scans columns 0-7, last hit kept; $EBB9 row 3 = $32 |
| A10k | basic/basic-pitfalls.md:53-67,232 | CONFIRMED-ERROR | DATA contents are not tokenised | ROM $A598 "BIT $0F", $A59A "BVS ... was DATA" |
| A10l | gamedev/techniques.md:63 | IMPRECISE | 7-cycle entry after the current instruction; taken branch delays one instruction; bad lines 40-43 | nesdev "7-cycle instruction sequence"; Bauer "40-43 cycles" |

$01 low three bits ($A000 / $D000 / $E000), cartridge lines inactive: %000 RAM/RAM/RAM; %001 RAM/CHAR/RAM;
%010 RAM/CHAR/KERNAL; %011 BASIC/CHAR/KERNAL; %100 RAM/RAM/RAM; %101 RAM/IO/RAM; %110 RAM/IO/KERNAL;
%111 BASIC/IO/KERNAL (STA $0001).

## Part B - own sweep

| Item | file:line | Verdict | Corrected wording | Source |
|---|---|---|---|---|
| B1 | api/kernal-api-spec.md:35; kernal/rom-routines.md:186 | CONFIRMED-ERROR (PRG text inverted) | SETMSG: bit 7 control messages, bit 6 KERNAL error messages | ROM $F5B1 "BPL ... control messages off"; $F71D "BVC ... kernal messages off" |
| B2 | kernal/rom-routines.md:29 | CONFIRMED-ERROR | SIN entry $E26B | ROM "*** perform SIN()" at $E26B |
| B3 | kernal/rom-routines.md:74 | CONFIRMED-ERROR | Colour code table at $E8DA | ROM $E8CD "CMP $E8DA,X" |
| B4 | kernal/rom-routines.md:109-111 | IMPRECISE | $EE85 CLK out high (released), $EE8E CLK low, $EE97 DATA high | ROM $EE88 "set serial clock out high" |
| B5 | kernal/rom-routines.md:228 | IMPRECISE | IRQ via $0314/5, BRK via $0316/7 | ROM $FD30 |
| B6 | api/kernal-api-spec.md:15,24 | IMPRECISE | Jiffy clock $00A0-$00A2; vectors $0314-$0319 | ROM $F6DE-$F6E2 |
| B7 | api/basic-api-spec.md:144,150-153 | CONFIRMED-ERROR | OR $AFE6, AND $AFE9, NOT $AED4, unary minus $BFB4, relational $B016 | ROM table $A08F-$A09B; $AED9 "EOR #$FF" |
| B8 | basic/basic-spec.md:360 | CONFIRMED-ERROR | Line numbers 0-63999 | ROM $A97D "maximum line number 63999" |
| B9 | basic/basic-spec.md:140,393 | CONFIRMED-ERROR | Garbage collection exists ($B526), runs when string space is exhausted and on FRE() | ROM $B526, $B384 |
| B10 | basic/basic-spec.md:52 | CONFIRMED-ERROR | Float range +/-2.94E-39 to +/-1.70E+38 | ROM constant $BFE8 = 1.0 implies 0.1b x 2^(E-$80) |
| B11 | basic/basic-spec.md:41, table | IMPRECISE | Add pi = $FF and operator tokens $AA-$AE, $B1-$B3 | tok.py, cmp.py |
| B12 | basic/basic-spec.md:351 | IMPRECISE | FRE(0) signed 16-bit | ROM $B391 |
| B13 | basic/basic-pitfalls.md:147 | CONFIRMED-ERROR | Program/variables/arrays grow up from $0801; strings down from MEMSIZ | Mapping $0033/$0037 |
| B14 | basic/basic-pitfalls.md:215-224 | CONFIRMED-ERROR | V2 RESTORE has no line number | ROM $A81D-$A82B |
| B15 | basic/basic-pitfalls.md:212 | CONFIRMED-ERROR | After a clear, colour RAM = background colour; also POKE colour RAM | ROM $EA07 "JSR $E4DA", $E4DA "LDA $D021" |
| B16 | drive/drive-spec.md:44-48 | CONFIRMED-ERROR | BAM: $00-$01 dir T/S, $02 DOS "A", $04-$8F, $90-$9F name, $A2-$A3 ID, $A5-$A6 "2A" | D64 |
| B17 | drive/drive-spec.md:54-57 | CONFIRMED-ERROR | Dir entry: $00-$01 link, $02 type, $03-$04 T/S, $05-$14 name, $1E-$1F size | D64 |
| B18 | drive/drive-spec.md:115-160 | CONFIRMED-ERROR | SETNAM A=len X=lo Y=hi; examples also wrong in LOAD/SAVE setup | ROM $FDF9 "STA $B7 set file name length" |
| B19 | drive/drive-spec.md:167 | CONFIRMED-ERROR | 1571: 1366 blocks | arithmetic (683 x 2; 349696 / 256) |
| B20 | memory/low-memory-map.md:66 | IMPRECISE | $006F-$0070 | Mapping $006F, $0070 |
| B21 | memory/memory-map.md:92 | CONFIRMED-ERROR | STAL $00C1-$00C2; EAL $00AE-$00AF | Mapping $00AE-$00AF, $00C1-$00C2 |
| B22 | io/cia-spec.md:32,75 | CONFIRMED-ERROR | Write to hours stops TOD until tenths is written; read of hours latches until tenths is read | Mapping: "will not start again until you write to the tenths" |
| B23 | io/cia-spec.md:65 | IMPRECISE | Latch loaded by force load, underflow, or high-byte write while stopped | Mapping CIA timers; cia-spec:26 |
| B24 | context/bootstrap.md:44 | IMPRECISE | RAM when LORAM=0 (or HIRAM=0) | STA $0001 |

VICE binary monitor spec: frames, error codes and bodies of 0x01, 0x02, 0x12, 0x15, 0x22, 0x32, 0x41, 0x42,
0x51, 0x52, 0x71, 0x72, 0x82, 0x83, 0x84, 0x85, 0x91, 0xa2, 0xb2, 0xdd match the manual.

## Coverage

Fully verified: sid-spec, sid-programming-best-practices (except loop timings), sid-file-structure,
bootstrap (except backend text), vic-spec, assembly-spec, kernal/rom-routines, kernal-api-spec,
basic-api-spec (addresses), basic/rom-routines (addresses), basic-spec, basic-pitfalls, low-memory-map,
memory-map, cia-spec, io-spec, drive-spec, petscii-style-guide (codes), gamedev/architecture (except
Ultimate measurements), gamedev/techniques (except Ultimate parts).

Partly verified: vice-binary-monitor-spec (RESET values 0x08-0x0b, CPU_HISTORY layout), gamedev/toolchain
(BASIC stub bytes correct), gamedev/index, SKILL.md files (few C64 facts).

Not checked: gamedev/references (URLs, licences, ratings), Ultimate measurement tables, sidwave.md, printer
documents, character-set.csv, context/chat.md, context/fast-paths.md.

Unresolved: GOSUB nesting depth (basic-pitfalls:159 "~50"; ROM arithmetic suggests about 35, not run);
"empty lines stored as $20" (basic-spec:41).

## Part C - C64 facts in code (HANDOVER list)

Checked 2026-11-20 against mist64/c64ref `7cae8b9` and the Bauer VIC-II article (both re-fetched,
not from memory). Branch code was read with `git show origin/h6/<X>:<path>`; nothing on another
branch was edited. `h6/F` (`src/petscii.ts`) is owned by another agent and not checked here.
Line numbers are those of the branch tips fetched on 2026-11-20.

### Base tree `src/knowledge.ts` name-to-address pairs (h6/K)

| Fact | branch:file:line | Verdict | Source |
|---|---|---|---|
| `zero_page` $0000-$00FF, `stack` $0100-$01FF | K:src/knowledge.ts:21-22 | CONFIRMED | Mapping "$0100-$01FF Microprocessor Stack Area" |
| `basic_input_buffer` $0200-$02FF | K:src/knowledge.ts:23 | CONFIRMED (range is page 2; BUF itself is $0200-$0258, the rest is KERNAL workspace, as the description says) | Mapping "$0200-$0258 BUF" |
| `screen_ram` $0400-$07E7, symbols `screen`/`screen_ram` $0400 | K:src/knowledge.ts:24,37-38 | CONFIRMED | STA $0288 HIBASE "Default: $04, $0400"; 1000 cells end at $07E7 |
| `basic_program` $0801-$9FFF, symbols `basic`/`basic_start` $0801 | K:src/knowledge.ts:25,39-40 | CONFIRMED | Mapping TXTTAB "beginning at 2049 ($0801)"; MEMSIZ "(40959, $9FFF)" |
| `vic_ii_registers` $D000-$D3FF, symbol `vic` $D000 | K:src/knowledge.ts:26,43 | CONFIRMED | Mapping "$D040-$D3FF VIC-II Register Images"; Bauer "repeated every 64 bytes" |
| `sid_registers` $D400-$D7FF, symbol `sid` $D400 | K:src/knowledge.ts:27,44 | CONFIRMED | Mapping "$D420-$D7FF SID Register Images" |
| `color_ram` $D800-$DBFF, symbols `color`/`color_ram` $D800 | K:src/knowledge.ts:28,41-42 | CONFIRMED | Mapping "$D800-$DBFF Color RAM" |
| `cia1_registers` $DC00-$DCFF, symbol `cia1` | K:src/knowledge.ts:29,45 | CONFIRMED | Mapping "$DC10-$DCFF CIA #1 Register Images" |
| `cia2_registers` $DD00-$DDFF, symbol `cia2` | K:src/knowledge.ts:30,46 | CONFIRMED | Mapping "$DD10-$DDFF CIA #2 Register Images" |
| `io_area` $D000-$DFFF | K:src/knowledge.ts:31 | CONFIRMED | STA $0001 "%1xx: I/O area visible at $D000-$DFFF" |
| `kernal_rom` $E000-$FFFF, symbol `kernal` $E000 | K:src/knowledge.ts:32,47 | CONFIRMED | STA $0001 "KERNAL ROM visible at $E000-$FFFF" |

No pair changes value, so no code change and no test were needed.

Prose in the same file (outside the name-to-address pairs; fixed later, see "Follow-up corrections"):

| Fact | branch:file:line | Verdict | Source |
|---|---|---|---|
| "$D011 bit 7=screen on/off" | K:src/knowledge.ts:403 | ERROR: bit 7 is RST8 (raster bit 8); the display enable is bit 4 (DEN) | Bauer register table; Mapping $D011 |
| "$D011 ... writing: bit7 Screen on/off ... bit4 (unused)"; bit 3 not listed | K:src/knowledge.ts:423 | ERROR: bit 7 RST8 on read and write (raster compare), bit 4 DEN, bit 3 RSEL | Bauer register table; Mapping $D011 |
| "Disable screen ($D011 bit7=0) ... to suppress badlines" | K:src/knowledge.ts:433 | ERROR: clear bit 4 (DEN) | Mapping $D011 "4 Blank the entire screen"; Bauer 3.5 |
| USR vector $0311/$0312 | K:src/knowledge.ts:295 | CONFIRMED | Mapping "$0311-$0312 USRADD" |
| $02A6 PAL=$01, NTSC=$00 | K:src/knowledge.ts:162 | CONFIRMED | as G2 below |

### Other branches (not edited)

| Fact | branch:file:line | Verdict | Source |
|---|---|---|---|
| Multicolour pixels are twice as wide (pixel width ratio 2) | G1:src/vicBitmap.ts:163 | CONFIRMED | Bauer 3.7.3.2 (multicolor text mode): "each pixel being twice as wide" |
| Bottom-right cell at screen $07E7 (2023) and colour RAM $DBE7 (56295) | G1:src/petsciiArt.ts:413-415 | CONFIRMED | $0400 + 999 = $07E7; Mapping "$D800-$DBFF Color RAM"; $D800 + 999 = $DBE7 |
| Cursor (text) colour at 646 ($0286) | G1:src/petsciiArt.ts:396,415 | CONFIRMED | Mapping "$0286 COLOR Current Foreground Color for Text" |
| $D016 bits 6-7, $D018 bit 0, $D020/$D021 bits 4-7 read as 1 (masked `& 0x3f`, `& 0xfe`, `& 0x0f`) | G1:src/tools/registry/graphics.ts:129-130,173-176 | CONFIRMED | Bauer register table and note "bits marked with '-' are not connected and yield '1' on reading" |
| $D011 bit 7 reads as bit 8 of the raster line (masked `& 0x7f`) | G1:src/tools/registry/graphics.ts:129,172 | CONFIRMED | Bauer "$d011 RST8"; Mapping $D011 "7 High bit (Bit 8) of raster compare register" |
| Screen base = (3 - ($DD00 & 3)) x $4000 + ($D018 >> 4) x $400 | E:src/device.ts:132 (base-tree code, used by E background.ts:412-427) | CONFIRMED | Mapping $DD00 "0-1 Select the 16K VIC-II chip memory bank (11=bank 0, 00=bank 3)"; $D018 "4-7 Video matrix base address" |
| Character block = (($D018 >> 1) & 7) x $800 inside the bank | E:src/tools/meta/graphics.ts:413,420-424 | CONFIRMED | Mapping $D018 "1-3 Text character dot-data base address", "If they equal 2, the data area starts 2*1K" (nybble value x 1K = bits 1-3 x 2K) |
| Character ROM image in banks 0 and 2 at bank offset $1000-$1FFF | E:src/tools/meta/graphics.ts:422-423 | CONFIRMED | Mapping $D000 Character ROM: "see an image of the Character ROM at 4096-8191 ($1000-$1FFF) and at 36864-40959 ($9000-$9FFF). It is not available in the other two blocks." |
| Sprite pointer = (address within the 16 KB bank) / 64 | E:src/tools/meta/graphics.ts:82,295-297 | CONFIRMED | Mapping $D000 sprites: "The number in the pointer times 64 equals the address of the first byte of the data block within the VIC-II addressing range" |
| Charset candidates $0800, $2000, $2800, $3000, $3800 in bank 0 are 2 KB aligned and avoid the ROM image | E:src/tools/meta/graphics.ts:378-381 | CONFIRMED | as the two rows above |
| KERNAL names CINT $FF81, IOINIT $FF84, RAMTAS $FF87, RESTOR $FF8A, SCNKEY $FF9F, READST $FFB7, SETLFS $FFBA, SETNAM $FFBD, OPEN $FFC0, CLOSE $FFC3, CHKIN $FFC6, CHKOUT $FFC9, CLRCHN $FFCC, CHRIN $FFCF, CHROUT $FFD2, LOAD $FFD5, SAVE $FFD8, SETTIM $FFDB, RDTIM $FFDE, STOP $FFE1, GETIN $FFE4, CLALL $FFE7, UDTIM $FFEA, PLOT $FFF0 | C:src/knowledge.ts:50-73 | CONFIRMED (all 24) | kernal_prg.txt headings ("$FF81 CINT" ... "$FFF0 PLOT"); c64disasm_en.txt jump table $FF81-$FFF0 |
| Comment cites "Programmer's Reference Guide, chapter 5" | C:src/knowledge.ts:48-49 | UNVERIFIABLE (chapter number not in the c64ref text files; the routine list is) | - |
| $02A6 is 1 for PAL, 0 for NTSC | G2:src/tools/audio.ts:686,694 | CONFIRMED (the replaced base text "1=NTSC, 0=PAL" was the error) | Mapping $02A6 "a 0 indicating an NTSC system in use, and one signifying a PAL system"; STA "$00: NTSC", "$01: PAL"; ROM $FF66-$FF68 |
| PAL frequency values on NTSC sound about 65 cents sharp | G2:src/tools/audio.ts:256 | CONFIRMED | 1200 x log2(1022727 / 985248) = 64.6 cents; clocks as in sid-spec.md (Mapping $D400 equation) |

ERROR verdicts on other branches: none.

### Follow-up corrections (coordinator request, 2026-11-20)

| Fact | file:line | Verdict | Corrected wording | Source |
|---|---|---|---|---|
| $D011 bit 7 "screen on/off" | src/knowledge.ts:403 | CONFIRMED-ERROR, fixed (9a450414) | Bit 7 RST8 = raster bit 8 on read and write; bit 4 DEN, bit 3 RSEL | Bauer register table; Mapping $D011 |
| $D011 row: bit 7 screen on/off on write, bit 4 unused, bit 3 missing | src/knowledge.ts:423 | CONFIRMED-ERROR, fixed (9a450414) | bit7 RST8, bit6 ECM, bit5 BMM, bit4 DEN, bit3 RSEL, bits 0-2 YSCROLL | as above |
| "Disable screen ($D011 bit7=0)" to suppress bad lines | src/knowledge.ts:433 | CONFIRMED-ERROR, fixed (9a450414) | Clear $D011 bit 4 (DEN) | Mapping $D011 "4 Blank the entire screen" |
| Art example printing `/\_/\` and `^` | data/context/bootstrap.md:89-94 | CONFIRMED-ERROR, replaced (1f3bc115) | Example without `\` and `^`; CHR$(92) shown as the pound sign | C64IPRI "0x5C POUND SIGN", "0x5E UPWARDS ARROW"; control_codes_c64 "0D RETURN" |
| Line number field range 0-65535 | data/basic/basic-spec.md:36 | CONFIRMED-ERROR, fixed (4312a60a) | 0-63999 | ROM $A97D "maximum line number 63999" |

Test: `test/knowledge.test.mjs` "VIC-II spec gives the $D011 bit layout" passes on bun and node, and fails
on both with the previous `src/knowledge.ts` restored.

## Part D - Wave 2 item 6: knowledge gaps and remaining documents (W6, 2026-11-20)

Every row was checked against a copy fetched on 2026-11-20 and kept in `~/.c64bridge/h6/W6-src`
(not from memory). Sources:

- cc65 `eebf54af545f4ae52f8489a2f6d4d5f93e7942d2` (https://github.com/cc65/cc65): `doc/cc65-intern.sgml`,
  `doc/c64.sgml`, `cfg/c64.cfg`, `libsrc/c64/crt0.s`, `libsrc/c64/irq.s`, `libsrc/runtime/zeropage.s`, `asminc/zeropage.inc`.
- Oscar64 `08b01c9ec14f0c6080c3a26be7adb16b1a0d6432` (https://github.com/drmortalwombat/oscar64): `oscar64.md`, `include/crt.c`.
- llvm-mos-sdk `555253f65a0fa3b4bbe8a203fe21f160da27f931` (https://github.com/llvm-mos/llvm-mos-sdk):
  `mos-platform/c64/{link.ld,clang.cfg,unmap-basic.S,basic-header.S}`, `mos-platform/commodore/{commodore.ld,save-basic.S}`,
  `mos-platform/common/ldscripts/imag-regs.ld`. llvm-mos `ae72e49843c256272d89421942079cd623bedafb`
  (https://github.com/llvm-mos/llvm-mos): `llvm/lib/Target/MOS/MOSCallingConv.td`, `MOSCallLowering.cpp`.
  The llvm-mos wiki (llvm-mos.org) refused automated fetches (HTTP 403), so the compiler source is used instead.
- mist64/c64ref `7cae8b9` and the Bauer VIC-II article, as in Part A.
- Multiply/divide: routines assembled with 64tass 1.60 and run in `verify/sim6502.py`, a 6502 interpreter whose
  opcode, addressing-mode and cycle tables are parsed from c64ref `src/6502/cpu_6502.txt` (`verify/test_muldiv.py`).

### D1 - C compiler runtime facts (data/gamedev/toolchain.md section 1)

| Fact | Verdict | Source |
|---|---|---|
| cc65 runtime zero page `$02-$1B`, 26 bytes, names and 6-byte `regbank` | ADDED | `c64.cfg` "ZP: start = $0002, size = $001A"; `zeropage.s` (`c_sp` 2, `sreg` 2, `regsave` 4, `ptr1-4`, `tmp1-4`, `regbank`); `zeropage.inc` "zpspace = 26", "regbanksize = 6" |
| cc65 `fastcall` default, A/X/`sreg` order, push order, return rules, free registers, `regbank` kept, variadic = `cdecl` with Y | ADDED | `cc65-intern.sgml` "Calling conventions", "Prologue", "Return requirements", "Clobbered state" |
| cc65 `c64.cfg`: `$0801`, 13-byte HEADER, HIMEM `$D000`, stack `$800`; `c64-asm.cfg`, `--start-addr`, `-u __EXEHDR__`; `-Ln` label file | ADDED | `c64.cfg` ("size = $000D", "__HIMEM__ ... $D000", "__STACKSIZE__ ... $0800"); `c64.sgml` "c64-asm.cfg"; `cl65.sgml` "-Ln name Create a VICE label file" |
| cc65 startup: `$01` AND `$F8` OR `$06`, saved SP and zero page, `c_sp`, `CHR$(14)`, constructors, BSS, exit to BASIC with code in ST; IRQ via `$0314` | ADDED | `crt0.s` ("ora #$06 ; Enable Kernal+I/O, disable BASIC", "sta STATUS"); `irq.s` (`IRQVec`) |
| Oscar64 zero-page layout `$02` ... `$53-$8F`, "not yet final"; `__zeropage` usually `$80-$FF`; `-xz` | ADDED | `oscar64.md` "Zero page usage", "Usage of zero page", "Compiler arguments" |
| Oscar64 calling convention per function, static stack, inline asm access, `__interrupt`/`__hwinterrupt` | ADDED | `oscar64.md` "Global Analyzer", "Avoid Recursion", "Accessing variables in assembler", "Interrupt routines" |
| Oscar64 regions (`startup` `$0801-$0900`, `bytecode`, `main` `$0A00-$A000`), pragmas, stack 4 KB, heap 1 KB, `.lbl`, `-o=`, `-d64=` | ADDED | `oscar64.md` "Placement", "Heap and Stack sections", "Vice debugger .lbl", "Creating a d64" |
| Oscar64 startup saves SP, clears BSS and zero-page BSS, calls `main` | ADDED | `crt.c` `startup` ("tsx / stx spentry", "Clear BSS Segment", "jsr main"); `oscar64.md` "-dNOBSSCLEAR", "-dNOZPCLEAR" |
| `.lbl` lines `al 0801 .startup` are accepted as `symbolsFile` | ADDED | `src/tools/translation/symbolRegistry.ts:66` (device prefix optional) |
| llvm-mos `__rc0` at `$02`, 32 imaginary registers, zero page `$22-$8F`, `-mlto-zp=110` | ADDED | `link.ld` "__basic_zp_start = 0x0002", "__basic_zp_end = 0x0090"; `commodore.ld` "__rc0 = __basic_zp_start", "zp : ORIGIN = __rc31 + 1"; `clang.cfg` "-mlto-zp=110" ($90 - $22 = 110) |
| llvm-mos argument and return order, caller/callee-saved sets, variadic and struct rules | ADDED | `MOSCallingConv.td` (CC_MOS lists, header comment "A, X, Y, C, N, V, Z, and RS1-RS9 are caller-saved ... RS0, and RS10-RS15 are callee-saved"); `MOSCallLowering.cpp:54` uses CC_MOS for returns too |
| llvm-mos `link.ld` RAM `$0801` length `$C7FF`, `__stack = $D000`, BASIC header; init `$00=$2F`, `$01=$3E`; exit loop, `save-basic.o` | ADDED | `link.ld`, `basic-header.S`, `unmap-basic.S` ("ldx #$3E ; LORAM = 0", ".fini.990 ... ldx #$3F"), `c64/CMakeLists.txt` (`common-exit-loop`), `save-basic.S` header comment |
| Toolchain Makefile note: Oscar64 output flags "see its README"; label file "(unverified)" | IMPRECISE, replaced | `oscar64.md` "Compiler arguments" (`-o`), "Vice debugger .lbl" |
