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
| 014 | G | wip | | | | |
| 015 | G | wip | | | | |
| 010 | H | wip | | | | |
| 040 | H | wip | | | | |
| 041 | H | wip | | | | |
| 042 | H | wip | | | | |
| 043 | H | wip | | | | |
| 044 | H | wip | | | | |
| 045 | H | wip | | | | |

## Issues found during the work (owner: fix all; tracked as I-numbers)

Status as in the task table. Each fix gets its own commit with the I-number in the body.

| ID | Status | Where | Issue |
|---|---|---|---|
| I1 | todo | src/tools/meta/filesystem.ts | `find_and_run_first_match` `waitMs` is an unbounded sleep that ignores cancellation |
| I2 | todo | src/tools/meta/compilation.ts | `compile_run_verify_cycle` `durationMs` is unbounded and ignores cancellation |
| I3 | todo | test/viceSession.test.mjs | `wait_for_state with expectedPC polls the PC while a session holds only a disabled stopping checkpoint` is timing-sensitive (1 failure in 3 isolated runs on 2 CPUs) |
| I4 | todo | src/tools/meta/graphics.ts | `rip_charset_from_ram` with an explicit `address` in $D000-$DFFF still reads the I/O area (039 covers only the defaults) |
| I5 | todo | src/tools/meta/program.ts | `program_shuffle` ignores the `success` of `runPrgFile`/`runCrtFile` (E8) |
| I6 | todo | src/c64Client.ts, src/streamTargets.ts | the user-stream registry of 033 is updated only by the `c64_stream` tools, not by `C64Client.streamStart`/`streamStop` |
| I7 | todo | src/tools/printer.ts | `print_text` checks the screen once right after the run; a later `?DEVICE NOT PRESENT` is missed |
| I8 | todo | src/device.ts (ViceBackend.feedKeyboard) | a single VICE keyboard feed above 16384 bytes while the CPU runs is not refused (VICE drops it silently) |
| I9 | todo | src/tools/debug.ts | after a cancelled `wait_for_state` the underlying `viceWaitForStop` keeps running until its own timeout |
| I10 | todo | src/tools/meta/memory.ts | `memory_dump` cancellation throws `ToolExecutionError` (code `cancelled`) instead of the shared `cancelledResult()` |
| I11 | todo | test/audioRuntime.test.mjs, test/diagnostics.test.mjs | tests interfere when several files run in one Bun process (pass alone) |
| I12 | info | test/suites/mcpServerToolsSuite.mjs | tools/list tripwire moved from 70,000 to 71,000 bytes for the new maxima (commit 835d1db6) |
| I13 | owner decision | src/tools/meta/filesystem.ts | `fs_stats` and `shuffle` on C64U/U2 are single-directory, one match per pattern (review default); marking them unsupported remains the owner's choice |
| I14 | info | environment | Node 22 cancels 7 tests; the project requires Node 24 (`engines`) |

## Log

- 2026-11-14: capability check; amended team structure; branch created; HARD03-046 landed; draft PR #169.
- 2026-11-14: wave 1 started (A, B, C in worktrees `../c64bridge-wt/{a,b,c}`, Sonnet). 024 moved to D as one commit.
- 2026-11-14: wave 1 integrated (A, B, C), both mock suites green, every test fails when reverted. 029 held for wave 2.
- 2026-11-14: wave 2 started: D (Sonnet), E (Sonnet), F (Haiku). 034, 035, 037 moved from D to F to balance load.
- 2026-11-14: wave 2 integrated and pushed; suites green; every test fails when reverted. Wave 3 started: G (Sonnet), H1 (Haiku: 040, 043-045), H2 (Sonnet: 010, 041, 042, docs). Issues I1-I14 recorded; owner asked to fix all.
