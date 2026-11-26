# sidwave

SIDWAVE ("SID Wave") is a music language, compiler and toolkit for the Commodore 64 SID chip. Write a score as YAML or JSON; compile it to a self-playing C64 PRG or a PSID file that includes the 6502 player.

Status: pre-release. This package has not been published to npm yet; the install command below is the intended one.

```sh
npm install sidwave
```

Requires Node.js 24 or later. Runtime dependencies: `yaml` and `c64-asm6502`.

## Library

The public API is not final. These functions exist today:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { parseSidwave, compileSidwaveToPrg, compileSidwaveToSid } from "sidwave";

const doc = parseSidwave(readFileSync("song.sidwave.yaml", "utf8")); // throws SidwaveValidationError
const result = compileSidwaveToPrg(doc);
const { sid } = compileSidwaveToSid(doc, result.prg);

writeFileSync("song.prg", result.prg);
writeFileSync("song.sid", sid);
```

## Command line

```sh
sidwave validate song.sidwave.yaml
sidwave lint song.sidwave.yaml
sidwave compile song.sidwave.yaml
sidwave examples
```

The CLI is minimal and its options are not final; run `sidwave --help`.

## What you get

- Language versions 1.0 to 1.3: wave, pulse and filter tables, hard restart, sync and ring, echo, unison, follower voices, multispeed, sections, up to 10 SIDs and 30 voices in a PRG (PSID: up to 3 SIDs), CIA2 volume digis in a PRG.
- Lint checks and error messages that name the failing path in the score.
- 14 example scores.

Planned and not yet available: SID file reader and writer, `sidwave verify`, formatter and diff, a relocatable player and sound effects for games, reconstruction of SID tunes into scores, MIDI/MusicXML/tracker import.

## More

- [Repository README](https://github.com/chrisgleissner/sidwave#readme): overview, examples, roadmap
- [Language specification](doc/sidwave.md)
- [Licensing notes](doc/licensing.md): read this before releasing a tune or embedding the player in a game

License: GPL-2.0-only.
