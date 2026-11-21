---
title: Use harmonic sources for pitched ring bells
author: Christian
date: 2026-11-21
branch: feat/sidwave-1.3-render-ci
id: l-a80c4f63
scope: repo
status: active
src: agent
touches:
  - src/audio/generateSidwave.ts
  - ".github/skills/sid-music/SKILL.md"
---

When a ring-modulated note is intended to sound pitched, keep its source oscillator harmonic with the carrier, usually at +12 semitones. A +11 source is a major seventh interval: for a B4 carrier and A#5 source, the ring product has a strong ~A4 difference tone that can overpower the intended pitch. Inspect the fully resolved per-SID channel/table state because source_note is synthesized onto the preceding oscillator, and verify the full render spectrum/harmony. If no clean source voice can hold the intended pitch, use a non-ring pitched tone such as a triangle bell with an octave attack. Keep lib:bell_ring and other inharmonic ring choices available for deliberate metallic effects.
