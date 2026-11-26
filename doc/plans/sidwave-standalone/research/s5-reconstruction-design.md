# S5 reconstruction, analysis and preservation: design

Status: design (orchestrator, 2026-11-27). Brief section S5 and section 6 apply in full. Work packages S5a to S5e below are implemented by Sonnet workers; each one ends in a pull request to `chrisgleissner/sidwave`.

## Summary

A SID tune is reconstructed by observing its complete register trace on the libsidplayfp-wasm engine. The trace is turned into a per-call frame-state representation. Notes, instruments, tables and structure are recovered analytically, and a canonical SIDWave score is emitted. The score is compiled with the production compiler, and the result is compared with the original. Two comparisons are made: a frame-state difference (F-diff) for diagnosis and repair, and the calibrated audio level A1 for the verdict. T0 and T1 do not apply, because the reconstructed score runs on the SIDWave player, which writes registers in its own order and at its own cycles; they are reported as "not applicable". Repair and compaction are bounded and declared. Work runs on a frozen 30-tune corpus (24 development, 6 held out), chosen by a deterministic coverage procedure, plus synthetic fixtures and seeded round-trip property tests that need no HVSC.

## Frame-state representation (IR)

- Calls: writes are grouped into player calls by cycle gap (the existing `callGroups` rule in `sidwave/src/verify/index.ts`, shared, not copied). The call period is the median spacing of call starts. Calls per frame = round(frame cycles / period); jitter and irregular spacing are reported.
- Per call and per SID: the 25 write-only registers after the call; the set of registers written in the call; the in-call order of writes to each voice's control register (needed for gate and test-bit sequences such as hard restart).
- Writes not grouped into periodic calls (for example `$D418` sample playback from NMI) are measured and reported as unsupported, with their rate and share of writes, unless the language can express them.
- F-diff: compares two IRs call by call after aligning the first call. It reports the first differing call per voice and register class (pitch, gate, waveform, pulse, ADSR, filter, volume, call timing), with time, SID, voice, expected and observed. F-diff is a diagnostic, not a verdict level.

## Recovery pipeline

1. Observation: trace from init to the horizon, which is the Songlengths length of the subtune or 180 s, whichever is shorter. The horizon is declared in every result; it is never shortened silently. The engine is SIDLite (deterministic, decision D3); the clock and model are taken from the header.
2. Tuning: a histogram of the frequency registers at gate-on gives the tuning offset in cents relative to A4 = 440 Hz for the clock. Notes are expressed as note plus cents. When the language cannot express the measured tuning, that is a language-extension candidate (exact frequency values and free tuning, section 6).
3. Note segmentation per voice: a note starts at a gate-on edge, or at a hard-restart pattern (gate off and/or test bit, ADSR change, then gate on within 3 calls), or, with gate held (legato), at a pitch step larger than a declared threshold that is not part of a recognised periodic modulation. A note ends at its gate-off edge or at the next note.
4. Note programs: for each note, the sequences over note-relative calls of waveform and control bits, pitch offset in cents from the base note, pulse width, AD, SR and the voice's filter routing. Identical programs after base-note normalisation form one instrument. Periodic pitch offsets are fitted as vibrato; arpeggio cycles become arp tables; everything else becomes explicit wave, pulse and pitch tables. A fit is accepted only when its compiled output reproduces the program exactly in the F-diff.
5. Global state: the filter cutoff, resonance, routing, mode and volume sequences become filter tables and global effects.
6. Structure: notes are grouped into patterns by exact repetition of event sequences (base note, duration, instrument). Sections and the loop point come from the longest repeated suffix and the trace's own repetition after the Songlengths end. The choice between alternatives is made by description length (bytes of emitted score). Compaction is accepted only when the F-diff of the compiled score is unchanged.
7. Emission: a canonical SIDWave score, formatted with the S4 formatter.
8. Compile and compare: compile with the production compiler, trace on the same engine, F-diff and A1.
9. Diagnosis and repair: the earliest material F-diff difference is classified by root cause (pitch, timing or call rate, gate or hard restart, waveform, pulse, ADSR, filter, volume, structure). Repair is local (for example an explicit table for one note instead of a fitted vibrato). Its search space, objective order (F-diff first difference later, then fewer differing calls, then smaller score), seed, work budget (iterations and wall time), stagnation rule (no improvement in N iterations) and resume behaviour (state file keyed by the content hash of the input and settings) are declared. Each repair rule must be general, carry a regression test, and must not mention a specific tune.

Every optimiser in the pipeline declares the same fields. Analytical solutions come first, then constraint solving, then bounded search.

## Verdicts

Each tune gets the ladder result with T0 and T1 "not applicable" and A1 (calibrated, or "unvalidated" if A1 calibration is not accepted), plus the F-diff summary: the first material difference and the share of calls that match per register class. A valid tune that fails stays a failure. Failures are grouped by root-cause class, and causes are fixed rather than tunes.

## Corpus (S5a)

- Pool: every HVSC subtune with a Songlengths entry of at least 30 s that the engine plays within the budget. Candidates are ordered by SHA-256(md5 + subtune number), and the first 3,000 are traced for 60 s to measure features.
- Features, from the header: model, clock, PSID or RSID, SID count and speed flags. From the trace: calls per frame, writes per call, sync, ring, test bit, filter routing per voice, filter mode use, waveform combinations, a hard-restart rate, a table-heaviness measure (distinct note programs per minute), sample playback (non-periodic `$D418` writes) and the length of the intro before the first repetition. The SIDFlow full export from the latest sidflow-data release, downloaded once and verified against `SHA256SUMS`, supplies style features where present; if the download or schema does not fit, the selection uses trace features only and says so.
- Selection: a greedy cover over feature bins. Each bin is covered by at least two tunes where the pool allows, ties are broken by the hash order, and there are at most two tunes per composer directory. Related tunes (same composer directory and the same player signature, i.e. identical init and play code bytes) form one group.
- Split: groups are ordered by SHA-256(group id). Six held-out tunes are taken from the groups whose hash is lowest, subject to each held-out tune covering at least one bin that the development set also covers. The other 24 are for development.
- The manifest `sidwave/data/reconstruct/corpus-manifest.json` lists path, MD5, subtune, length, features, group and split. It contains no SID data. It is frozen and its hash is written to the ledger before any tuning. Held-out results are recorded once; after any tuning on them, new held-out tunes are drawn by the same procedure, excluding the used ones.
- HVSC is local only (`HVSC_DIR`); corpus tests skip in CI with a message, and local results go into the ledger.

## Fixtures and property tests (no HVSC)

- Independently written synthetic SIDs: small 6502 players assembled with 6502-toolkit, not produced by SIDWave. Each exercises one feature (hard restart, arpeggio, vibrato, pulse sweep, filter sweep, sync, ring, multispeed, two SIDs, test-bit tricks).
- Seeded round trip: generate a score with the existing generator (fixed seeds and styles), compile, trace, reconstruct, compile again, and require an exact F-diff match (zero differing calls) within the horizon. Failures are shrunk to a minimal score.

## Analysis and preservation (S5e)

- Instrument extraction with reuse tests: an instrument extracted from one tune is placed in a new score, and its note program must compile to the same register sequence.
- Structural analysis report: key, metre, form, motifs, voice use, techniques and resources, with each fact marked observed (from the trace) or inferred (from a model).
- Score and tune comparison: F-diff and A1 between any two inputs.
- Diagnostic voice isolation: a voice is muted by masking its writes in the trace replay. Where filter, sync or ring couple voices, the isolation is marked non-additive.
- Preservation bundle: the score, the source checksum and subtune, the reference configuration, engine and compiler identities, the horizon, the verdict, known ambiguities and rights fields, in a documented manifest that verifies offline. It never includes the original SID unless redistribution is permitted.

## Work packages

- S5a: corpus selection, feature extraction and manifest; synthetic feature fixtures.
- S5b: IR, call detection and F-diff, with tests on fixtures.
- S5c: recovery steps 2 to 7 and the seeded round-trip property tests.
- S5d: corpus runs on development tunes, diagnosis, general repairs and compaction, and language-extension proposals. Extensions are designed by the orchestrator under section 6.
- S5e: analysis reports, instrument extraction, comparison, voice isolation and the preservation bundle; then the held-out run, once.
