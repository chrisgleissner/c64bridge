# Changelog




## 1.0.6 - 2026-10-15

### Bug Fixes

- drop blank and comment-only lines from the merged coverage report (cfb9d9c)
- round SIDWAVE vibrato and reject vibrato above the frequency range (a983e8a)
- avoid early VICE mount completion and accept empty disks (bfcfd29)
- show SIDWAVE compiler warnings and free BASIC memory in tool results (cee8102)
- zero-fill reserved space that overlaps emitted bytes (629db1a)
- detect VICE autoload completion from machine state and keep the record of the first mount (fe0eb36)
- correct SIDWAVE filter, slide and vibrato ranges, ties across sections and BASIC after the PRG (1787715)
- copy generated README text literally (a74054b)
- make VICE mounts and joystick presses robust and document their side effects (a5ddafd)
- keep an https baseUrl's scheme and path when only the port is overridden (780d7a6)
- zero-fill reserved space that adjoins the emitted bytes (c996b64)
- keep the baseUrl path and send the network password in the startup probe (d7119c6)
- reject notes above the SID range as validation errors before playback (dcd8315)
- silence the SID even when the SIDWAVE player check cannot read memory (a08854d)
- limit the sid_silent assertion to the C64 Ultimate audio stream (b5c9c5f)
- fold only ASCII letters in REM text (99a859c)
- keep the last backend playing after music_play_preset (91ec58e)
- stop a running SIDWAVE PRG player when silencing the SID (8100cd5)
- report SIDWAVE errors as validation errors with their path (543a6e5)
- make SIDWAVE play the composition it describes (7337731)
- word backend failures neutrally instead of blaming the firmware (533834f)
- drop C128-only key tokens from c64_input (cdc251d)
- store lowercase REM text as PETSCII letters (a4105b7)
- skip a partially written line when reading the diagnostics log (b2b26d6)
- measure audio for the sid_silent batch assertion (9393192)
- report SID notes above the frequency range instead of clamping them (cb234cc)
- allow 35 to 41 tracks for D64 images and report the track count used (a4ec462)
- start assembled programs at their first instruction (a83295c)
- apply < and > to the whole expression in the assembler (6c21055)
- reserve space with .res without emitting bytes (2fe3ec6)
- disassemble and assemble undocumented NOP $F4 as zero page,X (b41d7ff)
- keep the scheme and path of a baseUrl-only Ultimate endpoint (fc6d0e3)
- list only VICE resources that exist and mark unmount as Ultimate-only (6dd10bd)
- drive VICE drives through resources and commands that VICE has (59069c3)
- make VICE joystick input reach the emulated CIA (706aab8)

### Tests

- allow for frame quantisation when matching SIDWAVE note gaps (add0362)
- ignore sidplayfp's leading silence when locating SIDWAVE note gaps (e7639ad)
- check that the startup probe reaches a password-protected mock (84a4a7b)
- cover display, verified-write and silence-measurement failure paths (b01a902)
- cover VICE drive operations on the mock and backend failure paths (4a28d14)
- poll for background task completion and the first arpeggio note instead of fixed sleeps (08aaeaa)
- read the write-only SID registers as $00 in the mock, as the Ultimate 64 does (547c1a2)

## 1.0.5 - 2026-10-15

### Bug Fixes

- split printer text by expression length so BASIC lines stay short (f4929b8)
- clear quote mode in PETSCII art and limit multi-word names to braces (2c78e11)
- stop a replaced music_generate sequence promptly without cutting off the next one (eb7d14c)
- accept a READY. prompt that appears during the ASM liveness check (16c4a84)
- point the automatic SYS stub at the first instruction (77e3a9e)
- prefer the enabled drive for bus numbers and allow spaces in task names (e77b1fb)
- keep legacy top-level config fields to configs without profile sections (7eb584d)
- reject malformed numeric PETSCII tokens in write_text instead of parsing a prefix (276a062)
- keep printer text in the printer's character set (eb45113)
- ignore Object.prototype names when mapping VICE drive letters (7c5c800)
- ignore Object.prototype names in named PETSCII and address symbol lookups (187e057)
- share one hex byte parser and detect apostrophe BASIC errors in the runner (b6de728)
- type lowercase letters as PETSCII letters in write_text and key (09df5a3)
- include the bytes in the memory read text result (1ead15b)
- find drive8 by bus number in drive_mount_and_verify (6f9467c)
- match Ultimate firmware drive ids, SID uploads, config paths and config precedence (6a10c27)
- treat a machine-code routine that returns to READY. as success (b5f8626)
- add a SYS stub to machine code assembled at $0801 and enter through it (ac19018)
- reject malformed addresses instead of parsing a numeric prefix (4cc04a6)
- reject inherited object property names as grouped tool operations (68f3eb7)
- read full 64 KB VICE memory, display pixel offset, and 0-based joystick ports (4624cdc)
- store lowercase BASIC string text as PETSCII letters (3065c91)
- avoid blank lines between full-width PETSCII art rows (9aaaa87)
- print reverse-video glyphs in PETSCII art with RVS ON and RVS OFF (b9ccf79)
- correct {heart}, multi-word named PETSCII codes, and screen code decoding (ec644ba)
- tokenize BASIC like the ROM for DATA, ? and line ordering (31ab83b)
- include the underlying cause in tool error text (6cac9de)
- keep internal review documents out of the RAG index (ea35b48)
- accept %-prefixed binary literals in the assembler (bd05706)
- assemble at the load address, reject unsupported indexed modes, and support *, < and > in expressions (9089e28)
- reject bitmap layouts that overlap the character ROM shadow in VIC banks 0 and 2 (8db507e)
- compile top-level SIDWAVE songs with note data and start each pattern on its first note (e9b8dfd)
- compare all expected bytes and fail on read errors in batch memory assertions (48fbe00)
- switch the drive type in drive_mount_and_verify instead of sending it as the mount mode (bba777a)
- reject background task names that would write outside the task folder (669c26f)
- let the note name override frequencyHz in sid_note_on as documented (144abc3)
- hold the SID gate for the note length in music_generate and clear it only between notes (da98608)
- detect BASIC errors whose names contain an apostrophe when polling (dd549b1)
- accept a $ prefix on each byte group in memory write hex input (64dad08)

### Tests

- parse multipart uploads byte-exactly in the firmware wire test (55e3b8d)
- update coverage tests for the SYS stub and the removed mock bypass (77b16fc)
- model the Ultimate 64 load_prg side effects and reset state in the mock (5dd6ec7)
- assemble the upload_run_asm integration program without a raw $0801 origin (9ef9bab)
- keep the no-config fallback probe off the network (fb8ad24)
- wait for asynchronous events instead of fixed short timeouts in two flaky tests (02fed10)
- remove the C64_TEST_TARGET=mock bypasses from C64Client (a3e099a)
- wait for music_generate playback calls instead of fixed sleeps (d0c7bff)

### Chores

- regenerate MCP interface files (f9ab0ca)

## 1.0.4 - 2026-10-07

### Bug Fixes

- align grouped tool platform gates and metadata with backend support across C64U/U64, U2/U2+/U2+L, and VICE, rejecting unsupported operations before device I/O (769075b)
- enable audio analysis (`record_analyze`, `analyze`) on VICE and U2 through the host audio input (06d1e12)
- wait for scanned npm archives before release verification (12686c3)

## 1.0.3 - 2026-10-07

### Bug Fixes

- retry audio and video stream startup after firmware host resolve errors (dc89bdd)
- analyze the Ultimate audio stream with per-channel offset removal and reliable stereo level and pitch detection (b88b2d6)
- read the firmware System Mode for accurate audio sample rates and report plain sample RMS (9860e51)
- update vulnerable runtime dependencies and synchronize npm and Bun lockfiles (f957831)
- require consistent release metadata and publish the exact tested npm archive from its prepared tag (814c3ed)

## 1.0.2 - 2026-08-07

### Bug Fixes

- resolve open Dependabot dependency alerts (f72973ec)

### Chores

- prepare release 1.0.1 (3eafecc5)

## 1.0.1 - 2026-07-20

### Bug Fixes

- make program-run polling truthful instead of assuming blind success (c0f5b00e)
- address Kilo Code review findings and raise patch coverage above 94% (ad93c5d6)
- restore C64BRIDGE_SKIP_AUTO_START after dynamic import instead of leaving it set process-wide (417ec892)
- use an impossible fixture path so the vice-leak check can't coincidentally pass (ec3b9660)
- make the 'no resolved config' createFacade test independent of real network reachability (59cf5d69)
- stop config-scenario tests from racing on the shared repo-root config file (87226bb0)
- harden C64 Bridge against 35 review findings (HARD01-001..035) (cfb7e4a8)

### Documentation

- add hardening 01-fable handover to the review trail (8b6cdef4)

### Chores

- prepare release 1.0.0 (cd435c85)

## 1.0.0 - 2026-07-14

### Bug Fixes

- skip publication when release exists, use curl to detect GitHub release, normalize repo URL in prepare-release (44f58332)
- skip publication when release already exists; add re-validation dispatch (e30d7fa8)

### Tests

- support native input probe in power cycle fixture (2c124bd1)

### Chores

- prepare release 0.9.3 (fd7c9952)

## 0.9.3 - 2026-07-12

### Highlights

- Added a concise BASIC memory map resource with consistent filesystem-to-resource URI mapping and cross-references alongside the existing KERNAL and full memory map documents.
- Standardised ROM routine resource filenames and paths so `c64://rom-routines/*` URLs map intuitively to matching Markdown files.
- Made VICE prewarming opt-in via `VICE_PREWARM=1` or `vice.prewarm: true`; default startup now keeps VICE lazy until first use.

### Maintenance

- Updated MCP server dependencies to current patch/minor versions and refreshed npm/Bun lockfiles.

## 0.9.2 - 2026-05-08

### Highlights

- Expanded the translation toolchain with a stronger 6510 assembler, BASIC tokenization, full opcode inventory coverage, and disassembly output that can reuse VICE symbols.
- Improved `c64_input` compatibility by flattening its grouped MCP schema and aligning its resource metadata with the current documentation set.

### Fixes

- Hardened memory helpers so malformed hex payloads and address ranges that overflow past `$FFFF` are rejected before reaching the backend.
- Improved coverage-report handling for temporary LCOV output and polished a README reference used in pull request workflows.

## 0.9.1 - 2026-05-07

### Highlights

- Added VICE monitor tooling, including monitor-state queries, continue execution, nuclear reset, and labeled checkpoints.
- Introduced grouped input and display-state workflows for keyboard and joystick control across supported backends.
- Expanded memory and debugging workflows with disassembly, symbol loading, batch execution, and bulk memory operations.

### Fixes

- Improved input handling, memory validation, and VICE backend reset/error-reporting behaviour.
- Fixed tool parameters in README.md

## 0.9.0 - 2026-05-07

### Highlights

- Added Claude Code as a first-class MCP client, including `.mcp.json` configuration and updated setup documentation.
- Improved Claude compatibility by flattening MCP tool schemas and returning structured JSON for memory reads. (Thanks @air)
- Standardised MCP resource paths for more consistent tool and resource discovery.
- Enhanced VICE backend support, documentation, smoke testing, and CI stability.

### Fixes

- Improved child-process output handling and logging.
- Stabilised CI startup checks, matrix validation, and Xvfb usage across platforms.

### Other

- Strengthened MCP schema validation, error handling, executable resolution, and integration test reliability.
- Regenerated README and MCP schemas for the updated tool format.
- Improved Bun integration, port validation, mock server management, and coverage checks.
- Added explicit VICE smoke-test logging.
- Updated ignore rules and minor test expectations.- add explicit vice smoke log step (d4a5442)
- 3rd party version updates

## 0.8.1 - 2026-03-27

- Added automatic publication to https://registry.modelcontextprotocol.io/

## 0.8.0 - 2026-03-26

### Highlights

- Introduced multi-backend runtime (C64U + VICE)
- Added diagnostics logging and performance improvements
- Enhanced test infrastructure, coverage, and CI stability
- Introduced SKILLS

### Fixes

- Fixed test isolation issues and CI memory problems
- Resolved edge-case runtime bugs

### Other

- General refactoring, test improvements, and maintenance

## 0.7.4 - 2026-03-07

### Features

- enhance network security by adding networkPassword support across configurations and clients; update documentation and tests accordingly (eef523d)
- Extended roll-out plan (3c5710e)
- Added Vice smoke test (27834c7)

### Bug Fixes

- update configuration resolution order in documentation and code; ensure repo config is preferred over home config (49a8806)
- update ViceClient to handle string and typed-array data chunks; add corresponding test (a708657)

### Refactoring

- Renamed audio/video data folders to sound/graphics to be consistent with doc folders (4a86a39)

### Documentation

- update configuration section in README for clarity and accuracy; add details on environment variables (0d55473)

### Tests

- add coverage for c64u facade operations with networkPassword support (55f506d)
- relocate binary monitor smoke test (708a816)

### Chores

- update package version and dependencies in package.json and package-lock.json (a1675d7)
- prepare release 0.7.3 (9688578)

### Other

- resolve BM smoke-test merge; switch timing logs to ms; add autostart polling; add doc/plans/vice-support (notes/plan/rollout) (c6d097e)
- Improved Vice binary monitor spec and C64U REST API comparison (6fde781)

## 0.7.3 - 2025-11-01

### Chores

- Improve release workflow (55855e6)
- prepare release 0.7.2 (dc038da)

### Other

- Added Vice docs (59f9d95)

## 0.7.2 - 2025-11-01

### Chores

- Improve release process (55d76a8)
- prepare release 0.7.1 (720871e)

## 0.7.1 - 2025-11-01

- No notable changes in this release.

## 0.7.0 - 2025-11-01

### Features

- Improved LLM tool discovery by consolidating to 12 tools with nested operations
- Upgrade to Node 24

## 0.6.0 - 2025-10-30

### Features

- Expanded ASM crash detection with low-memory, stack, and hardware monitoring plus post-run polling validation.
- Added comprehensive developer guides: sprite and charset workflows, PETSCII style and colour guide, BASIC pitfalls quickref.
- Introduced dynamically generated MCP resources for PETSCII and BASIC references.
- Enhanced RAG system with retrieval diversity, URI mapping, duplicate suppression, and SPDX-based metadata.
- Migrated CI and development tooling to Bun with reproducible Node 20 container workflow.
- Improved program runner outputs, audio generation, and metadata (including PRG and PAL/NTSC tags).
- Added new knowledge resources, developer examples, and improved LLM guidance.

### Bug Fixes

- Updated Docker base to Ubuntu 24.04 and installed Node 20 via `n`.
- Added native build dependencies (build-essential, python3) for Copilot setup.
- Fixed coverage configuration and reporting for Bun.
- Minor test and formatting corrections.

### Refactoring

- Optimized memory access by merging low-memory and screen RAM reads.
- Streamlined test execution and tooling using Bun.

### Documentation

- Reorganized and clarified meta tools, PETSCII, and Copilot documentation.
- Improved PETSCII code accuracy, VIC-II timing notes, and LLM readability.
- Updated rollout documentation for completed phases.
- Clarified Bun and npm compatibility.

### Tests

- Expanded test coverage across knowledge index, PETSCII, sprite workflows, and ASM polling.
- Added structured content and error handling verification.

### Other

- Improved BASIC specification and adjusted coverage targets.

## 0.5.1 - 2025-10-29

### Features

- Modularize meta.ts and add experimental tags (01bc020)
- Implement meta tools phase 1 with comprehensive tests (bc8d1bf)
- Add meta tools module for orchestration (dde23ac)

### Bug Fixes

- Improved docs on MCP server start (58c1bff)
- Use test/tmp folder for tmp test data (bd8d8ae)
- Test no longer tries to create /workspace (695d6a6)

### Refactoring

- Simplify timestamp parsing and formatting (610507e)
- Enhance filesystem tools for container awareness (97f22a5)

### Tests

- Add tests for device, metaModule, and C64Client invalid inputs (2b9c2c5)
- add tests for prompts registry (6578ea2)
- add tests for tools registry (0eed45c)
- hardcode expected MCP resource URIs and enforce min content size (782cf8a)

### Chores

- remove old monolithic meta.ts file (48e13a3)
- exclude coverage reports from git tracking (c53d898)
- sync lockfile after adding date-fns (c6b810d)
- remove tracked .c64bridge tasks.json and ignore state dir (22564b0)

### Other

- use namespaced temp dirs under .tmp-meta-tests/metaModule (82e2904)
- simplify date handling; use Date + date-fns addMilliseconds (536e75a)
- remove backwards-compat code and spec-alignment comments (0b6054c)
- align background task persistence with agent-state-spec (13cd6b7)
- Add agent state spec (31919b0)

## 0.5.0 - 2025-10-26

- No notable changes in this release.

## 0.4.0 - 2025-10-26

### Features

- Migrated to use the MCP SDK
- Improved knowledge base
- Consistent MCP/REST/RAG logs (b7c4172)
- Added chat mode on VS Code
- Improved RAG embeddings (5935f14)

## 0.3.0 - 2025-10-24

### Features

- Use device facade for backend abstraction, e.g. to support Vice(1927ff1)
- Simplify config (d62ab38)
- Add mock backend support and configure c64u base URL (4b3deaa)
- Add devices property to MCP tool options (caf9bbc)

### Bug Fixes

- post-package mcp check (d91e0f4)

### Chores

- Updated embeddings (599bfb5)
- update sample mcp config (154ccfd)
- Build PRs (c637c91)
- Build PRs (5a6cf6d)
- Run CI build on branches (58bb6d1)

## 0.2.5 - 2025-10-24

### Features

- Parallel Docker-based build (172c6d7)

### Chores

- Split package check workflow (240c06f)
- Drop swagger-typescript-api dependency (165ac8b)
- Document mock server helpers (3703cf9)
- Fix package check shell (f2c94ca)
- Harden package verification (a00ac01)
- Renamed GitHub workflow step (47dacb8)

## 0.2.4 - 2025-10-24

### Features

- Add RAG asset copying and runtime resolution (1e4f500)

### Chores

- Remove duplicate sources.csv from package (0e36f23)
- Removed 'post-' prefix from post-package-check.yml (8f700cd)
- add post-package smoke checks (4a15329)

## 0.2.3 - 2025-10-23

### Bug Fixes

- Flexible launcher so npm start works both from source and the published package (3b0ee24)
- load generated client from src during tests (0d78fff)

### Chores

- Remove duplicates from package (f1b9c23)

## 0.2.2 - 2025-10-23

### Chores

- Extend CHANGELOG.md automatically (fc3c5a3)

## 0.2.1 - 2025-10-23

### Added (0.2.1)

- CLI entrypoint `c64bridge` to enable `npx c64bridge` quick start.
- Clear installation paths in README (Quick start with npx, Persistent install with npm, From source).

### Changed (0.2.1)

- Package contents: ensure `mcp.json`, `AGENTS.md`, and `.github/prompts/**` are included in the npm tarball; tighten `files` list.
- Entry point set to `dist/index.js`; README badges refined; section icons adjusted for a more professional look.
- Health check guidance updated to use server `/health` and device `/tools/version`.

### Fixed (0.2.1)

- Post-publish smoke verification: run checks in the installed package directory (avoids false negatives).
- Release badge alignment; documentation touch-ups.

## 0.2.0 - 2025-10-23

### Added (0.2.0)

- Release preparation script (`npm run release:prepare`) to bump versions in `package.json` and `mcp.json` and regenerate `mcp-manifest.json`.
- Auto-generation of `mcp-manifest.json` at build time by scanning `@McpTool` annotations.
- Troubleshooting guide (`doc/troubleshooting-mcp.md`) and expanded documentation for RAG, SID programming, and development workflow.
- RAG discovery pipeline for GitHub sources and refreshed example embeddings.

### Changed (0.2.0)

- README: overhauled highlights, tool descriptions, and structure; relocated Local RAG documentation for clarity.
- Refactor: removed legacy `src/mcpManifest.json` in favor of generated `mcp-manifest.json`; extracted VICE execution into `viceRunner.ts`.

### Tests (0.2.0)

- Verified build emits `dist/mcp-manifest.json` with expected tools; improved mock and real-device testing notes.

## 0.1.0 - 2025-10-22

### Added

- Initial public release of c64bridge MCP server.
- Local RAG subsystem with prebuilt embeddings under `data/`.
- Full tool surface for BASIC/ASM upload, screen/memory access, drives, and SID control.
- Documentation under `doc/`, plus `AGENTS.md`, `.github/prompts/*.prompt.md`, and `data/context/chat.md`.
- GitHub Actions release pipeline and npm packaging configuration.
