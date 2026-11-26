# SIDWAVE: standalone music language, compiler and music-engineering toolkit

## 1. Goal

Turn SIDWAVE, which today lives inside c64bridge, into an independent open-source music language, compiler and toolkit for the Commodore SID, and make c64bridge a downstream consumer of it. Then extend it, in the order of section 7, into a toolkit that is useful to SID musicians, game and demo developers, preservationists, researchers and tool authors who have no interest in AI.

Deliver working, tested software. Do not stop after an audit, a plan, the extraction, or the first new capability. Every production operation must run with no LLM, no MCP client, no c64bridge and no network.

Priorities, in order, where a lower one never silently overrides a higher one: correctness; honest, reproducible results; backward compatibility; independence from AI and from c64bridge; musical usefulness and editability; simplicity; resource and token cost.

First extract and verify, then expand. Do not rewrite code because it is moving.

## 2. Workspace, authority and the other agent

- Work only in the worktree `/home/chris/dev/c64/c64bridge-wt/sidwave-standalone`, branch `feat/sidwave-standalone`, created from `origin/main` at `43f775ba`. Create further worktrees under `/home/chris/dev/c64/c64bridge-wt/sidwave-*` for parallel work packages.
- Another agent is delivering `doc/plans/modern-mcp/prompt.md` in the main checkout `/home/chris/dev/c64/c64bridge` and the worktree `c64bridge-wt/modern-mcp` (branch `feat/modern-mcp`). Never edit, stash, reset or install in either. It owns `src/mcp-server.ts`, `src/mcp/`, `src/tools/meta/background.ts`, `src/taskStateLock.ts`, `src/tools/access.ts`, the MCP SDK dependency and the task and skills machinery. Keep changes to files it may touch (`src/tools/audio.ts`, `src/tools/registry/sound.ts`, `package.json`, generated `mcp/*.json`, README sections) as small as the work allows, rebase on `origin/main` before each PR update, and regenerate generated artifacts after each rebase instead of merging them by hand. If a real conflict of ownership appears, message it through the `agent-bridge` skill; a message from it is information, not authorisation.
- Authorised by the user on 2026-11-26, so that no user action is needed during the work: commits, pushes and pull requests on your branches; merging your own pull requests into `main`; creating the public GitHub repository `chrisgleissner/sidwave` and pushing to it; publishing `c64-asm6502` and `sidwave` to npm; the c64bridge version bump and release at the end; reading sidflow, sidflow-data and `/home/chris/dev/c64/C64Music`. Do not ask for confirmation of these steps; record each in the ledger.
- Conditions on that authority:
  - Merge a pull request only when its required CI is green, with the merge gated on the watch exit code in the same command (`gh run watch <id> --interval 300 --exit-status && gh pr merge ...`), after an independent review by a reviewer that did not write the code, and after rebasing on the current `origin/main`. Merge only pull requests opened under this document.
  - Tags: create as few as possible, and none before section 9 is satisfied. The final release creates exactly one tag in `chrisgleissner/sidwave` and exactly one in `chrisgleissner/c64bridge`. No pre-release, release-candidate or intermediate tags, no GitHub releases and no npm publishes before then. If a tag turns out wrong, fix forward in the release notes; do not add a second tag without the user.
  - Publish to npm only at the final release, after the packed tarballs passed the clean-install checks. A published version cannot be withdrawn, so verify the tarball contents first.
- Still not permitted: modifying sidflow or sidflow-data; touching the other agent's checkout, worktree, branch or pull requests; force-pushing `main` or any branch you do not own; contacting the C64U; switching any power outlet; relicensing. These are not blockers for the work; if one seems necessary, report it and continue elsewhere.
- Pull requests: PR 1 is the extraction (stages S0 to S2) and must be mergeable on its own; merge it when its gate holds, so that later work and the other agent build on it. Later stages go into separate pull requests, one per stage or coherent capability group, each from its own branch `feat/sidwave-<topic>` off the current `main`. Follow the PR description rules in `~/.claude/CLAUDE.md`. Poll CI at most every five minutes with `gh run watch --interval 300`.
- Hardware: the Ultimate 64 at 192.168.1.13 and VICE only. Never contact the C64U and never switch a power outlet. One hardware session at a time across all agents; ask through `agent-bridge` before starting one. Hardware checks are confirmation at stage gates, not a development loop. If hardware is unavailable, report the hardware gate as unverified.
- Read `AGENTS.md` and `doc/developer.md` before the first edit. Do not use `git stash`.

## 3. Facts established on 2026-11-26

Treat these as the baseline. Do not repeat this research; verify only section 3.6.

### 3.1 State of SIDWAVE in c64bridge 1.3.3

- Language versions 1.0, 1.1, 1.2 and 1.3 (`ParsedSidwave.version`, `src/sidwave.ts:257`; an unsupported value throws at `:350`). 1.3 is a superset of 1.2 and compiles 1.2 documents to the same bytes. Features: up to 10 SIDs and 30 voices, wave, pulse and filter tables, hard restart, sync and ring, echo, unison, follower voices, CIA2 volume digis (PRG only), multispeed 1 to 4, sections, sequences, dynamics, 25 lint codes. Declared unsupported: per-note velocity, multiple subtunes, arbitrary register writes.
- Files: specification `data/sound/sidwave.md` (955 lines), schema `data/sound/sidwave.schema.json`, parser `src/sidwave.ts` (1745), compiler and player generator `src/sidwaveCompiler.ts` (4562; `buildPlayerAsm` at `:2878`), `src/sidwaveDigi.ts`, `sidwavePcm.ts`, `sidwaveForm.ts`, `sidwaveFilterModel.ts`, `sidwaveLint.ts`, `sidwaveExamples.ts`, generator `src/audio/generateSidwave.ts`, `src/audio/sidwaveReference.ts`, `sidwaveSimilarity.ts`, `sidwaveFidelity.ts`, `sidwaveQuality.ts`, and 14 example scores plus `Biosphere.sid` in `data/sound/examples/`.
- Output: PRG (`$0801`, `SYS2061`, CIA 1 timer IRQ, PAL/NTSC detection) and PSID v2, v3 or v4 (init `$0810`, play `$0813`, at most 3 SIDs, primary at `$D400`). No RSID, no relocation, no separate player and data. The player uses `$FB/$FC` and restores them; typical cost is 20 to 65 raster lines, worst case about 155.
- The only third-party runtime dependency of these files is `yaml`.
- Couplings to remove:
  - `sidwaveCompiler.ts:15` imports `assemblyToPrgDetailed` from `src/tools/translation/assembler.ts` (2955 lines; imports only `ioRange.ts`, `petscii.ts` `parseBraceToken`, `opcodeInventory.ts`; no device, MCP or third-party imports). The assembler is also used by `src/c64Client.ts`, `src/tools/programRunners.ts`, `scripts/turbo-bench.mjs` and about nine tests.
  - `sidwavePcm.ts:3` imports `resolveHostPath` and `DEFAULT_MAX_READ_BYTES` from `src/hostPaths.ts` (c64bridge path policy, environment variables); the parser imports `sidwavePcm.ts`.
  - `sidwaveExamples.ts` locates example files relative to `import.meta.url`.
  - `sidwaveReference.ts` spawns the external `sidplayfp` binary and omits CIA2 digis; digi renders use VICE through `scripts/render-sidwave-examples.mjs`.
- Device glue that stays in c64bridge: `src/sidwavePlaybackConfig.ts`, `src/sidwaveUltimateStart.ts`, `src/audio/record_and_analyze_audio.ts`, `scripts/sidwave-hil.mjs`, `scripts/sidwave-record.mjs`, `scripts/lib/ultimateAudioStream.mjs`. `src/c64Client.ts:1408` hard-codes the player's IRQ handler byte pattern and uses `SIDWAVE_PLAY_ADDRESS`; `src/tools/errors.ts:190` matches the error name `SidwaveValidationError` as a string.
- Consumers inside c64bridge: `src/c64Client.ts`, `src/tools/audio.ts`, `src/tools/meta/audio.ts`, `src/tools/registry/sound.ts`, `src/audio/record_and_analyze_audio.ts`, `src/rag/knowledgeIndex.ts`, `src/rag/resourceUris.ts`, `src/rag/indexer.ts`, `src/prompts/registry.ts`. MCP surface: `c64_sound` operations `sample_render`, `generate`, `compile_play`, `play_preset`, `pipeline`, `analyze`, `record_analyze`; resources `c64://sound/sidwave/spec`, `c64://sound/examples` and `c64://sound/examples/<name>`; the skill `.github/skills/sid-music/SKILL.md`. The schema is referenced publicly as `https://raw.githubusercontent.com/chrisgleissner/c64bridge/refs/heads/main/data/sound/sidwave.schema.json`.
- Tests: 45 of 206 `test/*.test.mjs` files cover SIDWAVE, on a runner abstraction (`#test/runner`: `bun:test` under Bun, `node:test` under Node). Byte-hash compatibility tests: `test/sidwaveCompat10.test.mjs`, `test/sidwaveCompat12.test.mjs`; fixtures in `test/fixtures/sidwave-*`; `test/helpers/sidwaveEmulator.mjs` is a self-contained 6502 and PSID emulator. Gates: `npm run check`, `npm run test:node`, `npm run check:node-compat`, `npm run check:package`, `npm run coverage` (90 % lines enforced). CI also renders 13 examples in `Dockerfile.sidwave-render` and the release workflow attaches them.
- Package: `c64bridge` 1.3.3, GPL-2.0-only, ESM, `engines.node >=24`, `packageManager bun@1.3.1`, no workspaces today.
- Known open items: `stereo_echo` fails raw hardware comparison without sample-clock calibration; `wall_of_sid` has no single-model reference; the hardware comparison accepts a uniformly shifted capture; no human listening sign-off exists.

### 3.2 Target names

- `github.com/chrisgleissner/sidwave` does not exist. The npm name `sidwave` is free. `asm6502` is taken on npm; `c64-asm6502` is free.

### 3.3 sidflow (HEAD `e6ec6b4`, v0.8.4, GPL-2.0-only, Bun 1.4.4)

- `libsidplayfp-wasm` is published on npm (1.1.1, GPL-2.0-or-later, Node >= 20, about 360 KB of WASM per engine, no native dependencies). It wraps libsidplayfp 3.1.1 with reSIDfp or SIDLite. API: `SidAudioEngine` with `loadSidBuffer`, `renderSeconds`, `render(cycles)`, `selectSong`, `getTuneInfo`, `getTuneMd5`, `setSystemROMs`, and a cycle-exact SID write trace (`setSidWriteTraceEnabled`, records `{sidNumber, address, value, cyclePhi1}`, packed `Float64Array` form, buffer capped at 2^20 records with a dropped-record counter). The hook is a null function pointer when tracing is off, so the audio path is unchanged. It ships no ROMs; without KERNAL, BASIC and CHARGEN some tunes initialise and never advance.
- Pure and reusable: `packages/sidflow-classify/src/sid-register-trace.ts` (390 lines; register decoding; its frame compaction keeps only the last value per register per frame and is therefore not suitable for reconstruction) and `sid-tonal-features.ts` (539 lines). `packages/sidflow-common/src/sid-parser.ts` and `songlengths.ts` are small references. Unsuitable: `essentia-features.ts`, the render orchestrator, the similarity export, station-quality scripts. `scripts/rom-audit/pcm-parity.ts` and `doc/research/hvsc-rom-production.md:40-58` document engineering thresholds for audible differences (21.3 ms windows, 15 % spectral distance above -60 dBFS, two consecutive or three total windows); these are starting points for calibration, not validated thresholds.
- Register traces come from CPU emulation and are the same for both SID engines. reSIDfp is the accurate engine and is about six times slower than SIDLite.
- About 3 % of HVSC subtunes change execution when KERNAL or BASIC is absent. c64bridge's render image already pins MEGA65 Open ROMs by commit and SHA-256.
- sidflow-data release `1.0.0` (GPL-3.0 data; GitHub release assets with manifests and `SHA256SUMS`): per-tune features as `sidcorr-hvsc-full-features-1.jsonl.gz` (76 MB, 58 dimensions, HVSC 85). Consume it as data at benchmark time only; do not copy GPL-3.0 material into the package.
- Local HVSC: `/home/chris/dev/c64/C64Music` (59,886 `.sid` files, `DOCUMENTS/SID_file_format.txt`, `Songlengths.md5`, `STIL.txt`). Its release differs from the one sidflow-data describes; pin tunes by MD5 and path, not by release number.

### 3.4 SID file format

Authoritative text: `C64Music/DOCUMENTS/SID_file_format.txt`. PSID and RSID versions 1 to 4; v2NG adds `flags` (clock, SID model), `startPage` and `pageLength` (free pages for relocation); v3 and v4 add one-byte second and third SID addresses. At most three SIDs. RSID requires play address 0, speed 0, load address at or above `$07E8`, and a real C64 environment.

### 3.5 Existing tools and the gap

- Trackers in use: GoatTracker 2.77 (`.sng` and `.ins` documented in its readme; ships `gt2reloc`), SID Factory II (active; `.sf2` layout is driver-defined), SID-Wizard (`.swm`), CheeseCutter (`.ct`), Furnace (`.fur`, documented in `papers/format.md`, may be zlib-compressed, has a C64 system).
- Conversion and analysis: `siddump` (per-frame register dump), SIDId and Player-ID (player signatures), desidulate (register log to MIDI and instrument fragments), `sid2sng` (GoatTracker tunes only), ChiptuneSAK. Text languages: Gakuon, XPMCK, generic MML.
- Gap that SIDWAVE can fill: none of these reconstructs an editable, structured score (instruments, tables, patterns, sections, loop) that recompiles and is verified against the original register trace; none combines a text language with relocatable game integration, sound effects and measured raster cost.
- Candidate libraries: `@spotify/basic-pitch` (Apache-2.0, TypeScript), `midi-file` and `@tonejs/midi` (MIT), `fast-xml-parser` (MIT). Essentia.js is AGPL-3.0 and must not become a dependency. ffmpeg is used only as an external process.

### 3.6 Open items to verify first (one research package, at most 500 words returned)

1. That `libsidplayfp-wasm` 1.1.1 from npm exposes the trace API and reSIDfp under Node, and the licences in its tarball.
2. Licences and redistributable example songs of GoatTracker 2 and Furnace, from their repositories.
3. Upstream licence texts of libsidplayfp, reSIDfp and any library before it is added.
4. The exact PSID header offsets against the local specification text.

## 4. Decisions already made

- **Shape of the extraction.** Do it in two steps so that every commit keeps c64bridge buildable and CI green without an unpublished external dependency. Step one: npm and Bun workspaces inside c64bridge with `packages/sidwave` (package `sidwave`) and `packages/asm6502` (package `c64-asm6502`). Step two: `scripts/split-sidwave-repo.sh` produces the standalone repository at `/home/chris/dev/c64/sidwave` with `git filter-repo`, preserving history and authorship of the moved files, and proves that it builds, tests and packs alone. The workspace stays the single source of truth until the final release in S9; the script is rerunnable. While `sidwave` is unpublished, c64bridge's own tarball carries both packages as `bundleDependencies`; `npm pack`, a clean install of that tarball and `check:package` must pass with no workspace symlinks and no absolute paths.
- **Assembler.** Move the assembler and exactly the modules it imports into `packages/asm6502`. `sidwave` and c64bridge both depend on it; c64bridge's general assembly does not depend on `sidwave`. No second copy remains in `src/`. Prove byte-identical output for the assembler test corpus and for every SIDWAVE artifact.
- **Boundary.** `sidwave` owns the specification, schema, parser, lint, compiler, player, digi and PCM code, generator, examples, reference rendering, similarity, fidelity and quality analysis, and everything added in section 7. It never imports from c64bridge and never opens a device. c64bridge keeps device configuration, deployment, capture, hardware comparison scripts and MCP translation, and imports only documented `sidwave` exports. Replace the two ABI couplings with exported player metadata (`playAddress`, `initAddress`, IRQ handler signature, zero-page use) and keep the error class name `SidwaveValidationError`.
- **Host files.** `sidwave` library functions take bytes or a caller-supplied reader. c64bridge passes a reader that applies `resolveHostPath`; the CLI passes one confined to the working directory unless told otherwise.
- **Compile result.** One typed result for all consumers: bytes, format, load, init and play addresses, memory range, SID count, addresses and models, clock, play rate, interrupt and zero-page use, measured CPU cycles per call (average and worst, measured on the bundled 6502 emulator), stream and player sizes, lint, diagnostics. Mark each number as measured or estimated.
- **Specification and schema.** The canonical files live in `packages/sidwave`. The canonical specification is tool-neutral; c64bridge appends its short MCP usage section when it serves `c64://sound/sidwave/spec`. `data/sound/sidwave.schema.json` stays at its public URL as a generated copy with a CI drift check. All existing resource URIs, operation names and result fields remain.
- **Versions.** Language version and package version are independent. Language 1.0 to 1.3 keep their bytes. New constructs are accepted only under a new language version (`1.4` onwards), following the 1.3 rule: a superset that compiles older documents to identical bytes and rejects new fields in older documents by name. The `sidwave` package starts at `0.x` and reaches `1.0.0` when the public API is frozen at the final gate.
- **Runtime.** TypeScript, ESM, Node and Bun, explicit `exports`, compiled JavaScript with declarations. Core dependencies: `yaml` and `c64-asm6502` only. Rendering and tracing use `libsidplayfp-wasm` as an optional dependency behind an engine interface (`render`, `trace`); the existing `sidplayfp` and VICE paths become further implementations of that interface. Heavy features (audio transcription) load optional dependencies on demand and are never needed for parsing, compiling or composing.
- **Licence.** Keep GPL-2.0-only for code. Do not relicense and do not grant an exception. Write `doc/licensing.md` in the package: what the generated player code in a compiled SID or PRG means for musicians and game developers, the option of a runtime exception for the player with a recommendation, and the dependency licences. A runtime exception is the one decision left to the user; it does not block any stage or the release.
- **Verification ladder.** Compare register traces first and audio second. Levels: T0 identical register writes per player call; T1 identical writes within a stated cycle tolerance; A0 bit-identical PCM under a pinned engine; A1 a calibrated, time-localised audio profile. A result names the highest level reached and its observation horizon. One global similarity score is never an acceptance criterion.
- **Reconstruction bound.** Reconstruction targets tunes whose observable behaviour is a sequence of register writes at a detectable player call rate. Sample playback, sub-call timing and anything else the language cannot express is reported as unsupported with the measured evidence, and becomes a candidate for a language extension under section 6. Replaying the register trace as data is not a reconstruction.
- **Importers.** GoatTracker `.sng` and Furnace `.fur` are the two tracker formats. Verify the GoatTracker importer differentially: `gt2reloc` output and the imported, recompiled score must agree on the verification ladder.
- **MCP exposure.** New capabilities appear as operations of the existing `c64_sound` group, with file artifacts and compact summaries. No new top-level tool unless a measured ambiguity requires it. c64bridge supplies connected-device facts (clock, SID count, models, addresses) as target parameters.
- **Positioning.** A music language and toolkit. AI assistance and c64bridge are optional integrations and are described as such.

## 5. Team and cost

- The session model orchestrates: decisions, dependency graph, integration, acceptance. It writes little code.
- Sonnet subagents supervise one work package each. They delegate bounded edits to Haiku subagents or to `codex exec -m gpt-6-luna -C <worktree> -s workspace-write "<task>"`, then review and verify the result themselves. Use the top-tier model at high effort only for the public API, the language extension designs, the verification calibration and the final review. Reviewers do not review code they wrote.
- At most three workers at a time, one writer per file, one worktree per worker. Never run two dependency installs, generators or hardware sessions concurrently.
- Each brief states the objective, paths, the applicable decisions, the write scope, the acceptance tests and the output format, and asks for at most 500 words: outcome, changed files, tests run, open risks. Do not forward this document.
- Tools report failures as compact records (category, first differing call or time, SID and voice, expected, observed, source location). Full traces, audio and logs stay on disk under `~/.c64bridge/sidwave-standalone/` and are never loaded whole into a model context. An insight that fixes a benchmark failure becomes general code and a regression test.

## 6. Rules for all stages

- **No shortcuts.** No hard-coded songs, song-specific exceptions, hand-repaired outputs presented as automatic, embedded original executables or recordings, thresholds tuned per case, silently shortened observation horizons, or skipped tests reported as passed.
- **Language extensions.** Add a construct only with: an observed unmet need and a minimal reproducer; evidence that existing constructs cannot express it; the chosen design and one rejected alternative; specification text, schema, parser, compiler, tests at boundaries and in combination; measured player cost; and proof that older versions compile unchanged. Prefer few orthogonal constructs. Do not extend the language to hide a compiler defect. Likely candidates, each still subject to this rule: exact frequency values and free tuning, subtunes, intro and loop separation, independently timed gate and envelope control, sound-effect sequences, references to external assets.
- **Editability.** A reconstructed or imported score must survive automatic edit tests: change one note, swap an instrument, transpose a section, change the tempo, reuse an extracted instrument in a new score. Each test checks the intended change and that unrelated voices and sections keep their register output.
- **Untrusted input.** Bound file size, parse depth, decompression, emulated cycles, trace size and wall time for every external input. No external XML entities, no path traversal through asset references or archives, no remote fetching by default, no mutation of input files.
- **Determinism.** Seeds, pinned engine versions and content-addressed caches whose keys include every input that affects the result. Cached and uncached runs must agree.
- **Evidence.** Keep `doc/plans/sidwave-standalone/STATE.md` (current stage, decisions, disproven hypotheses, next action) and `evidence/ledger.jsonl` (claim, requirement, revision, command, result, artifact path, limits). `sidwave bench --verify` recomputes the claims and exits nonzero on a missing, stale or failing one. A fresh agent must be able to resume from `STATE.md` without repeating work. Never fabricate a measurement; report what was not run.
- **Status vocabulary** for every capability and gate: not implemented, implemented but unverified, verified within declared bounds, approximate, blocked, unsupported, failed.
- **Blockers.** Record evidence and the affected requirements, continue with independent work, and do not loop on an unchanged experiment. A difficult valid input is not an environmental blocker.

## 7. Stages

Each stage ends with the repository buildable, all existing gates green, and its evidence in the ledger.

### S0 Baseline (before any move)

Commit a script that records, for every example, every fixture and every generator style with fixed seeds: SHA-256 of PRG and PSID bytes, lint output, compile metadata, and the `sidplayfp` reference render hash where deterministic. Record the MCP tool schemas, resource list, test totals on Bun and Node, package contents, startup time and coverage. Resolve section 3.6. Note pre-existing failures separately.

### S1 Isolation and packages

Introduce the two workspace packages, move the code with `git mv`, break the couplings listed in 3.1, move the SIDWAVE tests and the emulator helper, and switch every c64bridge consumer to public `sidwave` exports. Keep the diff free of behaviour changes.

### S2 Extraction gate and standalone repository (PR 1)

Required: baseline hashes identical; MCP tool schemas and resources unchanged apart from intended additions; `sidwave` builds, tests and packs without the rest of the repository; a clean consumer project installs the tarballs and compiles a score on Node and on Bun; no import from c64bridge in either package (enforced by a test); no duplicate implementation; c64bridge gates, coverage, package check and example render green; VICE playback checked; one U64 playback and capture check, or the gate reported as unverified. Add a minimal CLI (`sidwave validate | compile | lint | examples`) and the split script with its local proof. Merge PR 1 under the conditions of section 2. Do not tag, publish or create the `sidwave` GitHub repository yet; c64bridge keeps `bundleDependencies` until S9.

### S3 Foundation

- SID file module: read and write PSID and RSID v1 to v4 with validation against the specification, Songlengths lookup, subtune handling.
- Engine interface with `libsidplayfp-wasm`: PCM render and complete cycle-exact write traces from initialisation, bounded and streamed so that the 2^20 record cap cannot drop data unnoticed; ROM provisioning documented and offline. Prove that tracing does not change the rendered audio.
- Verification ladder (`sidwave verify`), with calibration: mutations at several severities (wrong, missing and extra notes, octave errors, detune, timing shifts, tempo drift, gate, envelope, waveform, pulse, filter, sync and ring changes, missing percussion, sound in silence, section and loop errors, one short defect in a long tune) and benign controls. Freeze decision rules before evaluating held-out cases and report false accept and false reject rates. An uncalibrated profile is reported as unvalidated.
- CLI and typed API parity: every operation is a library function; the CLI and MCP only translate. Machine-readable output, stable error categories, exit codes that separate operational failure from a failed verdict, cancellation, progress, resource budgets.

### S4 Authoring and integration (UC01, UC04, UC16 to UC20, UC22, UC23)

- Canonical formatter and stable serialisation; semantic diff that separates formatting, musical, synthesis, hardware and structural changes; three-way merge that refuses conflicting musical edits.
- Deterministic transformations with stated preconditions and preserved invariants: transpose, tempo, instrument substitution, quantise, restructure, bounded humanise.
- Game and demo integration: relocatable player, separate player and music data, PSID `startPage` and `pageLength`, entry points and symbols for common assemblers, register and zero-page contract, measured worst-case cycles; subtunes; sound effects with priorities, voice reservation and stealing, restoration of the interrupted voice, bounded trigger latency, tested with adversarial event sequences. Provide two verified example programs that play music and effects next to raster activity.
- Retargeting across PAL and NTSC, 6581 and 8580, and SID counts, with measured compromises; resource optimisation that never changes the music without saying so and reports infeasible budgets.
- Reusable assets: local and packaged libraries of instruments, patterns and effects with namespaces, content hashes, version pins, cycle detection, licence and provenance fields, and an offline bundle of the full dependency closure.
- Example scores from elementary to advanced, written for human authors.

### S5 Reconstruction, analysis and preservation (UC06, UC10 to UC14, UC21)

- Pipeline: complete trace; call-rate and player-cadence detection; analytical recovery of frequencies, gates, envelopes, waveforms, pulse and filter sequences; note and instrument segmentation; table and pattern recovery by repetition analysis and description-length comparison; loop and section detection; emission of canonical SIDWAVE; compilation with the production compiler; verification; diagnosis of the earliest material difference by root-cause class; bounded local repair; abstraction and compaction only after fidelity holds.
- Every optimiser declares its search space, objective order, seed, work budget, stagnation rule and resume behaviour. Prefer analytical solutions, then constraint solving, then bounded search.
- Corpus: 30 demanding, diverse HVSC subtunes chosen by a deterministic coverage procedure over sidflow-data features and raw traces (models, clocks, PSID and RSID, multi-SID, multispeed, table-heavy players, sync, ring, filter routing, percussion, intro and loop). 24 for development, 6 held out, related tunes grouped. Freeze the manifest before tuning. Add independently written synthetic feature fixtures and seeded round-trip property tests (generate a score, compile, trace, reconstruct, compare). Held-out results are recorded once; after any tuning on them, draw new held-out cases.
- Each tune gets an individual verdict on the ladder with residual differences; a valid failing tune stays a failure. Group failures by general cause and fix causes, not tunes.
- Instrument extraction with reuse tests; structural analysis reports (key, metre, form, motifs, voice use, techniques, resources) with observed and inferred facts kept apart; score and tune comparison; diagnostic voice isolation, labelled as non-additive where filter, sync or ring couple voices.
- Preservation bundle: score, source checksum and subtune, reference configuration, engine and compiler identities, observation horizon, verdict, known ambiguities, rights fields, in a documented manifest that verifies offline and never includes the original where redistribution is not permitted.

### S6 Interchange (UC08, UC09, UC15)

Standard MIDI File import and export (tracks, tempo map, time signatures, pitch bend, velocity where mapped), MusicXML import and export (uncompressed first), WAV and stem rendering, structured event export, and the two tracker importers. Document each mapping and its losses; verify outputs with an independent parser; do not embed source files to fake a lossless round trip.

### S7 Composition and completion (UC02, UC03)

Extend the seeded generator with form, harmony, melody, counterpoint, motif development, rhythm and instrumentation under hardware constraints; add continuation, harmonisation, accompaniment and missing-section completion that leave protected material byte-identical in its register output. Existing seeds and styles keep their bytes; new behaviour is opt-in. Evaluate at least 30 profiles with held-out seeds against the current generator on technical correctness, lint, structure and variation measures. Make no claim of artistic quality from proxy measures.

### S8 Audio transcription (UC07)

Optional module. Benchmark candidate transcription back ends on licensed recordings with symbolic ground truth before choosing; pin versions and model checksums; provide offline provisioning. Report transcription accuracy separately from the losses of arranging for SID voices (voice allocation by melodic, bass, harmonic and rhythmic importance; reduction and arpeggiation). Recognised SID files go to S5. If no candidate meets a preregistered baseline, deliver the measurements and mark the capability approximate or blocked.

### S9 c64bridge integration, documentation and final verification

- Expose the mature capabilities through `c64_sound` operations and update the `sid-music` skill. Demonstrate three workflows end to end: compose, compile, deploy to VICE and the U64, capture, verify; reconstruct a SID, verify, transform, deploy; build game music with effects, check budgets, run inside an example program.
- Documentation in the package: README and quick start for musicians, language tutorial, instrument design, game integration, reconstruction, preservation, API and CLI reference, hardware matrix, licensing, migration notes. A C64 musician must be able to install, write, compile and play without reading about MCP or AI.
- Offline proof: run every capability with the network disabled, no AI credentials and no MCP client, after provisioning optional dependencies.
- Independent consumer: a small program outside the repository that uses only the published API.
- Freeze the public API, rerun `sidwave bench --verify`, refresh the standalone repository with the split script.
- Final release, once, after everything above holds and all stage pull requests are merged:
  1. Create the public repository `chrisgleissner/sidwave`, push the split history, and wait for its CI to pass.
  2. Publish `c64-asm6502` and then `sidwave` 1.0.0 to npm from verified tarballs; create the single `sidwave` tag on the published commit.
  3. In c64bridge, replace the workspace packages and `bundleDependencies` with the registry dependencies, remove `packages/`, and prove baseline hashes, gates, package check and clean install again in one pull request. From then on the `sidwave` repository is the single source of truth.
  4. Bump the c64bridge version (a minor release) following the pre-tag checklist in the project memory `project_1_1_1_progress.md`, merge on green CI, confirm `main` CI is green, and create the single c64bridge tag; the release workflow publishes npm and the MCP registry entry. Verify the published packages by clean install and replace the generated release body with curated notes.
  If a step fails after a publish, stop tagging, fix forward and report; never reuse or move a tag.

## 8. Out of scope

A graphical tracker, DAW or notation editor; a hosted service or registry; a game engine; an emulator of its own; model training; changes to sidflow; the MCP protocol, Skills and Tasks work of the other agent; unrelated refactoring and dependency upgrades in c64bridge.

## 9. Done

The work is complete when all stage pull requests are merged on green CI, the final release of S9 is published and verified with one tag per repository, and the final report states, for every capability UC01 to UC24 and every stage gate, one status from section 6 with its ledger evidence. The report also contains: revisions, package layout and dependency graph, baseline and post-extraction comparison, language extensions with their evidence, the selected HVSC subtunes with per-tune verdicts and first-pass held-out results, calibration error rates, importer losses, measured player costs, the offline proof, failed, skipped and blocked items, every merge, publish and tag performed, the one open user decision (runtime licence exception), and the commands that reproduce each claim.

If something cannot be finished, deliver the best verified state and say exactly which requirement is unmet and why. Do not report completion that the evidence does not support.

## Appendix: capability index

UC01 manual composition; UC02 autonomous composition; UC03 completion and accompaniment; UC04 transformation; UC05 instrument and sound design (S4 assets and S5 extraction); UC06 SID reconstruction; UC07 audio transcription; UC08 MIDI and MusicXML import; UC09 tracker import; UC10 instrument extraction; UC11 preservation bundles; UC12 analysis; UC13 comparison; UC14 educational decomposition; UC15 rendering and export; UC16 executable generation; UC17 application integration; UC18 interactive music and effects; UC19 hardware retargeting; UC20 resource optimisation; UC21 verification; UC22 semantic diff and merge; UC23 reusable assets; UC24 library and CLI automation (S3, all stages).
