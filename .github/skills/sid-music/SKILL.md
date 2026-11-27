---
name: sid-music
description: Use when the user wants SID music or sound effects, such as playing a music file, presets, composing, converting music formats, reconstructing or inspecting SID files, game music, SID registers, or audio analysis.
---

## Intent

Use this skill for preset music demos, SIDWAVE composition, direct voice control, and audio verification.

## Inputs

- Whether the user wants the built-in `chiptune_drive` preset, another preset from `c64://sound/examples`, or a custom composition.
- Target backends and verification expectations.
- Desired format for custom work: direct voice events, SIDWAVE, or BASIC playback.
- Input files for conversion or reconstruction, and the target format, clock, SID model or CPU budget.

## Play any music file

To play a file or score the user has, execute `c64_sound` with `op: "play"` and `inputPath` (or `sidwave`). It detects SIDWave, SID, MIDI, MusicXML, MOD, tracker and notation files and PRG, converts when needed for the machine's clock, saves the score and PRG and starts them. Report `summary`, every loss and warning, and the saved paths. `approximate: true` means a reconstruction (a SID file on VICE): say so, and set `durationSeconds` for more than the first 30 s. Pass `from` only when detection fails, `configure: true` for more than three voices on an Ultimate. Edit the saved score with `op: "transform"` or `op: "retarget"` and play it again.

## Execution

1. For a quick demo, execute `c64_sound` with `op: "play_preset"`; use `chiptune_drive` by default and keep `fuer_elise` available when explicitly requested.
2. If a legacy preset identifier reaches this workflow, normalize it to `fuer_elise` before playback.
3. For custom music, read `c64://sound/sidwave/spec` and compose in the latest SIDWAVE version. Pick a style from `c64://sound/examples` and read its score. Use `acid_line` for a resonant bass, `arp_ballad` for a lyrical PWM lead, `drum_and_bass` for speed 4 drums, `digi_groove` for samples, `metal_sync` for sync and ring, `chamber_waltz` for 3/4, and `title_fanfare` for brass. Use `stereo_echo` and `ultisid_orchestra` for multiple SIDs. `wall_of_sid` needs `configure: true` and a fitted socket SID. Use the `drums` pattern with `lib:kick`, `lib:snare` and `lib:hat` for breaks. Share that voice with `lib:filter_bass` in grooves. Use `lib:chip_arp_major` or `lib:chip_arp_minor` for harmony on one voice.
4. Give a PWM lead delayed vibrato and use `portamento` with `legato` for connected phrases. Leave room for hard restart on fresh attacks. A pitched ring instrument needs a harmonic source oscillator: an octave (`+12`) source keeps the carrier's harmonics aligned, while an off-key source can create a strong difference tone (for example, a B4 carrier with an A#5 source produces an A4 sideband). Check resolved arrangement/table state and inspect a full render's spectrum and harmony. Prefer a pitched triangle instrument with an octave attack when no voice can hold the right source note. Keep filter ownership and all three voices in mind. `lib:bell_ring` and `lib:sync_lead` remain useful for deliberately inharmonic sound design; choose their source notes intentionally. Use octave jumps for variation and a delayed copy when a spare voice is available.
5. Use `c64_sound` with `op: "generate"`, `op: "compile_play"`, or `op: "pipeline"` as appropriate.
6. Use `.github/skills/basic-program/SKILL.md` only when the user explicitly wants BASIC-driven playback.

## Offline operations

These `c64_sound` operations work on host files and do not play anything (only `play` starts the machine). Give the score as `inputPath` or inline as `sidwave`. Without `outputPath` an operation writes a new file below `artifacts/sidwave/` (a score with `imports`: next to its input file) and returns its path; an existing file is replaced only with `overwrite: true`. `includeScore: true` also returns the written score.

| Task | Operations |
| --- | --- |
| Find out what a file is | `op: "inspect"`; `op: "formats"` lists what can be read and written |
| Convert between formats | `op: "convert"` with `to` or an `outputPath` extension; read `losses`, add `verify: true` for note metrics, `strict: true` to refuse lost content |
| Check a score | `op: "validate"`, `op: "lint"`, `op: "format"` |
| Write or extend a score | `op: "compose"`; `op: "complete"` with `action` continue, harmonise, accompany or fill-section |
| Change a score | `op: "transform"` with `action`; `op: "retarget"` for clock, SID model, SID count or budgets |
| Compile | `op: "compile"` with `output` prg, sid or game |
| Render audio | `op: "render"` to WAV: the mix, `action: "stems"` for one file per voice of a score, `action: "solo"` or `"mute"` with `voice` (for a SID file this is diagnostic audio from a reconstruction) |
| Reuse sounds | `op: "extract_instruments"` from a score or SID file writes a library; import it as the result field `use` shows |
| Maintain a collection | `op: "sid_info"` for header, song lengths, STIL and player; `op: "sid_edit"` with `action` header (`fields`) or songlength (`durations`, `hvscDir`) writes a copy |
| Preserve a tune | `op: "preserve"` with a SID file writes a bundle with score, report and manifest; `action: "verify"` checks one. Report the verdict unchanged; `includeOriginal` only when the user states the rights |
| Study music | `op: "analyze_music"`, `op: "compare"`; `op: "sid_info"` with `hvscDir` for song lengths and STIL notes |
| Recover a score | `op: "reconstruct"` from a SID file, a VICE dump or a siddump table |

`op: "analyze"` is different: it judges recorded audio. Reading a SID file, rendering WAV and verification trace the tune on an emulated SID, so give long tunes a `durationSeconds` horizon.

## Workflow: compose, compile, deploy, capture, verify

1. Select the backend with `c64_select_backend`. Execute `c64_sound` with `op: "compose"` (`style`, `seed`; the clock defaults to the machine) and `includeScore: true`, or write the score yourself.
2. Execute `c64_sound` with `op: "validate"`, then `op: "lint"`, and fix the findings.
3. Execute `c64_sound` with `op: "compile"` and `forDevice: true`. Resolve every warning about the clock, SID model or SID map. For a clock or model mismatch use `op: "retarget"` with `forDevice: true`.
4. Deploy with `c64_sound` `op: "compile_play"` (or `op: "pipeline"`), passing the score as `sidwave`. Use `configure: true` for scores with several SIDs on an Ultimate.
5. Capture and verify:
   - Ultimate (`c64u`): `c64_sound` `op: "record_analyze"` with `durationSeconds` and `expectedSidwave` records the audio stream.
   - VICE: `record_analyze` records the host microphone, not the emulator. To capture the emulator, the operator starts the server with `VICE_ARGS="-sounddev wav -soundarg <file>.wav -limitcycles 20000000"` (use `-sounddev dump` for register writes). VICE completes the file when it ends. Then run `c64_sound` `op: "analyze"` with `wavPath`, or compare the note starts of a dump with `op: "convert"` `to: "vice-dump"` of the same score.
   - Without a capture, say that playback was started and not verified.

## Workflow: reconstruct a SID, verify, transform, deploy

1. Execute `c64_sound` with `op: "sid_info"` for the subtunes, clock, SID model and song length.
2. Execute `c64_sound` with `op: "reconstruct"`, the `song` and a `durationSeconds` horizon.
3. Report the `verdict` and horizon unchanged: `strict_exact` (same register writes at the same calls), `register_state_exact` (same register state, timing of writes differs), `differs` (see `fdiff.differingClasses`) or `recompile_failed` (the recovered score does not compile; see `compile.error` and try a shorter horizon). Never call a result exact without that verdict.
4. For a second opinion execute `c64_sound` with `op: "compare"`, `inputPath` the SID, `comparePath` the score and the `level` the user needs.
5. Edit with `op: "transform"` or `op: "retarget"`, then deploy and verify as in the workflow above.

## Workflow: game music with effects and budgets

1. Read the effects and songs chapters of `c64://sound/sidwave/spec` and the example `c64://sound/examples/game_songs`. Write a score with `songs` and `effects`.
2. Execute `c64_sound` with `op: "lint"`, then `op: "compile"` with `output: "game"`, `origin` (page-aligned free memory, for example `0x8000`), `outputDir`, and `assembler` (`64tass`, `acme`, `kickass` or `ca65`) for one self-contained source include, `symbols` for symbol files, `relocation: true` for the bytes that change when the build moves by pages, and `maxCycles` to refuse a build whose play call is too slow.
3. Check the budget: `cycles.worst` (and `cycles.withEffects`) against the raster time the game leaves, and `contract.memory` and `contract.zeroPage` against its memory map. To meet a budget execute `op: "retarget"` with `budgetCycles` or `budgetBytes`; `allowChanges: true` permits lossy steps, which must be reported.
4. Run it inside a program with `c64_program` `op: "upload_run_asm"`. Follow `contract.registers`; for the origin `$8000`:

```asm
* = $7FC0
start:   sei
         lda #$00          ; song index
         ldx #$FF          ; read the PAL/NTSC flag
         jsr $8000         ; init
frame:   lda #$F8
wait:    cmp $D012
         bne wait
leave:   cmp $D012
         beq leave
         jsr $8003         ; play, contract.playCallsPerFrame times a frame
         jmp frame
         ; an effect: lda #index, ldy #$FF (any voice), jsr $8009
         .res $8000 - *
         .incbin "/absolute/path/to/song.bin"
```

## Validation

For a 2-4 minute piece, read the chapter "Arrangement, dynamics and long form (1.2)" of `c64://sound/sidwave/spec`: write patterns once, build the form with `sections`, a `timeline` and `loop_to` or `end`, shape dynamics with `level` and `volume`, and fix every `lint` entry and check the `arrangement` lines in the compile result before playing.

For SIDWAVE PCM digis, never send more than a few hundred raw samples in tool arguments. Use a procedural `synth:` definition or generate PCM on the host and reference it with `file:`. Reserve inline `b64:` for tiny sounds, with two 4-bit levels per byte, high nibble first. Use `c64_sound` with `op: "sample_render"` to preview a definition, then `op: "analyze"` with the returned WAV path as `wavPath`. Check the compiler's sample size and CPU report before playback. A digi changes the master volume for all voices on its SID.

1. On `c64u`, prefer `c64_sound` analysis results when verification is enabled.
2. On `vice`, summarize successful playback launch and state clearly when live audio analysis is unavailable.
3. Report the canonical preset or composition path that actually ran.
4. For offline operations, report the output path, every loss, warning and verdict.

## Safety

- Confirm before reset or silence actions that would interrupt an in-progress performance.

## Escalation

- Switch from preset playback to custom composition only when the user requests a different arrangement, instrumentation, or score.
