# SIDWAVE sample render artifacts

CI renders the 13 public SIDWAVE example scores with:

```sh
node scripts/render-sidwave-examples.mjs --out-dir <directory>
```

The output contains one byte-exact `<slug>.yaml` and one full-length `<slug>.mp3` per public example, plus
`manifest.json` with source/audio SHA-256 hashes, the renderer used, and the arranged duration. The output ends at the
arranged duration, including the score's release tail. CI uploads the directory as the `sidwave-examples` artifact.
The tag-release workflow renders from that tag's own source snapshot, validates every asset against the manifest, and
attaches the 26 MP3/YAML files to the GitHub release. The renders are not included in the npm package.

The 12 examples without CIA2 samples are rendered as one sidplayfp PSID per SID, then mixed with the score's pan law.
Per-SID PSIDs preserve the full resolved voices and support the 8- and 9-SID scores without relying on sidplayfp's
multi-SID PSID limit. The renderer honors each declared SID model. These are software renderings of the resolved
score and mixer settings; sidplayfp does not model the C64's surrounding timing and electrical audio path.

`digi_groove` is recorded from its compiled standalone PRG in VICE so its CIA2 NMI volume-register samples play along
with both SID chips. Both chips in that score are centered 8580s, so the VICE stereo output is folded to mono and
duplicated to both channels. VICE's ALSA `null` output discards host playback while allowing the recorder to drain;
the rendered signal still comes from VICE's SID emulation and PRG execution. Its MP3 receives a fixed 10 dB gain to
match the saved U64 capture's integrated level without compression or clipping; the manifest records this gain. This
does not claim hardware capture fidelity. A VICE run that drops audio, misses the requested cycle limit, or produces
no samples fails the job.
