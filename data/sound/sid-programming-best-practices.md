# SID Programming Best Practices - Perfect Scale Generation

## Overview

This document captures the successful approach for creating pleasant, musical SID sounds on the Commodore 64, discovered through iterative testing with the MCP server and real hardware feedback.

## Sample Programs

### Play C Major Scale with Basic

```basic
10 POKE 54296,15:REM VOLUME
20 POKE 54277,17:POKE 54278,240:REM FAST ATTACK, SLOW RELEASE
30 REM LOWER C MAJOR SCALE WITH TRIANGLE WAVE
40 POKE 54273,30:POKE 54274,0:POKE 54276,17:FOR I=1 TO 3000:NEXT I:POKE 54276,16:FOR I=1 TO 500:NEXT I
50 POKE 54273,34:POKE 54274,0:POKE 54276,17:FOR I=1 TO 3000:NEXT I:POKE 54276,16:FOR I=1 TO 500:NEXT I
60 POKE 54273,38:POKE 54274,0:POKE 54276,17:FOR I=1 TO 3000:NEXT I:POKE 54276,16:FOR I=1 TO 500:NEXT I
70 POKE 54273,40:POKE 54274,0:POKE 54276,17:FOR I=1 TO 3000:NEXT I:POKE 54276,16:FOR I=1 TO 500:NEXT I
80 POKE 54273,45:POKE 54274,0:POKE 54276,17:FOR I=1 TO 3000:NEXT I:POKE 54276,16:FOR I=1 TO 500:NEXT I
90 POKE 54273,51:POKE 54274,0:POKE 54276,17:FOR I=1 TO 3000:NEXT I:POKE 54276,16:FOR I=1 TO 500:NEXT I
100 POKE 54273,57:POKE 54274,0:POKE 54276,17:FOR I=1 TO 3000:NEXT I:POKE 54276,16:FOR I=1 TO 500:NEXT I
110 POKE 54273,60:POKE 54274,0:POKE 54276,17:FOR I=1 TO 3000:NEXT I:POKE 54276,16
120 POKE 54276,0:PRINT "SMOOTH SCALE DONE"
```

## Key Success Factors

### 1. Frequency Register Bytes

- **Register layout**: 54272 ($D400) is the frequency LOW byte and 54273 ($D401) the frequency HIGH byte. 54274 ($D402) is the pulse width LOW byte and has no effect on a triangle wave.
- **What the program does**: it writes 30-60 to the frequency HIGH byte and leaves the low byte alone. With the low byte at 0 that is register value 7680-15360, which is about 451-902 Hz on PAL (468-936 Hz NTSC). These are not low frequencies.
- **Pitch from a table**: the standard frequency table gives correct pitches (C4 = $1167 on PAL); see `sid-spec.md`. The scale above is not tuned to it.

### 2. Triangle Wave Instead of Pulse

- **Register 54276**: Use value `17` (triangle wave + GATE) instead of `33` (pulse wave + GATE)
- **Benefit**: Triangle waves are much smoother and more musical than pulse waves
- **Off State**: Use `16` (triangle wave, no GATE) to properly release notes

### 3. Proper ADSR Envelope

- **Attack/Decay (54277)**: `17` = $11 = attack 1 (8 ms), decay 1 (24 ms)
- **Sustain/Release (54278)**: `240` = high sustain (15), no release (0)
- **Effect**: Creates natural-sounding note onset and sustain

### 4. Timing is Everything

- **Note Duration**: a `FOR I=1 TO 3000:NEXT I` loop (3000 iterations, not CPU cycles; the duration in seconds is unverified)
- **Pause Duration**: a 500-iteration loop between notes for clear separation
- **GATE Control**: Keep GATE on during entire note, then turn off cleanly

### 5. Musical Expression and Phrasing

- **Varied Note Lengths**: Don't make all notes the same duration - create rhythm and emphasis
- **Phrase Breathing**: Use longer pauses between musical phrases (150-200 loop iterations)
- **Dynamic Emphasis**: Emphasize important notes (phrase beginnings/endings) with longer durations
- **Narrative Flow**: Each phrase should have its own character and emotional arc
- **Quick Passages**: Use shorter notes (140-180 loop iterations) for rapid, flowing sections
- **Sustained Endings**: Use longer notes (400-600 loop iterations) for phrase climaxes and endings

## Technical Analysis

### Frequency Values Used

```text
Note | High Byte (54273) | Hz PAL (low byte 0) | Hz NTSC (low byte 0)
-----|-------------------|---------------------|---------------------
C    | 30                | 451                 | 468
D    | 34                | 511                 | 531
E    | 38                | 571                 | 593
F    | 40                | 601                 | 624
G    | 45                | 677                 | 702
A    | 51                | 767                 | 796
B    | 57                | 857                 | 890
C    | 60                | 902                 | 936
```

### Register Settings

```text
54296 (Volume): 15 (maximum)
54277 (AD): 17 = $11 (attack=1, decay=1)
54278 (SR): 240 (sustain=15, release=0)
54273 (Freq Hi): Variable per note
54274 (Pulse Width Lo): 0 (always; no effect on a triangle wave)
54276 (Control): 17 (triangle+gate) / 16 (triangle only)
```

## Common Pitfalls to Avoid

### 1. Using Documentation Frequencies Directly

- The standard frequency table gives the correct pitch (C4 = 261.63 Hz = $1167 on PAL, $10C4 on NTSC)
- Write both bytes: low byte to 54272 ($D400), high byte to 54273 ($D401)

### 2. Pulse Wave Without Proper Setup

- Pulse waves require careful pulse width settings
- Triangle waves are much more forgiving and musical

### 3. Inadequate ADSR Settings

- Without proper envelope, notes sound like short clicks
- Fast attack + slow decay + high sustain = musical notes

### 4. Poor GATE Timing

- GATE must stay on during the entire note duration
- Turning GATE off too early creates click-like sounds

## Testing Methodology

This solution was developed through:

1. **Real Hardware Testing**: Used actual C64 Ultimate with MCP server
2. **Iterative Refinement**: Multiple attempts with frequency adjustments
3. **Audio Feedback**: Human verification of pleasant vs. harsh sounds
4. **Systematic Debugging**: Isolated individual notes before building full scale

## MCP Server Integration

### Upload Command

> [!NOTE]
> These curl commands require the optional legacy HTTP bridge. Start it manually before using them; the day-to-day workflow runs over MCP stdio.

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"op": "upload_run_basic", "program": "... BASIC program ..."}' \
  http://localhost:8000/tools/c64_program
```

### Future Audio Analysis

The working scale can now be used with `c64_sound` and `op: "analyze"`:

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"op": "analyze", "request": "verify the scale sounds correct"}' \
  http://localhost:8000/tools/c64_sound
```

## Musical Expression Example: "Alle meine Entchen"

The following example demonstrates how to create a musically expressive children's song using varied timing and proper phrasing. This serves as a template for writing engaging melodies.

### Key Musical Programming Principles

1. **Opening Emphasis**: First note gets longer duration (250 loop iterations) to establish the song
2. **Flowing Middle**: Quick notes (180 loop iterations) for melodic flow
3. **Phrase Endings**: Extended notes (400-600 loop iterations) at the end of each phrase
4. **Breathing Space**: Longer pauses (150-200 loop iterations) between phrases
5. **Character Variation**: Each verse has its own timing character:
   - "Swimming" = light, quick notes (160 loop iterations)
   - "Diving" = very short, rapid notes (140 loop iterations)
   - "Triumphant ending" = building emphasis

### Example Implementation

```basic
REM ALLE MEINE ENTCHEN - MUSICAL PHRASING
POKE 54296,15:POKE 54277,17:POKE 54278,240

REM OPENING PHRASE - emphasis on first note
POKE 54273,30:POKE 54274,0:POKE 54276,17:FOR I=1 TO 250:NEXT I:POKE 54276,16:FOR I=1 TO 40:NEXT I
POKE 54273,34:POKE 54274,0:POKE 54276,17:FOR I=1 TO 180:NEXT I:POKE 54276,16:FOR I=1 TO 40:NEXT I
REM ... continued with varied timing for musical expression
```

**Complete example**: See `data/basic/examples/audio/alle-meine-entchen-expressive.bas`

### Timing Patterns for Different Musical Effects

Values are FOR-loop iteration counts; durations in seconds are unverified.

- **Emphasis/Importance**: 250-400+ iterations
- **Normal melody notes**: 180-200 iterations  
- **Quick/flowing passages**: 140-160 iterations
- **Short pauses**: 25-40 iterations
- **Phrase breathing**: 120-200 iterations
- **Dramatic pauses**: 150-250 iterations

## Conclusion

The key insight is that **musical programming requires human feedback** in addition to correct register values. The frequency table in `sid-spec.md` gives correct pitches; the scale above uses only the high frequency byte. This approach prioritizes:

1. **Listenability** over technical accuracy
2. **Smooth waveforms** (triangle) over complex ones (pulse)
3. **Proper envelopes** for musical note shaping
4. **Musical expression** through varied timing and phrasing
5. **Real hardware testing** to validate results

**For Children's Songs and Simple Melodies**: Use the expressive timing patterns demonstrated in "Alle meine Entchen" to create engaging, musical compositions that tell a story rather than just playing notes mechanically.

This methodology can be applied to create more complex musical compositions while maintaining the warm, pleasant character achieved in this scale progression.

---

*Document created: December 2024*  
*Based on successful MCP server + C64 Ultimate testing session*
