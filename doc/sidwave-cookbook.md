# SIDWave prompt cookbook

Six prompts for an AI client with C64 Bridge connected. Each ends in something you can hear. Paste a prompt as it is and replace the file names with your own. The two files that the musician prompts name are original pieces in the [showcase example](https://github.com/chrisgleissner/c64bridge/tree/main/examples/sidwave-showcase/convert).

## Before you start

- Register C64 Bridge with your client as in the [Quick start](../README.md#quick-start), and install VICE.
- Start your client in the folder that holds your music files. C64 Bridge reads and writes files there, in `~/.c64bridge` and in the temp directory only, unless `C64BRIDGE_ALLOWED_DIRS` adds more.
- **To hear VICE,** set `VICE_ARGS=-sounddev pulse` (Linux) in the server environment. A VICE that C64 Bridge starts has no audio output otherwise. For other systems, use the name of a VICE sound driver of your install. The WAV files below play in any audio player and need no sound setting.
- **On hardware,** replace "in VICE" with "on c64u" in a prompt; `c64u` is also the backend name for an Ultimate 64. Prompts 1 and 3 were also run on an Ultimate 64 Elite, see [Verification on an Ultimate 64](#verification-on-an-ultimate-64).
- Rendering a WAV takes up to about as long as the audio, for each output file. A client with a short call timeout needs the background task described in the `sid-music` skill.

The client follows the [`sid-music` skill](../.github/skills/sid-music/SKILL.md), which has walkthroughs for musicians, game developers and archivists.

## Musicians

### 1. Hear your song on the SID

> In VICE: play my MIDI file harbour_lights.mid on the C64's SID and tell me what was lost in the conversion.

You get the song playing in VICE, a list of what the conversion lost with counts, an editable SIDWave score and a PRG. The same prompt works with MusicXML, ProTracker modules, ABC and the other formats that `c64_sound` `formats` marks as readable.

### 2. Stems and a transposed version

> Render my module tin_robot.mod to WAV as the SID plays it: the full mix and one file per voice. Then transpose it up two semitones, render that version too and play it in VICE.

You get a mix, three voice files, a converted score, a transposed score and its WAV. A four-channel module loses one channel on a single SID, and the loss list names it and counts its notes.

## Game developers

### 3. Title music with sound effects in your game

> Compose chiptune title music for my game and add a jump sound and a coin sound. Build it for $8000 as a 64tass include with at most 8000 cycles per play call, tell me the measured worst case, and run it in VICE in a test program that plays the coin sound when I press fire.

You get the score with two effects, a self-contained source include with the entry points `sidwave_init`, `sidwave_play` and `sidwave_sfx`, the binary, a symbol file, the memory and zero page the build uses, the measured cycles per play call, and the test program running. The coin sound takes one voice for a few frames while the music continues.

### 4. A level loop within a frame budget

> Compose a funk loop for level 2 of my game with at most 6000 cycles per frame. Build it for $8000 as an ACME include, render it to WAV, run it in VICE from a test program that uses the include, and tell me the measured worst case and the memory it needs.

You get the score, the include, a WAV, the test program running and the figures. The build is refused if the measured play call exceeds the limit.

## Retro and AI enthusiasts

### 5. A new SID tune without a C64

> I do not own a C64. Compose a new ambient tune, tell me its key and form, render it to WAV, check the WAV against the score, and play it in VICE.

You get a score, its key, metre and form, a WAV, a pitch check of the rendered audio and the tune playing in VICE. The audio check analyzes the mixed signal and does not separate voices; it is a sanity check, not a comparison of every note.

### 6. Open up an old SID file

> I found old_tune.sid. Tell me who wrote it and what it needs, make a preservation bundle and verify it, render each of its three voices to its own WAV, and play it in VICE.

You get the header facts, a preservation bundle (recovered score, report and manifest) with its verification, three voice files and the tune playing. SID reconstruction is experimental: the recovered score is approximate and carries a verdict that says how far it matches. The voice files come from that score and are diagnostic audio, not stems of the original player. On VICE the playback is the reconstruction of the first 30 seconds; on a C64 Ultimate or U2 the original file plays.

## Verification run on VICE

All six prompts were run on 2026-11-27 through the MCP server with VICE 3.10 (PAL), by an agent that made the tool calls described in the prompts and skills. VICE wrote its SID register writes to a file (`-sounddev dump`). "Notes match" means that, for each voice, the note frequencies VICE received are the same, in the same order, as an offline trace of the score. WAV levels are RMS relative to full scale.

| Prompt | Produced | SID output check |
| --- | --- | --- |
| 1 | 36.9 s loop, 3 voices; 1 loss (one drum hit dropped); score and PRG | Notes match over the first 15 s: 52, 26 and 52 notes |
| 2 | 39 s mix, 3 stems of 38.4 s, 39 s transposed mix; channel 4 (72 notes) dropped | Non-silent WAVs (RMS 0.022 to 0.048); transposed playback matches over 8 s: 26, 1 and 36 notes |
| 3 | 59.1 s of music, 2 effects; player at $8000-$99D1, variables $99D2-$9B47, zero page $FB-$FE; worst play call 4547 cycles measured, 5893 upper bound | Voices 1 and 3 match over 15 s (63 and 9 notes); the coin effect appears on voice 2 once for each of two fire presses |
| 4 | 82.3 s loop in E dorian; player at $8000-$9AC9, variables to $9C0C; worst play call 4277 cycles measured, 4738 upper bound; 83 s WAV | Notes match over 10 s: 31, 10 and 1 notes; WAV RMS 0.049 |
| 5 | D minor, 80 BPM, 32 bars AABA, 96 s loop; 97 s WAV; reported pitch deviation 11.4 cents | Notes match over 12 s: 16, 8 and 1 notes; WAV RMS 0.059 |
| 6 | Bundle of 3 files, verification passed, verdict "not strictly exact" over 180 s; three 30 s voice files | Playback of the reconstruction matches the score the SID file was built from over 8 s: 34, 35 and 6 notes; voice WAVs RMS 0.030 to 0.045 |

The input files of prompts 1, 2 and 6 were written for this test. The input of prompt 6 was compiled by SIDWave itself, so it does not show how well reconstruction works on tunes made with other players.

## Verification on an Ultimate 64

Run on 2026-11-27 on an Ultimate 64 Elite with firmware 3.15a (core 1.50, FPGA 126) in PAL mode, through the MCP server with backend `c64u`, by a script that made the tool calls. An UltiSID answered at `$D400`; both SID sockets were disabled. `configure` was not used, and the 20 configuration categories read the same before the first run and after the final reset.

Nobody listened to the machine and no audio was recorded. The checks read memory over the REST API:

- **Player state matches** means that the RAM the music player writes was identical, byte for byte, to an offline 6502 emulation of the same program after a whole number of play calls. Two such snapshots about 2 s apart gave 49.4 to 50.4 play calls per second; a PAL tune calls the player about 50 times per second, and the timing includes the REST requests.
- **Voice 3 activity** means that the readback registers `$D41B` and `$D41C` changed while the music played. The SID has no readback for voices 1 and 2.

| Run | Check | Result |
| --- | --- | --- |
| `play` with a MIDI file, a ProTracker module and a SIDWave score built by the tests (two voices each) | PRG in RAM equals the saved PRG outside the bytes the player writes; `$0314` points to the SIDWave interrupt handler; player state matches | Passed for all three; voice 3 is unused, so there is no readback |
| `play` with a SID file built by the tests (the original file, played by the firmware) | The firmware's SID player shows title, author, song 1 of 1 and the play time; the file's data is in RAM; player state matches | Passed; voice 3 is unused |
| `play` with a five-song SID compiled from the showcase score, `song: 3` | SID player shows song 3 of 5; player state matches song 3 and does not match song 4; voice 3 activity | Passed |
| Prompt 1, `harbour_lights.mid` | 36.9 s loop, 3 voices, 1 loss (one drum hit dropped), as on VICE; PRG, interrupt and player state checks; voice 3 activity | Passed |
| Prompt 3 (`compose` style `chiptune`, seed 3) | Player at `$8000`-`$99D5`, variables `$99D6`-`$9B4B`; the compiler reports a worst play call of 4551 cycles in its emulator, upper bound 5893 (cycles were not measured on the Ultimate). The test program ran and the player state matched. Fire on joystick port 2 was injected twice with `c64_input`; after each press the RAM matched the emulation with the coin effect started at one play call (9 of 10 and 10 of 10 snapshots) | Passed |
| The [Pulse Guard](../examples/sidwave-showcase/README.md) PRG | Title screen text; the game's interrupt installed and its frame counter advancing; title song player state matches; injected fire on port 2 changes the game from the title to play and draws the status lines; voice 3 activity in the title and flight songs | Passed; the game was not played further and its sound effects were not checked |

Not verified: prompts 2, 4, 5 and 6 as written (the SID file runs above cover playing an original SID, with files that SIDWave built, not tunes made with other players); a C64 Ultimate or a U2 cartridge; a physical SID chip; NTSC; `configure: true` and scores with several SIDs; audio capture; the `sidwave play --target u64` command line.
