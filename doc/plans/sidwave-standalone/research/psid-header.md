# PSID / RSID header (source: /home/chris/dev/c64/C64Music/DOCUMENTS/SID_file_format.txt)

All multi-byte fields are BIG endian. Strings are Windows-1252, 32 bytes, zero-terminated if shorter (not necessarily terminated at 32).
Header size: v1 = 0x76 bytes, v2/v3/v4 = 0x7C bytes. The C64 data (payload) starts at dataOffset.

| Offset | Size | Field | Versions | Notes |
|---|---|---|---|---|
| +00 | 4 | magicID | all | "PSID" (0x50534944) or "RSID" (0x52534944) |
| +04 | 2 | version | all | 1, 2, 3, 4. RSID and PSID v2NG must be 2, 3 or 4 |
| +06 | 2 | dataOffset | all | 0x0076 (v1), 0x007C (v2+) |
| +08 | 2 | loadAddress | all | 0 = first two payload bytes (little endian) are the load address. RSID: must be 0 in the header; real address $07E8 or higher |
| +0A | 2 | initAddress | all | 0 = equals effective load address. A = song number (0-based) on entry. RSID: $07E8-$9FFF or $C000-$CFFF, never ROM; must be 0 if C64BASIC flag set |
| +0C | 2 | playAddress | all | 0 = init installs its own interrupt handler. RSID: must be 0 |
| +0E | 2 | songs | all | 1..256 |
| +10 | 2 | startSong | all | 1..songs (default 1) |
| +12 | 4 | speed | all | bit n = tune n+1: 0 = VBI (50 Hz PAL / 60 Hz NTSC), 1 = CIA1 timer A (default 60 Hz). Bit 0 = tune 1. v1/v2 and PSID v2NG+ with psidSpecific=1: tunes >32 wrap (tune 33 uses bit 0). v2NG+ with psidSpecific=0: tunes >32 use bit 31. Surplus bits 0. RSID: must be 0. If play=0 bits should still be set for old players |
| +16 | 32 | name | all | title |
| +36 | 32 | author | all | |
| +56 | 32 | released | all | formerly copyright |
| +76 | 2 | flags | v2+ | see below |
| +78 | 1 | startPage (relocStartPage) | v2NG+ | see below |
| +79 | 1 | pageLength (relocPages) | v2NG+ | see below |
| +7A | 1 | secondSIDAddress | v3+ | see below |
| +7B | 1 | thirdSIDAddress | v4 | see below |
| +7C | - | data | v2+ | payload (v1: payload at +76) |

## flags (+76, WORD, valid 0x0000-0x03FF)

| Bits | Meaning | Values | Version |
|---|---|---|---|
| 0 | musPlayer | 0 built-in player; 1 Compute!'s Sidplayer MUS data (external player must be merged) | v2 |
| 1 | psidSpecific (PSID) / C64BASIC (RSID) | PSID: 0 C64 compatible, 1 PlaySID specific (samples). RSID: 1 = BASIC executable portion run (initAddress must be 0; song number stored in $030C, 0 = song 1) | v2NG |
| 2-3 | clock | 00 unknown, 01 PAL, 10 NTSC, 11 PAL and NTSC | v2NG |
| 4-5 | sidModel (SID 1) | 00 unknown, 01 MOS6581, 10 MOS8580, 11 both | v2NG |
| 6-7 | sidModel of 2nd SID | same coding; 00 = same as SID 1 | v3 |
| 8-9 | sidModel of 3rd SID | same coding; 00 = same as SID 1 | v4 |
| 10-15 | reserved | set to 0 | |

## startPage / pageLength (+78 / +79)
- startPage 0x00: file is clean (writes nothing outside its own load range); free area is derived from load address and data length.
- startPage 0xFF: no free page at all; driver relocation impossible. pageLength must then be 0.
- otherwise: first page of the largest free range (e.g. 0x1E => $1E00); pageLength = number of free pages from there.
- When startPage is 0 or 0xFF, pageLength must be 0.
- The range must not overlap the load range of the data. For RSID it must also avoid ROM areas ($A000-$BFFF, $D000-$FFFF) and $0000-$03FF.

## secondSIDAddress (+7A) / thirdSIDAddress (+7B)
- One byte = middle part of the I/O address $Dxx0: address = $D000 + byte*16 (0x42 => $D420, 0xFE => $DFE0).
- Valid: even values only, 0x42-0x7F ($D420-$D7F0) and 0xE0-0xFE ($DE00-$DFE0). 0x00-0x41 and 0x80-0xDF are invalid and mean "no extra SID" (same as 0x00).
- Second SID: v3+ (0 for v2NG). Third SID: v4 only (0 for v2NG and v3). Third must differ from second.
- Note: the document says "0x80-0xDF ($D800-$DDF0)" invalid; 0xE0 = $DE00.

## RSID constraints (all must be checked; reject tune otherwise)
- magicID = RSID; version 2, 3 or 4 only
- loadAddress (header) = 0; real load address (first 2 payload bytes) >= $07E8
- playAddress = 0; speed = 0
- initAddress: >= $07E8, not in $A000-$BFFF or $D000-$FFFF (so $07E8-$9FFF or $C000-$CFFF), and must lie inside the load image; 0 if C64BASIC flag
- flags bit 1 is the C64BASIC flag
- relocation range must avoid ROM and $0000-$03FF
- environment: VIC raster IRQ at $137 not enabled; CIA1 timer A 60 Hz running with IRQ active (0x4025 PAL / 0x4295 NTSC); other timers disabled, loaded 0xFFFF; bank register $01 = 0x37
- both PSID and RSID: $02A6 = 1 for PAL, 0 for NTSC

## PSID environment (for reference)
Bank register written on every init/play call: addr < $A000 -> 0x37; < $D000 -> 0x36; >= $E000 -> 0x35; else 0x34.
VIC raster IRQ enabled when speed bit 0, else CIA1 timer A IRQ enabled (60 Hz); other timers 0xFFFF disabled.
