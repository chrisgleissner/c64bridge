---
name: sid-music
description: Execute built-in and custom SID playback workflows through c64bridge.
---

## Intent

Use this skill for preset music demos, SIDWAVE composition, direct voice control, and audio verification.

## Inputs

- Whether the user wants the built-in `chiptune_drive` preset, another preset from `c64://sound/examples`, or a custom composition.
- Target backends and verification expectations.
- Desired format for custom work: direct voice events, SIDWAVE, or BASIC playback.

## Execution

1. For a quick demo, execute `c64_sound` with `op: "play_preset"`; use `chiptune_drive` by default and keep `fuer_elise` available when explicitly requested.
2. If a legacy preset identifier reaches this workflow, normalize it to `fuer_elise` before playback.
3. For custom music, read `c64://sound/sidwave/spec` and compose in SIDWAVE 1.2. Pick a style from `c64://sound/examples` and read its score. Use `acid_line` for a resonant bass, `arp_ballad` for a lyrical PWM lead, `drum_and_bass` for speed 4 drums, `digi_groove` for samples, `metal_sync` for sync and ring, `chamber_waltz` for 3/4, and `title_fanfare` for brass. Use `stereo_echo` and `ultisid_orchestra` for multiple SIDs. `wall_of_sid` needs `configure: true` and a fitted socket SID. Use the `drums` pattern with `lib:kick`, `lib:snare` and `lib:hat` for breaks. Share that voice with `lib:filter_bass` in grooves. Use `lib:chip_arp_major` or `lib:chip_arp_minor` for harmony on one voice.
4. Give a PWM lead delayed vibrato and use `portamento` with `legato` for connected phrases. Leave room for hard restart on fresh attacks. A pitched ring instrument needs a harmonic source oscillator: an octave (`+12`) source keeps the carrier's harmonics aligned, while an off-key source can create a strong difference tone (for example, a B4 carrier with an A#5 source produces an A4 sideband). Check resolved arrangement/table state and inspect a full render's spectrum and harmony. Prefer a pitched triangle instrument with an octave attack when no voice can hold the right source note. Keep filter ownership and all three voices in mind. `lib:bell_ring` and `lib:sync_lead` remain useful for deliberately inharmonic sound design; choose their source notes intentionally. Use octave jumps for variation and a delayed copy when a spare voice is available.
5. Use `c64_sound` with `op: "generate"`, `op: "compile_play"`, or `op: "pipeline"` as appropriate.
6. Use `.github/skills/basic-program/SKILL.md` only when the user explicitly wants BASIC-driven playback.

## Validation

For a 2-4 minute piece, read the chapter "Arrangement, dynamics and long form (1.2)" of `c64://sound/sidwave/spec`: write patterns once, build the form with `sections`, a `timeline` and `loop_to` or `end`, shape dynamics with `level` and `volume`, and fix every `lint` entry and check the `arrangement` lines in the compile result before playing.

For SIDWAVE 1.2 PCM digis, never send more than a few hundred raw samples in tool arguments. Use a procedural `synth:` definition or generate PCM on the host and reference it with `file:`. Reserve inline `b64:` for tiny sounds, with two 4-bit levels per byte, high nibble first. Use `c64_sound` with `op: "sample_render"` to preview a definition, then `op: "analyze"` with the returned WAV path as `wavPath`. Check the compiler's sample size and CPU report before playback. A digi changes the master volume for all voices on its SID.

1. On `c64u`, prefer `c64_sound` analysis results when verification is enabled.
2. On `vice`, summarize successful playback launch and state clearly when live audio analysis is unavailable.
3. Report the canonical preset or composition path that actually ran.

## Safety

- Confirm before reset or silence actions that would interrupt an in-progress performance.

## Escalation

- Switch from preset playback to custom composition only when the user requests a different arrangement, instrumentation, or score.
