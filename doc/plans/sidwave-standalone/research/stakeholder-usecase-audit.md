# SIDWave use-case, conversion, quality and usability audit (2026-11-27)

Basis: `origin/main` of the sidwave repo (after PR 19), branches feat/analyze-preserve, feat/perf, feat/sound-effects (partly merged as #10), feat/reconstruct-corpus, worktrees sidwave-formats1 (SWM, traces) and sidwave-formats2 (CheeseCutter, WIP), and c64bridge `src/tools/registry/sound.ts`. Read-only audit; nothing was run beyond reading code and docs, so timings below are the documented ones in `doc/performance.md` (branch feat/perf), not new measurements.

## 1. Summary

1. **No `sidwave convert` exists.** `import` auto-detects its input (`detect(file, bytes)`) and writes a score YAML. `export` picks the target from the `-o` extension or `--format`, and reads only a SIDWave score. Anything to anything is therefore two commands plus an intermediate YAML, and there is no combined loss report. A `.sid` can only enter through `reconstruct` (score YAML on stdout), and there is no `.sid` to MIDI command.
2. **Importers and exporters are symmetric only for four formats on main:** MIDI, MusicXML, GoatTracker (1/2), Furnace. SID-Wizard (+ VICE/siddump traces) is on a local branch, CheeseCutter on another, SF2, DMF, MUS, MOD/XM/IT, ABC, LilyPond, BASIC DATA and assembler-include export are missing.
3. **Developer outputs are strong but incomplete:** game build with symbols for ACME, KickAssembler, ca65, VICE, JSON and measured cycles exists; 64tass symbol/include output, an assembler-source include of the data, and a relocatable player blob are missing. Sound effects are in the language (SIDWave 1.4), with no runtime API for other 6502 code beyond the symbols.
4. **Several library-only capabilities have no CLI:** transform (transpose, tempo, substitute, quantise), format, diff, merge, autonomous compose, retarget is CLI. These are UC04/UC22 gaps for non-programmers.
5. **No play or preview command.** Live audition through VICE or the U64 is only possible through the c64bridge MCP `compile_play` op.
6. **MCP `c64_sound` exposes none of the new sidwave capabilities** (ops: sample_render, capture_samples, set_volume, reset, note_on, note_off, silence_all, play_sid_file, play_mod_file, generate, compile_play, play_preset, pipeline, analyze, record_analyze). S9 must add import/export/convert, reconstruct, retarget, verify, analyze, complete, transform.
7. **Quality measurement is strongest for reconstruct (strict F-diff) and verify (T0/T1/A0/A1) and weakest for the importers**, which report quantisation error and counts but never compare the audio of the result with the source. Furnace has no external oracle at all.
8. **Performance** is documented and budgeted for compile, verify and analysis. Importers have only a bound test (`BOUND_SECONDS`), not documented budgets. No CLI progress output.

Open items: (a) SF2 and CheeseCutter licence (GPL-2.0-only possible) and the SF2 layout source question from the survey; (b) whether W5 lifts are worth XL effort versus fallback reconstruct; (c) the sidwave-formats worktrees are behind main (formats1: 3 ahead/2 behind, formats2: 2 ahead/1 behind) and need rebase before PR; (d) the UC statuses below were read from code and not executed, so some "implemented" marks need the ledger evidence; (e) whether `convert` should accept `.sid` as a source by calling reconstruct (slow, approximate), decided below as opt-in.

## 2. Stakeholder use cases

Legend: Cur = current support (main / branch / missing).

### Chip musicians
| Goal | UC | Cur | Gap |
|---|---|---|---|
| Move a GoatTracker song into SIDWave to edit as text | UC09 | `import` .sng (GT1/2, main) | Pattern commands other than tempo are lost (counted); no .ins instrument import |
| Send a SIDWave song to GoatTracker | UC15 | `export --format goattracker` (first SID, 3 voices; gt2reloc differential) | multi-SID, instruments exchange |
| Use SID-Wizard | UC09 | branch feat/formats-trace-swm: swm/sws/swi import, swm/swi export | not on main; needs rebase |
| Use SID Factory II / CheeseCutter | UC09 | CT: formats2 WIP; SF2 missing (W3) | licence open item; SF2 largest popularity |
| Use Furnace / DefleMask | UC09 | Furnace main; .dmf missing (W6) | Furnace has no real-program check |
| Share instruments between trackers and libraries | UC10/23 | extract-instruments (analyze branch) to library YAML; .swi in formats1 | no .ins (GT), no GT/SF2 instrument import-export, no instrument browser |
| Hear edits instantly | new | `compile_play` via MCP only | no `play`, `preview`, `watch` |
| Fix a tune's tempo/transposition | UC04 | library only | CLI `transform` |

### Composers from DAW or notation
| Goal | UC | Cur | Gap |
|---|---|---|---|
| Import MIDI with 3-voice reduction | UC08 | `import` MIDI (skyline, bass rule, drums, quantise, report) | no tempo-map-aware multi-tempo fidelity score; no velocity curve choice; no voice-allocation preview |
| MusicXML in/out (MuseScore, Dorico) | UC08 | main | repeats, grace notes, key signatures not imported (reported); `.mxl` compressed absent |
| MuseScore native `.mscz`, LilyPond, ABC | new | missing (ABC W9; LilyPond and mscz not planned) | ABC small; LilyPond export is a useful "engraving" target; mscz: reject, use MusicXML |
| Get a MIDI back to arrange in a DAW with stems | UC15 | `export midi --bend`, `render --stems` | no per-voice MIDI files, no tempo/loop markers |
| Audio to score | UC07 | missing (S8) | whole stage |

### Game and demo developers
| Goal | UC | Cur | Gap |
|---|---|---|---|
| Player at chosen address, no KERNAL, symbols | UC17 | `compile --target game`; symbols acme/kickass/ca65/vice/json; measured cycles | 64tass symbols, `.inc` with `.byte` data, single self-contained include |
| Zero-page and cycle budgets | UC20 | `--zp`, measured cycles per play call; retarget budgets | no budget gate (`--max-cycles`) exit code in game build; no per-voice cost report |
| Sound effects over music, priority | UC18 | language 1.4 effects (#10) | no documented 6502 call API summary per assembler, no effect-only build |
| Multispeed, PAL/NTSC | UC19 | retarget; songs | multispeed tested in effects; no CLI `--speed` on `compile` |
| Relocation of an existing .sid | new | missing | relocate PSID/RSID player (needs reconstruct or driver knowledge); realistic only for SIDWave-built SIDs |
| Edit/convert existing .sid for use in game | new | reconstruct then compile (verify) | slow multi-step; per-tune verdicts |

### Preservationists and HVSC curators
| Goal | UC | Cur | Gap |
|---|---|---|---|
| Read PSID/RSID headers, MD5, Songlengths | UC11 | `sid-info`, `parseSidFile`/`writeSidFile` (byte-identical on 59,886 files), `parseSonglengths` | |
| Bundle with STIL, hashes, rights | UC11 | `preserve` (analyze branch) | not on main |
| Edit header (title/author/released, flags, speed) | new | `writeSidFile` library | no CLI `sid-edit`; no batch, no Songlengths writer; no STIL query by path |
| Verify a re-render equals the original | UC21 | `verify` T0..A1 | |

### Educators, researchers, tool builders
| Goal | UC | Cur | Gap |
|---|---|---|---|
| Learn from decomposition | UC14 | tutorial + lesson scores (#12); `analyze` (branch) | no per-stakeholder quick start; no explainer output for `analyze` |
| Features for MIR | UC12/13 | `reconstruct/features.ts`; `analyze`, `compare` (branch) | feature export to CSV/Parquet, dataset script |
| Library API, JSON schemas | UC24 | subpath exports `./sidwave`, `./compiler`, `./export`; `--json` envelope | no JSON Schema for events/loss reports in the package; no single `convert()` function; `index.ts` does not re-export interchange |

### LLM agents (MCP) and hardware users
| Goal | UC | Cur | Gap |
|---|---|---|---|
| Agent converts, verifies, retargets | UC24 | `c64_sound` lists only legacy ops | add ops (W19) |
| Play result on U64/C64U/U2 | UC17 | `play_sid_file`, `compile_play` | no round trip "convert then play then compare" |
| 6581 vs 8580, SID count, SIDFX, ARMSID/FPGASID, multi-SID | UC19 | `retarget` (clock, model, SID count, budgets) | no SIDFX/ARMSID/FPGASID profile (filter curve, digi), `--model` absent from `compile`/`convert` |

## 3. Conversion matrix

D direct, S via score (import then export), P planned (W-package), M missing, R rejected. "Score" = SIDWave YAML. All S cells need two commands today.

| Source \ Target | .sid | score | MIDI | MusicXML | GT .sng | SWM | SF2 | CT | Furnace | DMF | MUS | MOD/XM/IT | ABC/Ly | WAV | PRG/asm/BASIC | events |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| .sid PSID/RSID | D copy | S reconstruct | S | S | S | S(P branch) | P W3 | P W4 | S | M | M | M | M | D render | M | S |
| Score | D compile | - | D | D | D | P(branch) | P W3 | P(W4 WIP) | D | P W6 | P W7 | R (no SID-less target) | P W9 / M | D render | PRG D; asm include P W9, BASIC P W9 | D |
| MIDI | S compile | D import | - | S | S | S | P | P | S | P | M | R | M | S | S | S |
| MusicXML | S | D | S | - | S | S | P | P | S | P | M | R | M | S | S | S |
| GT .sng | S | D | S | S | -(S) | S | P | P | S | P | M | R | M | S | S | S |
| SWM/SWS/SWI | S | P (branch) | S | S | S | - | P | P | S | P | M | R | M | S | S | S |
| SF2 | M | P W3 | P | P | P | P | - | P | P | P | M | R | M | P | P | P |
| CT | M | P (WIP) | S | S | S | S | P | - | S | P | M | R | M | S | S | S |
| Furnace | S | D | S | S | S | S | P | P | - | P | M | R | M | S | S | S |
| DefleMask .dmf | M | P W6 | P | P | P | P | P | P | P | - | M | R | M | P | P | P |
| Sidplayer .mus | M | P W7 | P | P | P | P | P | P | P | P | - | R | M | P | P | P |
| MOD/XM/IT | M | P W8 | P | P | P | P | P | P | P | P | M | - | M | S | P | P |
| ABC | M | P W9 | P | P | P | P | P | P | P | P | M | R | - | P | P | P |
| LilyPond | M | R (no spec subset, use MusicXML) | | | | | | | | | | | | | | |
| VICE dump / siddump | S via reconstruct (branch formats1, approximate for siddump) | P | S | S | S | S | P | P | S | P | M | R | M | S | S | S |
| WAV / audio | M | P S8 | P S8 | P S8 | P | P | P | P | P | P | M | R | M | - | M | P |
| PRG | M (could wrap: a PSID needs init/play; R unless built by SIDWave) | M | | | | | | | | | | | | | - | |
| Events JSON | R (lossy view, no import by design) | R | R | R | R | R | R | R | R | R | R | R | R | R | R | - |

Rejected reasons: MOD/XM/IT as targets, because they carry sample playback and cannot express SID waveform/filter/ADSR; events JSON import because it would fake a lossless path (doc/interchange.md); LilyPond import because it is a programming language; PRG import because BASIC/ML programs have no score.

**Any-to-any gaps:** (1) no `convert`; (2) `.sid` as a first-class source of every exporter; (3) exports only read scores; (4) exporters share no common "reduce" step: GoatTracker takes 3 voices from SID 0; MIDI keeps all voices; Furnace uses its own limit; (5) no combined loss report.

### Convert hub design (W10)

**CLI.** `sidwave convert <in> [<out>] [--to <fmt>] [--from <fmt>] [--song <n>] [--voices <n>] [--sids <n>] [--model 6581|8580] [--mode PAL|NTSC] [--grid <beats>] [--seconds <s>] [--keep-score <file>] [--report <file>|-] [--strict] [--dry-run] [--force] [--json]`. Target from `--to`, else the `<out>` extension; output default is `<in stem>.<ext>` in the current directory, never overwriting without `--force`. `--from` overrides detection; `--dry-run` prints detection and the planned chain with the expected losses and does not write.

**Registry.** One table in `interchange/registry.ts`: `{ id, extensions[], magic(bytes)->confidence, read?(bytes,opts)->{score, losses[]}, write?(score,opts)->{bytes, losses[]}, caps }`. Existing functions are wrapped, not rewritten. Magic: `PSID`/`RSID`, `MThd`, `GTS!/GTS2/GTS3/GTS4/GTS5`, `FUR` zlib header or `-Furnace module-`, `<score-partwise` / `.mxl` zip, `.swm` header, `.ct` (`CCUTSONG`-style, per survey), `.dmf` `.DelekDefleMask.`, `.mus` (load-address plus Sidplayer voice-length header), `MThd`, WAV `RIFF....WAVE`, VICE dump (text lines `reg value` tabular), siddump (`| Frame |` header), SIDWave YAML (`sidwave:` key). Detection returns candidates with confidence; extension acts only as a tie-breaker. If two candidates score within 0.2 or the best is below 0.6, `convert` exits 3 (`input`) with the candidates and the exact `--from` fix. A wrong extension with a clear magic produces a warning, not an error.

**Chain.** `read -> normalise(score) -> reduce(target caps) -> write`. `.sid` and trace inputs go through reconstruct (opt-in notice: slow, approximate; its F-diff result is part of the report). Score-to-score (YAML) is a plain copy through the writer. Compiled targets (`.sid`, `.prg`, game include) use the compiler.

**Loss accumulation.** Each stage returns `Loss { stage, code, severity: info|approx|lost, count, where?, message }`. The hub concatenates and groups by code. `--strict` exits 1 on any `lost`. The `--json` result is `{ chain: [..], detected: {format,confidence}, losses, metrics, outputs }`. Quality metrics (section 4) are attached when `--verify` is set.

**Exporter needs from the score** (`TargetCaps` and a `ScorePlan` service all exporters share): voice count and SID count limits with a deterministic reduction (rank by `notes x range`, as the MIDI importer does) and reporting of dropped voices; a single tempo map with time-signature map (GT/SWM/CT have one tempo per song: use the median or reject with a loss, ramps become steps); row grid selection (GT export already searches 3 to 12 calls per row, reuse for SWM/CT/SF2); instruments with no target equivalent (map to nearest by waveform/ADSR class, else a default instrument plus loss entry `instrument.unmapped`); loops (restart points); ties and legato; drums; effects (vibrato, slide, arpeggio) mapped to tracker commands when present; the song's clock (PAL/NTSC) and the number of calls per frame (multispeed); samples/digi (lost in every tracker target); pulse/filter modulation tables; text metadata (title, author, copyright).

## 4. Output quality: measurement today and targets

| Path | Measured today | Weak or unmeasured | Target and measurement for W10+ |
|---|---|---|---|
| Score to PRG/SID | T0 against bundled emulator, example tests | none notable | keep |
| `.sid` to score (reconstruct) | strict F-diff per call; corpus verdicts (feat/reconstruct-corpus) | horizon-limited (default seconds), digi/samples | report horizon; target: T1 on the held-out set |
| Score to MIDI/MusicXML | export tests, note/tick exactness | no re-import round-trip metric published | round trip note F1 >= 0.99 (pitch, onset within 1 grid, offset); `losses` equal expected set |
| MIDI/MusicXML to score | quantisation error (max/mean ticks), counts | no audio or note-level agreement with source | note-onset F1 vs source on skyline-reduced reference; mean onset error <= 1/2 grid |
| GT export | differential vs gt2reloc (register trace, aligned) | only hand-authored fixtures | run on every importer's fixture; T1 tolerance stated |
| GT import | tested on one file per version | no differential against GT player on real songs | import then compile vs GT player trace, T1 within frame |
| Furnace | spec-built fixtures, write/read back | no oracle (no Furnace in CI) | cross-check with `furnace` CLI (`-console`/`--output`) if available; else mark "unverified" in the report |
| SWM/CT/SF2/DMF/MUS | planned: tool's own player trace vs SIDWave compile (T0/T1, F-diff) | all new | T1 on all fixtures; SF2 driver-11 exact |
| VICE dump/siddump | fixtures with fur-elise | siddump is approximate | comparison of reconstructed vs dump at F-diff |
| Audio transcription (S8) | none | all | pitch/onset F1 on synthetic SID renders (known ground truth); A1 of re-render |
| Convert hub | none | combined | for each importer x exporter fixture pair: re-import the exported file and compare to the intermediate score (note F1 >= 0.97, voice-count-adjusted), plus A1 of both compiles where both compile |

A "quality" field in every convert report: `{ noteF1, onsetErrorTicks, voicesDropped, octaveShifted, instrumentsMapped/unmapped, fdiff?, a1? }`.

## 5. Performance

Documented (feat/perf, median CPU on a loaded 8-core): parse 25-105 ms; compile 185-240 ms; lint 220-310 ms; format 17-72 ms; diff 340-570 ms; merge 110-360 ms; game build with cycle measurement 0.7-2.3 s (`--no-measure` skips); verify A1 30 s: 0.9 s; analysis 0.35-1.7 s; engine render or trace 30 s: 1.45 s; CLI cold start 120-175 ms (`--help`), 0.7-0.85 s (compile). Interactive target (<1 s) is met for all except game build (measured), diff, similarity and long renders.
Unmeasured: MIDI/MusicXML/GT/Furnace import and export CPU time (only an upper bound test), `reconstruct` (traces plus recompile plus F-diff; expected seconds to tens of seconds for 3 minutes; must be benchmarked), `retarget` (optimiser), `compose`/`complete`, `preserve`.
Targets for W-packages: any importer or exporter < 1 s for a typical file (<1 MB), < 3 s for the largest bound input; `convert` overhead < 50 ms over the sum of the stages; reconstruct-based paths show progress and are < 10 s per minute of music or are labelled slow; add each to `scripts/bench-perf.mjs` with a budget and the regression test pattern already used in `performanceBudgets.test.mjs`.

## 6. Ease of use today and gaps (W19)

Found: consistent `--json` envelope and exit codes (good); `import` auto-detects; `export` by extension; refuses to overwrite; `--allow-dir`; `sidwave examples`. Gaps and fixes:
1. No `convert`, `play`, `preview`, `watch`, `info` (detect and describe any file), `formats` (list formats with read/write support and loss summary).
2. Help is one wall of usage text; add `sidwave <cmd> --help` with examples for every command, and `sidwave help <topic>` (quick starts: musician, game developer, preservationist, agent).
3. Flags differ: `-o`/`--output`, `--song` 0-based on compile but 1-based on reconstruct; unify and print the base in help and errors.
4. Errors state the cause but not always the fix (e.g. "cannot tell the format... pass --format" is the right pattern; extend it everywhere, including near-miss suggestions for typos).
5. No progress on slow paths (reconstruct, verify A1, transcribe): stderr progress with `--quiet`, not in `--json`.
6. First run: `sidwave examples` lists scores; add `sidwave init`/`quickstart` that writes a sample score and shows compile, play, convert in three commands; README quick start per stakeholder.
7. Library: `index.ts` does not re-export interchange, effects of subpaths are inconsistent; add `convert()`, `detectFormat()`, `listFormats()` at the root with one TypeDoc/API page.
8. MCP op naming: `compile_play`, `pipeline`, `generate` do not follow verbs of the CLI; add `convert`, `import`, `export`, `verify`, `retarget`, `analyze_sid` with the CLI names and keep old ones as aliases.
9. Defaults: `convert` output name, voice count 3, grid 0.25, PAL, 6581; print them in the result.

## 7. Prioritised work packages (W10 onward)

Priority = value / effort. All build on main unless noted; formats branches must merge first where they are inputs.

| # | Package | Scope | Acceptance (incl. differential and speed) | Touches |
|---|---|---|---|---|
| W10 | Convert hub | `sidwave convert`, format registry and detection, chain, loss accumulation, `--to`, ambiguity refusal, `--dry-run`, library `convert()` | detection test over every fixture and 50 mismatch/ambiguous cases with typed errors; every chain equals the two-step result byte for byte; overhead < 50 ms | main interchange; adopts swm/ct on merge |
| W11 | Conversion test matrix | generated test for every importer x exporter pair on fixtures (corrupt and truncated inputs too); only typed errors; losses listed; note-F1 via re-import; skip when oracle missing | < 60 s total in CI; no untyped exception; losses match golden files | formats1/2, main |
| W12 | Land branches | rebase and merge formats1 (SWM, traces) and formats2 (CT); then W3 SF2 (driver 11 first) after licence decision | SWM/CT: tool-player trace T1; SF2 driver 11 exact on fixtures | formats1, formats2 |
| W13 | Developer integration | `compile --target game --format asm`: `.inc` for 64tass, ACME, KickAssembler, ca65 containing player+data as `.byte`, symbols for 64tass; relocatable build (`--origin` plus `--reloc` table where feasible); sound-effects call-API sheet per assembler and `--effects-only` build | assemble each include with the real assembler (where installed) and run the 6502 emulator: T0 vs the PRG; budget gate `--max-cycles`; build < 1 s with `--no-measure` | main game build, sound-effects |
| W14 | Transform/format/diff/merge CLI | `sidwave transform transpose|tempo|instrument|quantise`, `format`, `diff`, `merge` (git mergetool config) | outputs identical to the library; format idempotent; < 0.6 s | main transform (UC04, UC22) |
| W15 | Live preview | `sidwave play <file>` (local sidplayfp or VICE or U64/C64U via c64bridge, `--target`), `sidwave watch <score>` (recompile and restart on save, show lint), `--loop-section` | latency from save to sound < 1.5 s in VICE; never touches hardware unless `--target u64` is given; stop on exit | c64bridge, main |
| W16 | Instrument exchange | GT `.ins`, SWM `.swi` import/export, SF2 instrument, library browsing (`sidwave instruments list|show|export`) from `extract-instruments` | instrument renders with the tracker player match (T1) for the waveform/ADSR subset | analyze branch |
| W17 | HVSC tooling | `sidwave sid edit` (header fields, flags, speed), `songlengths` (lookup, write, verify against MD5), `stil` (parse, query, attach), batch over a directory | header edit round-trips byte-identical for untouched fields on full HVSC; 60,000-line Songlengths < 250 ms | sidFile, preserve branch |
| W18 | Missing formats | W6 DMF, W7 MUS, W9 ABC/BASIC DATA/asm include, W8 MOD/XM/IT import, LilyPond export | per survey verification classes | survey W-packages |
| W19 | Ease of use | the section 6 list | `--help` examples for each command (tested), `convert` quick start in README, error fix hints covered by a test per error code | all CLI |
| W20 | MCP `c64_sound` coverage | ops: `convert`, `import`, `export`, `verify`, `retarget`, `analyze_sid`, `complete`, `transform`, `reconstruct`, `sid_info`, `play_converted` with host path confinement; skill and resource docs | each op has a schema test and one VICE-backed run; destructive/hardware ops gated by `C64BRIDGE_ACCESS` | c64bridge S9 |
| W21 | Quality and performance gates | metrics from section 4 in convert reports; benchmark entries for all importers/exporters/reconstruct/retarget with budgets | regression test fails on 5x budget; quality thresholds in CI | feat/perf, verify |
| W22 | Multi-SID and hardware profiles | `--sids`, `--model`, SIDFX/ARMSID/FPGASID filter and digi profiles in `convert`/`compile` | differential vs retarget on 2SID/3SID fixtures; hardware smoke test on the U64 only | retarget |

## 8. UC01-UC24 status (read from code)

| UC | Status | Evidence / missing |
|---|---|---|
| 01 manual composition | implemented | validate, compile, lint, examples, tutorial |
| 02 autonomous composition | partial | library generator (`audio/generateSidwave`, compose); no CLI |
| 03 completion | implemented | `sidwave complete` (4 ops, protected checks) |
| 04 transformation | partial | `transform` library only, `retarget` CLI; no transform CLI |
| 05 instrument/sound design | partial | libraries, lock, bundle (main); extraction on branch |
| 06 reconstruction | implemented | `reconstruct`, F-diff; corpus verdicts on branch |
| 07 audio transcription | missing | S8 |
| 08 MIDI/MusicXML import | implemented | import, with documented losses |
| 09 tracker import | partial | GT, Furnace on main; SWM/CT branches; SF2, DMF, MUS, MOD missing |
| 10 instrument extraction | partial | feat/analyze-preserve, not on main |
| 11 preservation | partial | `preserve`, `sid-info` (branch); no STIL/header-edit CLI |
| 12 analysis | partial | `analyze` on branch |
| 13 comparison | partial | `verify` on main, `compare` on branch |
| 14 educational decomposition | partial | tutorial, lesson scores; `analyze` explanation missing |
| 15 render/export | implemented | render, stems, export (5 formats), compile prg/sid |
| 16 executable generation | implemented | compile PRG/PSID |
| 17 application integration | partial | game build with symbols; 64tass, includes, relocation missing |
| 18 interactive music/effects | implemented (language) | effects 1.4, example games; API doc and effects-only build missing |
| 19 hardware retargeting | implemented | retarget (clock, model, SID count, budget) |
| 20 resource optimisation | partial | retarget budgets, perf branch; no game-build budget gate |
| 21 verification | implemented | verify T0 to A1 |
| 22 semantic diff/merge | partial | library only |
| 23 reusable assets | partial | libraries, bundle; instrument exchange missing |
| 24 library and CLI automation | partial | `--json`, exports; no schemas, no `convert`, MCP coverage missing |
