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
| 029 | B | wip | h3/b e2017024+e22f8b51 | viceSession |  | held: input.ts write_text/key (F) and upload_run_asm in c64Client.ts (D) must surface the status |
| 030 | B | done | 2ae92d72 | groupedToolsShims | yes |  |
| 024 | D | wip | | | | all three parsers in one commit in wave 2 (debug.ts, meta/memory.ts, meta/graphics.ts) |
| 005 | C | done | 7b0f0a44 | accessMode | yes |  |
| 006 | C | done | d49c5eb7 | loggingHttpClient, configWriteRedaction | yes |  |
| 007 | C | done | b1f1af6b | resultRedaction | yes |  |
| 011 | C | done | 8e48fcc9 | batchAndDisplayState | yes |  |
| 012 | C | done | 1b9183b1 + follow-up | cancellation, groupedToolsShims | yes | tools/list tripwire 70,000 -> 71,000 bytes |
| 008 | D | wip | | | | |
| 021 | D | wip | | | | |
| 022 | D | wip | | | | |
| 023 | D | wip | | | | shuffle part specified by F |
| 025 | D | wip | | | | |
| 034 | F | wip | | | | |
| 035 | F | wip | | | | E3 helper |
| 036 | D | wip | | | | |
| 037 | F | wip | | | | |
| 016 | E | wip | | | | |
| 028 | E | wip | | | | |
| 038 | E | wip | | | | |
| 009 | E | wip | | | | |
| 026 | E | wip | | | | |
| 027 | E | wip | | | | |
| 033 | E | wip | | | | |
| 017 | F+D | wip | | | | filesystem part F, shuffle part D; combined at integration |
| 031 | F | wip | | | | |
| 032 | F | wip | | | | |
| 014 | G | todo | | | | |
| 015 | G | todo | | | | |
| 010 | H | todo | | | | |
| 040 | H | todo | | | | |
| 041 | H | todo | | | | |
| 042 | H | todo | | | | |
| 043 | H | todo | | | | |
| 044 | H | todo | | | | |
| 045 | H | todo | | | | |

## For the owner (found outside review.md, not fixed)

- `find_and_run_first_match` `waitMs` (src/tools/meta/filesystem.ts) and `compile_run_verify_cycle` `durationMs`
  (src/tools/meta/compilation.ts) are unbounded sleeps without cancellation.
- `wait_for_state with expectedPC polls the PC while a session holds only a disabled stopping checkpoint`
  (test/viceSession.test.mjs) is timing-sensitive: 1 failure in 3 isolated runs on this 2-CPU machine.
- `rip_charset_from_ram` with an explicit `address` in $D000-$DFFF is still allowed (039 covers only defaults).

## Log

- 2026-11-14: capability check; amended team structure; branch created; HARD03-046 landed; draft PR #169.
- 2026-11-14: wave 1 started (A, B, C in worktrees `../c64bridge-wt/{a,b,c}`, Sonnet). 024 moved to D as one commit.
- 2026-11-14: wave 1 integrated (A, B, C), both mock suites green, every test fails when reverted. 029 held for wave 2.
- 2026-11-14: wave 2 started: D (Sonnet), E (Sonnet), F (Haiku). 034, 035, 037 moved from D to F to balance load.
