# Hardening 03 - work log

Branch: `fix/hardening-3` (from `main` at `5161677`, baseline `6756495`). Brief: `prompt.md`. Findings: `review.md`.
This file is the resume point: the task table is the source of truth for what is done.

## How to resume

1. `git fetch origin fix/hardening-3 && git checkout fix/hardening-3`.
2. Use Node 24 (`engines: >=24`). Under Node 22 seven tests in `concurrencyFixes.test.mjs` and
   `mcpServerPlatformStatusResource.test.mjs` are cancelled ("Promise resolution is still pending"); this is
   the runtime, not a defect.
3. Environment for every build and test: `C64BRIDGE_CONFIG=<empty JSON file>`, `VICE_VISIBLE=false`,
   `C64BRIDGE_TEST_ASSERT_HERMETIC=1`. Never call real hardware.
4. Pick the first row whose status is `todo`, follow the definition of done in `prompt.md`, update the row,
   commit, push.

## Team structure (amended)

The cloud environment cannot run the brief's three tiers: workers cannot start their own workers, the
built-in worktree isolation is denied, and `codex` is not installed. Amended structure, approved by the owner:

- Lead (Opus): plans, writes each worker brief, reviews every diff, proves each new test fails when the
  production change is reverted (`git checkout <commit>^ -- <non-test files>` in a throwaway worktree),
  cherry-picks into `fix/hardening-3`, rebuilds generated files, runs both mock suites, pushes.
- Workers (Sonnet by default; Haiku only for mechanical items): at most three at once, one group each, in a
  manual worktree `../c64bridge-wt/<group>` on branch `h3/<group>`, one commit per finding. Workers do not push.

## Baseline (Node 24, `6756495` + docs)

- `npm run build`: passes, no generated drift.
- c64u mock: pass (after HARD03-046: 1,580 tests in the summed runner output, 0 fail).
- VICE mock: pass (282 + 28). `x64sc` is not installed, so `test:vice:device` and `coverage` cannot run here.
- Tools not available: `sidplayfp` (one test skips).

## Tasks

Status: `todo`, `wip` (worker running), `review` (lead reviewing), `done`, `skipped` (finding does not hold;
evidence in notes), `blocked` (reason in notes). "Reverted" = the new test fails when the fix is reverted.

| ID | Group | Status | Commit | Test | Reverted | Notes |
|---|---|---|---|---|---|---|
| 046 | 0 | done | see git log | `test/stateRootDir.test.mjs` | yes | `C64BRIDGE_STATE_DIR`; runners use a temp state dir |
| 003 | A | done | c97fd4e6 | hostPaths, hostPathsTools | yes | E1; opt-out C64BRIDGE_ALLOW_HIDDEN_PATHS |
| 002 | A | done | 85573dfb | graphicsModule | yes | readHostFile + Jimp.fromBuffer; 4096x4096 cap |
| 004 | A | done | 6ac546aa | vicBitmap | yes | src/ioRange.ts (E3) |
| 039 | A | done | 0a1efe9c | charsetScanIo | yes |  |
| 001 | B | done | a2fa3f4e | viceModule | yes | E2; mock case-insensitive |
| 013 | B | done | dd8bcafd | viceProcess | yes |  |
| 018 | B | done | cc9ad0ce | viceSession | yes | stopped:false, success:false |
| 019 | B | done | dd28471e | groupedToolsShims | yes |  |
| 020 | B | done | 087488c4 | viceSession | yes |  |
| 029 | B | done | d5b61d81 + 1be781f3 | inputModule, keyboardInjection, viceSession, programRunnersModule | yes |  |
| 030 | B | done | 2ae92d72 | groupedToolsShims | yes |  |
| 024 | D | done | 98076acb | addressParsing | yes | all three parsers in one commit |
| 005 | C | done | 7b0f0a44 | accessMode | yes |  |
| 006 | C | done | d49c5eb7 | loggingHttpClient, configWriteRedaction | yes |  |
| 007 | C | done | b1f1af6b | resultRedaction | yes |  |
| 011 | C | done | 8e48fcc9 | batchAndDisplayState | yes |  |
| 012 | C | done | 1b9183b1 + follow-up | cancellation, groupedToolsShims | yes | tools/list tripwire 70,000 -> 71,000 bytes |
| 008 | D | done | fb210900 | meta/screen | yes | E5: static repeat budget 3 on runtimes without vm timeout |
| 021 | D | done | babdf40b | pollValidator, programRunnersModule | yes |  |
| 022 | D | done | f7b9edbb | meta/artifacts | yes |  |
| 023 | D | done | 6fc94030 | meta/program | yes |  |
| 025 | D | done | ef0c2c1b | pollValidator | yes | needs hardware confirmation |
| 034 | F | done | 307df3b2 | assembler | yes |  |
| 035 | F | done | bdc2af15 | assembler | yes |  |
| 036 | D | done | 2bfe108c | memory, meta/memory | yes |  |
| 037 | F | done | 5c81e068 | printerModule | yes |  |
| 016 | E | done | 132264fd | spriteDisplayPointer | yes |  |
| 028 | E | done | 797b11a1 | batchAndDisplayState | yes |  |
| 038 | E | done | 63e3007e + a7986ce0 | publishedExamples | yes | examples now run in a scratch directory |
| 009 | E | done | 3853560b | sidwave | yes | limit 4096 bars |
| 026 | E | done | 75e5a03f | audioVerdicts, meta/audio | yes |  |
| 027 | E | done | cd23392f | audioVerdicts | yes |  |
| 033 | E | done | be0a664a | c64Client, streamCaptureRestore | yes | new src/streamTargets.ts |
| 017 | F+D | done | 2237a14b + f8dffcd3 | device, meta/filesystem, meta/program | yes | single directory, one match per pattern; fs_stats kept (not marked unsupported) |
| 031 | F | done | 25663201 | meta/filesystem | yes |  |
| 032 | F | done | b4f9b170 | inputModule | yes | needs hardware confirmation |
| 014 | G | done | 7d97e2b3 + 1fd6c57c + 8ad4ecaa | taskRetention, taskOwnership | yes | unique runs; startup 200/30-day retention; 200 finished tasks; delete_task; coalesced/current snapshots |
| 015 | G | done | 1fd6c57c | taskOwnership, backgroundState | yes | real two-process merge/ownership/crash/deletion; filesystem ticket lock; session folders |
| 010 | H | done | a02ba544 | ragModule, ragDedup | yes | 500 characters; 32 lexical terms |
| 040 | H | done | 33c06c45 | scripts/start | yes | foreign cwd/config preserved |
| 041 | H | done | ebecd860 + 088f1209 | ragDeveloperExclusions | yes | maintenance prompts excluded from index/package; local embeddings rebuilt |
| 042 | H | done | 71b6d13e + e438033b | knowledgeIndex, mcpServerResourcesSuite | yes | public tool/op references; missing URI -32002; runtime/skill docs |
| 043 | H | done | 57fe2c64 | scripts/cli | yes | pathToFileURL; # and % install paths |
| 044 | H | done | 92732b2f | scripts/invoke-bun | yes | TERM/INT/HUP forwarding, reaping and spawn errors |
| 045 | H | done | 43de6d10 | scripts/validate-release | yes | read-only validation; minimal OIDC publication; immutable checks; pinned publisher |

## Issues found during the work (owner: fix all; tracked as I-numbers)

Status as in the task table. Each fix gets its own commit with the I-number in the body.

| ID | Status | Where | Issue |
|---|---|---|---|
| I1 | done | src/tools/meta/filesystem.ts | bounded abort-aware launch wait; d37f8ad2 |
| I2 | done | src/tools/meta/compilation.ts | bounded duration; cancellation through verification/archival; fa119570 + 842271f8 |
| I3 | done | test/viceSession.test.mjs | Transient-PC regression uses virtual CPU time instead of a host-timer window; a397590e; full-timeout mutation still fails |
| I4 | done | src/tools/meta/graphics.ts | explicit charset spans reject I/O before pause; 2698cfe6 |
| I5 | done | src/tools/meta/program.ts | `program_shuffle` checks unsuccessful `runPrgFile`/`runCrtFile` results before capture (E8); 74837fdd |
| I6 | done | src/c64Client.ts, src/streamTargets.ts | `C64Client.streamStart`/`streamStop` now update the user-stream registry; 158f0f3a |
| I7 | done | src/tools/printer.ts | bounded delayed-error observation; truthful printer launch wording; c04aaf76 |
| I8 | done | src/device.ts (ViceBackend.feedKeyboard) | running and stopped keyboard feeds enforce 16384-byte capacity; 97b52dad |
| I9 | done | src/tools/debug.ts | underlying VICE waiter/timer cancelled without changing CPU; b5ed0f2b |
| I10 | done | src/tools/meta/memory.ts | shared cancellation result, no final-chunk write, owned pause cleanup; 6842f29d |
| I11 | skipped | test/audioRuntime.test.mjs, test/diagnostics.test.mjs | Supported test and coverage runners already isolate module-mocking audioRuntime (run-tests.ts ISOLATED_BUN_TEST_FILES and run-coverage.mjs isolatedTests); runner regressions enforce this. Direct combined Bun rerun: 22 passed, zero failures. No production defect substantiated. |
| I12 | info | test/suites/mcpServerToolsSuite.mjs | tools/list tripwire moved from 70,000 to 71,000 bytes for the new maxima (commit 835d1db6) |
| I13 | done | src/tools/meta/filesystem.ts | Retain the review specification default: single-directory, one match per pattern. Documented in the behavior guide and drive skill; no API removal. |
| I14 | info | environment | Node 22 cancels 7 tests; the project requires Node 24 (`engines`) |

## Log

- 2026-11-14: capability check; amended team structure; branch created; HARD03-046 landed; draft PR #169.
- 2026-11-14: wave 1 started (A, B, C in worktrees `../c64bridge-wt/{a,b,c}`, Sonnet). 024 moved to D as one commit.
- 2026-11-14: wave 1 integrated (A, B, C), both mock suites green, every test fails when reverted. 029 held for wave 2.
- 2026-11-14: wave 2 started: D (Sonnet), E (Sonnet), F (Haiku). 034, 035, 037 moved from D to F to balance load.
- 2026-11-14: wave 2 integrated and pushed; suites green; every test fails when reverted. Wave 3 started: G (Sonnet), H1 (Haiku: 040, 043-045), H2 (Sonnet: 010, 041, 042, docs). Issues I1-I14 recorded; owner asked to fix all.

## PR #169 review follow-up (2026-11-15)

All 15 inline review findings are covered by fixes and regression cases in these commits:

- `1a699429`: legacy and mixed `batch_update` network writes are subject to the access guard; `accessMode.test.mjs` covers legacy and mixed requests.
- `34a75021`: legacy and mixed configuration values are redacted; `configWriteRedaction.test.mjs` covers argument redaction and diagnostics.
- `1c845a82`: adjacent assembler reservations use a linear gap check; `assembler.test.mjs` covers many adjacent reservations.
- `299ecf40`: joystick taps retain their backend, serialize overlapping controls, and release after a lost press response; `inputModule.test.mjs` covers each case.
- `5a11c99f`: optional and nested regex repetitions count toward the budget; `meta/screen.test.mjs` covers backtracking on runtimes without interruption.
- `ce5124cd`: inherited task-state and diagnostics overrides are redirected during tests; `stateRootDir.test.mjs` checks isolation and preservation of operator files.
- `d735c261`: artifact snapshots enforce aggregate memory and range-count limits before reads or file creation; `meta/artifacts.test.mjs` covers limits and the accepted boundary.
- `81acf78b`: discovered paths use the matched filename rather than the echoed wildcard; `meta/filesystem.test.mjs` covers firmware wildcard results.
- `74837fdd`: `program_shuffle` records unsuccessful launches before capturing; `meta/program.test.mjs` covers run errors.
- `2261a60e`: silent playback is cleaned up and request cancellation reaches audio capture; `audioVerdicts.test.mjs` covers cleanup/error preservation and signal forwarding.
- `158f0f3a`: stream changes wait for capture cleanup, cancelled queued captures do not start later, and one-shot captures invalidate and recreate reusable video sessions; `streamCaptureRestore.test.mjs` and `cancellation.test.mjs` cover these interleavings.

Generated metadata has been refreshed. Additional test-only commit `a397590e` removes the pre-existing I3 scheduling race without weakening its transient-PC check: restoring the old full-timeout wait in a temporary copy fails the test.

Validation on the integrated fixes:

- Full build and TypeScript checking pass; generated MCP snapshot parity passes.
- C64U mock batches: 1,770 passed, four skipped, with one pre-existing I3 timing failure. After its deterministic correction, the full isolated VICE session file passes all 23 tests; the old full-timeout mutation fails I3 as expected (22 other tests pass).
- VICE mock selection: 335 passed, 15 skipped, no failures in the serial run.
- Bun-only C64U batches (included in the C64U count): 82 passed, zero failures, including microphone abort tests.
- The real-Xvfb supervision test was explicitly excluded because Xvfb is absent and the environment has no usable package indexes/helper. No hardware or real VICE was contacted.
- Earlier forced-Bun-environment harness assertions pass when rerun with the intended Node environment; an initial concurrent VICE short-deadline test failure does not recur in the serial run.

This follow-up addresses all 15 inline threads; it does not mark the overall Hardening 3 work complete.

## CI follow-up (2026-11-16)

The PR workflow run `43768819063` exposed a test portability error in Bun coverage:
`assert.doesNotMatch` is available in Node's assertion library but not in this
repository's Bun adapter. Both PR-added occurrences (input cleanup and queued ASM
reporting) now use the equivalent supported boolean assertion. Each failure was
reproduced before the correction. Afterwards, Bun coverage passes 27 input tests
and 46 program-runner tests, and both files pass under Node. The exact previously
failing `c64u-mock/all-04` coverage shard passes all 185 tests. Full matrix coverage
is checked by the PR workflow; no assertion or coverage threshold was weakened.

## Merge-readiness completion (2026-11-17)

All 46 specification findings have implementations and regression coverage. The remaining nine rows and actionable I-number issues above are now complete. Each new correction was checked against a failing pre-fix implementation or a targeted mutation in an isolated worktree; specialist results were reviewed before integration. The I11 test-isolation concern is dismissed with the runner and direct-run evidence above. I12/I14 are informational, and I13 retains the explicitly specified default.

A fresh independent pass found and posted two additional P2 inline findings: cancellation during a pending screen read (`12a80c17`) and successful self-modifying BASIC being called unloaded (`b6d1ec0a`). The existing regex thread was reopened after an escaped-quantifier bypass; `97d1d9b2` tracks parsed quantifier tokens, preserving legitimate lazy quantifiers. Each regression failed before its fix. BASIC verification retains the unchanged stale-screen rejection; a post-execution byte mismatch alone cannot prove a self-modifying program was never loaded.

Targeted integration checks: 158 tests across the cancellation/device/graphics/filesystem/printer suites passed; 37 state tests passed; 32 combined MCP/retention/ownership tests passed, including the tools/list size budget. Launcher suites passed 18 tests. Release fixtures passed seven tests plus Node execution and actionlint, including corrupt artifact rejection. The official pinned publisher archive checksum was verified and its local manifest validation passed; no tag, authentication or publication was performed. Real Xvfb was obtained from a checksum-verified Debian package in /tmp, and the existing supervision test passed.

Final full build, two consecutive runs of each mock matrix, package checks, exact-head CI and thread/mergeability status are recorded in PR #169 before draft status is removed. No real C64 hardware was contacted. The firmware-specific checks in review.md remain explicitly unverified; they are preserved as validation limits, not represented as mock-proven behavior. The PR must not be merged by this task.
