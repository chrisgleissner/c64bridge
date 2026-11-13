# Turbo benchmark results

Measured 2026-11-13 with `scripts/turbo-bench.mjs --suite full` (programs and method: `data/ultimate/bench/README.md`).
Raw decoded data, including every repetition's CIA tick count, is in `ultimate-64-2026-11-13.json` and `c64u-2026-11-13.json`.
Both machines were PAL, with the REU enabled (16 MB), interrupts off, `$01 = $35`. The frame-length records read 19657 ticks
(nominal 19656 plus the timer counting convention) in every run, which proves the timebase and raster synchronisation.

Definitions. "Multiple" is the delivered CPU rate as a multiple of PHI2 (0.985248 MHz PAL), so index 0 is 1.0000 and a
"48 MHz" setting is 47.00. "MHz" columns are multiple x 0.985248. "Cycles/frame" is the number of CPU cycles the program
executed per PAL frame, counted at the delivered speed (multiple x 19656 PHI2 cycles). "on" is the screen on with badlines
(`$D011 = $1B`), "blank" has `$D011` bit 4 clear, "+sprites" has eight double-height sprites enabled. Loads use 50 percent
accesses of the named type: `lda abs` from RAM, `sta $D020`, `lda $D012` (VIC), `lda $DC05` (CIA). Median of three repetitions,
three start rasters. `$D031` bit 7 clear (stock badline timing) in the main tables. REU rates are bytes per microsecond
(bytes per PHI2 tick x 0.985248), from the slope between 32 KB and 16 KB transfers.

Findings.

* RAM speed scales with the setting: the blanked RAM multiple equals the nominal MHz up to 32 MHz on both machines, and is one
  short at the top entries (U64 idx 14/15: 38.99 and 47.00 for 40 and 48 MHz; C64U idx 14/15: 47.00 and 63.00 for 48 and
  64 MHz; C64U 40 MHz: 39.99).
* Screen on at 1 MHz loses 1081 cycles per PAL frame (25 badlines x 43.2); at higher speed the loss scales with the speed
  (about 5.5 percent at every index). Eight double-height sprites on a blanked screen cost another 802 cycles at 1 MHz,
  also scaling (4.1 percent).
* `$D031` bit 7 set removes all of that: screen on and blanked, with and without sprites, give the same multiple at 1, 12/14 and
  top speed (a loss of at most 0.2 percent remains at top speed). Bit 7 set means badline (and sprite) stalls are
  suppressed. The `Badline Timing` configuration item had no effect on results while Turbo Control was in registers mode
  (the program writes bit 7 through `$D031`); it was not tested separately in the other modes.
* Reading `$D012` falls behind RAM from 24 MHz and clearly from 32 MHz (U64 at 48 MHz: 42.1 against 47.0 multiples of PHI2;
  C64U at 64 MHz: 56.5 against 63.0). Writes to `$D020` run at RAM speed. A loop that reads a CIA register saturates: about
  4.0 multiples at 5-6 MHz, 7.5 at 8-12 MHz and 8.8 from 14 MHz up (the CPU waits for the CIA).
* REU DMA is not proportional to the CPU speed and is not monotonic. At 1, 2 and 3 MHz it is 1, 2 and 3 bytes per PHI2
  tick. The U64 stash is 3.0 to 5.1 B/us from 6 MHz up and the fetch 2.0 to 3.6 B/us (index 3 fetch equals index 1, index 5
  stash equals index 2); the C64U stash reaches 7.8 B/us and the fetch 4.3 B/us (stash at 10 MHz and 20 MHz is lower than at the
  neighbouring settings). With the screen on and badlines the rate is about 5 percent lower.
* After the reset done by `run_prg`, a `$D031` speed request was ignored for 2.55 s (U64) and 2.57 s (C64U) after program start.

Flagged points. In the `Manual` and `TurboEnable Bit` runs the first point (screen on, RAM load, repetition 1) carries the
interference flag on both devices (for example U64 manual 12 MHz repetitions 2536245, 416596, 416596 ticks; C64U manual
64 MHz 2699263, 423317, 422973). In those modes the program does not probe for the speed, so repetition 1 ran during the
post-reset 1 MHz window. The reported median of the three repetitions is unaffected and equals the registers-mode value. The
cpu-regs-all runs were read four times early by the host script (its time estimate of 350 s was too short; the script now
uses 442 s for the full run), and the flags and spreads (below 0.4 percent) show no disturbance.

## Ultimate 64, 2026-11-13

Firmware 3.15a, FPGA 126, core 1.50. PAL (frame 19657 ticks). Multiples are relative to PHI2 (0.985248 MHz).

### CPU, Turbo Control = U64 Turbo Registers, Badline Timing as configured, `$D031` bit 7 clear

| idx | nominal MHz | blank RAM multiple of PHI2 | blank RAM MHz | on RAM MHz | blank $D020 MHz | blank $D012 MHz | blank CIA MHz | cycles/frame blank | on | on+sprites | blank+sprites | cycles/line on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 1 | 1 | 0.99 | 0.93 | 0.99 | 0.99 | 0.99 | 19656 | 18575 | 17783 | 18854 | 59.54 |
| 1 | 2 | 2 | 1.97 | 1.86 | 1.97 | 1.97 | 1.93 | 39313 | 37151 | 35571 | 37708 | 119.07 |
| 2 | 3 | 3 | 2.96 | 2.79 | 2.96 | 2.96 | 2.61 | 58970 | 55726 | 53356 | 56563 | 178.61 |
| 3 | 4 | 4 | 3.94 | 3.72 | 3.94 | 3.94 | 3.73 | 78627 | 74302 | 71143 | 75418 | 238.15 |
| 4 | 5 | 5 | 4.93 | 4.66 | 4.93 | 4.93 | 4.02 | 98284 | 92877 | 88929 | 94272 | 297.68 |
| 5 | 6 | 6 | 5.91 | 5.59 | 5.91 | 5.91 | 4.02 | 117941 | 111453 | 106714 | 113127 | 357.22 |
| 6 | 8 | 8 | 7.88 | 7.45 | 7.88 | 7.88 | 7.46 | 157255 | 148604 | 142287 | 150836 | 476.29 |
| 7 | 10 | 9.9999 | 9.85 | 9.31 | 9.85 | 9.85 | 7.46 | 196569 | 185754 | 177857 | 188545 | 595.37 |
| 8 | 12 | 11.9999 | 11.82 | 11.17 | 11.82 | 11.82 | 7.46 | 235883 | 222906 | 213429 | 226254 | 714.44 |
| 9 | 14 | 13.9999 | 13.79 | 13.03 | 13.79 | 13.79 | 8.70 | 275197 | 260057 | 249001 | 263963 | 833.51 |
| 10 | 16 | 15.9999 | 15.76 | 14.90 | 15.76 | 15.76 | 8.70 | 314510 | 297208 | 284573 | 301673 | 952.59 |
| 11 | 20 | 19.9999 | 19.70 | 18.62 | 19.70 | 19.70 | 8.71 | 393138 | 371510 | 355716 | 377091 | 1190.74 |
| 12 | 24 | 23.9999 | 23.65 | 22.34 | 23.65 | 23.50 | 8.71 | 471766 | 445811 | 426860 | 452510 | 1428.88 |
| 13 | 32 | 31.9998 | 31.53 | 29.79 | 31.53 | 29.85 | 8.71 | 629021 | 594415 | 569146 | 603347 | 1905.18 |
| 14 | 40 | 38.9998 | 38.42 | 36.34 | 38.42 | 35.19 | 8.71 | 766620 | 725003 | 693456 | 736079 | 2323.73 |
| 15 | 48 | 46.9998 | 46.31 | 43.80 | 46.31 | 41.51 | 8.71 | 923875 | 873784 | 836375 | 886920 | 2800.59 |

### REU DMA, bytes per microsecond (median of repetitions; 32 KB minus 16 KB slope), 1-byte transfer overhead in PHI2 ticks

| idx | nominal MHz | stash blank | fetch blank | stash on | fetch on | 1-byte stash ticks | 1-byte fetch ticks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 1 | 0.99 | 0.99 | 0.94 | 0.94 | 15 | 15 |
| 1 | 2 | 1.97 | 1.97 | 1.89 | 1.89 | 9 | 9 |
| 2 | 3 | 2.95 | 2.93 | 2.80 | 2.79 | 7 | 7 |
| 3 | 4 | 3.83 | 1.97 | 3.72 | 1.89 | 5 | 5 |
| 4 | 5 | 4.63 | 2.45 | 4.45 | 2.38 | 5 | 5 |
| 5 | 6 | 2.98 | 2.94 | 2.83 | 2.79 | 5 | 5 |
| 6 | 8 | 3.92 | 2.62 | 3.81 | 2.52 | 5 | 5 |
| 7 | 10 | 4.75 | 3.21 | 4.54 | 3.03 | 4 | 4 |
| 8 | 12 | 3.96 | 2.94 | 3.88 | 2.80 | 4 | 4 |
| 9 | 14 | 4.51 | 3.35 | 4.38 | 3.19 | 4 | 4 |
| 10 | 16 | 4.99 | 3.13 | 4.75 | 2.96 | 4 | 4 |
| 11 | 20 | 4.83 | 3.24 | 4.57 | 3.09 | 3 | 3 |
| 12 | 24 | 4.71 | 3.34 | 4.50 | 3.18 | 3 | 3 |
| 13 | 32 | 5.06 | 3.45 | 4.81 | 3.31 | 3 | 3 |
| 14 | 40 | 5.04 | 3.51 | 4.80 | 3.36 | 3 | 3 |
| 15 | 48 | 5.08 | 3.57 | 4.82 | 3.44 | 3 | 3 |

### Other runs (RAM loop; multiple of PHI2 and cycles per frame; for the manual and enablebit runs the idx column is 0 and the nominal MHz is the CPU Speed setting)

| run | idx | nominal MHz | condition | load | multiple | cycles/frame | spread % | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cpu-badlinecfg-Disabled | 0 | 1 | screen on | RAM lda | 0.945 | 18575 | 0.083 |  |
| cpu-badlinecfg-Disabled | 0 | 1 | screen blank | RAM lda | 1 | 19656 | 0 |  |
| cpu-badlinecfg-Disabled | 8 | 12 | screen on | RAM lda | 11.3398 | 222906 | 0.083 |  |
| cpu-badlinecfg-Disabled | 8 | 12 | screen blank | RAM lda | 11.9999 | 235883 | 0 |  |
| cpu-badlinecfg-Disabled | 15 | 48 | screen on | RAM lda | 44.4516 | 873784 | 0.091 |  |
| cpu-badlinecfg-Disabled | 15 | 48 | screen blank | RAM lda | 46.9998 | 923875 | 0 |  |
| cpu-badlinecfg-Enabled | 0 | 1 | screen on | RAM lda | 0.945 | 18575 | 0.083 |  |
| cpu-badlinecfg-Enabled | 0 | 1 | screen blank | RAM lda | 1 | 19656 | 0 |  |
| cpu-badlinecfg-Enabled | 8 | 12 | screen on | RAM lda | 11.3398 | 222906 | 0.083 |  |
| cpu-badlinecfg-Enabled | 8 | 12 | screen blank | RAM lda | 11.9999 | 235883 | 0 |  |
| cpu-badlinecfg-Enabled | 15 | 48 | screen on | RAM lda | 44.4516 | 873784 | 0.091 |  |
| cpu-badlinecfg-Enabled | 15 | 48 | screen blank | RAM lda | 46.9998 | 923875 | 0 |  |
| cpu-enablebit-12MHz | 0 | 12 | screen on | RAM lda | 11.3398 | 222906 | 511.505 | INTERFERENCE  |
| cpu-enablebit-12MHz | 0 | 12 | screen blank | RAM lda | 11.9999 | 235883 | 0 |  |
| cpu-enablebit-1MHz | 0 | 1 | screen on | RAM lda | 0.945 | 18575 | 0.083 |  |
| cpu-enablebit-1MHz | 0 | 1 | screen blank | RAM lda | 1 | 19656 | 0 |  |
| cpu-enablebit-48MHz | 0 | 48 | screen on | RAM lda | 44.4156 | 873078 | 538.154 | INTERFERENCE  |
| cpu-enablebit-48MHz | 0 | 48 | screen blank | RAM lda | 46.9998 | 923875 | 0 |  |
| cpu-manual-12MHz | 0 | 12 | screen on | RAM lda | 11.3398 | 222906 | 508.802 | INTERFERENCE  |
| cpu-manual-12MHz | 0 | 12 | screen blank | RAM lda | 11.9999 | 235883 | 0 |  |
| cpu-manual-1MHz | 0 | 1 | screen on | RAM lda | 0.945 | 18575 | 0.083 |  |
| cpu-manual-1MHz | 0 | 1 | screen blank | RAM lda | 1 | 19656 | 0 |  |
| cpu-manual-48MHz | 0 | 48 | screen on | RAM lda | 44.4156 | 873078 | 534.779 | INTERFERENCE  |
| cpu-manual-48MHz | 0 | 48 | screen blank | RAM lda | 46.9998 | 923875 | 0 |  |
| cpu-off | 0 | 1 | screen on | RAM lda | 0.945 | 18575 | 0.083 |  |
| cpu-off | 0 | 1 | screen blank | RAM lda | 1 | 19656 | 0 |  |
| cpu-regs-badbit80 | 0 | 1 | screen on | RAM lda | 1 | 19656 | 0 |  |
| cpu-regs-badbit80 | 0 | 1 | screen blank | RAM lda | 1 | 19656 | 0 |  |
| cpu-regs-badbit80 | 8 | 12 | screen on | RAM lda | 11.9999 | 235883 | 0 |  |
| cpu-regs-badbit80 | 8 | 12 | screen blank | RAM lda | 11.9999 | 235883 | 0 |  |
| cpu-regs-badbit80 | 15 | 48 | screen on | RAM lda | 46.949 | 922876 | 0.003 |  |
| cpu-regs-badbit80 | 15 | 48 | screen blank | RAM lda | 46.9998 | 923875 | 0 |  |
| reu-regs-badbit80 | 0 | 1 | screen blank | REU stash/fetch B/us | 0.99 / 0.99 | - | - | |
| reu-regs-badbit80 | 8 | 12 | screen blank | REU stash/fetch B/us | 3.96 / 2.95 | - | - | |
| reu-regs-badbit80 | 15 | 48 | screen blank | REU stash/fetch B/us | 5.08 / 3.57 | - | - | |

### Reset window (speed request ignored after the reset done by run_prg)

Attempts: 30; first attempt that ran faster than 1 MHz: 30, 2551 ms after program start.


## C64U, 2026-11-13

Firmware 1.2.1, FPGA 126, core 1.50. PAL (frame 19657 ticks). Multiples are relative to PHI2 (0.985248 MHz).

### CPU, Turbo Control = U64 Turbo Registers, Badline Timing as configured, `$D031` bit 7 clear

| idx | nominal MHz | blank RAM multiple of PHI2 | blank RAM MHz | on RAM MHz | blank $D020 MHz | blank $D012 MHz | blank CIA MHz | cycles/frame blank | on | on+sprites | blank+sprites | cycles/line on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 1 | 1 | 0.99 | 0.93 | 0.99 | 0.99 | 0.99 | 19656 | 18575 | 17783 | 18854 | 59.54 |
| 1 | 2 | 2 | 1.97 | 1.86 | 1.97 | 1.97 | 1.93 | 39313 | 37151 | 35571 | 37708 | 119.07 |
| 2 | 3 | 3 | 2.96 | 2.79 | 2.96 | 2.96 | 2.61 | 58970 | 55726 | 53356 | 56563 | 178.61 |
| 3 | 4 | 4 | 3.94 | 3.72 | 3.94 | 3.94 | 3.73 | 78627 | 74302 | 71143 | 75418 | 238.15 |
| 4 | 6 | 6 | 5.91 | 5.59 | 5.91 | 5.91 | 4.02 | 117941 | 111453 | 106714 | 113127 | 357.22 |
| 5 | 8 | 8 | 7.88 | 7.45 | 7.88 | 7.88 | 7.46 | 157255 | 148604 | 142287 | 150836 | 476.29 |
| 6 | 10 | 9.9999 | 9.85 | 9.31 | 9.85 | 9.85 | 7.46 | 196569 | 185754 | 177857 | 188545 | 595.37 |
| 7 | 12 | 11.9999 | 11.82 | 11.17 | 11.82 | 11.82 | 7.46 | 235883 | 222906 | 213429 | 226254 | 714.44 |
| 8 | 14 | 13.9999 | 13.79 | 13.03 | 13.79 | 13.79 | 8.70 | 275197 | 260057 | 249001 | 263964 | 833.51 |
| 9 | 16 | 15.9999 | 15.76 | 14.90 | 15.76 | 15.76 | 8.70 | 314510 | 297208 | 284573 | 301673 | 952.59 |
| 10 | 20 | 19.9999 | 19.70 | 18.62 | 19.70 | 19.70 | 8.71 | 393138 | 371510 | 355716 | 377091 | 1190.74 |
| 11 | 24 | 23.9999 | 23.65 | 22.34 | 23.65 | 23.65 | 8.71 | 471766 | 445811 | 426860 | 452510 | 1428.88 |
| 12 | 32 | 31.9998 | 31.53 | 29.79 | 31.53 | 31.33 | 8.71 | 629021 | 594415 | 569146 | 603347 | 1905.18 |
| 13 | 40 | 39.9998 | 39.41 | 37.24 | 39.41 | 37.31 | 8.71 | 786276 | 743019 | 711433 | 754183 | 2381.47 |
| 14 | 48 | 46.9998 | 46.31 | 43.80 | 46.31 | 41.78 | 8.71 | 923875 | 873784 | 836375 | 886920 | 2800.59 |
| 15 | 64 | 62.9998 | 62.07 | 58.69 | 62.07 | 55.70 | 8.71 | 1238387 | 1170907 | 1121520 | 1188597 | 3752.91 |

### REU DMA, bytes per microsecond (median of repetitions; 32 KB minus 16 KB slope), 1-byte transfer overhead in PHI2 ticks

| idx | nominal MHz | stash blank | fetch blank | stash on | fetch on | 1-byte stash ticks | 1-byte fetch ticks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 1 | 0.99 | 0.99 | 0.94 | 0.94 | 15 | 15 |
| 1 | 2 | 1.97 | 1.97 | 1.89 | 1.89 | 9 | 9 |
| 2 | 3 | 2.96 | 2.93 | 2.81 | 2.78 | 7 | 7 |
| 3 | 4 | 3.94 | 3.59 | 3.83 | 3.45 | 5 | 5 |
| 4 | 6 | 5.84 | 2.94 | 5.43 | 2.79 | 5 | 5 |
| 5 | 8 | 7.71 | 3.66 | 7.04 | 3.53 | 4 | 5 |
| 6 | 10 | 4.92 | 3.27 | 4.68 | 3.12 | 4 | 4 |
| 7 | 12 | 5.87 | 3.80 | 5.45 | 3.70 | 4 | 4 |
| 8 | 14 | 6.81 | 3.86 | 6.28 | 3.75 | 4 | 4 |
| 9 | 16 | 7.67 | 3.83 | 7.18 | 3.72 | 4 | 4 |
| 10 | 20 | 6.52 | 3.85 | 5.92 | 3.75 | 3 | 3 |
| 11 | 24 | 7.71 | 3.88 | 7.21 | 3.77 | 3 | 3 |
| 12 | 32 | 7.72 | 4.20 | 7.16 | 4.10 | 3 | 3 |
| 13 | 40 | 7.77 | 4.25 | 7.23 | 4.11 | 3 | 3 |
| 14 | 48 | 7.73 | 4.24 | 7.24 | 4.10 | 3 | 3 |
| 15 | 64 | 7.79 | 4.28 | 7.24 | 4.15 | 3 | 3 |

### Other runs (RAM loop; multiple of PHI2 and cycles per frame; for the manual and enablebit runs the idx column is 0 and the nominal MHz is the CPU Speed setting)

| run | idx | nominal MHz | condition | load | multiple | cycles/frame | spread % | flags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cpu-badlinecfg-Disabled | 0 | 1 | screen on | RAM lda | 0.945 | 18575 | 0.083 |  |
| cpu-badlinecfg-Disabled | 0 | 1 | screen blank | RAM lda | 1 | 19656 | 0 |  |
| cpu-badlinecfg-Disabled | 8 | 14 | screen on | RAM lda | 13.2297 | 260057 | 0.083 |  |
| cpu-badlinecfg-Disabled | 8 | 14 | screen blank | RAM lda | 13.9999 | 275197 | 0 |  |
| cpu-badlinecfg-Disabled | 15 | 64 | screen on | RAM lda | 59.5669 | 1170907 | 0.132 |  |
| cpu-badlinecfg-Disabled | 15 | 64 | screen blank | RAM lda | 62.9998 | 1238387 | 0 |  |
| cpu-badlinecfg-Enabled | 0 | 1 | screen on | RAM lda | 0.945 | 18575 | 0.083 |  |
| cpu-badlinecfg-Enabled | 0 | 1 | screen blank | RAM lda | 1 | 19656 | 0 |  |
| cpu-badlinecfg-Enabled | 8 | 14 | screen on | RAM lda | 13.2297 | 260057 | 0.083 |  |
| cpu-badlinecfg-Enabled | 8 | 14 | screen blank | RAM lda | 13.9999 | 275197 | 0 |  |
| cpu-badlinecfg-Enabled | 15 | 64 | screen on | RAM lda | 59.5669 | 1170907 | 0.132 |  |
| cpu-badlinecfg-Enabled | 15 | 64 | screen blank | RAM lda | 62.9998 | 1238387 | 0 |  |
| cpu-enablebit-14MHz | 0 | 14 | screen on | RAM lda | 13.2297 | 260057 | 517.957 | INTERFERENCE  |
| cpu-enablebit-14MHz | 0 | 14 | screen blank | RAM lda | 13.9999 | 275197 | 0 |  |
| cpu-enablebit-1MHz | 0 | 1 | screen on | RAM lda | 0.945 | 18575 | 0.083 |  |
| cpu-enablebit-1MHz | 0 | 1 | screen blank | RAM lda | 1 | 19656 | 0 |  |
| cpu-enablebit-64MHz | 0 | 64 | screen on | RAM lda | 59.5185 | 1169955 | 538.668 | INTERFERENCE  |
| cpu-enablebit-64MHz | 0 | 64 | screen blank | RAM lda | 62.9998 | 1238387 | 0 |  |
| cpu-manual-14MHz | 0 | 14 | screen on | RAM lda | 13.2297 | 260057 | 515.6 | INTERFERENCE  |
| cpu-manual-14MHz | 0 | 14 | screen blank | RAM lda | 13.9999 | 275197 | 0 |  |
| cpu-manual-1MHz | 0 | 1 | screen on | RAM lda | 0.945 | 18575 | 0.083 |  |
| cpu-manual-1MHz | 0 | 1 | screen blank | RAM lda | 1 | 19656 | 0 |  |
| cpu-manual-64MHz | 0 | 64 | screen on | RAM lda | 59.5185 | 1169955 | 538.164 | INTERFERENCE  |
| cpu-manual-64MHz | 0 | 64 | screen blank | RAM lda | 62.9998 | 1238387 | 0 |  |
| cpu-off | 0 | 1 | screen on | RAM lda | 0.945 | 18575 | 0.083 |  |
| cpu-off | 0 | 1 | screen blank | RAM lda | 1 | 19656 | 0 |  |
| cpu-regs-badbit80 | 0 | 1 | screen on | RAM lda | 1 | 19656 | 0 |  |
| cpu-regs-badbit80 | 0 | 1 | screen blank | RAM lda | 1 | 19656 | 0 |  |
| cpu-regs-badbit80 | 8 | 14 | screen on | RAM lda | 13.9999 | 275197 | 0 |  |
| cpu-regs-badbit80 | 8 | 14 | screen blank | RAM lda | 13.9999 | 275197 | 0 |  |
| cpu-regs-badbit80 | 15 | 64 | screen on | RAM lda | 62.9487 | 1237382 | 0.002 |  |
| cpu-regs-badbit80 | 15 | 64 | screen blank | RAM lda | 62.9998 | 1238387 | 0 |  |
| reu-regs-badbit80 | 0 | 1 | screen blank | REU stash/fetch B/us | 0.99 / 0.99 | - | - | |
| reu-regs-badbit80 | 8 | 14 | screen blank | REU stash/fetch B/us | 6.76 / 3.85 | - | - | |
| reu-regs-badbit80 | 15 | 64 | screen blank | REU stash/fetch B/us | 7.67 / 4.27 | - | - | |

### Reset window (speed request ignored after the reset done by run_prg)

Attempts: 30; first attempt that ran faster than 1 MHz: 30, 2570.8 ms after program start.

