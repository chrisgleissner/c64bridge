# c64bridge 1.5.0 release notes

## Before publishing (remove this section)

- The release workflow builds the GitHub release body from the `## 1.5.0 - 2026-11-27` entry of `CHANGELOG.md`. As for 1.4.0, replace that body with the release text below (everything under `## Release text`, without that heading) after the workflow has created the release.
- The links to clips, video and PRG, here and in the SIDWave section of `README.md`, point to assets of the GitHub release `1.5.0`. They are not committed and the release workflow does not upload them, so every link returns 404 until you do. Check the clips and the video by ear first. After the workflow has created the release, run this on the machine that holds the files (`release-assets.txt` lists source and asset name):

  ```sh
  cd ~/.c64bridge/sidwave-standalone/showcase && d=$(mktemp -d) &&
    grep -v '^#' release-assets.txt | while read -r source name; do cp "$source" "$d/$name"; done &&
    gh release upload 1.5.0 "$d"/* -R chrisgleissner/c64bridge
  ```
- Update the figures if the SIDWave version changes before the release: reconstruction results and tracker fidelity. After such a change, also run `build.mjs`, `render.mjs`, `verify.mjs` and `record.mjs` in `examples/sidwave-showcase`, compare the figures in its README and in the showcase paragraph below, and replace the files to upload if they changed.

## Release text

**Ask your AI for C64 music. Hear it on a real C64 or in VICE. Ship it in your game.**

> **Original music:** [Pulse Guard, in game](https://github.com/chrisgleissner/c64bridge/releases/download/1.5.0/sidwave-showcase-pulse-guard.mp3) (71 s) · [Deep Field, title](https://github.com/chrisgleissner/c64bridge/releases/download/1.5.0/sidwave-showcase-deep-field.mp3) (77 s) · [Iron Moth, boss fight](https://github.com/chrisgleissner/c64bridge/releases/download/1.5.0/sidwave-showcase-iron-moth.mp3) (51 s)
>
> **Conversion, source then SID (16 s each):** [MIDI](https://github.com/chrisgleissner/c64bridge/releases/download/1.5.0/sidwave-showcase-midi-before-after.mp3) · [ProTracker module](https://github.com/chrisgleissner/c64bridge/releases/download/1.5.0/sidwave-showcase-mod-before-after.mp3)
>
> **Video:** [one minute of Pulse Guard](https://github.com/chrisgleissner/c64bridge/releases/download/1.5.0/sidwave-showcase-pulse-guard.mp4) with music and sound effects, recorded from VICE

The clips and the video come from [Pulse Guard](https://github.com/chrisgleissner/c64bridge/blob/main/examples/sidwave-showcase/README.md), a showcase game in the repository whose five songs and nine sound effects are one SIDWave score ([PRG](https://github.com/chrisgleissner/c64bridge/releases/download/1.5.0/sidwave-showcase-pulse-guard.prg), joystick in port 2). Its player and music take 14,925 bytes; the worst play call takes 5,392 of the 19,656 cycles of a PAL frame in the SIDWave emulator (5,507 with an effect started on every call), and the longest call measured in 191 seconds of scripted play in VICE took 5,383. Play beyond the start of a game was tested by a script in VICE only; on an Ultimate 64 the title screen, the title song and the start of a game were checked. The MIDI source in the first conversion clip is played by a small synthesiser that is part of the example.

C64 Bridge 1.5.0 adds SIDWave to your AI client: compose, convert, play, render and build SID music through the `c64_sound` tool.

### Musicians: bring your song and hear it on the SID in one request

One operation, `play`, takes a MIDI, MusicXML, ProTracker, ABC, GoatTracker, Furnace, SID-Wizard, CheeseCutter, SID Factory II or JCH file, a SIDWave score, a PRG or a SID file. It converts where needed, starts the music on the active target, saves an editable score and a PRG, and lists what the conversion lost, with counts. A PRG, and on hardware a SID file, runs unchanged. Render the result to WAV as a mix or one file per voice, then transpose it, change the tempo or add bars.

> In VICE: play my MIDI file harbour_lights.mid on the C64's SID and tell me what was lost in the conversion.

### Game developers: music, sound effects and a measured cycle cost

One score holds several songs and up to 32 prioritised sound effects that borrow a voice while the music continues. `compile` writes the player and data, a source include for 64tass, ACME, ca65 or KickAssembler, symbol files and a relocation table. It reports the worst measured cycles per play call, an upper bound, and the memory, zero page and registers the player uses, and `maxCycles` refuses a build that is too slow.

> Compose chiptune title music for my game and add a jump sound and a coin sound. Build it for $8000 as a 64tass include with at most 8000 cycles per play call, tell me the measured worst case, and run it in VICE in a test program that plays the coin sound when I press fire.

### AI and retro enthusiasts: no C64 needed

Compose a tune, render it to WAV, check the audio and play it in VICE. On a C64 Ultimate, Ultimate 64 or U2 cartridge the same operations play it on the machine.

> I do not own a C64. Compose a new ambient tune, tell me its key and form, render it to WAV, check the WAV against the score, and play it in VICE.

The [prompt cookbook](https://github.com/chrisgleissner/c64bridge/blob/main/doc/sidwave-cookbook.md) has six prompts, run end to end on VICE, with what each produced. The MIDI playback prompt and the game music prompt were also run on an Ultimate 64 Elite (see Limits). To hear VICE, set `VICE_ARGS=-sounddev pulse` (Linux).

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

- **Hardware:** checked on an Ultimate 64 Elite, firmware 3.15a, PAL, with an UltiSID: `play` with a MIDI file, a ProTracker module, a SIDWave score and SID files built by SIDWave, the MIDI playback and game music prompts of the cookbook, and the start of Pulse Guard. The checks read the machine's memory; nobody listened and no audio was recorded. Not verified: a C64 Ultimate, a U2 cartridge, a physical SID chip, NTSC, `configure: true` with several SIDs, SID files made with other players, the other four cookbook prompts and the `sidwave play --target u64` command line.
- **SID reconstruction is experimental.** It gives an approximate score with a verdict. On 24 development tunes, none matched exactly, neither in register writes nor in register state.
- **SID Factory II** support covers driver 11 and playback fidelity is partial. Over the first 8 seconds of 54 example songs, compared with the original driver, the medians were 0.957 gate and 0.709 note agreement on import, and 0.979 and 0.756 on export. The weakest songs for pitch were Cracked Down (0.17, import) and Scotch Koczka (0.11, export). Export loses some effects, including glides in 36 of those songs.
- **CheeseCutter** fidelity is also partial: over 12 example songs, 0.989 gate and 0.849 note on import, 0.997 and 0.883 on export.
- **SID Factory II and CheeseCutter export** needs a driver file that you supply: `convert` takes it as `driverPath` (an existing song of that format or its player binary). No driver is included.
- **JCH** import is approximate and reads version 20.G: the filter, most commands and per-voice looping are not imported. **ABC** import omits ornaments, chord symbols and voice overlays.
- **Voices:** one SID has three. A conversion drops further voices and reports them. Module samples become SID waveforms and envelopes.
- **VICE** cannot start a SID file: `play` reconstructs its first 30 seconds (`durationSeconds` sets more) and plays that. A VICE that C64 Bridge starts has no sound unless `VICE_ARGS` names a sound device.
- **KickAssembler** includes have not been verified with KickAssembler. The 64tass, ACME and ca65 includes have been assembled with those tools.
- **Audio checks** analyze the mixed signal. `preserve` and `compare` report the A1 audio level as not evaluated, because they take no ROM files.
- **Machine defaults:** `forDevice` uses the machine's clock and, on Ultimate hardware, its SID model. It does not use the SID count.

## Compatibility

No existing operation or resource URI was removed or renamed. SIDWave and the 6502 assembler now come from the `sidwave` and `6502-toolkit` npm packages instead of workspace packages. Node.js 24 or later is required, as before.

## Fixes

- `compile_play` and `pipeline` resolve SIDWave imports and file samples safely.
- Reference renders are deterministic: the sidplayfp power-on delay is fixed.
- C64 Bridge warns that the HTTP transport under Bun does not cancel a call when the client disconnects.

**Full Changelog**: https://github.com/chrisgleissner/c64bridge/compare/1.4.0...1.5.0
