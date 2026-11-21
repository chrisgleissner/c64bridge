# SIDWAVE 1.3.3 release handover

This branch prepares package version 1.3.3 from published 1.3.2. The release has not been merged or tagged. PR #190 remains the review and CI checkpoint: https://github.com/chrisgleissner/c64bridge/pull/190

## Candidate score sources

These SHA-256 values match the YAML assets in the verified 14d7ca09 CI artifact. Durations are the compiled full score lengths, including release tails.

| Example | YAML SHA-256 | Duration (s) | Renderer |
| --- | --- | ---: | --- |
| `acid_line` | `6ec81fced37eef5420112bb71b44fee2dbdb2a5f31bb863a57a4b706d5bf5cdf` | 154.176 | SIDPlayFP per SID |
| `ambient_filter` | `335010cfb29d41f4ad1e40b6fb44a19ba3ee516b508b8ca9ae7674c063149a74` | 171.553 | SIDPlayFP per SID |
| `arp_ballad` | `1a26713b58cd0ae7a41b2ba76147a403d1de6030919dff16f339e3569fa81ee9` | 182.625 | SIDPlayFP per SID |
| `chamber_waltz` | `c54d67af50c26cf64ebe4809dac906394f83c63660294505f89aa14b3be7e6e7` | 139.034 | SIDPlayFP per SID |
| `chiptune_drive` | `13e58ed20f69ba6a82b3fc9643cd56162b2af7836fac6de5b268c52d23093aef` | 154.495 | SIDPlayFP per SID |
| `digi_groove` | `72acc1cac3d5effae405b72923fb74351685452575749ab47e7212295529bcf7` | 163.293 | VICE PRG with CIA2 samples |
| `drum_and_bass` | `e4e2ec6d52d2e298bc0783313d922a001a9fc49cd74e630ad0fa90564bf27e0c` | 163.722 | SIDPlayFP per SID |
| `funk_bass` | `79c3532770e94a06d45e88c24802b5ca2f4b15f7ce02909c0c79c8f333658d3e` | 160.091 | SIDPlayFP per SID |
| `metal_sync` | `6954a8f195713132f47564a3f2341fb55d2f39e0ef0eb5646ce438929aca9e68` | 157.817 | SIDPlayFP per SID |
| `stereo_echo` | `a48514793bc3910ac8b5c6314e4f06cc3dae3f587f71e499a5c1476dc2eac909` | 175.184 | SIDPlayFP per SID |
| `title_fanfare` | `a7571917fb456704310c8cd217376ecbf615f3bf04df8c1493a10f7a836828b0` | 18.753 | SIDPlayFP per SID |
| `ultisid_orchestra` | `24e23b0cd5940a5e11b496edd572accbafff8e0b794b13f463e873c96aad5371` | 146.695 | SIDPlayFP per SID |
| `wall_of_sid` | `2a6a718e0752e22d414d29ff5232a55183d781fc74fa2773f8c0a9424e3f3f0d` | 172.151 | SIDPlayFP per SID |

## Concrete corrections and prevention

- `arp_ballad` and three `metal_sync` ring bells use an octave source; the metal intro was also retimbred. Resolved arrangement/render spectral checks found the intended B4 energy without the false A4 sideband.
- `ambient_filter`'s Water bell source moved from a major seventh to an octave. In the prior render the out-of-key F5 ring sideband dominated the intended G5 carrier by about 35 dB; the corrected render restored the 784 Hz carrier and its 2352 Hz harmonic.
- `drum_and_bass` kick and early snare stages were shortened. At the same scheduled bar-25 hit, the full render's 40–250 Hz attack energy rose 2.39× at +30–40 ms and 1.76× at +40–50 ms.
- Generated ambient music now uses a pitched triangle bell. The previous 1.1 generated score is frozen in a fixture to preserve its PRG/PSID fingerprints. `test/sidwaveRingSource.test.mjs` checks resolved source notes across the 13 examples; the focused tests passed 13/13. The SID music skill now documents harmonic source selection.

## Verification evidence

- On PR head `14d7ca09bb18b29f8c91f9503a7ec80b956c8e74`, required CI passed: build/test, package check, Node compatibility, and 13-example render. The downloaded render artifact contained 13 manifest entries and exactly 26 MP3/YAML assets; all asset SHA-256 values matched the manifest. The manifest and MP3 files are CI artifacts, not committed here.
- The renderer pins open MEGA65 ROMs by commit and SHA-256 in its image, sets VICE's 8580 model explicitly, verifies both configured SIDs, and checks the sample PRG started before accepting the cycle-limited capture.
- Fresh U64 captures were made for the four changed scores. Clean WAV hashes and detailed HIL/quality JSONs are in `~/.c64bridge/recovery/`. Post-capture configuration matched the saved 19-category baseline; IRQ bytes at `$0314` remained `$31,$EA` (vector `$EA31`) and BASIC returned to READY. One ambient take lost a UDP packet and is retained only as failed evidence; the clean retry is the accepted capture.
- Exact changed-candidate HIL primary checks passed: arp chroma/onset `.962/.515`; metal `.958/.601`; ambient `.987/.819`; DnB `.894/.601`. HIL schedule-presence rates are secondary, model-sensitive diagnostics, not the primary verdict.
- Quality review passed without clipping or dropouts for all four. Ambient remains WARN for high-frequency spikes at 84.335, 140.527, and 146.232 s. DnB remains WARN for one unexplained spike at 159.002 s. Earlier ambient/chiptune quality warnings are recorded with their unchanged captures in the local recovery reports.
- Raw `stereo_echo` HIL remains a FAIL: onset `.471`, drift `−67.7 ms`. A single calibrated working copy, using the median `−0.0540%` offset slope from ten other score captures and `asetrate=47974,aresample=48000`, passes unchanged primary thresholds (onset `.887`, chroma `.950`, control margin `.258`, drift `−2.2 ms`). The raw capture and failure remain preserved; the calibration indicates shared sample-clock bias, not an altered score.
- `digi_groove`'s U64 capture measured all 15 sample triggers non-silent during its sample-only intro. The CI VICE render includes its CIA2 samples and both SIDs. `wall_of_sid` has no valid single-model SIDPlayFP fidelity comparison because it mixes eight 8580s and one 6581; its full render duration and source hashes are still checked.
- Audio-input listening was unavailable to the agents. The corrections above address the user's specific heard bell and drum-timing reports using resolved-score renders, spectrum/attack measurements, and U64 captures; they do not claim an independent subjective listening sign-off.

## Release steps

1. Confirm PR #190 checks on the release-prepared head, then merge it.
2. Confirm `main` CI is green and `1.3.3` remains unused on npm and GitHub.
3. Create tag `1.3.3` from the verified `main` release-prepared commit. The release workflow renders from that tag, verifies the 13-pair artifact, publishes npm/MCP after render success, and attaches the 26 MP3/YAML files.
4. Verify npm `1.3.3`, the GitHub release tag, and all 26 release assets against the final manifest hashes.
