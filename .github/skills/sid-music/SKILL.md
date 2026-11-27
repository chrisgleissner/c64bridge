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

To play a file or score the user has, execute `c64_sound` with `op: "play"` and `inputPath` (or `sidwave`). It detects SIDWave, SID, MIDI, MusicXML, MOD, tracker and notation files and PRG, converts when needed for the machine's clock, saves the score and PRG and starts them. Report `summary`, every loss and warning, and the saved paths. `approximate: true` means a reconstruction (a SID file on VICE) or a partial importer (ABC, JCH, SID Factory II, CheeseCutter): say so with `warnings`. For a SID file on VICE set `durationSeconds` for more than the first 30 s. Pass `from` only when detection fails, `configure: true` for more than three voices on an Ultimate. Edit the saved score with `op: "transform"` or `op: "retarget"` and play it again.

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
| Recover a score (experimental) | `op: "reconstruct"` from a SID file, a VICE dump or a siddump table: an approximate score with a verdict |

`op: "analyze"` is different from `analyze_music`: it judges recorded audio. Reading a SID file, rendering WAV and verification trace the tune on an emulated SID, so give long tunes a `durationSeconds` horizon. `convert`, `reconstruct`, `render`, `analyze_music` and `compare` can run as background tasks (`c64_system` `start_task` with `name`, `operation: "c64_sound.render"` and its `arguments`, then `op: "task_result"` with `name` and `waitMs`). Rendering can take close to the length of the audio for each output file, so use a task for stems or songs over 30 s when the client limits the duration of a call. Results with `approximate: true` (SID and register trace recovery, ABC, JCH, SID Factory II and CheeseCutter import) must be reported as approximate. SID Factory II and CheeseCutter are import only here: writing them needs a driver file and the `sidwave export` command line.

## Workflow: compose, compile, deploy, capture, verify

1. Select the backend with `c64_select_backend`. Execute `c64_sound` with `op: "compose"` (`style`, `seed`; the clock defaults to the machine) and `includeScore: true`, or write the score yourself.
2. Execute `c64_sound` with `op: "validate"`, then `op: "lint"`, and fix the findings.
3. Execute `c64_sound` with `op: "compile"` and `forDevice: true`. Resolve every warning about the clock, SID model or SID map. For a clock or model mismatch use `op: "retarget"` with `forDevice: true`; it does not read the SID count, so pass `sids` for that.
4. Deploy with `c64_sound` `op: "compile_play"` (or `op: "pipeline"`), passing the score as `sidwave`. Use `configure: true` for scores with several SIDs on an Ultimate.
5. Capture and verify:
   - Ultimate (`c64u`): `c64_sound` `op: "record_analyze"` with `durationSeconds` and `expectedSidwave` records the audio stream.
   - VICE: `record_analyze` records the host microphone, not the emulator. To capture the emulator, the operator starts the server with `VICE_ARGS="-sounddev wav -soundarg <file>.wav -limitcycles 20000000"` (use `-sounddev dump` for register writes). VICE completes the file when it ends. Then run `c64_sound` `op: "analyze"` with `wavPath`, or compare the note starts of a dump with `op: "convert"` `to: "vice-dump"` of the same score.
   - Without a capture, say that playback was started and not verified.

A VICE that c64bridge starts has no audio output unless `VICE_ARGS` names a sound device (Linux: `-sounddev pulse`). Say so when the user expects to hear it, and offer `op: "render"`.

## Walkthrough: musician (bring a song, hear it on the SID)

1. Select the backend with `c64_select_backend`. The user's files must be in the folder the server runs in (or another allowed directory).
2. Execute `c64_sound` with `op: "play"` and `inputPath`. Report `summary`, every entry of `losses` and `warnings`, and the saved score and PRG paths.
3. For audio files execute `c64_sound` with `op: "render"` and the same `inputPath` (`outputPath` ending in `.wav`), then `action: "stems"` with `outputDir` for one WAV per voice. Report the conversion losses of the result.
4. To change the music, execute `c64_sound` with `op: "convert"` and `to: "sidwave"` (or use the score `play` saved), then `op: "transform"` (`transpose` with `semitones`, `set_tempo` with `bpm`) or `op: "complete"` (`continue` with `bars`; `accompany` with `bass` or `drums` writes only to a voice that does not play yet). Each call writes a new score: pass its `outputPath` on, then `op: "play"` and `op: "render"` it.
5. The importer keeps three voices per SID; `voices` in `op: "play"` and `op: "convert"` asks for more, which need further SIDs. A loss message that names `--sids` means this argument.

## Walkthrough: game developer (music, effects, cycle budget, assembler include)

1. Execute `c64_sound` with `op: "compose"` (`style`, `seed`, `cycleBudget`, `outputPath`), or write a score with `songs`.
2. For sound effects, edit the score file: set `sidwave: "1.4"` (a composed score says `"1.2"`) and add top-level `effects`. Read the effects chapter of `c64://sound/sidwave/spec`; the index of an effect is its position. Voice 2 (the arpeggio in composed scores) is usually the one to give up:

```yaml
effects:
  coin:
    priority: 8
    voices: [2]
    steps:
      - { freq: B5, wave: pulse, pulse: 0.25, adsr: [0, 0, 15, 6], wait: 4 }
      - { freq: E6, wait: 10 }
      - { gate: false, wait: 6 }
```

3. Execute `c64_sound` with `op: "validate"`, `op: "lint"`, then `op: "compile"` with `output: "game"`, `origin` (page-aligned free memory, for example `32768`), `outputDir`, `assembler` (`64tass`, `acme`, `kickass` or `ca65`) for one self-contained source include, `symbols` for symbol files, `relocation: true` for the bytes that change when the build moves by pages, and `maxCycles` to refuse a build whose play call is too slow. The `kickass` include has not been verified with KickAssembler.
4. Check the budget: `cycles.worst` (and `cycles.withEffects`) against the raster time the game leaves, and `contract.memory` and `contract.zeroPage` against its memory map. To meet a budget execute `op: "retarget"` with `budgetCycles` or `budgetBytes`; `allowChanges: true` permits lossy steps, which must be reported. A `verdict` of `infeasible` means the written score does not fit: compose again with `cycleBudget`, or simplify it.
5. Run it in a test program with `c64_program` `op: "upload_run_asm"`. The built-in assembler reads the `acme` or `64tass` include; give its absolute path. The include defines `sidwave_init`, `sidwave_play`, `sidwave_sfx` and `sidwave_fx_<name>` and sets its own origin, so put it last and the program below the build. This program plays the music and starts the `coin` effect when fire is pressed on joystick 2 (omit those lines for a score without effects):

```asm
* = $7F80
start:   sei
         lda #$00          ; song index
         ldx #$FF          ; read the PAL/NTSC flag
         jsr sidwave_init
         lda #$10
         sta held
frame:   lda #$F8
wait:    cmp $D012
         bne wait
leave:   cmp $D012
         beq leave
         jsr sidwave_play  ; contract.playCallsPerFrame times a frame
         lda $DC00         ; joystick 2, bit 4 low: fire
         and #$10
         cmp held
         beq frame
         sta held
         cmp #$00
         bne frame
         lda #sidwave_fx_coin
         ldy #$FF          ; any allowed voice
         jsr sidwave_sfx
         jmp frame
held:    .byte 0
         .include "/absolute/path/to/title.inc"
```

6. Press fire with `c64_input` `op: "joystick"`, `action: "tap"`, `port: 2`, `controls: ["fire"]`.
7. To hear the music without an emulator, `c64_sound` `op: "render"` writes it (not the effects) to WAV.

## Walkthrough: archivist (identify, preserve, listen to a SID file)

1. Execute `c64_sound` with `op: "sid_info"` for author, subtunes, clock and SID model; add `hvscDir` for song lengths and STIL notes from the user's HVSC copy.
2. Execute `c64_sound` with `op: "preserve"` (`inputPath`, `outputDir`; this traces the tune and can take a minute), then `op: "preserve"` with `action: "verify"` and the bundle folder. Report the verdict unchanged. `ok: true` means the bundle is intact and reproduces its stored result, not that the score matches the original. The default level reports `A1` as not evaluated because no ROMs are passed.
3. To listen, execute `c64_sound` with `op: "render"` for the original (`action` mix), and `action: "solo"` with `voice` 1, 2 and 3. Voice audio comes from a reconstructed score and is diagnostic.
4. `op: "play"` starts the original SID on `c64u` and `u2`. On `vice` it plays an approximate reconstruction of the first 30 s (`durationSeconds` sets more).
5. For an editable score execute `c64_sound` with `op: "reconstruct"`, the `song` and a `durationSeconds` horizon. Report the `verdict` and horizon unchanged: `strict_exact` (same register writes at the same calls), `register_state_exact` (same register state, timing of writes differs), `differs` (see `fdiff.differingClasses`) or `recompile_failed` (see `compile.error` and try a shorter horizon). Never call a result exact without that verdict. For a second opinion use `op: "compare"` with `inputPath` the SID, `comparePath` the score and a `level`.

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
