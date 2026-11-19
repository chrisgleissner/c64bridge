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
| A1b | sound/sid-spec.md:117-124 | CONFIRMED-ERROR | PAL/NTSC: C4 $1167/$10C4, D4 $1389/$12D1, E4 $15ED/$151F, F4 $173B/$1661, G4 $1A13/$191E, A4 $1D45/$1C32, B4 $20DA/$1FA6, C5 $22CE/$2188 | freq.py (PAL 985248 Hz, NTSC 1022727 Hz) |
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
