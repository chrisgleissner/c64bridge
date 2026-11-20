---
name: sid-music
description: Execute built-in and custom SID playback workflows through c64bridge.
---

## Intent

Use this skill for preset music demos, SIDWAVE composition, direct voice control, and audio verification.

## Inputs

- Whether the user wants the built-in `chiptune_drive` preset, another preset, or a custom composition.
- Target backends and verification expectations.
- Desired format for custom work: direct voice events, SIDWAVE, or BASIC playback.

## Execution

1. For a quick demo, execute `c64_sound` with `op: "play_preset"`; use `chiptune_drive` by default and keep `fuer_elise` available when explicitly requested.
2. If a legacy preset identifier reaches this workflow, normalize it to `fuer_elise` before playback.
3. For custom music, prefer SIDWAVE 1.1 instruments and library recipes: use wavetable noise-to-pitched drum transients, filtered bass, a single-voice chord arpeggio, PWM leads with delayed vibrato, octave variation, and echoes on a spare voice. Respect the shared filter and three-voice limit.
4. Use `c64_sound` with `op: "generate"`, `op: "compile_play"`, or `op: "pipeline"` as appropriate.
4. Use `.github/skills/basic-program/SKILL.md` only when the user explicitly wants BASIC-driven playback.

## Validation

1. On `c64u`, prefer `c64_sound` analysis results when verification is enabled.
2. On `vice`, summarize successful playback launch and state clearly when live audio analysis is unavailable.
3. Report the canonical preset or composition path that actually ran.

## Safety

- Confirm before reset or silence actions that would interrupt an in-progress performance.

## Escalation

- Switch from preset playback to custom composition only when the user requests a different arrangement, instrumentation, or score.
