/*
C64 Bridge - An MCP Server for the Commodore 64 Ultimate
Copyright (C) 2025 Christian Gleissner

Licensed under the GNU General Public License v2.0 or later.
See <https://www.gnu.org/licenses/> for details.
*/

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface MemoryRegion {
  name: string;
  start: number;
  end: number;
  description: string;
}

export const MEMORY_MAP: MemoryRegion[] = [
  { name: "zero_page", start: 0x0000, end: 0x00ff, description: "Zero page (system vectors, pointers, variables)" },
  { name: "stack", start: 0x0100, end: 0x01ff, description: "6502 hardware stack" },
  { name: "basic_input_buffer", start: 0x0200, end: 0x02ff, description: "BASIC input buffer / screen editor workspace" },
  { name: "screen_ram", start: 0x0400, end: 0x07e7, description: "Default text screen RAM (1000 bytes)" },
  { name: "basic_program", start: 0x0801, end: 0x9fff, description: "Default BASIC program area (grows upward)" },
  { name: "vic_ii_registers", start: 0xd000, end: 0xd3ff, description: "VIC-II registers (mirrored)" },
  { name: "sid_registers", start: 0xd400, end: 0xd7ff, description: "SID registers (mirrored)" },
  { name: "color_ram", start: 0xd800, end: 0xdbff, description: "Color RAM (nibbles, 1000 cells + extras)" },
  { name: "cia1_registers", start: 0xdc00, end: 0xdcff, description: "CIA1 (keyboard, joystick, timers)" },
  { name: "cia2_registers", start: 0xdd00, end: 0xddff, description: "CIA2 (serial IEC, timers)" },
  { name: "io_area", start: 0xd000, end: 0xdfff, description: "I/O area (VIC/SID/CIAs/Color RAM / Char ROM when mapped)" },
  { name: "kernal_rom", start: 0xe000, end: 0xffff, description: "KERNAL ROM (may be banked out)" },
];

const SYMBOLS: Record<string, number> = Object.freeze({
  // Common symbols
  screen: 0x0400,
  screen_ram: 0x0400,
  basic: 0x0801,
  basic_start: 0x0801,
  color: 0xd800,
  color_ram: 0xd800,
  vic: 0xd000,
  sid: 0xd400,
  cia1: 0xdc00,
  cia2: 0xdd00,
  kernal: 0xe000,
});

export function formatAddress(address: number): string {
  return address.toString(16).toUpperCase().padStart(4, "0");
}

export function resolveAddressSymbol(input: string): number | undefined {
  const key = input.trim().toLowerCase().replace(/\s+/g, "_");
  return SYMBOLS[key];
}

export function listSymbols(): Array<{ name: string; address: number; hex: string }> {
  return Object.entries(SYMBOLS)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, address]) => ({ name, address, hex: `$${formatAddress(address)}` }));
}

export function listMemoryMap(): MemoryRegion[] {
  return MEMORY_MAP.slice().sort((a, b) => a.start - b.start);
}

// Commodore BASIC v2 concise language specification for guidance and validation.
// This content is intended as a knowledge base for prompts and tool help.
export const basic_spec: string = `
# Commodore BASIC v2 – Concise Language Specification

## When to Use REST API vs BASIC/Assembly
- **IMPORTANT: Use REST API for direct hardware manipulation**
- If user says "direct", "directly change", "poke", or mentions "direct" + "RAM/SID/VIC", use write REST API
- If user asks for sound generation, use REST API SID manipulation (unless they want a complete program)
- REST API endpoints: write (address, bytes), read (address, length)
- Examples: "directly set border red" → write(53280, "02"), NOT POKE 53280,2
- Examples: "make a sound" → write SID registers, NOT BASIC sound code
- Only generate BASIC/ASM code when user explicitly asks for programs/code

## SID Sound Generation via REST API
**Use write for direct SID chip manipulation:**

Key SID Registers (decimal addresses):
- Volume Control: 54296 ($D418) - Set to 15 ($0F) for maximum volume
- Voice 1 Frequency Low: 54272 ($D400) 
- Voice 1 Frequency High: 54273 ($D401)
- Voice 1 Control: 54276 ($D404) - Waveform selection + Gate control
- Voice 1 Attack/Decay: 54277 ($D405) - Envelope timing
- Voice 1 Sustain/Release: 54278 ($D406) - Envelope levels
- Voice 2 starts at 54279 ($D407), Voice 3 at 54286 ($D40E)

**SID Frequency Register Values for C Major Scale (C4-C5):**

**PAL vs NTSC Clock Differences:**
- PAL: 985,248 Hz SID clock
- NTSC: 1,022,727 Hz SID clock
- Formula: freq_value = round((frequency_Hz × 16777216) / clock_rate) (SID has a 24-bit phase accumulator)

**Complete SID Frequency Lookup Table (All Notes, Multiple Octaves):**

**NTSC Frequencies (1,022,727 Hz clock):**
| Note  | Hz      | SID Value | Lo    | Hi    | Note  | Hz      | SID Value | Lo    | Hi    |
|-------|---------|-----------|-------|-------|-------|---------|-----------|-------|-------|
| C2    | 65.41   | 1646      | $6E   | $06   | C#2   | 69.30   | 1744      | $D0   | $06   |
| D2    | 73.42   | 1848      | $38   | $07   | D#2   | 77.78   | 1958      | $A6   | $07   |
| E2    | 82.41   | 2072      | $18   | $08   | F2    | 87.31   | 2196      | $94   | $08   |
| F#2   | 92.50   | 2328      | $18   | $09   | G2    | 98.00   | 2465      | $A1   | $09   |
| G#2   | 103.83  | 2612      | $34   | $0A   | A2    | 110.00  | 2767      | $CF   | $0A   |
| A#2   | 116.54  | 2932      | $74   | $0B   | B2    | 123.47  | 3106      | $22   | $0C   |
| C3    | 130.81  | 3291      | $DB   | $0C   | C#3   | 138.59  | 3488      | $A0   | $0D   |
| D3    | 146.83  | 3696      | $70   | $0E   | D#3   | 155.56  | 3915      | $4B   | $0F   |
| E3    | 164.81  | 4145      | $31   | $10   | F3    | 174.61  | 4392      | $28   | $11   |
| F#3   | 185.00  | 4655      | $2F   | $12   | G3    | 196.00  | 4930      | $42   | $13   |
| G#3   | 207.65  | 5223      | $67   | $14   | A3    | 220.00  | 5534      | $9E   | $15   |
| A#3   | 233.08  | 5863      | $E7   | $16   | B3    | 246.94  | 6211      | $43   | $18   |
| C4    | 261.63  | 6583      | $B7   | $19   | C#4   | 277.18  | 6976      | $40   | $1B   |
| D4    | 293.66  | 7392      | $E0   | $1C   | D#4   | 311.13  | 7830      | $96   | $1E   |
| E4    | 329.63  | 8289      | $61   | $20   | F4    | 349.23  | 8784      | $50   | $22   |
| F#4   | 369.99  | 9310      | $5E   | $24   | G4    | 392.00  | 9859      | $83   | $26   |
| G#4   | 415.30  | 10446     | $CE   | $28   | A4    | 440.00  | 11068     | $CC   | $2B   |
| A#4   | 466.16  | 11726     | $CE   | $2D   | B4    | 493.88  | 12422     | $86   | $30   |
| C5    | 523.25  | 13166     | $4E   | $33   | C#5   | 554.37  | 13952     | $80   | $36   |
| D5    | 587.33  | 14784     | $C0   | $39   | D#5   | 622.25  | 15659     | $2B   | $3D   |
| E5    | 659.25  | 16578     | $C2   | $40   | F5    | 698.46  | 17568     | $A0   | $44   |
| F#5   | 739.99  | 18620     | $BC   | $48   | G5    | 783.99  | 19718     | $06   | $4D   |
| G#5   | 830.61  | 20892     | $9C   | $51   | A5    | 880.00  | 22137     | $99   | $56   |

**PAL Frequencies (985,248 Hz clock):**
| Note  | Hz      | SID Value | Lo    | Hi    | Note  | Hz      | SID Value | Lo    | Hi    |
|-------|---------|-----------|-------|-------|-------|---------|-----------|-------|-------|
| C2    | 65.41   | 1710      | $AE   | $06   | C#2   | 69.30   | 1812      | $14   | $07   |
| D2    | 73.42   | 1920      | $80   | $07   | D#2   | 77.78   | 2034      | $F2   | $07   |
| E2    | 82.41   | 2153      | $69   | $08   | F2    | 87.31   | 2281      | $E9   | $08   |
| F#2   | 92.50   | 2418      | $72   | $09   | G2    | 98.00   | 2560      | $00   | $0A   |
| G#2   | 103.83  | 2712      | $98   | $0A   | A2    | 110.00  | 2874      | $3A   | $0B   |
| A#2   | 116.54  | 3046      | $E6   | $0B   | B2    | 123.47  | 3227      | $9B   | $0C   |
| C3    | 130.81  | 3421      | $5D   | $0D   | C#3   | 138.59  | 3623      | $27   | $0E   |
| D3    | 146.83  | 3840      | $00   | $0F   | D#3   | 155.56  | 4068      | $E4   | $0F   |
| E3    | 164.81  | 4306      | $D2   | $10   | F3    | 174.61  | 4562      | $D2   | $11   |
| F#3   | 185.00  | 4835      | $E3   | $12   | G3    | 196.00  | 5120      | $00   | $14   |
| G#3   | 207.65  | 5424      | $30   | $15   | A3    | 220.00  | 5749      | $75   | $16   |
| A#3   | 233.08  | 6093      | $CD   | $17   | B3    | 246.94  | 6454      | $36   | $19   |
| C4    | 261.63  | 6842      | $BA   | $1A   | C#4   | 277.18  | 7246      | $4E   | $1C   |
| D4    | 293.66  | 7680      | $00   | $1E   | D#4   | 311.13  | 8136      | $C8   | $1F   |
| E4    | 329.63  | 8612      | $A4   | $21   | F4    | 349.23  | 9125      | $A5   | $23   |
| F#4   | 369.99  | 9670      | $C6   | $25   | G4    | 392.00  | 10240     | $00   | $28   |
| G#4   | 415.30  | 10849     | $61   | $2A   | A4    | 440.00  | 11498     | $EA   | $2C   |
| A#4   | 466.16  | 12186     | $9A   | $2F   | B4    | 493.88  | 12908     | $6C   | $32   |
| C5    | 523.25  | 13684     | $74   | $35   | C#5   | 554.37  | 14492     | $9C   | $38   |
| D5    | 587.33  | 15360     | $00   | $3C   | D#5   | 622.25  | 16272     | $90   | $3F   |

**Usage Notes:**
- All frequencies calculated with precise formulas for accurate tuning
- Sharps/flats (# symbols) are essential for proper key signatures
- Multiple octaves available: C2-A5 covers full musical range
- Use C#/Db, D#/Eb, F#/Gb, G#/Ab, A#/Bb for chromatic scales and proper harmony

**System Detection:** Check $02A6 (PAL=$01, NTSC=$00) or use appropriate table based on user's system type.

**Key Signature Reference:**
- C Major: C D E F G A B (no sharps/flats)
- G Major: C D E F# G A B (one sharp: F#)  
- D Major: C# D E F# G A B (two sharps: F#, C#)
- F Major: C D Eb F G A Bb (one flat: Bb)
- This comprehensive table ensures all notes are perfectly in tune for any key!

**Default Pleasant Sound - C Major Chord:**
Use multiple voices for harmony instead of single harsh tones:

NTSC System:
- Voice 1 (C4): Low=$B7, High=$19 (freq=6583)
- Voice 2 (E4): Low=$61, High=$20 (freq=8289)  
- Voice 3 (G4): Low=$71, High=$26 (freq=9841)

PAL System:  
- Voice 1 (C4): Low=$34, High=$1B (freq=6964)
- Voice 2 (E4): Low=$52, High=$22 (freq=8786)
- Voice 3 (G4): Low=$CB, High=$28 (freq=10443)

Waveform: Triangle wave ($10) + Gate ($01) = $11 (pleasant, not harsh)
ADSR: Attack/Decay=$31 (gentle), Sustain/Release=$F6 (smooth)

**Sound Generation Sequence:**
1. Set volume: write(54296, '0F')
2. Configure ADSR envelope for each voice  
3. Set frequencies for desired notes
4. Trigger with waveform + gate: write(control_reg, waveform + '1')
5. Stop by clearing gate: write(control_reg, waveform + '0')

**Advanced SID Music Techniques:**

**Multi-Voice Arrangements:**
- Voice 1: 54272-54278 (freq, pulse, control, attack/decay, sustain/release)
- Voice 2: 54279-54285 (same register layout, +7 from Voice 1)
- Voice 3: 54286-54292 (same register layout, +7 from Voice 2)
- Use different waveforms for different musical roles

**Waveform Selection (Control Register bits 4-7):**
- Triangle ($10): Smooth, mellow - perfect for bass lines and soft accompaniment
- Sawtooth ($20): Bright, cutting - excellent for lead melodies
- Pulse ($40): Rich harmonics - versatile for chords and melodies (requires pulse width setting)
- Noise ($80): Percussion and sound effects

**ADSR Envelope Settings:**
- Gentle/Romantic: Attack/Decay=$31, Sustain/Release=$F6-$F8
- Percussive/Rhythmic: Attack/Decay=$09-$41, Sustain/Release=$F0-$F4
- Lead Melody: Attack/Decay=$09, Sustain/Release=$F0 (quick attack, sustain for clarity)
- Soft Accompaniment: Attack/Decay=$31-$51, Sustain/Release=$A6-$C8

**Musical Arrangement Techniques:**
- Arpeggios: Play chord notes in sequence across voices for flowing accompaniment
- Lead + Harmony: Voice 1 sawtooth melody, Voices 2+3 triangle/pulse harmony
- Chord Progressions: Simultaneous 3-voice chords with appropriate voice spacing
- Classical Style: Bright lead (sawtooth) with soft arpeggiated accompaniment (triangle)

**Popular Song Examples (3-chord progressions):**
- C-F-G: Many folk and country songs
- G-C-D: Classic rock and ballad progression  
- A minor arpeggios: A-C-E-A for classical accompaniment
- Use faster tempos (0.6-0.8s chords) for upbeat, slower (1.2-1.5s) for ballads

## Program Structure
- Programs consist of numbered lines: 1–63999 recommended (absolute max 65535).
- Each line: lineNumber <space?> statement [{ : statement } ...]
- Statements on a line are separated by ':'; execution proceeds in line-number order.
- Comments: REM <text> (or ' in some editors, but not v2); everything until end-of-line.
- Whitespace is ignored outside strings; keywords are case-insensitive and stored tokenized.

## Data Types and Variables
- Types: numeric (floating point, 5-byte) and string.
- Numeric variable: A–Z or A–Z followed by digits (e.g., A, X1, SCORE10). No underscore.
- String variable: same as numeric but with trailing $ (e.g., A$, NAME$).
- Arrays: DIM name(size[,size...]) for numeric; DIM name$(...) for strings.
- Default array bounds: not allocated until DIM; indices start at 0 unless explicitly designed otherwise.
- Constants: numbers (e.g., 10, 3.14, .5, 1E3); strings in double quotes.

## Operators and Precedence (high → low)
1. Unary: -x, NOT x
2. Exponentiation: x ^ y
3. Multiplication/Division: x * y, x / y
4. Addition/Subtraction: x + y, x - y
5. Comparisons: =, <>, <, <=, >, >= (note: V2 uses =, <, > tokens; <= and >= are parsed as combinations)
6. Logical: AND, OR (non-short-circuit; numeric 0=false, nonzero=true)
Parentheses may be used to group.

## Control Flow Statements
- END: terminate program.
- STOP: break execution (like END but indicates stop).
- CONT: continue after STOP if possible.
- GOTO line: jump unconditionally.
- GOSUB line: call subroutine; RETURN: resume after call. Nesting depth limited by stack.
- IF expr THEN target
  - target: line number (GOTO implicit), or single statement after THEN.
  - ELSE is not in v2; use IF ... THEN ... : GOTO ... style.
- FOR var = start TO end [STEP step]
  - NEXT [var]
  - Loop variable is numeric; step defaults to 1; loop executes while (var <= end) for positive step, (var >= end) for negative.
  - NEXT may list multiple variables: NEXT I,J

## Input/Output and Devices
- PRINT [#dev,] [exprs]
  - Separators: ; concatenates without spacing; , tab to next zone (every 10 columns).
  - PRINT# is device output to open channel.
- INPUT [#dev,] list
  - Prompts with '?'; use INPUT# for device channel.
- GET [#dev,] var: read single character (no echo), or from device with GET#.
- TAB(n), SPC(n) in PRINT:
  - TAB(n): move to column n (1-based). SPC(n): print n spaces.
- CMD dev: make dev the default output device until PRINT# or CMD closed.
- OPEN dev,[sec],sa,"filename[,params]"; CLOSE dev
  - dev: device number (e.g., 8 for disk); sec is secondary address; sa usually 0 for read, 1 for write.
- LOAD "name",dev[,sa]; SAVE "name",dev[,sa]
  - On C64, dev=8 is disk drive; without dev uses default.
- VERIFY "name",dev: compare program in memory with storage.

## Data and Variables
- LET var = expr (LET optional).
- READ var[, var...]; DATA literal[, literal...]; RESTORE resets DATA pointer to first DATA.

## String Handling
- Concatenation: A$ + B$
- Substrings: LEFT$(A$,n), MID$(A$,start[,len]), RIGHT$(A$,n)
- Conversion: STR$(n) -> string; VAL(A$) -> numeric; CHR$(n) -> 1-char string; ASC(A$) -> code of first char.
- LEN(A$) -> length in characters.
- **Quotes in strings**: Cannot use " directly inside "...". Use CHR$(34) for quote character.
  Example: PRINT "He said " + CHR$(34) + "Hello!" + CHR$(34) + " to me"

## Numeric Functions
- ABS, SGN, INT, RND([n]), SQR, LOG, EXP, SIN, COS, TAN, ATN, FRE(x), POS(x), USR(x)
- RND behavior: RND(0) repeats last sequence; RND(1) yields [0,1); RND(n<0) seeds with n.
- USR(x): calls machine-language routine pointed by vector at $0311/$0312; return value in FAC.
- PEEK(addr) reads byte; POKE addr, byte writes byte.

## Screen and Keyboard Helpers
- POKE 646,color: set default text color; PRINT CHR$(147) clears screen.
- GET A$: non-blocking single key; returns "" if none.

## Memory and Addresses
- Default BASIC start: $0801. Program and variables share memory up to top-of-BASIC pointer.
- Important areas: Screen $0400–$07E7; Color RAM $D800–$DBE7; I/O/VIC/SID at $D000+.

## Errors and Limits (common)
- Syntax errors at tokenization or runtime: ?SYNTAX ERROR, ?TYPE MISMATCH, ?OUT OF MEMORY, ?REDIM'D ARRAY, etc.
- Line length: ~80 visible chars editor limit; interpreter line storage larger but practical limits apply.
- Variable namespaces: A and A$ are distinct; arrays share namespace with scalars.

## Grammar (informal)
- program := { line }+
- line := lineNumber [statement] { ':' statement }
- statement :=
  END | STOP | CONT |
  GOTO lineNumber |
  GOSUB lineNumber | RETURN |
  FOR var '=' expr TO expr [STEP expr] | NEXT [var {',' var}] |
  IF expr THEN ( lineNumber | statement ) |
  LET? var '=' expr |
  PRINT [ printlist ] | PRINT# expr, [ printlist ] |
  INPUT [ inputlist ] | INPUT# expr, [ inputlist ] |
  GET var | GET# expr, var |
  READ varlist | DATA datalist | RESTORE |
  DIM dimlist |
  OPEN expr[,expr][,expr][,string] | CLOSE expr |
  LOAD string[,expr][,expr] | SAVE string[,expr][,expr] | VERIFY string[,expr] |
  POKE expr, expr | SYS expr | WAIT expr[,expr[,expr]] |
  ON expr GOTO linelist | ON expr GOSUB linelist

## Token List (selected)
END, FOR, NEXT, DATA, INPUT, INPUT#, DIM, READ, LET, GOTO, RUN, IF, RESTORE, GOSUB, RETURN, REM, STOP, ON, WAIT, LOAD, SAVE, VERIFY, DEF, POKE, PRINT#, PRINT, CONT, LIST, CLR, CMD, SYS, OPEN, CLOSE, GET, NEW, TAB(, TO, FN, SPC(, THEN, NOT, STEP, AND, OR, >, =, <, SGN, INT, ABS, USR, FRE, POS, SQR, RND, LOG, EXP, COS, SIN, TAN, ATN, PEEK, LEN, STR$, VAL, ASC, CHR$, LEFT$, RIGHT$, MID$, GO

## Notes and Dialect Differences
- ELSE is not part of v2; no WHILE/REPEAT; no LOCAL variables.
- Disk commands via PRINT# to command channel (15) on device 8, e.g., PRINT#15,"S0:NAME".
- Some editors accept '?' as PRINT abbreviation; stored as PRINT token.
`;

export function getBasicV2Spec(): string {
  return basic_spec;
}

export function searchBasicV2Spec(query: string): Array<{ heading: string; content: string }> {
  return searchMarkdownSections(basic_spec, query);
}

const ASM_GUIDE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/assembly/assembly-spec.md");
let cachedAsmReference: string | null = null;

export function getAsmQuickReference(): string {
  if (cachedAsmReference) return cachedAsmReference;
  try {
    cachedAsmReference = readFileSync(ASM_GUIDE_PATH, "utf8");
  } catch {
    cachedAsmReference = "# 6502 Assembly Quick Reference\n\nReference file not found.";
  }
  return cachedAsmReference;
}

export function searchAsmQuickReference(query: string): Array<{ heading: string; content: string }> {
  const guide = getAsmQuickReference();
  return searchMarkdownSections(guide, query);
}

// --- VIC-II Knowledge Base (Concise but practical for graphics/sprites) ---

export const vic_spec: string = `
# VIC-II Technical Knowledge Base (Concise, PAL/NTSC, timing-driven)

## Overview
The VIC-II (MOS 6567 NTSC / 6569 PAL) is the video interface in the Commodore 64. It handles text/bitmap graphics, sprites, colour, fine scrolling, raster IRQs, and DRAM refresh. All effects are raster and cycle-timed.

## Video Standards
- PAL 6569: ~312 raster lines, ~63 cycles/line, 50.12 Hz frame rate, CPU ~0.985 MHz.
- NTSC 6567: ~262 raster lines, ~65 cycles/line, 59.83 Hz frame rate, CPU ~1.023 MHz.
  - Note: Exact values vary slightly by chip revision and board. The CPU clock is derived from the VIC, hence different between PAL and NTSC.

## Text and Bitmap Modes (Built-in)
| Mode | Resolution | Cell granularity | Colours per cell | Notes |
|------|------------|------------------|------------------|-------|
| Text (Hi-res) | 40×25 characters (320×200 px) | 8×8 | 1 fg + bg | Default. Foreground per-character via Colour RAM; BG via $D021. |
| Multicolour Text | 40×25 (effective 160×200 px) | 4×8 | Up to 3 + BG | Double-wide pixels horizontally; shares $D021–$D023 colours. |
| Extended Background (ECM) | 40×25 | 8×8 | 4 BG | Top 2 bits of char code select BG from $D021–$D024. |
| Bitmap Hi-Res | 320×200 | 8×8 | 2 per block | BMM=1, MCM=0. Colours per 8×8 from screen RAM nybbles. |
| Bitmap Multicolour | 160×200 | 4×8 | 3 + BG | BMM=1, MCM=1. Colours per 4×8 from screen RAM nybbles. |

## Special “Research” Modes (Demo-scene techniques)
These are not official hardware modes; they exploit timing and badline behaviour to increase colour detail:
- FLI (Flexible Line Interpreter): Forces a badline every raster line (by changing $D011 Y-scroll each line) so that colour nybbles are reloaded per line, yielding more colours per character row in bitmap or char modes. Costs: very heavy DMA (badline each line) and tight cycle budgets.
- AFLI/IFLI (Advanced/Interlaced FLI): Variants combining hi-res and multicolour assets and/or alternating frames to increase apparent colour count at the cost of flicker and extreme timing.
- NUFLI, SHIFLI and derivatives: Advanced compressors of colour clashes using sprite overlays plus FLI. Require multiplexing and per-line colour changes.
These modes demand stable raster IRQs, avoiding writes during critical cycles (especially on badlines) and often sprite multiplexing.

## Sprite System
- 8 hardware sprites (0–7), nominal 24×21 px; multicolour halves horizontal resolution to 12×21 with 3 + transparent colours.
- Control: position $D000–$D00F (+$D010 MSBs), enable $D015, multicolour $D01C, behind/priority $D01B, expand X $D01D, expand Y $D017.
- Colour: shared $D025/$D026; per-sprite colours $D027–$D02E.
- Data: 63 bytes/sprite (3 bytes/row × 21 rows). Sprite pointers at $07F8–$07FF hold (address/64).
- Limit: max 8 sprites on any raster line (hardware). Exceed width with multiplexing via raster IRQ repositioning.

## Raster and Timing Essentials
- Raster register: $D012 (low 8 bits), high bit in $D011 bit 7 is NOT the high raster bit; note: $D011 bit 7=screen on/off; high raster bit is bit 7 of $D011? On C64: bit 7 of $D011 is actually the 9th raster bit when read via $D011; the same register contains vertical scroll (lower 3 bits), ECM and BMM bits.
- Badlines: Occur when (screen enabled) AND (rasterY between first and last text row) AND ((rasterY & 7) == (Y-scroll bits in $D011)). On a badline the VIC fetches 40 character pointers, stealing about 40 cycles, leaving ~23 CPU cycles on PAL. There are 25 potential badlines for the 25 text rows per frame (when screen on).
- Sprite DMA: Each visible sprite steals ~3 cycles per raster line while fetching its graphics. Fetch windows are fixed per sprite index; budget carefully on heavy lines. These steals are in addition to badline character fetches.
- Per-line CPU cycles (approximate):
  - PAL non-badline: ~63 − 3×(active sprites on that line)
  - PAL badline: ~23 − 3×(active sprites not covered by the 40-char fetch window)
  - NTSC has ~65 cycles per line; proportions similar. Exact overlap depends on chip revision; measure on target hardware if cycle-exact code is required.

## Opening Borders (precise effect windows)
Border visibility depends on the scroll bits and internal fetch state. The classic windows are:
- Top/Bottom border: Toggle $D011 bit 3 (denoted RSEL/Y-Enable) around the transition into/out of the main display to trick the VIC into considering display active. Common practice is to change $D011 as the raster passes the last visible row (e.g., lines $F8–$FB on PAL) with stable-cycle IRQs.
- Side borders: Write to $D016 (horizontal scroll) within a narrow cycle window early in a raster line of the visible area (roughly cycles 24–26 on PAL for the canonical trick) to prevent the side border from opening. Maintain matching scroll values per line to keep it open. This must be timed each line you want the side border suppressed.
Notes: Exact cycle numbers vary slightly (PAL vs NTSC and chip revisions). Always establish a stable raster using a delay-tuned IRQ prologue and verify on real hardware.

## PAL/NTSC Geometry
- Text columns/rows: 40×25 in both PAL and NTSC when borders are normal.
- Visible bitmap area: 320×200 (hi-res) or 160×200 (multicolour). The full frame has additional border scanlines and cycles that are not visible unless border tricks are used.
- Frame/refresh rates: PAL ~50.12 Hz; NTSC ~59.83 Hz. Colour subcarrier and pixel clocks differ, affecting exact cycle lengths.

## Useful Registers (subset)
$D011: CTRL1 (bit7=High raster bit when reading; writing: bit7 Screen on/off), bit6 ECM, bit5 BMM, bit4 (unused), bits 0–2=Y scroll.
$D016: CTRL2 (bit4 MCM, bits 0–2 X scroll).
$D015: Sprite enable, $D01C: Sprite multicolour, $D01D: Sprite X expand, $D017: Sprite Y expand.
$D020/$D021: Border/background, $D022–$D024: shared multicolours, $D025/$D026: sprite shared colours.
$07F8–$07FF: Sprite data pointers (address/64).

## Best Practices for Raster Effects
- Do not write to $D011/$D016 during badlines unless you deliberately trigger FLI behaviour.
- Align IRQs to known cycle counts; use a stable raster entry sequence (acknowledge $D019, delay with a tuned instruction sequence, then effect writes).
- Budget for sprite DMA on lines with many sprites; schedule heavy updates on non-badlines.
- Disable screen ($D011 bit7=0) temporarily to suppress badlines when maximum CPU time is needed.

## References
- Zimmers.net: VIC-II register and memory maps
- C64 Programmer’s Reference Guide (graphics and raster chapters)
- Codebase64: VIC-II timing tables, badline definitions, border opening write windows, and FLI/IFLI techniques
`;

export function getVicIISpec(): string {
  return vic_spec;
}

export function searchVicIISpec(query: string): Array<{ heading: string; content: string }> {
  return searchMarkdownSections(vic_spec, query);
}

function searchMarkdownSections(content: string, query: string): Array<{ heading: string; content: string }> {
  if (!query || typeof query !== "string") {
    return [];
  }
  const normalized = query.trim().toLowerCase();
  const sections: Array<{ heading: string; content: string }> = [];
  const lines = content.split(/\r?\n/);
  let currentHeading = "";
  let currentBuffer: string[] = [];
  const flush = () => {
    if (!currentHeading) return;
    const content = currentBuffer.join("\n").trim();
    sections.push({ heading: currentHeading, content });
  };
  for (const line of lines) {
    const headingMatch = /^(##+)\s+(.*)$/.exec(line);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2].trim();
      currentBuffer = [];
    } else {
      currentBuffer.push(line);
    }
  }
  flush();

  const matches = sections.filter((s) =>
    s.heading.toLowerCase().includes(normalized) || s.content.toLowerCase().includes(normalized),
  );
  return matches;
}
