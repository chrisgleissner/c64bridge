<!--
c64bridge additions to the SIDWave specification. scripts/sync-sidwave-data.mjs inserts each block below the heading
named in its marker and writes the result to data/sound/sidwave.md. The heading must be one line of the sidwave
package specification. Links are relative to data/sound. This comment is not copied.
-->

<!-- after: # SIDWave Format Specification -->
**Using this specification with the c64bridge MCP server.** `c64_sound` with `op: compile_play` compiles a score
and plays it, and `op: pipeline` also records and analyzes the output. Statements about the `sidwave` command apply
to the command line. The server offers `c64_sound` operations such as `validate`, `lint`, `format`, `compile`,
`convert`, `compose`, `complete` and `reconstruct`. Paragraphs introduced by **c64bridge** describe the server.

LLM → SIDWave (YAML) → MCP compiler → PRG or PSID → C64 / Ultimate / VICE playback

<!-- after: ## Generated pieces -->
**c64bridge.** `c64_sound` with `op: generate` plays a seeded eight-bar piece once and returns
a short summary and the resource URI for a bundled example in the chosen style.
Set `includeScore: true` to receive the generated SIDWave source and lead timeline.
Like `play_preset`, it loads the song as a PRG with its own player,
which replaces the program in memory. The styles are `chiptune` (130 BPM, speed 2), `ambient`
(80 BPM) and `funk` (105 BPM). Use `seed` to reproduce the harmony and melody.

`root` sets the tonic and lead register. An explicit `pattern` repeats semitone
offsets relative to that root. `steps` sets the number of lead notes and
`tempoMs` sets their spacing with `preset: classic`. The `expression` preset
uses varied phrasing and retains its 250, 180, 180 and 400 ms timing cycle when
you customize the lead length, pattern or spacing. The accompaniment then runs
to the end of the final bar. `waveform` overrides the lead sound, and `system`
sets the score timing to PAL or NTSC. By default, timing follows the machine.

`op: generate` uses composer 1. `op: compose` writes a composer 2 score without playing it.

The next paragraph describes the command line.

<!-- after: ### Playback setup -->
**c64bridge.** On Ultimate backends, `compile_play`, `pipeline`, `play_preset`, `generate` and `play` (for music
that it compiles to a SIDWave PRG)
start a SIDWave PRG without a reset when BASIC is idle at `READY.` or the
SIDWave player owns the IRQ and the keyboard queue is idle. The server detaches
the previous player, clears the SID registers, DMA-writes the PRG body, and
queues a BASIC `SYS` command. Other machine states use the normal PRG runner.

The capture harness at `scripts/sidwave-hil.mjs` in the c64bridge repository uses the same launcher.
It starts recording before launching the score so the capture includes startup.

These operations accept `configure: true`. On supported Ultimate firmware,
the server snapshots the SID addressing, sockets, mixer, and UltiSID stores in
memory. It clears the old SID windows before changing the map and clears the
new windows afterward. It restores the changed settings when playback stops,
is replaced, the machine resets, or the active backend switches. A dry run
leaves the device alone.

With `configure: true`, the `ultisid8` layouts disable mirroring and split both UltiSIDs with `1/4 (A7,A8)`. The
bases are `$D400` and `$D420`. The layouts map and enable the required sockets at `$D440` and `$D460`. For explicit
maps, the server can configure subsets of those windows and maps using up to four unsplit decoders. Other maps
require manual setup. For `cpu: turbo`, the server snapshots the turbo settings store and selects the registers mode
advertised by firmware. Without `configure`, the playback result lists the needed device settings.
[Owner configurations](../ultimate/multisid.md#owner-configurations-and-settings),
[Ultimate turbo registers](../ultimate/hardware.md)

VICE playback through the server automatically sets and restores `SidStereo` and `Sid2AddressStart` through
`Sid8AddressStart` using the Binary Monitor. These are the resources for the VICE 3.10 options `-sidextra` and
`-sid2address` through `-sid8address`.

The rest of this section describes the command line and the device settings that apply to both.

<!-- after: ### CIA2 volume digis -->
**c64bridge.** Never send raw PCM through tool arguments beyond a few hundred samples. A `file:` source read by the
server follows the [host path and size rules](../../doc/hardening-behavior.md) in place of the command line's
`--allow-dir` rule.

To preview a sample, use `c64_sound` with `op: sample_render` and optional `definition`,
`rate` and `outputDir`. It defaults to a kick at 4,000 Hz and writes its
quantized output as a mono WAV under `artifacts/samples`. Pass its returned
`outputPath` as `wavPath` to `c64_sound` with `op: analyze` to analyze the file
without recording from a device.

<!-- after: ## Playable examples -->
**c64bridge.** Open the [composition index](c64://sound/examples) and use the names with `c64_sound` `play_preset`.
The result includes the resource URI and a short summary. Set `includeScore: true`
to include the YAML in the result. Each original YAML has a technique and form
guide in its header. `wall_of_sid` needs `configure: true` and a fitted SID in socket 1.

The `sidwave examples` command below is the command line equivalent.
