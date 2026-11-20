# Commodore 64 SID (MOS 6581 / 8580) — Concise Technical Overview

## Overview

- **Voices:** 3 independent oscillators  
  Each has: 16-bit frequency, waveform select (triangle / saw / pulse / noise), pulse-width, ADSR envelope, optional SYNC and RING-MOD.  
- **Global:** Analog multimode filter (LP / BP / HP), resonance, master volume, and read-back registers for OSC3 and ENV3.  
- **Models:** 6581 (original, “warmer”, nonlinear filter) and 8580 (revised, linear filter, lower noise).

---

## Register Map (base = $D400 / 54272)

**Per Voice (1 – 3):**

| Function | Voice 1 | Voice 2 | Voice 3 | Bits / Notes |
|-----------|----------|----------|----------|--------------|
| Frequency LO | $D400 | $D407 | $D40E | Low byte of 16-bit pitch increment |
| Frequency HI | $D401 | $D408 | $D40F | High byte |
| Pulse Width LO | $D402 | $D409 | $D410 | 12-bit value (0-4095) |
| Pulse Width HI | $D403 | $D40A | $D411 | Upper 4 bits used |
| Control | $D404 | $D40B | $D412 | **7..0 = NOISE PULSE SAW TRI TEST RING SYNC GATE** |
| AD | $D405 | $D40C | $D413 | Attack/Decay nibbles |
| SR | $D406 | $D40D | $D414 | Sustain/Release nibbles |

**Global:**

| Function | Address | Description |
|-----------|----------|-------------|
| Cutoff LO | $D415 | Bits 0-2 = low 3 bits of filter cutoff |
| Cutoff HI | $D416 | High 8 bits of filter cutoff |
| Res/Routing | $D417 | 7..4 = resonance (0–15); 3..0 = route Ext,V3,V2,V1 into filter |
| Mode/Volume | $D418 | 0..3 = master vol (0–15); 4..6 = LP/BP/HP; 7 = CH3 off |
| Read-backs | $D419–$D41C | POTX, POTY, OSC3, ENV3 |

---

## Note → SID Frequency

```
FREQ = round( note_hz * 2^24 / φ2 )   ; 16-bit register value
```

- φ₂ = system clock  
  - PAL = 985 248 Hz  
  - NTSC = 1 022 727 Hz  
- Store FREQ (low/high) into FREQLO/HI.  
- Typical usage: lookup table per note/octave.

**Example (PAL):**

```
FREQ16 = round( (note_hz * 16777216) / 985248 )
```

---

## Basic Play / Stop Sequence

1. Set FREQ, PW, AD/SR.  
2. Write CTRL = waveform bits | GATE (=1) → start note.  
3. Clear GATE bit to release note.

---

## Waveforms & Pulse Width

- **Waveform bits:** Triangle = bit 4, Saw = 5, Pulse = 6, Noise = 7.  
- **Pulse Width:** 12-bit ($000–$FFF); $0800 ≈ 50 % duty.  
- Combining waveform bits produces nonlinear mixed timbres.  
- PWM = vary pulse-width in real time.

---

## Filter Block

- **Cutoff:** $D415 + $D416 (11 bits).  
- **Resonance / Routing:** $D417.  
- **Mode / Volume:** $D418 → LP/BP/HP bits + master volume.  
- **Differences:** 6581 = nonlinear; 8580 = more accurate.

---

## Famous Effects

**Arpeggio** – Cycle chord intervals (e.g. 0,+4,+7) each tick by rewriting FREQ.  
**Vibrato** – Small sinusoidal offset of FREQ each tick (software LFO).  
**PWM** – Periodic variation of pulse-width for animated tone.  
**Filter Sweep** – Ramp cutoff ($D415/$D416) and/or resonance ($D417).  
**Hard Restart** – Clear GATE early, optionally TEST=1 to reset osc; next tick set ADSR + GATE=1 for tight attack.  
**Sync / Ring-Mod** – Enable SYNC or RING bits in CTRL to tie oscillators.  
**Digi Playback** – Rapid writes to $D418 volume simulate 4-bit PCM DAC (~4–8 kHz).

---

## Reset Tips

Write $FF then $00 to all SID registers on init to clear stale state before loading new instrument settings.

---

## Alternative Exact Frequency Formulas

```
PAL:  x = f * (18 * 2^24) / 17734475
NTSC: x = f * (14 * 2^24) / 14318182
```

Equivalent to `FREQ = f * 2^24 / φ2`; the result is the 16-bit register value.

---

## Frequency Table (C-Major, A4 = 440 Hz)

| Note | Freq (Hz) | FREQ PAL (hex) | FREQ NTSC (hex) |
|------|------------|----------------|-----------------|
| C4 (Do) | 261.63 | 0x1167 (4455) | 0x10C4 (4292) |
| D4 (Re) | 293.66 | 0x1389 (5001) | 0x12D1 (4817) |
| E4 (Mi) | 329.63 | 0x15ED (5613) | 0x151F (5407) |
| F4 (Fa) | 349.23 | 0x173B (5947) | 0x1661 (5729) |
| G4 (Sol)| 392.00 | 0x1A13 (6675) | 0x191F (6431) |
| A4 (La) | 440.00 | 0x1D45 (7493) | 0x1C32 (7218) |
| B4 (Ti) | 493.88 | 0x20DA (8410) | 0x1FA6 (8102) |
| C5 (Do) | 523.25 | 0x22CE (8910) | 0x2188 (8584) |

*Multiply FREQ by 2ⁿ to move up n octaves.*

---

## Primary References (for RAG)

- Oxyron SID Register Reference — bit map, frequency formulas, play sequence.  
- Commodore 64 Programmer’s Reference (sound chapter, PDF).  
- C64-Wiki — SID overview and filter behavior.  
- Codebase64 — SID programming patterns (arpeggio, vibrato, PWM, players).  
- $D418 Digi Playback articles — technique and bias requirements.

---

## Typical Usage Snippet (ASM)

```asm
; Initialize SID
lda #$0f        ; volume = 15
sta $d418

; Play note (Voice 1 example)
lda freq_lo
sta $d400
lda freq_hi
sta $d401
lda #$00
sta $d402
lda #$08
sta $d403
lda #$11
sta $d405
lda #$f3
sta $d406
lda #%01000001  ; pulse + gate
sta $d404

; ... release ...
and #%11111110
sta $d404
```
