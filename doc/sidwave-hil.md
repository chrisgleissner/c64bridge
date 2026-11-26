# SIDWAVE hardware-in-the-loop fidelity check

The harness compares a SIDWAVE PRG running on a real Ultimate with offline SID stems and the compiled note schedule.

Run: `npm run test:sidwave-hil -- --host <ip> --song <file.yaml|preset:chiptune> [--seconds N] [--out dir] [--latency-ms 4000] [--pan sid1=left,sid2=right] [--model 6581|8580]`. `--replay capture.wav` re-analyses an earlier capture without contacting the device. `--host` has no default. The script starts the audio stream to this host, runs the PRG with `POST /v1/runners:run_prg`, records, stops the stream, and writes `capture.wav` and `report.json`. It exits 1 when the reference comparison below fails. The schedule-based report (next section) is a diagnostic and no longer sets the exit status. `--configure` only prints the `SID Addressing` settings the song needs (owner layouts in `data/ultimate/multisid.md`); device configuration is not changed. The Audio Mixer pan must be set by the operator and declared with `--pan`.

## Primary method: comparison with a sidplayfp reference (`src/audio/sidwaveReference.ts`, `sidwaveSimilarity.ts`)

The schedule-based presence test depends on SID model and filter: a faithful sidplayfp render scored 0.78 pitched and the hardware capture 0.22 although the same music played. The primary check therefore compares the capture with a rendering and uses only features that survive a change of SID model.

1. Reference. Resolve the full arrangement before projecting each SID to `$D400`. The single-SID stems retain the score’s version, filters, dynamics, and resolved echo, unison and centre parts. Render each PSID with sidplayfp and mix it using the score’s pan or the `--pan` overrides. sidplayfp stems omit CIA2 NMI digis. The harness and offline review report this limitation in the console and JSON. Use a VICE capture of the standalone PRG to include the samples.
2. Alignment. Onset envelopes of reference and capture (20 ms frames, log energy in 7 bands from 60 Hz to 9 kHz, positive change per band, each band scaled by its own mean, summed, smoothed, max-pooled over +-20 ms) are correlated (Pearson) over the whole song for offsets from -200 ms to `--latency-ms` (default 4000, the PRG start-up takes about 1.9 s). A song repeats its bars, so the correlation has several maxima one bar or beat apart. The best 8 are ranked by the mean chroma similarity of 48 frames spread over the song, and the best of those is used. On the first hardware run the onset maximum was at 32 ms and the right offset was 1881 ms; the wrong bar gave a chroma median of 0.11. The first and last third are then aligned again within +-200 ms of the chosen offset; both offsets and the drift are reported.
3. Similarity on 300 ms frames every 50 ms after alignment. Chroma: Hann-windowed zero-padded FFT magnitudes summed per semitone band (A1 to B5), log-compressed, whitened by subtracting the +-12 semitone moving mean (so a loud bass or a dense harmonic series does not dominate), clipped at 0, folded into 12 pitch classes, centred and normalised per frame; the frame score is the cosine. Reported: median and fraction of frames above 0.7 (frames silent in the reference are skipped). Onset: Pearson correlation of the aligned envelopes. Stereo: for songs whose reference has a panned part (90th percentile of |L-R|/(L+R) above 0.3), the mean absolute difference of the per-frame balance.
4. Controls, printed in every run: the capture compared with the reference chroma moved up one semitone, and with the reference half a bar later (chroma and onset). A pass needs chroma median >= 0.6, onset correlation >= 0.5, both at least 0.2 above the controls, and balance error <= 0.3 where applicable.

Calibration. First U64 hardware run (chiptune seed 65, UltiSID against the 8580 sidplayfp rendering, capture about 10 dB louder with more bass and denser harmonics): chroma median 0.96 (99 % of frames above 0.7), onset 0.79; controls: +1 semitone 0.05, half bar 0.07 chroma and 0.25 onset. A 6581 against an 8580 rendering: 0.96 / 0.76, controls -0.00 and 0.37 / 0.37. Synthetic square against low-passed saw: 0.91 / 0.94, controls up to 0.37 / 0.12. The previous 100 ms peak-picking chroma scored the same pair at 0.11 because of the wrong-bar alignment and its dependence on timbre. A 5 s excerpt of the hardware pair (mono, 8 kHz, `test/fixtures/sidwave-hil/`) is a regression test (`test/sidwaveHilFixture.test.mjs`).

Limits: a whole capture shifted in time is indistinguishable from latency and passes (the offset is reported). One voice played half a bar late lowers the chroma median by about 0.17 and is not a pass/fail case. Per-SID filters and volumes are not in the reference. The output files are `reference.wav`, `capture.wav`, `spectrograms.png` (reference, aligned capture, difference; needs ffmpeg) and `report.json`.

## Diagnostic: schedule-based presence

Method (`src/audio/sidwaveFidelity.ts`)

1. Schedule. Each arranged note starts at `frame / fps`, where `fps` is the video frame rate times `speed`. It sounds until its gate-off frame: the earlier of the arranged end and the hard restart (`SIDWAVE_HARD_RESTART_FRAMES` before the next note on that voice). Voice `v` is on SID `floor(v / 3)`. Instruments with a noise waveform are percussion: only their onset times are kept.
2. Offset. The capture starts before the song, so the playback start offset is found by cross-correlating the onset strength of the capture (log-spectral flux, 512-sample Hann frames, hop 128) with a train of triangular pulses (+-12 ms) at every scheduled onset, over lags 0 to `latencySearchMs`, with parabolic refinement. The stream is started first and the PRG after the first datagram, so the offset is the PRG start-up time.
3. Pitched notes. For each note the middle 60 % of the sounding time is taken (Hann window, 40 ms to 500 ms). At the fundamental and the next two harmonics the Goertzel power is the maximum over -20, 0 and +20 cents. It is compared with the median power on a 20-cent grid within +-2 semitones, excluding +-30 cents around the target. The medians are floored at the level of a 0.002 amplitude sine (about -54 dBFS), so leakage over silence is not read as a tone. A note is present when the ratio of summed target power to summed median power exceeds 6 dB and the fundamental alone exceeds 6 dB. The 6 dB threshold sits well below the 20 to 60 dB measured with clean tones and above the 0 to 3 dB of an absent note; it is the `thresholdDb` option.
4. Percussion. An onset matches when the energy above 4 kHz within +-30 ms of the expected time is above 4 times (6 dB) the median level of the preceding 100 ms and above 1e-6 absolute.
5. Report: offset and confidence, pitched rate overall, per voice and per SID, percussion rate, left and right RMS, and for SIDs declared left or right the summed fundamental power of their notes in each channel with the separation in dB.

## Counting rules and limitations

- Notes of different voices with the same pitch (within 50 cents) and overlapping in time are counted once (the first in schedule order). The merged notes are listed in `notes` with `merged: true`.
- Notes whose analysis window is shorter than 30 / f seconds (low notes shorter than about 0.5 s) cannot be separated from a semitone away with a Hann window. They are reported as `unresolved` and are not counted. The report shows how many notes were not judged, so a high rate with many unresolved notes is not full coverage.
- Arpeggios count as present when any of their pitches is. Vibrato, slides and portamento move the pitch by up to the effect depth; an effect deeper than 30 cents can fail the fundamental test.
- A harmonic of another voice can fall on the fundamental or a harmonic of a note. The fundamental must pass alone, but a note an octave or a twelfth above a sounding note is only distinguishable when the lower note lacks that harmonic.
- Filters, SID model differences and mixer levels change levels, not pitch; only presence is tested, not level or timbre.
- The stream is UDP. Missing packets are replaced with silence of the same length, so the timeline stays aligned, but heavy loss lowers the rates.
- Unit tests (`test/sidwaveFidelity.test.mjs`) use synthetic PCM only. The method has not been run against a device in this change.

## Quality gate (`packages/sidwave/scripts/sidwave-review.mjs`, `packages/sidwave/src/audio/sidwaveQuality.ts`)

`node packages/sidwave/scripts/sidwave-review.mjs --wav <reference.wav|capture.wav> [--song <file|preset:style>] [--offset-ms N] [--out report.json]` runs offline checks and prints PASS, WARN, FAIL or SKIP per check and a verdict (exit 1 on FAIL). With `--song`, the schedule gives scheduled onsets, bars and sections; the song start in the WAV is found by aligning with a sidplayfp rendering unless `--offset-ms` is given. Checks marked "score" are SKIP without `--song`. Thresholds are `DEFAULT_QUALITY_THRESHOLDS`.

| Check | Measure | WARN | FAIL |
|---|---|---|---|
| clipping | samples at or above 0.99 full scale, longest run | run >= 3 | run >= 8 or more than 1e-4 of samples |
| glitches (score) | 3 kHz high-pass and 1 ms peaks. A candidate must exceed 8× the 85th percentile of nearby 10 ms spectral peaks and an absolute floor of 0.02. Masks cover arranged attacks, releases, table changes and drum or digi playback. | 1 event | 6 events |
| dropouts (score) | RMS below -66 dBFS for more than 30 ms while a note is scheduled | 1 | 3 |
| tonal balance | octave band levels 40 Hz to 10 kHz (reported), bass 40-250 Hz against 1-4 kHz, median spectral centroid | bass more than 12 dB below, or centroid above 2.5 kHz | 20 dB, or 3.5 kHz |
| fullness | fraction of 100 ms frames with 3 octave bands within 15 dB of the loudest; with score, fraction of bars with bass above -60 dBFS | below 0.5 / 0.8 | below 0.25 / 0.5 |
| dynamics | integrated RMS, crest factor, loudness range (10th to 95th percentile of 400 ms RMS, gated at -60 dB); with score, RMS per section (4-bar blocks when there is one named section) | RMS outside -30..-8 dBFS, or section range below 3 dB (loudness range below 3 dB without score) | - |
| repetition (score) | per bar chroma sequence similarity with earlier bars | more than 75 % of bars above 0.95 | more than 90 % |
| stereo | mono sum energy against the average channel energy; side/mid width per section | loss above 3 dB | above 6 dB |
| pitch stability (score) | notes of 0.3 s or more, 100 Hz or more, without vibrato, slide, portamento, arpeggio or wavetable: Goertzel peak in 150 ms windows (2 cent resolution, windows with a peak within 100 cents only, first and last window of a note dropped), worst deviation from the global tuning offset, 95th percentile over notes | above 15 cents | above 30 cents |

Calibration on the sidplayfp renders and live U64 captures of the three presets (seed 65, C3):

| song | source | verdict | bass vs mid (dB) | centroid (Hz) | full | RMS (dBFS) | crest | loudness range | repeat | pitch p95 (cents) | glitch events |
|---|---|---|---|---|---|---|---|---|---|---|---|
| chiptune | render | WARN | +8.7 | 482 | 1.00 | -23.8 | 11.4 | 1.9 | 14 % | n/a | 0 |
| chiptune | capture | WARN | +7.2 | 501 | 0.99 | -14.6 | 11.8 | 2.0 | 0 % | n/a | 0 |
| funk | render | WARN | +8.5 | 481 | 1.00 | -24.2 | 10.6 | 1.7 | 29 % | n/a | 0 |
| funk | capture | WARN | -1.8 | 827 | 1.00 | -17.2 | 13.9 | 2.7 | 29 % | n/a | 0 |
| ambient | render | FAIL | +10.2 | 390 | 0.94 | -24.8 | 13.1 | 4.8 | 29 % | 30 | 41 |
| ambient | capture | WARN | +9.5 | 528 | 0.97 | -17.5 | 13.5 | 12.6 | 29 % | 14 | 0 |

All six are WARN or FAIL only because of the dynamics check (no section differs by 3 dB: the generated arrangements are flat). No clipping, no dropouts, bass present in every bar, not tinny (centroid under 830 Hz). The sidplayfp ambient render has periodic 12 Hz HF ticks at the start and near 12 s that the U64 capture does not have, and a pad that drifts by 30 cents. The chiptune and funk presets have no unmodulated note of 0.3 s or more, so pitch stability is SKIP. Without the exclusion of ring/sync/wavetable notes, the ambient bell and the drum noise gave 30 to 260 false glitch events per song.
