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

Not checked: Ultimate measurement tables, character-set.csv, context/chat.md, context/fast-paths.md.
gamedev/references, sidwave.md (C64 facts) and the printer documents: Part D (D6-D8).

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

### D2 - Raster timing, stable raster and open borders (data/gamedev/techniques.md section 1)

| Fact | Verdict | Source |
|---|---|---|
| 63 / 65 / 64 cycles per line (6569, 6567R8, 6567R56A) | ADDED | Bauer 3.6.3 "63 cycles on the 6569, 64 cycles on the 6567R56A, and 65 cycles on the 6567R8"; table in 3.4 |
| Raster compare in cycle 1 (line 0: cycle 2), at most one IRQ per line | ADDED | Bauer 3.12 RST row |
| Bad line 40-43 cycles; 2 cycles per sprite; BA low 3 cycles before | ADDED | Bauer 3.5 "stun the processor for 40-43 cycles"; 2.4.3/3.8.1 "three cycles before"; A8f |
| Longest documented instruction 7 cycles | ADDED | c64ref `cpu_6502.txt` [timing]: maximum base value 7 (e.g. `00`, `1E`) |
| Double-IRQ stable raster | UNVERIFIED, kept as sketch | no primary source fetched; not run |
| Open top/bottom border: RSEL=0 in lines 248-250, back to RSEL=1 after 251; never 0 to 1 in 52-54; `$D011` values `$13`/`$1B` | ADDED | Bauer 3.14.1 steps 1-4 and "If you switch from RSEL=0 to RSEL=1 in the raster line range 52-54, the border never turns off"; bit layout Bauer register table ($D011 RST8 ECM BMM DEN RSEL YSCROLL) |
| Opened border shows sprites and the idle byte at `$3FFF` (`$39FF` with ECM), set bits black | ADDED | Bauer 3.14.1 ("mainly limited to sprites"), 3.7.3.9 "the VIC reads the graphics data from address $3fff ($39ff if ... ECM)"; 3.7.1 |
| Side border: CSEL 1 to 0 exactly in cycle 56; inside the vertical border area also open that border | ADDED | Bauer 3.14.1 "the change from CSEL=1 to CSEL=0 has to be exactly in cycle 56", "the main border flip-flop can only be reset if the vertical flip-flop is not set" |

### D3 - Bitmap and multicolour setup (data/gamedev/techniques.md section 11)

| Fact | Verdict | Source |
|---|---|---|
| BMM `$D011` bit 5, MCM `$D016` bit 4, ECM `$D011` bit 6 | ADDED | Bauer register table; A3a, A3b |
| Multicolour text: colour RAM bit 3 selects multicolour per character; `00` `$D021`, `01` `$D022`, `10` `$D023`, `11` colour RAM bits 0-2; otherwise colours 0-7 | ADDED | Bauer 3.7.3.2 ("If bit 11 of the c-data is zero ... colors 0-7", MC flag table) |
| Standard bitmap: `0` = screen bits 0-3, `1` = bits 4-7 | ADDED | Bauer 3.7.3.3 c-access data table |
| Multicolour bitmap 160x200; `00` `$D021`, `01` bits 4-7, `10` bits 0-3, `11` colour RAM | ADDED | Bauer 3.7.3.4 g-access data table (bits 8-11 of c-data = colour RAM) |
| Bitmap 8 KB at bank offset `$0000`/`$2000` by `$D018` bit 3; screen matrix by bits 4-7; `$2000` in banks 0 and 2 because of the ROM image | ADDED | Mapping $D011 bit 5 text ("Only Bit 3 is significant", "the VIC-II chip sees an image of the character ROM ... $1000-$1FFF"); Bauer $D018 CB13 |
| Setup values `$3B`, `$18`/`$08`, `$18` | ADDED | from the bit layouts above; `$D018 = $18` as A3d |
| Byte `base + 40*(y AND 248) + (y AND 7) + (x AND 504)`, bit `7 - (x AND 7)`; multicolour form with `2*(x AND 252)` | ADDED | Mapping $D011 bit 5 program line 100 and "POKE BY,PEEK(BY) OR (2^(NOTX AND 7))"; multicolour form derived (x_hires = 2x) |
| 8 bytes per cell, 40 cells per row | ADDED | Mapping ("The ninth byte controls the eight dots directly to the right"); Bauer g-access address VC/RC |

### D4 - Multiply and divide (data/gamedev/techniques.md section 12)

| Fact | Verdict | Source |
|---|---|---|
| `mul8`, `mul16`, `div8`, `div16` give exact products, quotients and remainders | ADDED, verified | `verify/muldiv.asm` assembled with 64tass 1.60; `verify/test_muldiv.py` runs the bytes in `verify/sim6502.py` (tables parsed from c64ref `cpu_6502.txt`): all 65,536 pairs for `mul8`/`div8`, 350,144 pairs (12x12 edge grid plus random) for `mul16`/`div16`; result in `verify/result.txt` |
| The checks can fail | CONFIRMED | `neg_mul8.asm` (first `clc` removed) fails at (1,0); `neg_div8.asm`, `neg_div16.asm` (`cmp` replaced by `nop`) fail at (1,1) |
| Sizes 18/39/19/44 bytes; cycles 134-166, 623-927, 158-174, 655-1007 | ADDED | 64tass label file `muldiv.lbl` (routine start addresses, 120 bytes total); cycle counts from the interpreter using c64ref [timing] including branch-taken and page-cross extras |
| Divide by zero returns quotient `$FF` / `$FFFF` | ADDED | `result.txt` divide-by-zero set |
| An earlier draft guarded a carry out of `ROL` in the dividers; the guard was removed | NOTE | the guarded and unguarded versions agree on all pairs: the partial remainder is below 128 (`$8000`) before each `ROL` because it is less than the divisor and is built from at most 7 (15) dividend bits |
| Quarter-square identity a*b = f(a+b) - f(a-b), f(n) = floor(n*n/4) | ADDED (arithmetic) | (a+b)^2 - (a-b)^2 = 4ab; a+b and a-b have the same parity, so the floors cancel |

### D5 - Safe zero-page map (data/gamedev/architecture.md section 4)

| Fact | Verdict | Source |
|---|---|---|
| `$02` unused; `$FB-$FE` free and never altered by BASIC | ADDED | Mapping `$0002 Unused`; `$00FB-$00FE FREKZP` "it is guaranteed that BASIC will not alter these locations"; ROM: no access to `$02` or `$FB-$FE` except indexed `$FD53 STA $0002,Y` (RAMTAS) |
| `$F7-$FA` used only by RS-232 OPEN/CLOSE/NMI | ADDED | Mapping RIBUF/ROBUF "When device number 2 (the RS-232 channel) is opened"; ROM accesses at `$EF26`, `$EFB1`, `$F026`, `$F096` (RS-232 NMI send/receive), `$F2B5-$F2C3` (CLOSE, after `CMP #$02` device test at `$F2A7`), `$F46B-$F47B` (RS-232 OPEN) |
| KERNAL `$E4D3-$FFFF` does not access `$02-$8F` or `$FF` except RAMTAS | ADDED | `verify/zpscan.py` over c64ref `c64disasm_en.txt`: only `$FD53 STA $0002,Y` in `$02-$8F`; no access to `$FF` |
| `$02-$8F` BASIC workspace, `CHRGET` at `$73-$8A`; `$90-$FA` KERNAL (jiffy `$A0-$A2`, editor/keyboard `$C5-$F6`) | ADDED | Mapping entries `$0003`-`$008F`, `$0073-$008A CHRGET`, `$0090`-`$00F6`; KERNAL IRQ `$EA31-$EB48` accesses `$C0`-`$F6` (zpscan) |
| `$00/$01` CPU port | CONFIRMED | Mapping `$0000 D6510`, `$0001 R6510` |

### D6 - data/gamedev/references.md

Licences read with `gh api repos/<owner>/<repo>` (SPDX field) and the repositories' README/LICENSE files on
2026-11-20 (`refs/github-licences.txt`, `refs/*.readme`); URLs fetched with curl.

| Item | Verdict | Corrected wording | Source |
|---|---|---|---|
| Doom C64U licence "other" | IMPRECISE, fixed | CC BY-NC-SA 4.0: read, do not copy | slesinger/doom `LICENSE` (deed1f7) first line |
| Doom test-map fps 0.83/7.15/16.78/50.1 | CONFIRMED | "(PAL, 1.1.0" version tag dropped (not in the table) | `pipeline.md:1523-1528` |
| Doom E1M1 "disputed" 16.7 vs 25.05 fps | CONFIRMED-ERROR, fixed | different milestones: 25.05 flat-shaded (M1), 16.7 textured (M2, 64 MHz) | `IMPLEMENTATION_PLAN.md:3,16`; README:32-36; press article not checked, dropped |
| ultimate-uci-oscar64 GPL-3.0, 78 of 179 untested in 1.4.0 | CONFIRMED | - | GitHub API; README:15-16 (2def4db) |
| mandelbrot-upic GPL-3.0, 16 cycles per 2 pixels at 64 MHz | CONFIRMED | - | GitHub API; `docs/UPIC_VIEWER.md` "a pixel written every 8 cycles" (e71abb5) |
| heartbeat-demo GPL-3.0, 8 SIDs + 7 PCM channels from one tick IRQ | CONFIRMED | - | GitHub API; README:7-8 |
| c64u-radar GPL-3.0, gateway for TLS/JSON, fake 64 KB RAM harness, 8 sprites, poll about 10 s | CONFIRMED | - | GitHub API; README:28,49,126,158 |
| ReadyOS MIT, REU suspend, acceptance at 1/16/64 MHz | CONFIRMED | - | GitHub API; README:4,74 |
| ultimate-uci-sdk MIT, status "early" | CONFIRMED | - | GitHub API; README:38 "Status: early." |
| Order: Omega facts | UNVERIFIED, marked | - | itch.io returned HTTP 429 |
| Zzap!64 ratings, "Known for" column, Paradroid/Wizball ratings | UNVERIFIED, marked | - | no primary (magazine) source fetched |
| Hessian MIT code, assets not free | CONFIRMED | - | README "Code license" and "Graphics, levels, music ... All rights reserved" |
| Steel Ranger demo MIT code; c64gameframework MIT; Tetris C64 MIT (README); Tony MIT | CONFIRMED | - | READMEs; GitHub API (tony-demo MIT) |
| UridiumFraktion, Monty, SquareDoom, Gridrunner: no licence | CONFIRMED | - | GitHub API `null`; no licence text in README |
| CROSS-LIB "none stated" | CONFIRMED-ERROR, fixed | README: zlib-style terms, non-commercial use only | CROSS-LIB README "## LICENSE" ("for non-commercial applications") |
| Oscar64, Corescape, Cadaver multiplexer GPL-3.0 | CONFIRMED | - | GitHub API |
| codetapper, cadaver.github.io, elmerproductions, readthedocs, theweb.dk URLs | CONFIRMED (HTTP 200) | - | curl 2026-11-20 |
| codebase64.net page ids | UNVERIFIED, marked | - | codebase64.net no connection; codebase64.org 404 |
| generationamiga article | UNVERIFIED, marked | - | no URL given |

### D7 - data/sound/sidwave.md (C64 facts only; compiler behaviour is code, not checked here)

Calculations in `verify/` notes: PAL 985248 Hz, NTSC 1022727 Hz as in A1b.

| Item | file:line | Verdict | Corrected wording | Source |
|---|---|---|---|---|
| PAL 985248 Hz, 50.12 (50.1245) frames/s; NTSC 1022727 Hz, 59.83 (59.8262) | sidwave.md:98,106 | CONFIRMED | - | Bauer 3.4 table (63 x 312, 65 x 263) and clock as A1b: 985248/19656 = 50.1245, 1022727/17095 = 59.8261 |
| B7 exceeds the 16-bit register on PAL; highest PAL note A#7 | :134 | CONFIRMED | - | f x 2^24 / clock (Mapping $D400): B7 PAL 67280 > 65535, NTSC 64815; A#7 PAL 63504 |
| Vibrato limits A#7 PAL 0.54, B7 NTSC 0.19 semitones | :140 | CONFIRMED | - | 12 log2(65535/63504) = 0.545; 12 log2(65535/64815) = 0.191 |
| Frequency resolution "about 3 cents in the lowest octave" | :140 | IMPRECISE, fixed | about 6 cents at C0, 3 cents at C1 (PAL) | 1200 log2((r+1)/r): C0 r = 278.4 gives 6.2, C1 r = 556.8 gives 3.1 |
| Hard restart "avoids the SID's ADSR delay bug" | :170 | UNVERIFIED, marked | - | no primary source fetched |
| 20-65 raster lines = "about 1,400-4,100 cycles" | :174 | IMPRECISE, fixed | about 1,300-4,100 | 20 x 63 = 1260, 65 x 63 = 4095 |
| 9,800 cycles = 155 lines, half a PAL frame | :174 | CONFIRMED | - | 9800 / 63 = 155.6; 312 / 2 = 156 |
| ADSR nibbles 0-15; filter cutoff 0-2047 | :116,:159 | CONFIRMED | - | PRG $D405/$D406; A1c (11-bit cutoff) |
| Program must end below $D000, about 50 KB | :173 | CONFIRMED | - | $D000 - $0801 = 51199 bytes |
| KERNAL IRQ normally 60 Hz; TI about 16.5 % slow on a PAL song, 0.3 % on NTSC | :181 | CONFIRMED | - | ROM $FDE2-$FDF0: CIA1 timer A = $4025 (PAL) / $4295 (NTSC), 985248/16422 = 59.996 Hz, 1022727/17046 = 59.998 Hz; 1 - 50.1245/59.996 = 16.45 %, 1 - 59.826/59.998 = 0.29 % |
| `10 SYS2061` | :179 | CONFIRMED | - | 2061 = $080D |

### D8 - Printer documents (data/printer/*.md)

Sources fetched 2026-11-20 (`printer/` in W6-src): Commodore MPS-801 manual, zimmers mirror
`.../manuals/printers/mps801.txt`; MPS-803 User's Guide (`MPS-803_Printer_Users_Guide.pdf`, pdftotext);
Epson FX-80 Printer User Manual 1984, archive.org `Epson_FX-80_Printer_User_Manual_1984_Epson_America_Inc`
(`_djvu.txt` OCR). Ultimate emulation: 1541ultimate `18bea13` `software/io/printer/{mps_printer_cbm.cc,
mps_printer_epson.cc,mps_printer.cc,iec_printer.cc}` and 1541u-documentation `9b06839` `ultimate_printer.rst`.
KERNAL registers: c64ref ROM disassembly.

| Item | file | Verdict | Corrected wording | Source |
|---|---|---|---|---|
| sa 0 upper case/graphics (default), sa 7 business | commodore, spec | CONFIRMED | - | MPS-801 "sa = 0: graphic mode.. . (default)", "sa = 7: business mode"; Ultimate `iec_printer.cc` `_push_command` 0x00/0x07 |
| CHR$(8, 10, 13, 14, 15, 17, 18, 26, 27, 145, 146) meanings | commodore, spec | CONFIRMED | - | MPS-801 "5. Printing Modes and Control Codes" list; MPS-803 Table 1 |
| Column position `CHR$(16);CHR$(n)`, n = 0-79 | commodore, spec | CONFIRMED-ERROR, fixed | two ASCII digits `CHR$(16);"nn"` | MPS-801 5.4 ("2-digit number following the CHR$(16)", `CHR$(16)"08MPS-801"`); Ultimate `case 0x10` (`input & 0x0F`, two digits) |
| Dot position `ESC CHR$(16) HP LP`, 0-479 | commodore, bitmap, spec | CONFIRMED | - | MPS-801 5.5 (9-bit address, dots 0-479) |
| Local charset modes until CR | commodore | CONFIRMED for MPS; Ultimate differs, added | - | MPS-803 "CHR$(17) functions until CHR$(145) or carriage return"; MPS-801 5.8; Ultimate CR handler does not reset `charset_variant` |
| CR/LF: "use CR+LF if overprinting occurs" | commodore, spec | IMPRECISE, fixed | CR and LF each advance; CR+LF leaves a blank line (Ultimate) | Ultimate `mps_printer_cbm.cc` "LF: line feed (LF+CR)", "CR: carriage return (CR+LF)" |
| CHR$(9) tab, CHR$(12) form feed, ESC "-" underline on MPS | commodore | IMPRECISE, marked *Ultimate* | not in MPS-801/803 lists; handled by the Ultimate (MPS-1230) emulation | MPS-801/803 code lists; Ultimate `case 0x09`, `case 0x0C`, ESC `case 0x2D` |
| Bit image: 7 dots, LSB top, add 128 | bitmap, spec | CONFIRMED | - | MPS-801 5.3 (rows 1..64 top to bottom, "add 128"); Ultimate `CBMBim` "LSB is up" |
| Exit bit image with CHR$(15) "or any printable char" | bitmap | IMPRECISE, fixed | CHR$(15) per manual; the Ultimate also exits on a printable byte below 128 | MPS-801 example `CHR$(8)A$;CHR$(15)`; MPS-803 "CHR$(14) and CHR$(15) cancel ... bit image"; Ultimate default case `bim_mode = false` |
| "~60 dpi H, 72 dpi V", "~480 dots" | bitmap, spec | IMPRECISE, fixed | 60 dpi H, about 63 dpi V, at most 480 columns | MPS-801 Appendix A: 480 columns, 10 char/in x 6 dots, 9 lines/in in bit image mode with 7 dots |
| CHR$(26) repeat: count then byte | bitmap, spec | CONFIRMED; Ultimate count 0 = 256 added | - | MPS-801 5.6 figure 3.19; Ultimate `case 0x1A` |
| "16 columns x 3 rows" example comment | bitmap | CONFIRMED-ERROR, fixed | 48 columns in one row | the program prints A$ three times on one line |
| "printer auto-prints when ~480 dots are filled" | bitmap | UNVERIFIED, marked | - | not in the manuals |
| FX-80: ESC @, ESC M/P, SO/DC4, ESC W, SI/DC2, ESC E/F, ESC 4/5, ESC - n, ESC 0/1/2/3/A, ESC D/B/l/Q, ESC J/j | epson, spec | CONFIRMED | - | FX-80 manual index of ESC sequences (p. 242 ff.), Elite 12 cpi (p. 52), compressed 17.16 cpi, SO "turns off after each print line" |
| `ESC x n` NLQ | epson | IMPRECISE, marked | not on the FX-80; accepted by the Ultimate emulation | FX-80 command index (no ESC x); Ultimate `case 0x78` |
| `ESC $` absolute position, `ESC t n` charset | spec | CONFIRMED-ERROR, fixed | none on FX-80; charset via `ESC R n` | FX-80 command index; Ultimate Epson interpreter has no `0x24`/`0x74` case |
| "Condensed / Elite (12 cpi) = ESC M" | spec | IMPRECISE, fixed | Elite = ESC M; condensed = SI/DC2 | FX-80 p. 52-53 |
| Graphics K 60, L 120, Y 120 high speed, Z 240, `ESC *` 0-6 = 60/120/120/240/80/72/90 dpi, MSB top, 72 dpi vertical | epson-bitmap, spec | CONFIRMED; "no adjacent dots" for Y and Z added | - | FX-80 graphics density table ("does not print consecutive dots in any one row"), "Single-Density graphics dots are printed 60 per inch horizontally and 72 per inch vertically", "fire the top pin ... CHR$(128)" |
| `ESC ^ d n m h1 l1`, d in {0,1} | epson-bitmap | IMPRECISE, fixed | two bytes per column: first = top 8 pins, bit 7 of second = 9th pin; d 0 single, 1 double | FX-80 9-pin section and figure 11-5 |
| Epson "Exit bit image: any printable char or LF" | spec | CONFIRMED-ERROR, fixed | mode ends after `n + 256*m` columns | FX-80 "Width = n1+256*n2"; Ultimate `ESC K/L/Y/Z` end after `param_build` bytes |
| "Ultimate-II may treat Y as L" | epson-bitmap, spec | CONFIRMED (same spacing) | - | Ultimate `density_tab` rows 1 and 2 both `{2,2,2}` |
| Assembly example: SETLFS A=device X=SA Y=file; SETNAM `lda #<msg / ldx #>msg / ldy #5`; CHKOUT with A | spec | CONFIRMED-ERROR, fixed | SETLFS A=file X=device Y=SA; SETNAM A=length X/Y=address (length 0 here); CHKOUT X=file | ROM $FE00-$FE04 (`STA $B8` file, `STX $BA` device, `STY $B9` SA), $FDF9-$FDFD, $F30F/$F313 "copy the logical file number to A" from X (B18) |
| Ultimate emulation "supports both PETSCII and ESC/P", "Ignores DLL" | spec, prompts | IMPRECISE, fixed | emulation chosen in the settings (Commodore MPS default, Epson FX-80, IBM GP, IBM PP); Commodore mode ignores `ESC =`, Epson mode has `ESC &` | `ultimate_printer.rst` "Printer emulation" setting; Ultimate CBM `case 0x3D` "parse but ignore", Epson `case 0x26` |
| 256-byte buffer, Flush Printer/Eject Page | spec | ADDED | - | `ultimate_printer.rst` "Flushing the printer spool" |
| `$033C-$03FB` free for print buffers | spec | CONFIRMED | - | A8b (Mapping TBUFFR) |


## Part E: U64 measurements (HF2, 2026-11-20)

All measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20 (core 1.50, FPGA 126); evidence in `~/.c64bridge/h6/hw/results.md`. A U64 result does not confirm C64 Ultimate-only statements; those are unchanged.

| Row | Claim | Verdict | Where recorded |
|---|---|---|---|
| 1 | readmem/writemem of $D012 and $D020 | CONFIRMED | hardware.md |
| 2 | readmem $A000/$E000 returns ROM (CPU view) | CONFIRMED | not in data/ |
| 3 | readmem length limits 1-65536, past $FFFF 400 | CONFIRMED | hardware.md (REST paragraph) |
| 4 | range search skips $D000-$DFFF; explicit read unguarded | CONFIRMED | code, not data/ |
| 5 | DMA read of $DD0D clears the CIA ICR | CONFIRMED | hardware.md (REST paragraph) |
| 6 | writemem: PUT max 128 bytes; POST 65537 bytes at $0000 truncated silently to 64 KB | CONFIRMED (truncation noted) | hardware.md, written |
| 7 | $D800 reads colour RAM; extract charset guard | CONFIRMED | code, not data/ |
| 8-10 | run_prg/mount/run_crt via host upload; error text | CONFIRMED | code, not data/ |
| 11 | Firmware does not decode %3A before routing (404); escapes inside parameter segments decoded; `..` not normalised | CONTRADICTED | hardware.md and doc/hardening-behavior.md corrected; client rejection described as defence |
| 12 | files:info wildcard: first match only, `**` = `*`, 404 texts | CONFIRMED | hardware.md, written |
| 13 | sidecar .cfg applied by run_prg and load_prg, not run_crt or host upload | CONFIRMED | hardware.md (already stated) |
| 14 | LOAD_CONFIG status 89/88, log text, RAM value changes | PARTIALLY VERIFIED | uci.md: status and log observed; hardware effect and flash persistence not observed |
| 15-16 | error texts, no 3xx | CONFIRMED | code, not data/ |
| 17-18 | network password | SKIPPED | unchanged |
| 19 | REST joystick tap hold | CONTRADICTED (0.5-18.5 ms, not two frames) | src/tools/input.ts comment corrected |
| 20-22 | key/keyboard/write_text injection | CONFIRMED | code, not data/ |
| 23 | reset/reboot waitForReady grace | CONTRADICTED (3 s grace still paid) | code finding, not data/ |
| 24 | upload_run_basic finish detection, liveness wording | CONTRADICTED | code finding, not data/ |
| 25-27 | stream: 384x272, 4 bpp, 68 packets, 50 fps, encoding 0; 2-byte 00 00 start datagram; audio max 65536 pairs | CONFIRMED (+ start datagram) | hardware.md, written |
| 28 | palette=1 packet layout | CONFIRMED | hardware.md (already stated) |
| 29 | $02A6 PAL/NTSC pitch table detection | PARTIALLY VERIFIED (PAL detection only; tempo and NTSC not tested) | no data/ claim changed |
| 30 | sampler ~6.2 MHz/(rate+1); 21.95 kHz at 283 | CONFIRMED | hardware.md, '(unverified)' replaced |
| 31 | $D07A/$D07B act only in U64 Turbo Registers and TurboEnable Bit modes; $D07A reads $FF | CONFIRMED | hardware.md, '(unverified)' replaced |
| 32 | KERNAL IEC LOAD at 16 and 48 MHz | PARTIALLY VERIFIED (fastloader not tested) | hardware.md item 4 |
| 33 | $DF0C-$DF0F absent on U64 Elite core 1.50 (read $FF, writes not kept) | CONTRADICTED (as an open question) | hardware.md, reu.md; C64 Ultimate not covered |
| 34 | Ultimate Ident Service item; unicast reply | CONFIRMED | hardware.md, item name settled |
| 35 | UCI OPEN/CHKIN/CLOSE layouts | CONFIRMED (13/14/15) | uci.md; CHKOUT not tried |
| 36 | UCI palette 04 53 / 04 54 | PARTIALLY VERIFIED (Upic program not run) | upic.md |
| 37-38 | Turbo Control values, System Mode values | CONFIRMED | already in data/ |
| 39 | $D031 bit 7 set = badline stalls suppressed | CONFIRMED | hardware.md, written |
| 40 | GET /v1/info fields | CONFIRMED | hardware.md (already stated) |
| 41-44 | C64 Ultimate only | SKIPPED | C64 Ultimate statements left as they are |

## Part F: precision rewrite

### F-U: data/ultimate (hardware, uci, reu, upic, multisid, bench)

Sources: `1541ultimate@700c7f2fa` (firmware `software/`, FPGA `fpga/`); measured U64 = Ultimate 64 Elite, firmware 3.15a, 2026-11-20 (`~/.c64bridge/h6/hw/results.md`); measured C64U = C64 Ultimate 1.2.1, 2026-11-13 (bench data and earlier rounds).

| Claim | File | Verdict | Source |
|---|---|---|---|
| Turbo Control values Off, Manual, U64 Turbo Registers, TurboEnable Bit; `a`/`b` entries outside range 0-3 | hardware | CONFIRMED, written as the complete list | software/u64/u64_config.cc:328,390 |
| `C64U Turbo Registers` label | hardware, upic | REMOVED from rules; moved to Not verified (not in source, no measurement) | u64_config.cc:328; bench README (C64U 1.2.1 used U64 Turbo Registers) |
| CPU Speed lists per build; `5` absent on Elite II/C64U, `64` absent on MK1 | hardware | CONFIRMED, written as rule | u64_config.cc:325-326,392-395 |
| .cfg enum match: case-insensitive, outer spaces ignored; `4 MHz` invalid | hardware, uci | ADDED | software/userinterface/configio.cc:343-350,415-431 |
| REST PUT enum match is exact apart from case (leading space needed) | hardware | ADDED | software/api/route_configs.cc:79-89 |
| LOAD_CONFIG with an invalid line: status 89, values stored, no store effectuated; effect at next apply | hardware, uci | CORRECTED ("rejects the whole file" was imprecise) | control_target.cc:559-609; configio.cc:399-431; measured U64 row 14 |
| File browser / sidecar load applies valid lines, skips invalid | hardware, uci | CONFIRMED | configio.cc:436-478 |
| Unknown item or store: skipped, no error | hardware, uci | CONFIRMED | configio.cc:280-297,381-389 |
| setCpuSpeed register values Off $00/$80, Manual $00, Registers $01, TurboEnable $05, +$02 SuperCPU | hardware | CONFIRMED | u64_config.cc:1696-1708 |
| System Mode timing per value (63/65 cycles, 50/60 Hz, encoding, locked carrier) | hardware | ADDED (replaced "hybrid modes decouple") | software/u64/color_timings.cc:6-29 |
| Speaker items only on MK1 build | hardware | CONFIRMED (table row) | u64_config.cc:381-384 |
| Elite II Programmatic LED window $D200-$D2FF | hardware | CORRECTED (was "$D2xx/$D3xx (2026-05)") | software/u64/led_strip.cc:420-423 |
| Sampler register reset values 63/7/283/REU 0 | hardware | CORRECTED: registers have no reset; power-up volume 32, pan 8, rate 0, start 0, length 0; firmware zeroes control and volume of all voices on C64 reset | fpga/io/sampler/vhdl_source/sampler_regs.vhd (c_voice_control_init unused); software/io/audio/sampler.h:35-42 |
| Sampler voice n at $DF20+32n, n = 0-6 | hardware | CONFIRMED | slot_server_v4.vhd:953-958; slot_to_io_bridge.vhd:61-65 |
| Sample rate 6.25 MHz/(rate+1) | hardware | CONFIRMED (VHDL + measured U64 row 30) | sampler2.vhd |
| 24-bit field byte order, 16-bit/interleave modes "(unverified)" | hardware | RESOLVED from VHDL (high byte first; bits 5-4, bit 6) | sampler_regs.vhd |
| REU decodes $DF00-$DF17; $DF0B, $DF10-$DF17 read $FF ("aliases $DF10-$DF1F") | hardware, reu | CORRECTED | fpga/cart_slot/vhdl_source/reu.vhd:429-483 |
| CRT prohibit table; ALL_BUT_REU = EasyFlash 1, C128 IO 1, FC3 1 (not GeoRAM); EasyFlash and C128 IO 1/2 force UCI on | hardware | CORRECTED | software/io/c64/c64.h:243-258; c64_crt.cc:468-648; c64.cc:1358-1430 |
| ACIA mapping values | hardware | ADDED | software/io/acia/modem.cc:46,69 |
| Streams routes on U2 family: "501" | hardware | CORRECTED to 404 (route not built) | 1541ultimate@700c7f2fa target/u64*/…/Makefile list route_streams.cc, U2 makefiles do not |
| debugreg on U2 family: 501 | hardware | CORRECTED to 404 (`#if U64`) | software/api/route_machine.cc:453 |
| Ident service JSON reply trigger | hardware | ADDED | software/network/socket_dma.cc:650 |
| "IEC activity can re-trigger the 1 MHz window" | hardware | REMOVED (no source, no measurement) | - |
| C64U LED section "UNRESOLVED" hedge | hardware | REWRITTEN as measured C64U facts; restart recovery to Not verified | earlier camera measurements |
| No data phase for REBOOT and zero-length commands | uci | CORRECTED: only the no-reply bit skips it; a null command ends in data-last | software/io/command_interface/command_intf.cc:214-247,274-281 |
| IRQ on completion "firmware 3.15+" | uci | CORRECTED to gateware commit date 2026-03-08 | 1541ultimate git log 3ebd5322e |
| `$DF1B` reads 0 when unset | uci | CORRECTED: Soft Drive Bus ID (default 11), 31 when IEC Drive Disabled | software/io/iec/iec_drive.cc:34,553; command_protocol.vhd:203-207 |
| C64 reset keeps HTTP handles, "probably" the DOS file | uci | CORRECTED: reset frees HTTP handles and closes sockets; DOS file stays open | command_intf.cc:46-53,185-190; http_target.cc:1140-1143 |
| "200x256 polls is about 1.5 s" | uci | REMOVED; replaced by jiffy-clock deadline rule | - |
| Volume names /Usb0, /Usb1, /SD; case-insensitive names | uci | CORRECTED: names depend on device (measured U64: USB2); list the root | results.md (device directories) |
| MOUNT_DISK id 0 = last mounted | uci | CONFIRMED + drive A fallback, 90 on no match | software/filemanager/dos.cc:69-83,325-336 |
| SET_TIME "earlier note … a device check decides" | uci | REWRITTEN from source (sets RTC and chip; wrong length 21 + length digits) | dos.cc:531-576 |
| LOAD_REU/SAVE_REU truncation, ABORT behaviour | uci | CONFIRMED | dos.cc:255-323 |
| READ_SOCKET history (older firmware $FFFF; 3.15 crash) | uci | REMOVED history; crash moved to Not verified (request U-2) | network_target.h:41; network_target.cc:540-556 |
| Connect timing 31 s / 30 ms | uci | MOVED to Not verified (request U-1) | - |
| Control LOAD_REU/SAVE_REU return codes, wedge history | uci | CORRECTED (codes -1/-2/-3, 81 below 5 bytes); history removed | control_target.cc:345-378; reu_preloader.cc:82-176 |
| GET_DRVINFO argument | uci | CORRECTED: 1/omitted = effective address, 0 = configured | control_target.cc:216-248 |
| Palette lengths; RESET_PALETTE restores built-in colours; U64-only | uci | CONFIRMED | control_target.cc:250-301; palette_command.h; u64_config.cc:2881-2884 |
| Palette "quarter of a frame at 1 MHz" | uci | REMOVED (no source); C64U 12-58 ms measurement kept | - |
| LOAD_CONFIG all-or-nothing | uci | CORRECTED: no store effectuated, RAM values change and apply at next store apply; full error list | configio.cc:230-434; control_target.cc:559-609 |
| SoftwareIEC CHKOUT layout "(unverified)" | uci | RESOLVED from source: `<sec> <unused> <data>`, `$Fx` open, `$Ex` close; status 00,OK text | software/io/command_interface/softiec_target.cc:305-333 |
| SoftwareIEC status 04 missing; store name | uci | ADDED `04` unknown command; store `SoftIEC Drive Settings` | softiec_target.cc:12-21; iec_drive.cc:165 |
| HTTPS "a device check decides" | uci | REWRITTEN: https only selects port 443, plain socket | io/command_interface/http_target.h:77-86; software/network/http_request.cc:6-40 |
| REU config "changing it re-initialises the cartridge, a reset follows" | reu | REMOVED (no source) | - |
| Status b3-0 version; b4 = REU Size >= 256 KB | reu | CONFIRMED, version is 0 | fpga/cart_slot/vhdl_source/reu.vhd:429-437 |
| $DF06 reads bits 7-3 as 1 without extended regs | reu | ADDED | reu.vhd:461-465 |
| Extended registers "(unverified)" on other cores | reu | REWRITTEN: VHDL meaning, U2 builds disabled, U64 core 1.50 absent (measured); C64U to Not verified | reu.vhd:253-266,469-471; results.md row 33 |
| 512 KB wrap mechanism | reu | CONFIRMED and explained (bits 23-19 from base) | reu.vhd:137-140 |
| Wrap at configured size | reu | CONFIRMED | reu.vhd:127-140 |
| "CPU store loop about 12 B/us" | reu | CORRECTED to 15.75 B/us for unrolled sta abs (63 cycles/us measured) | bench summary |
| $FF00 trigger under I/O "(unverified)" | reu | MOVED to Not verified, request U-3 | - |
| Turbo DMA start "firmware before 2026-08-28" | reu | CORRECTED: gateware change g_no_dma_delay, commit 59594060b | reu.vhd:288-295; 1541ultimate git log |
| DOS LOAD_REU "chunk at 32 KB or less" | reu | CORRECTED: one command up to 16 MB minus start | software/filemanager/dos.cc:255-323 |
| Preload timing "about 125 ms" | reu | CONFIRMED: 25 ticks at configTICK_RATE_HZ 200 | software/io/c64/reu_preloader.cc:14-80; FreeRTOSConfig.h:22 |
| Save REU Memory writes the configured size | reu | CONFIRMED | software/io/c64/c64_subsys.cc:296-315 |
| Stash stub "early stub hung" anecdote, 3.14d wedge history | reu | REMOVED | - |
| Charset/bitmap swap timing "about 2,000 phi2" | reu | REWRITTEN from measured fetch rates | bench summary |
| Digi sample design "(unverified)", "about 8 kHz" | reu | REWRITTEN as design pattern with CIA value 122 for 8000 Hz on PAL | c64ref (PAL phi2 985,248 Hz) |
| GeoRAM layout "(unverified)" | reu | RESOLVED: $DE00 window, $DF80-$DFFF even = page, odd = block | fpga/cart_slot/vhdl_source/all_carts_v5.vhd:644-653 |
| CRT types that keep the REU | reu | CORRECTED (EasyFlash 1, C128 IO 1/2, FC3 1) | software/io/c64/c64_crt.cc:468-648 |
| Upic turbo requirement with `C64U Turbo Registers` hedge and two-label .cfg advice | upic | CORRECTED: one `Turbo Control=U64 Turbo Registers` line; LOAD_CONFIG rule referenced | software/u64/u64_config.cc:328; configio.cc; control_target.cc:559-609 |
| Palette firmware "3.15 or later" | upic | CORRECTED to public master since 2026-09-03 | 1541ultimate git log 4d4f6a727 |
| 1 MHz window "about 2 s" | upic | CORRECTED to 2.55 s / 2.57 s measured | bench 2026-11-13 |
| Free-cycle percentages "roughly 17-27 %", "about 82 %", "about 30 %", "1/312 per row" | upic | REWRITTEN from the measured table (16.5-26.7 %, 83.5 %, 31 %, 3,969 cycles per row) | measured C64U |
| Full-screen clear "(derived, unverified)" | upic | REWRITTEN as cycle count 196,608 / 245,760 | 6510 timing (c64ref) |
| 48 KB fetch times | upic | RECOMPUTED 11.4 / 13.7 / 49.6 ms from measured rates | bench summary |
| Palette retry "about 10 times 0.2 s apart" | upic | REMOVED (no source) | - |
| `$D031 = $00` "suggests TurboEnable Bit" | upic | REMOVED; $FF rule kept | u64_config.cc:1696-1708 |
| Raster IRQ "about line $17" | upic | REMOVED (not found in mandelbrot-upic) | - |
| Exit recipe "(unverified)", odd-x shift "(unverified)" | upic | REWRITTEN as program rules (no hardware claim) | - |
| Upic program on U64 | upic | Not verified, request U-5 | results.md row 36 |
