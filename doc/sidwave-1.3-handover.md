# SIDWAVE 1.3 handover

This PR is a review checkpoint for SIDWAVE 1.3. Package metadata remains at 1.3.2. Do not tag, publish, merge, or prepare a release from this checkpoint. Actual listening acceptance and the full CI gates remain outstanding.

## Candidate score hashes

The four entries marked **recapture** changed after their saved hardware recording. Their existing WAVs and quality reports are hash-bound to the earlier score and are stale for the current candidate. `metal_sync` did not change and its capture/report remain current.

| Example | Current score SHA-256 | Hardware capture status |
| --- | --- | --- |
| `acid_line` | `6ec81fced37eef5420112bb71b44fee2dbdb2a5f31bb863a57a4b706d5bf5cdf` | Current capture; quality review pending |
| `ambient_filter` | `72cccef13fe35e19fbdfeb4aba51bfd25ea82a44cba0f26442b420522bc99f8a` | Current capture; WARN: one unexplained high-frequency spike at 84.341 s |
| `arp_ballad` | `1c6298e249020aaf1ca61189e09c1ead0614115755eebbde687c6ca3a569606e` | **Recapture**; saved capture is for `f1d031944c0c79d2424d32780620e34c4212fb6ca96155af1cb0e5b216889afa` |
| `chamber_waltz` | `c54d67af50c26cf64ebe4809dac906394f83c63660294505f89aa14b3be7e6e7` | **Recapture**; saved capture is for `95b07f45d8d795156b34538270564876a03954eae132b24e2c9b492562162e42` |
| `chiptune_drive` | `13e58ed20f69ba6a82b3fc9643cd56162b2af7836fac6de5b268c52d23093aef` | Current capture; WARN: three unexplained high-frequency spikes at 1.183, 2.060, 104.766 s |
| `digi_groove` | `72acc1cac3d5effae405b72923fb74351685452575749ab47e7212295529bcf7` | Current capture and quality report; sample activity measured in sample-only intro bars 1–2 |
| `drum_and_bass` | `d1c58e5278f25ae9381492642cf993fa17dd8d947d87141506fa82c2458e30b5` | Current capture; quality review pending |
| `funk_bass` | `79c3532770e94a06d45e88c24802b5ca2f4b15f7ce02909c0c79c8f333658d3e` | Current capture; quality review pending |
| `metal_sync` | `96231e8e56209b81c3d9e63b3120c42182effee93b788dc15f147f80c0ddf79b` | Current capture and quality report |
| `stereo_echo` | `a48514793bc3910ac8b5c6314e4f06cc3dae3f587f71e499a5c1476dc2eac909` | Current capture; PASS |
| `title_fanfare` | `a7571917fb456704310c8cd217376ecbf615f3bf04df8c1493a10f7a836828b0` | Current capture; PASS |
| `ultisid_orchestra` | `24e23b0cd5940a5e11b496edd572accbafff8e0b794b13f463e873c96aad5371` | **Recapture**; saved capture is for `d7482ba3e3b4752c7e0d8aae0c217b027ce2bb7322ca3b4f7434a8aa10bec16f` |
| `wall_of_sid` | `2a6a718e0752e22d414d29ff5232a55183d781fc74fa2773f8c0a9424e3f3f0d` | **Recapture**; saved capture is for `9d1be562bd47bb3c30bd01436447cf4238afa5b5d0ee055931444aadec34165f` |

## Local hardware evidence

The WAVs, MP3s, JSON quality reports, and transcripts are outside Git in `~/.c64bridge/recovery/`. Filenames use `<example>-1.3.{wav,mp3,log}` and `<example>-1.3-quality.json`; `digi_groove` uses `digi-groove-candidate-72acc1.*`.

The recordings were made serially on the U64 bench. The capture script reported no lost-packet warnings. Before and after each run, the 206-item configuration snapshot diff was empty, IRQ vector `$0314` remained `$31EA`, and the machine returned to BASIC READY. These checks prove capture and restoration, not artistic acceptance.

Current, hash-bound quality reports at checkpoint:

- `digi_groove` (`72acc1ca…`): PASS; 568 ms measured onset; no clipping, unexplained spikes, or dropouts; RMS -21.4 dBFS, loudness range 10.1 dB. Its first two bars are sample-only: hardware capture RMS L/R 1055/1055 against pre-roll 5.8/5.6, and all 15 scheduled sample triggers measured non-silent.
- `metal_sync` (`96231e8e…`): PASS; no clipping, unexplained spikes, or dropouts; 100% fullness; RMS -19.4 dBFS, loudness range 7.0 dB.
- `title_fanfare` (`a7571917…`): PASS; no clipping, unexplained spikes, or dropouts; RMS -19.9 dBFS, loudness range 8.5 dB.
- `stereo_echo` (`a4851479…`): PASS; no clipping, unexplained spikes, or dropouts; RMS -20.7 dBFS, loudness range 12.4 dB.
- `ambient_filter` (`72cccef1…`): WARN for one unexplained high-frequency spike at 84.341 s; otherwise no clipping or dropouts, RMS -25.9 dBFS, loudness range 15.7 dB.
- `chiptune_drive` (`13e58ed2…`): WARN for three unexplained high-frequency spikes at 1.183, 2.060, and 104.766 s; otherwise no clipping or dropouts, RMS -20.0 dBFS, loudness range 8.6 dB.

Four earlier multipart reports are stale after the one-pass score edits: `arp_ballad` and `chamber_waltz` had PASS reviews; `ultisid_orchestra` had PASS with 107 long notes and p95 pitch deviation 10 cents; `wall_of_sid` had PASS with three samples at or above 0.99 full scale (maximum 32682/32767, below full-scale clipping). Their reports remain beside the old WAVs, but do not validate the current hashes above. `wall_of_sid` uses eight 8580 UltiSIDs plus the installed socket 6581; its old score-only report must not be confused with an actual listening review.

Sol 6.2’s pre-pass multipart rubric totals were 88, 82, 87, 84, and 80 across the five pieces. The assessment was score-only: that session did not receive audio input. No actual listening acceptance is available yet.

## Remaining work

1. Recapture and review the four changed multipart scores above, serially. Reuse the `metal_sync` capture because its score hash is unchanged. Keep all captures under `~/.c64bridge/recovery/`; never commit audio artifacts. For U64 recordings, compare configuration snapshots and IRQ `$0314` before/after and confirm BASIC READY.
2. Investigate the objective spike warnings for `ambient_filter` and `chiptune_drive`; finish `sidwave-review.mjs` checks for the current single-tempo captures (`acid_line`, `drum_and_bass`, `funk_bass`). Check existing report hash against the table before reusing it.
3. Run the local gates from the repository root:

   ```sh
   npm ci
   npm run build
   git diff --exit-code -- README.md mcp mcp.json server.json
   npm run test:node
   npm run check:node-compat
   bun install --frozen-lockfile --omit=optional
   bun run build
   CI=1 FORCE_XVFB=1 VICE_VISIBLE=false VICE_WARP=true VICE_DEVICE_TEST_DEBUG=1 npm_config_loglevel=verbose npm run coverage
   ```

   The CI package-check job must also pass on the PR. The archived suite log is historical and has no reliable HEAD metadata; do not treat its 9 reported failures as the current result.
4. Obtain real listening review on the exact final candidate scores, address concrete findings, and rerun score-hash-bound captures/reviews for any changed file. Only then decide release version and prepare a separate release change.

No release metadata was bumped in this PR. The original dirty drafts remain preserved in the local archive `examples2-dirty-2026-11-21.tar`; this PR uses the recovered score files from that archive and the later committed revisions.

## Verification at checkpoint

- `npm run check:package`: passed.
- Initial full `npm test`: 2,235 passed and 14 failed because the composed-score test still expected SIDWAVE 1.2 headers/version. The assertions now parse the 1.3 comment block and retain the separate 1.2 fixture checks. The focused `test/sidwavePlayer.test.mjs` rerun passed all 105 tests; `test/sidwave13Vibrato.test.mjs` passed all 7 tests after replacing an assertion helper unavailable in Bun 1.3.1.
- The full suite and CI coverage must pass on the follow-up PR SHA. Earlier CI reported the Bun 1.3.1 helper incompatibility, now fixed; rerun the PR checks before treating it as resolved.
- No audio-input-capable listening review has been completed. Sol 6.2 did not receive audio and its multipart scores (88, 82, 87, 84, 80) were score-only, pre-pass assessments.
