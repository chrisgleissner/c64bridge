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
3. For custom music, read `c64://sound/sidwave/spec` and compose in SIDWAVE 1.1. Use the `drums` pattern with `lib:kick`, `lib:snare` and `lib:hat` for breaks. Share that voice with `lib:filter_bass` in grooves. Use `lib:chip_arp_major` or `lib:chip_arp_minor` for harmony on one voice.
4. Give a PWM lead delayed vibrato and use `portamento` with `legato` for connected phrases. Leave room for hard restart on fresh attacks. When you use `lib:bell_ring` or `lib:sync_lead`, choose the notes on the source oscillator too. Keep filter ownership and all three voices in mind. Use octave jumps for variation and a delayed copy when a spare voice is available.
5. Use `c64_sound` with `op: "generate"`, `op: "compile_play"`, or `op: "pipeline"` as appropriate.
6. Use `.github/skills/basic-program/SKILL.md` only when the user explicitly wants BASIC-driven playback.

## Validation

1. On `c64u`, prefer `c64_sound` analysis results when verification is enabled.
2. On `vice`, summarize successful playback launch and state clearly when live audio analysis is unavailable.
3. Report the canonical preset or composition path that actually ran.

## Safety

- Confirm before reset or silence actions that would interrupt an in-progress performance.

## Escalation

- Switch from preset playback to custom composition only when the user requests a different arrangement, instrumentation, or score.
