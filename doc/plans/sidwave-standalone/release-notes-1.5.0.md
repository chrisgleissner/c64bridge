# c64bridge 1.5.0 release notes (draft)

## Before publishing (remove this section)

- The release workflow builds the GitHub release body from the `## 1.5.0 - YYYY-MM-DD` entry of `CHANGELOG.md`. Rename `## Unreleased` to that heading. `npm run release:prepare` also prepends a list generated from commit subjects when it changes the version; replace it with the curated entry. As for 1.4.0, paste the text below into the GitHub release after the workflow has created it.
- Fill or delete each `PLACEHOLDER`, here and in the SIDWave section of `README.md`. Clips and video come from the showcase work and need to be checked by ear.
- Run the cookbook prompts that lead the notes on the Ultimate 64. Until then keep the sentence that they have not been verified on hardware.
- Update the figures if SIDWave changes before the release: reconstruction results, tracker fidelity, and the MOD short-loop limit (delete it if the fix is in the packaged version).

## Release text

**Ask your AI for C64 music. Hear it on a real C64 or in VICE. Ship it in your game.**

> **PLACEHOLDER, audio clip:** an original tune.
>
> **PLACEHOLDER, audio clips:** a MIDI or module conversion, before and after.
>
> **PLACEHOLDER, video:** music and sound effects in a game, recorded from VICE.

C64 Bridge 1.5.0 adds SIDWave to your AI client: compose, convert, play, render and build SID music through the `c64_sound` tool.

### Musicians: bring your song and hear it on the SID in one request

One operation, `play`, takes a MIDI, MusicXML, ProTracker, ABC, GoatTracker, Furnace, SID-Wizard, CheeseCutter, SID Factory II or JCH file, a SIDWave score, a PRG or a SID file. It converts where needed, starts the music on the active target, saves an editable score and a PRG, and lists what the conversion lost, with counts. A PRG, and on hardware a SID file, runs unchanged. Render the result to WAV as a mix or one file per voice, then transpose it, change the tempo or add bars.

> In VICE: play my MIDI file harbour_lights.mid on the C64's SID and tell me what was lost in the conversion.

### Game developers: music, sound effects and a measured cycle cost

One score holds several songs and up to 32 prioritised sound effects that borrow a voice while the music continues. `compile` writes the player and data, a source include for 64tass, ACME, ca65 or KickAssembler, symbol files and a relocation table. It reports the worst measured cycles per play call, an upper bound, and the memory, zero page and registers the player uses, and `maxCycles` refuses a build that is too slow.

> Compose chiptune title music for my game and add a jump sound and a coin sound. Build both for $8000 as a 64tass include with at most 8000 cycles per play call, tell me the measured worst case, and run it in VICE in a test program that plays the coin sound when I press fire.

### AI and retro enthusiasts: no C64 needed

Compose a tune, render it to WAV, check the audio and play it in VICE. On a C64 Ultimate, Ultimate 64 or U2 cartridge the same operations play it on the machine.

> I do not own a C64. Compose a new ambient tune, tell me its key and form, render it to WAV, check the WAV against the score, and play it in VICE.

The [prompt cookbook](https://github.com/chrisgleissner/c64bridge/blob/main/doc/sidwave-cookbook.md) has six prompts, run end to end on VICE, with what each produced. They have not been verified on hardware. To hear VICE, set `VICE_ARGS=-sounddev pulse` (Linux).

### Losses are part of the result

Every conversion says what it dropped or approximated, with counts. `strict` writes nothing if content would be lost. Importers and features that are approximate by nature are marked `approximate` in `formats`, in conversions and in playback.

## New `c64_sound` operations

| Task | Operations |
| --- | --- |
| Play | `play` |
| Convert and inspect | `formats`, `inspect`, `convert` |
| Compose and edit | `compose`, `complete`, `transform`, `retarget`, `validate`, `lint`, `format` |
| Build for games | `compile` (PRG, PSID, game build) |
| Audio and instruments | `render` (mix, stems, solo, mute), `extract_instruments` |
| Study and preserve | `reconstruct`, `analyze_music`, `compare`, `sid_info` (header, song lengths, STIL, player identification from your `sidid.cfg`), `sid_edit`, `preserve` |

`convert`, `reconstruct`, `render`, `analyze_music` and `compare` can run as background tasks. The `sid-music` skill has walkthroughs for musicians, game developers and archivists.

## Limits

- **SID reconstruction is experimental.** It gives an approximate score with a verdict. On 24 development tunes, none matched exactly, neither in register writes nor in register state.
- **SID Factory II** support covers driver 11 and playback fidelity is partial. Over the first 8 seconds of 54 example songs, compared with the original driver, the medians were 0.957 gate and 0.709 note agreement on import, and 0.979 and 0.756 on export. The weakest songs for pitch were Cracked Down (0.17, import) and Scotch Koczka (0.11, export). Export loses some effects, including glides in 36 of those songs.
- **CheeseCutter** fidelity is also partial: over 12 example songs, 0.989 gate and 0.849 note on import, 0.997 and 0.883 on export.
- **SID Factory II and CheeseCutter export** needs a driver file that you supply and works with the `sidwave export` command line. `c64_sound` imports these formats and does not write them.
- **JCH** import is approximate and reads version 20.G: the filter, most commands and per-voice looping are not imported. **ABC** import omits ornaments, chord symbols and voice overlays.
- **Voices:** one SID has three. A conversion drops further voices and reports them. Module samples become SID waveforms and envelopes. A module sample with a very short loop can be imported an octave low.
- **VICE** cannot start a SID file: `play` reconstructs its first 30 seconds (`durationSeconds` sets more) and plays that. A VICE that C64 Bridge starts has no sound unless `VICE_ARGS` names a sound device.
- **KickAssembler** includes have not been verified with KickAssembler. The 64tass, ACME and ca65 includes have been assembled with those tools.
- **Audio checks** analyze the mixed signal. `preserve` and `compare` report the A1 audio level as not evaluated, because they take no ROM files.
- **Machine defaults:** `forDevice` uses the machine's clock and SID model, not its SID count.

## Compatibility

No existing operation or resource URI was removed or renamed. SIDWave and the 6502 assembler now come from the `sidwave` and `6502-toolkit` npm packages instead of workspace packages. Node.js 24 or later is required, as before.
