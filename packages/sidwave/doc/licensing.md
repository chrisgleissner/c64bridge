# Licensing notes

This page explains how the SIDWAVE licence applies to the things people make with it. It is an explanation, not legal advice; ask a lawyer if a decision depends on it.

## Code licence

The SIDWAVE code (the parser, compiler, player generator, CLI and tools) is licensed under **GPL-2.0-only**. It is not available under any later GPL version, and there is no relicensing.

## What a compiled PRG or SID contains

The compiler's output contains two things:

1. **Your music data**: the note, instrument and timing streams generated from your score.
2. **The player**: a 6502 program, produced from assembly that is part of the compiler's source, that reads those streams and drives the SID.

The score you write is yours. Music data derived from your score is your work.

The player is different. It is generated from code that is licensed under GPL-2.0-only, so a PRG or SID file that includes it contains a GPL-2.0-only program. Under the plain GPL text this has these consequences:

- **Musicians releasing tunes.** You may distribute the compiled file. If you do, the player part is GPL-2.0-only: you need to be able to offer its corresponding source, which is the SIDWAVE source at the version you used together with your score. Keeping the score and naming the SIDWAVE version in the release notes satisfies this in practice. Your music remains yours, but whether the whole PRG or SID counts as one combined work under the GPL is a question the GPL text does not answer clearly for generated binaries.
- **Game and demo developers embedding the player.** If the player is linked into or distributed together with your program as one work, the GPL-2.0-only terms for the player may extend to the combination, which would require releasing your program's source under compatible terms. No relocatable or separable player exists yet, so this mostly concerns the standalone player today, but the question will matter when one is added.

## Open decision: a player exception

A project in this position can add a runtime exception to the licence for the generated player, similar to the GCC Runtime Library Exception: output that contains the player may be distributed under terms of your choice, while the compiler itself stays GPL-2.0-only. This would remove the uncertainty above for musicians and game developers.

**This decision has not been made.** It belongs to the copyright holder. Until the copyright holder adds an exception, no exception exists and the plain GPL-2.0 text governs everything described above. The recommendation is to grant a narrow exception that covers only the player code emitted into compiled output and leaves the rest of the code unchanged.

## Dependencies

| Component | Licence | Use |
| --- | --- | --- |
| `yaml` 2.9.0 | ISC | Required. Parses YAML scores. |
| `c64-asm6502` | GPL-2.0-only (same author) | Required. Assembles the player. |
| `libsidplayfp-wasm` 1.1.1 | GPL-2.0-or-later | Optional, planned for rendering and tracing. Wraps libsidplayfp 3.1.1 and reSIDfp, both GPL-2.0-or-later. |

`sidplayfp` and VICE are separate programs that you install and run yourself. SIDWAVE calls them as external processes and does not include or link their code.

## Example scores

The example scores are covered by the same licence as the repository unless a file states otherwise. Some examples are arrangements of public-domain compositions.
