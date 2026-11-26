# SIDWAVE

**Write SID music as text. Compile it to a C64 program or a SID file.**

SIDWAVE ("SID Wave") is a music language, compiler and toolkit for the Commodore 64 SID sound chip. A score is a YAML (or JSON) file that describes instruments, patterns and a timeline of sections. The compiler turns it into a self-playing C64 program (PRG) or a PSID file, including the 6502 player that runs on the C64. It is for chip musicians who prefer a text editor and version control to a tracker, for game and demo developers who need a small, scriptable music pipeline, and for tool authors who want a documented, testable description of SID music. It runs without a network, an AI assistant, or a C64.

[![License: GPL v2](https://img.shields.io/badge/License-GPL%20v2-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html)
[![Status](https://img.shields.io/badge/status-pre--release-orange.svg)](#status-and-roadmap)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-forestgreen)](#for-developers)

## Contents

- [A short score](#a-short-score)
- [What it compiles to](#what-it-compiles-to)
- [For musicians](#for-musicians)
- [For developers](#for-developers)
- [Status and roadmap](#status-and-roadmap)
- [Documentation](#documentation)
- [Related projects](#related-projects)
- [License](#license)

## A short score

This is the opening of Beethoven's *Für Elise* for three triangle voices. It is a complete, valid SIDWAVE 1.3 score; it compiles to a 1.8 KB PRG and plays for about 11.5 seconds before it loops.

```yaml
sidwave: 1.3
title: "Für Elise (opening)"
author: "Ludwig van Beethoven"
tempo: 83.54
mode: PAL
voices:
  - id: 1
    name: Lead
    waveform: triangle
    adsr: [1, 4, 9, 4]
    patterns:
      theme:
        groove: [E5, D#5, E5, D#5, E5, B4, D5, C5, A4, "-", A3, C4, E4, "-", A4, B4]
  - id: 2
    name: Harmony
    waveform: triangle
    adsr: [2, 5, 8, 5]
    patterns:
      accomp:
        groove: ["-", "-", "-", "-", "-", "-", "-", "-", A2, E3, A3, E3, A2, E3, A3, E3]
  - id: 3
    name: Bass
    waveform: triangle
    adsr: [1, 3, 10, 5]
    patterns:
      bass:
        groove: ["-", "-", "-", "-", "-", "-", "-", "-", A1, "-", "-", "-", A1, "-", "-", "-"]
timeline:
  - section: Theme
    bars: 4
    layers: { v1: theme, v2: accomp, v3: bass }
```

Each voice has an instrument (waveform and ADSR envelope) and named patterns. A `groove` pattern lists one note per entry; `-` is a rest and `~` ties to the previous note. The `timeline` plays sections in order, choosing a pattern per voice, and the song loops after the last section. Real scores add instruments with wave, pulse and filter tables, vibrato, echo, several SIDs and more. The [examples](#examples) show what a full piece looks like.

## What it compiles to

| Output | Contents | Limits |
| --- | --- | --- |
| **PRG** | A program loaded at `$0801` and started with `SYS 2061`. It detects PAL or NTSC, programs CIA 1 timer A for the song's play rate, installs an IRQ handler, and returns to BASIC while the music plays. | Up to 10 SIDs and 30 voices. Must end below `$D000`. CIA2 volume digis (sampled sound) are available here. |
| **PSID** | A PSID v2, v3 or v4 file with the same player (init `$0810`, play `$0813`) for SID players. | Up to 3 SIDs. No CIA2 digis. |

Language features, by SIDWAVE version (1.0 to 1.3; each version compiles older scores to the same bytes):

- Wave, pulse and filter tables per instrument; hard restart; sync and ring modulation.
- Vibrato (with delay and fade-in), slide, portamento, legato, chord arpeggios, pitch bends.
- Echo, unison and follower voices.
- Multispeed (1 to 4 player calls per frame), a metre per section, sections, sequences and dynamics.
- Several SIDs with model, pan and filter ownership per chip; CIA2 volume digis (PRG only).
- Lint checks that report problems such as notes shorter than the hard-restart minimum or a tempo that does not fit the frame grid.

The compiler measures the player's cost and reports it (`worstCaseCyclesPerCall` in the compile result is a conservative cycle estimate). Typical songs use roughly 20 to 65 raster lines per frame. The full definition is in the [language specification](sidwave/data/sound/sidwave.md).

## For musicians

### 1. Write a score

Save a score as `song.sidwave.yaml`. A JSON Schema is shipped for editor completion and validation; see [Authoring and validation](sidwave/data/sound/sidwave.md#authoring-and-validation). Start from one of the [examples](#examples) and change it.

### 2. Check and compile

```sh
sidwave validate song.sidwave.yaml
sidwave lint song.sidwave.yaml
sidwave compile song.sidwave.yaml
```

`validate` exits 0 for a valid score and 1 with the path of the first error otherwise. `compile` writes `song.prg` (or `song.sid` with `--format sid`) into the current directory; `-o <file>` chooses another name. `lint` prints the findings. `sidwave examples` lists the bundled scores. The full list of commands and options is in the [package README](sidwave/README.md#command-line).

### 3. Play

- **VICE**: open the PRG with `x64sc song.prg` (autostart), or attach it from the emulator's menu. It needs a normal C64 setup with ROMs.
- **sidplayfp**: play the PSID, for example `sidplayfp song.sid`. sidplayfp emulates the SID and CPU only, not the C64's analogue audio path, so it sounds close to, but not identical with, a real machine.
- **Real hardware**: copy the PRG to a disk image, SD card or other storage the machine can read, then `LOAD` and `RUN` it. On an Ultimate 64 or C64 Ultimate you can also run the PRG from the file browser or through c64bridge. Pitch and tempo are correct on PAL and NTSC machines because the PRG detects the video standard.

### Examples

The repository ships 14 example scores in [`sidwave/data/sound/examples`](sidwave/data/sound/examples); `sidwave examples <name> -o <dir>` writes one out. Their headers describe technique and form. A few starting points:

| Score | Shows |
| --- | --- |
| `chiptune_drive`, `ambient_filter`, `funk_bass` | Typical single-SID styles. |
| `acid_line` | Filter accents. |
| `arp_ballad` | Chord arpeggios and pulse-width modulation. |
| `drum_and_bass` | Multispeed breakbeats. |
| `digi_groove` | CIA2 volume samples (PRG only). |
| `metal_sync` | Sync, ring modulation and pitch bends. |
| `chamber_waltz` | 3/4 time and counterpoint. |
| `title_fanfare` | Two SIDs, filtered brass, a held cadence. |
| `ultisid_orchestra`, `wall_of_sid` | 24 and 27 voices on several SIDs. |

## For developers

### Install

```sh
npm install sidwave
```

`sidwave` has not been published to npm yet; until the first release, build it from this repository. It requires Node.js 24 or later and has two runtime dependencies: `yaml` and [`c64-asm6502`](asm6502/README.md), the 6502 assembler that builds the player.

### Library

The public API is not frozen. The functions below exist today and are what the package currently exports for the core path; other names may change before 1.0.

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { parseSidwave, compileSidwaveToPrg, compileSidwaveToSid } from "sidwave";

const doc = parseSidwave(readFileSync("song.sidwave.yaml", "utf8")); // throws SidwaveValidationError
const result = compileSidwaveToPrg(doc);  // prg, addresses, duration, lint, warnings, cycle estimates
const { sid } = compileSidwaveToSid(doc, result.prg); // PSID built around the PRG's player

writeFileSync("song.prg", result.prg);
writeFileSync("song.sid", sid);
```

`parseSidwave` rejects unknown fields, unknown pattern names and out-of-range values with an error that names the path in the score. The compile result also carries `entryAddress`, `initAddress`, `playAddress`, `loadAddress`, `endAddress`, `durationSeconds`, `lint` and `warnings`. A parser, lint, generator for new scores, and similarity and fidelity analysis also exist inside the code base; their public names are not final and are not documented here.

### Command line

`sidwave validate | compile | lint | examples`; see the [package README](sidwave/README.md#command-line) for every option and the exit codes.

### Using the player in a game

Not available yet. Today the compiled player is a standalone program at `$0801` that takes over the CIA 1 timer IRQ, uses zero-page bytes `$FB/$FC` (restored after each call) and ends below `$D000`; the PSID has init at `$0810` and play at `$0813`. There is no relocatable player, no separate player/data split and no sound-effect support. A relocatable player and sound effects are planned (see below).

### Rendering and analysis

The existing reference render calls an external `sidplayfp` binary and does not include CIA2 digis; digi scores are rendered with VICE by a script in c64bridge. A WebAssembly engine (`libsidplayfp-wasm`) is planned as an optional dependency.

## Status and roadmap

SIDWAVE is being extracted from [c64bridge](https://github.com/chrisgleissner/c64bridge) into this repository. It is pre-release, and nothing has been published to npm.

**Available now**

- Parser and validator for language versions 1.0 to 1.3, with the specification and JSON Schema.
- Lint with documented finding codes.
- Compiler to PRG and PSID, with an emulator-based test suite and byte-hash tests that pin older language versions.
- Generator for new scores.
- 14 example scores.
- Reference rendering through an external `sidplayfp`.
- Similarity and fidelity analysis of rendered audio.
- A minimal CLI: `sidwave validate | compile | lint | examples`, with exit codes 0 (success), 1 (invalid input or failed verdict) and 2 (usage or operational error).

**Planned, not available**

- SID file reader and writer.
- `sidwave verify`: a verification ladder that compares register traces first and audio second.
- Formatter and diff for scores.
- A relocatable player and sound effects for games.
- Reconstruction of existing SID tunes into editable scores.
- Import from MIDI, MusicXML and tracker formats (GoatTracker, Furnace).
- Preservation bundles.

Known limitations of the language: no per-note velocity, no multiple subtunes, no arbitrary register writes. No human listening sign-off exists for the examples, and some hardware comparisons are open (for example `stereo_echo`).

## Documentation

- [Language specification](sidwave/data/sound/sidwave.md) and [JSON Schema](sidwave/data/sound/sidwave.schema.json)
- [Licensing notes](sidwave/doc/licensing.md), including what the generated player means for released tunes and games
- [Repository structure](doc/repository-structure.md)
- [Changelog](CHANGELOG.md)

## Related projects

- [c64bridge](https://github.com/chrisgleissner/c64bridge) is an MCP server that connects coding agents to VICE and Ultimate hardware. It is an optional integration: it lets an AI assistant write, compile and play SIDWAVE scores and run them on a device. SIDWAVE does not need it.
- [SIDFlow](https://github.com/chrisgleissner/sidflow) analyses SID collections and streams similar tunes. It is a separate project; SIDWAVE's planned verification work may use its published analysis data.

## License

SIDWAVE is licensed under [GPL-2.0-only](LICENSE). The compiled output contains generated player code, which affects how you can distribute tunes and games; read the [licensing notes](sidwave/doc/licensing.md).
