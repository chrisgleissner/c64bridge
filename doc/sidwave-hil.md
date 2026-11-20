# SIDWAVE hardware-in-the-loop fidelity check

Purpose: show that a SIDWAVE song compiled to a PRG and run on a real Ultimate sounds as the schedule says. `sidplayfp` renders at most 3 SIDs, so the reference is the schedule from `arrangeSidwave` itself, not rendered audio.

Run: `npm run test:sidwave-hil -- --host <ip> --song <file.yaml|preset:chiptune> [--seconds N] [--out dir] [--latency-ms 1500] [--pan sid1=left,sid2=right]`. `--host` has no default. The script starts the audio stream to this host, runs the PRG with `POST /v1/runners:run_prg`, records, stops the stream, and writes `capture.wav` and `report.json`. It exits 1 when the pitched rate is below 0.9 or the percussion match rate is below 0.8. `--configure` only prints the `SID Addressing` settings the song needs (owner layouts in `data/ultimate/multisid.md`); device configuration is not changed. The Audio Mixer pan must be set by the operator and declared with `--pan`.

## Method (`src/audio/sidwaveFidelity.ts`)

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
