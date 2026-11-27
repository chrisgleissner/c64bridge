# Pulse Guard: the SIDWave showcase

A small vertical shooter for the PAL Commodore 64 with an original soundtrack and sound effects. The whole sound of
the game is one text file, [`pulse_guard.yaml`](pulse_guard.yaml): five songs and nine effects with priorities,
compiled by `sidwave compile --target game` and called from 6502 code.

Shoot the drones, catch the green energy cells to restore your shield, and defeat the Iron Moth at the end of each
wave. Each wave is faster and its boss tougher. Joystick in port 2.

| File | Content |
| --- | --- |
| `pulse_guard.yaml` | The score: songs `title`, `flight`, `boss`, `clear`, `gameover` and the effects |
| `pulse_guard.asm` | The game (ACME syntax, assembled by `6502-toolkit`) |
| `art.txt` | Sprites and title lettering as text |
| `build.mjs` | Builds `out/pulse_guard.prg` |
| `render.mjs` | Renders the audio clips and the conversion before/after pairs |
| `verify.mjs` | Plays the game in headless VICE and checks it |
| `record.mjs` | Records the video from VICE |
| `convert/` | An original MIDI file and ProTracker module for the conversion demo, and the script that writes them |

## Build and run

The scripts use the `sidwave` package. Install it, or point `SIDWAVE_DIR` at the `sidwave` folder of a built
checkout (tested with sidwave `main` at `237a250`).

```sh
SIDWAVE_DIR=/path/to/sidwave/sidwave node examples/sidwave-showcase/build.mjs
x64sc -autostart examples/sidwave-showcase/out/pulse_guard.prg
```

`render.mjs`, `verify.mjs` and `record.mjs` also need `ffmpeg`; rendering needs the `libsidplayfp-wasm` peer
dependency of `sidwave`; the last two need `x64sc` and `Xvfb`. They never play sound on the host: VICE records to a
file. Their output goes to `~/.c64bridge/sidwave-standalone/showcase/` (`SHOWCASE_DIR` overrides it).

## How the game calls the music

The build places the player at `$4000` and writes its symbols for the assembler (`sidwave_init`, `sidwave_play`,
`sidwave_sfx`, `sidwave_fx_explode`, ...).

- One raster interrupt per frame calls `sidwave_play`. When the main program has asked for another song, the same
  interrupt calls `sidwave_init` with the song number instead, so the two calls never overlap.
- The main program starts effects with `lda #sidwave_fx_shot : ldy #$ff : jsr sidwave_sfx`.
- The player picks the voice. Most effects may only take the chord voice. Explosions and damage may also take the
  bass voice. The start sound and the boss alarm may take the lead, and the final blast all three voices. A higher
  priority replaces a lower one, and the music continues underneath at its current position.

## Player cost

Measured for the committed score (PAL, one call per frame, 19656 cycles per frame):

| Measurement | Cycles per play call |
| --- | ---: |
| Average, SIDWave emulator, all songs | 2245 |
| Worst, SIDWave emulator, music only | 5392 (27 % of a frame) |
| Worst, SIDWave emulator, with an effect started on every call | 5507 |
| Static upper bound reported by the compiler | 7729 |
| Longest call seen in VICE over 191 s of play (CIA 2 timer, includes video DMA) | 5383 |

A `sidwave_sfx` call costs at most 395 cycles. The player and the data of all five songs and nine effects take 14 925
bytes at `$4000`-`$7A4C`, plus 413 bytes of RAM behind them. The game code and its data take 4746 bytes, and the whole
PRG is 29 262 bytes.

## Verification

`verify.mjs` plays 9600 frames (191 s) in VICE 3.10 through the emulated joystick. In the last run:

- every state was reached (title, wave, warning, boss, boss destroyed, wave cleared, ship destroyed, game over), and a
  second game started from the title;
- the frame interrupt ran in every frame; the main loop took longer than one frame 3 times;
- the sound recording was audible in every state (-26 to -20 dBFS RMS) with no clipped sample;
- in a second run with silent songs, all nine effects were requested by the game and audible afterwards.

The script's player dodges and shoots without pause, which is not how a person plays. The difficulty has not been
tested with people. The game has been run in VICE only, not on hardware, and it is written for PAL.

## The soundtrack

| Song | Title | Style |
| ---: | --- | --- |
| 0 | Deep Field | Atmospheric, 94 BPM, E minor: filtered bass swells, broken chords, a singing lead; three eight-bar parts |
| 1 | Pulse Guard | Driving, 150 BPM, A minor: bass and drums on one voice, chord arpeggios, theme, variation, bridge, break |
| 2 | Iron Moth | Boss fight, 7/8 at 150 BPM, E Phrygian: saw bass riff, drum break, sixteenth-note variation |
| 3, 4 | jingles | Wave cleared, game over |

## Conversion demo

`convert/harbour_lights.mid` (flute, plucked bass arpeggio, drums) and `convert/tin_robot.mod` (four channels) are
original pieces written by `convert/make-sources.mjs`. `render.mjs` converts both with `sidwave convert` and renders
the source and the result. Every conversion reports what it lost:

| Source | Reported by `sidwave convert` |
| --- | --- |
| MIDI | 1 drum hit dropped (a simultaneous hit has priority); drum velocity is not imported |
| MOD | channel 4 (72 notes) dropped because one SID has three voices; 52 set-volume effects approximated; samples replaced by SID waveforms and envelopes |

The MOD import maps tracker notes to pitches without reading the length of a sample loop. The loops of this module
are 64 bytes long, which comes out in the octave in which the module plays. A 32-byte loop came out an octave low.

All music, code and artwork in this folder were made for this example.
