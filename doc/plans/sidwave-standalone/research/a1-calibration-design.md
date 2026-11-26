# A1 audio verification level: design and calibration protocol

Status: design, frozen before implementation (orchestrator, 2026-11-26). Changes after the held-out evaluation require a new held-out set (brief section 7, S3 and S5).

## Summary

A1 decides whether two renders of a SID tune are materially the same music when the register-level levels T0 and T1 fail. It compares short, time-localised windows of the two PCM renders, marks windows that differ by more than calibrated thresholds, and fails when bad windows cluster. It never uses one global similarity score. Thresholds are fitted on a development set of score-level mutations and benign controls, frozen in a rule file whose SHA-256 goes into the ledger, and then evaluated once on a held-out set. The result reports false-accept and false-reject rates with 95 % confidence intervals. If either held-out rate exceeds 5 %, A1 keeps the status "approximate".

## 1. Inputs and pinned conditions

- Two PSID files (reference, candidate), one subtune each, same clock and SID model, rendered by the pinned reSIDfp engine (`libsidplayfp-wasm` 1.1.1, emulation `residfp`) at 48,000 Hz, mono, Int16, with the pinned MEGA65 Open ROMs. A1 is defined only under these conditions; any other engine or rate yields "A1 not evaluated".
- Observation horizon H seconds, the same for both; reported in the result. Default H = min(song length, 180 s). Never shortened silently: if a render ends early, the result says so and the missing part counts as bad windows.

## 2. Features (per window)

- Window 1024 samples (21.33 ms), Hann, hop 512 (10.67 ms).
- 48 log-spaced bands from 40 Hz to 16 kHz; band energy in dBFS from a radix-2 FFT (own implementation, no dependency).
- Window level L = RMS in dBFS. Silence floor F = -60 dBFS.
- Spectral flux (positive band-energy increases) for onset alignment only.

## 3. Alignment

- One global lag search in [-24, +24] ms (about one PAL play call plus a window) maximising the correlation of spectral flux over the first 30 s with signal. No piecewise warping. The chosen lag is reported. A lag outside the range is not searched: a uniform shift larger than that is a timing defect, not an alignment (this closes the known gap that the hardware comparison accepted a uniformly shifted capture).

## 4. Window decision

For each aligned window pair (a, b):

- Both below F: equal (silence).
- Exactly one below F and the other above F + S_gap: bad, class `sound_in_silence` or `missing_sound`.
- Otherwise:
  - D_spec = mean over bands where max(a_band, b_band) > F of |a_band - b_band| (dB).
  - D_level = |L_a - L_b| (dB).
  - bad if D_spec > θ_spec or D_level > θ_level.

## 5. Tune verdict

Fail if there are at least K consecutive bad windows, or at least M bad windows within any sliding 2-second span. Otherwise pass. The result names the first failing time, the class of the first bad window (spectral, level, sound_in_silence, missing_sound, truncated), the number of bad windows and the horizon.

Starting values from sidflow's ROM audit (engineering guesses, not validated): θ_spec = 15 dB, θ_level = 6 dB, S_gap = 10 dB, K = 2, M = 3.

Calibrated parameters: θ_spec ∈ {6, 8, 10, 12, 15, 20}, θ_level ∈ {3, 4.5, 6, 9}, S_gap ∈ {6, 10, 15}, K ∈ {2, 3, 4}, M ∈ {3, 5, 8}. Grid search only (432 points); no per-tune or per-class values.

## 6. Calibration corpus

Base tunes: the 14 example scores plus 10 generator outputs (3 styles, fixed seeds listed in the manifest), 24 base tunes. Mutations are applied to the SIDWave score (never to audio), recompiled with the production compiler, so every mutated tune is a real SID.

Mutation classes and severities (label in brackets: M = material, must fail; B = benign, must pass; X = borderline, reported but not scored):

| Class | Severities |
|---|---|
| wrong note | ±1 semitone [M], ±2 [M] |
| octave error | ±12 on one note [M] |
| missing note | one note replaced by rest [M] |
| extra note | one rest replaced by a note [M] |
| detune whole voice | 3 cents [B], 8 cents [X], 25 cents [M], 50 cents [M] |
| single-note timing shift | 1 frame [X], 3 frames [M], 6 frames [M] |
| tempo drift | 0.5 % [X], 2 % [M] |
| gate length | ±1 frame on one note [X], half the note [M] |
| envelope | release ±1 step [X], attack or decay ±4 steps [M] |
| waveform | one instrument triangle↔pulse or saw [M] |
| pulse width | ±1/64 [X], ±1/8 [M] |
| filter | cutoff ±5 % [X], ±40 % [M], filter off [M] |
| sync / ring | toggled on one instrument [M] |
| missing percussion | drum voice muted [M] |
| sound in silence | 50 ms noise burst in a rest [M] |
| section and loop | two sections swapped [M], loop point moved by one bar [M] |
| short defect in long tune | one wrong note in a tune longer than 90 s [M] |
| benign controls | identical recompile [B], register writes reordered within one player call [B] (synthetic trace-preserving score refactor: duplicate section split, renamed instrument) [B], volume of an inaudible (gated-off) voice changed [B], 1-sample PCM delay [B] |

Each base tune receives every applicable mutation once, at a deterministic position chosen by a seeded hash of (tune, class, severity). A mutation that is not applicable to a tune (no drums, no filter) is skipped and listed.

## 7. Split, fitting, freezing

- Split by base tune: SHA-256(tune id) mod 10 < 7 → development (about 17 tunes), else held out (about 7). All mutations of a tune stay on its side.
- Objective on development: minimise FA + FR weighted 3:1 (a false accept, i.e. passing a material defect, is worse); ties broken by the larger θ values (fewer false rejects on real captures).
- Freeze: write `sidwave/data/verify/a1-rules.json` (parameters, engine identity, ROM hashes, grid, objective, split seed, corpus manifest hash), record its SHA-256 in the ledger, commit it. Only then render and evaluate the held-out set, once.
- Report: FA and FR on development and on held-out, overall and per mutation class, with Wilson 95 % intervals; list every misclassified case (tune, class, severity, first bad time or "no bad window").
- Acceptance for status "verified within declared bounds": held-out FA ≤ 5 % and FR ≤ 5 %. Otherwise "approximate" with the measured rates. Any later change to rules or features requires new held-out tunes (add generator seeds not used before) and a new freeze.

## 8. Implementation notes

- Library function `compareAudioA1(reference: Int16Array, candidate: Int16Array, rules, options) → A1Result` in `sidwave/src/verify/a1.ts`; `verifySid` calls it when a reSIDfp engine is supplied; result fields `levels.A1: "pass" | "fail" | "not evaluated"`, `a1: { lagMs, badWindows, firstBad?: { timeSeconds, class }, horizonSeconds, rulesSha256 }`.
- Calibration is a script (`scripts/calibrate-a1.mjs`) with `--phase dev|freeze|heldout`, content-addressed render cache keyed by score hash, compiler version, engine identity, ROM hashes, model, clock, horizon. `--phase heldout` refuses to run when the rule file hash differs from the one recorded at freeze, and refuses a second run unless `--new-heldout` names new seeds.
- Budget: the corpus is about 24 × 40 mutations ≈ 1,000 renders; each render bounded at 180 s audio; run with nice and at most 3 parallel workers.
