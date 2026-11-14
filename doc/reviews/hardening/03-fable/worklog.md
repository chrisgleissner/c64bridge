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
| 003 | A | todo | | | | |
| 002 | A | todo | | | | |
| 004 | A | todo | | | | E3 helper |
| 039 | A | todo | | | | E3 helper |
| 001 | B | todo | | | | |
| 013 | B | todo | | | | |
| 018 | B | todo | | | | |
| 019 | B | todo | | | | |
| 020 | B | todo | | | | |
| 029 | B | todo | | | | |
| 030 | B | todo | | | | |
| 024 | B/D/A | todo | | | | three parsers: debug.ts (B), meta/memory.ts (D), meta/graphics.ts (A) |
| 005 | C | todo | | | | |
| 006 | C | todo | | | | |
| 007 | C | todo | | | | |
| 011 | C | todo | | | | |
| 012 | C | todo | | | | |
| 008 | D | todo | | | | |
| 021 | D | todo | | | | |
| 022 | D | todo | | | | |
| 023 | D | todo | | | | shuffle part specified by F |
| 025 | D | todo | | | | |
| 034 | D | todo | | | | |
| 035 | D | todo | | | | E3 helper |
| 036 | D | todo | | | | |
| 037 | D | todo | | | | |
| 016 | E | todo | | | | |
| 028 | E | todo | | | | |
| 038 | E | todo | | | | |
| 009 | E | todo | | | | |
| 026 | E | todo | | | | |
| 027 | E | todo | | | | |
| 033 | E | todo | | | | |
| 017 | F | todo | | | | shuffle edit made by D |
| 031 | F | todo | | | | |
| 032 | F | todo | | | | |
| 014 | G | todo | | | | |
| 015 | G | todo | | | | |
| 010 | H | todo | | | | |
| 040 | H | todo | | | | |
| 041 | H | todo | | | | |
| 042 | H | todo | | | | |
| 043 | H | todo | | | | |
| 044 | H | todo | | | | |
| 045 | H | todo | | | | |

## Log

- 2026-11-14: capability check; amended team structure; branch created; HARD03-046 landed.
