# SIDWAVE standalone: state

Resume instructions for a fresh agent: read `prompt.md` (the brief), then this file, then the tail of `evidence/ledger.jsonl`. Do not repeat work recorded here.

## Current stage

S0 done (commits 32cf57e2, d50cdd95). S1 in progress in worktree sidwave-s1; docs drafts in sidwave-docs, on branch `feat/sidwave-standalone` from `origin/main` `43f775ba`.

## Environment notes

- `bun install --frozen-lockfile` fails here (`segfault-handler` needs `node-gyp`). Use `npm ci` for dependency installs.
- Tools present: node 24.22.1, bun 1.3.1, `/usr/bin/sidplayfp`, `/usr/local/bin/x64sc`, `git-filter-repo`, `codex`, `gh` (logged in).
- Bulky artifacts and logs: `~/.c64bridge/sidwave-standalone/`.

## Decisions

(see prompt.md section 4; additional decisions below)

- D1 (2026-11-26) `src/petscii.ts`, `src/ioRange.ts`, `src/tools/translation/assembler.ts` remain in c64bridge as one-line re-export shims from `c64-asm6502`, because `src/tools/meta/background.ts` (owned by the modern-mcp agent) imports petscii; no second implementation.
- D2 Standalone repository layout: `packages/` in c64bridge becomes the root of `chrisgleissner/sidwave` (filter-repo path rename). Root README, CHANGELOG, doc/, CI and a workspace-root package.json for the standalone repo live under `packages/` in c64bridge; `packages/*` workspace glob in c64bridge matches only the two package directories.
- D3 A0 (bit-identical PCM) is defined on SIDLite; reSIDfp PCM is not reproducible across fresh engines (3.6 finding).
- D5 `data/sound/examples/Biosphere.sid` (third-party tune, 1993, in c64bridge since 2025-10, unreferenced by code) stays in c64bridge and is not moved into the sidwave package.
- D6 Docs drafts done on wip/sidwave-docs 934191e2 (packages/README.md, sidwave/README.md, asm6502/README.md, sidwave/doc/licensing.md, CHANGELOG.md, doc/repository-structure.md). Before PR 1: fix spec/schema links to the paths S1 chose, confirm CLI `--help`, drop Biosphere mention from licensing.md if it stays out of the package.
- D7 S3 SID file module done on feat/sidwave-sidfile 4c00c5c1 (worktree sidwave-sidfile): parseSidFile/writeSidFile/subtunes/songSpeed/md5ForSonglengths, songlengths parser; 25 tests both runners; full HVSC 59,886 files parse and rewrite byte-identically. Rebase onto main after PR 1; package tsconfig needs `types: ["node"]`; songSpeed v2 psidSpecific=0 ambiguity documented in code.
- D8 (user, 2026-11-26) Create the public repo `chrisgleissner/sidwave` right after PR 1 (#193) merges, from the split output; S3+ work then happens there with its own CI and PRs. c64bridge keeps its bundled workspace copy frozen until S9 replaces it with npm dependencies. No npm publish and no tags before S9. This replaces the brief's "create at S9 step 1".
- D9 Assembler package name stays `c64-asm6502` (recommended to the user 2026-11-26): `asm6502` on npm is an unrelated MIT ES6 assembler (v0.0.2, one `assemble` function, Mesen labels); unscoped names that differ only by punctuation are refused by npm; `asm6510` would overclaim, because the 6510 has the same NMOS instruction set (incl. undocumented opcodes) and only adds the $00/$01 I/O port, which the assembler does not model. Its C64-specific features (PRG with load address, PETSCII text and brace tokens, $D000-$DFFF I/O overlap checks) are platform, not CPU, features. User deferred to this judgement (2026-11-26): final.
- Open: 4 source files carry a "GPL v2.0 or later" header while package.json files say GPL-2.0-only. Not changed (no relicensing); flagged in the report for the user.
- D10 S3 engine done on feat/sidwave-engine 95fb8378 (worktree sidwave-engine, by codex): sidwave/engine, createLibsidplayfpEngine; trace sid is 0-based (verified by orchestrator: 1-SID chiptune_drive gives only sid 0, 2-SID title_fanfare 0 and 1; the 3.6 note of '1' was wrong) and address is the register offset 0x00-0x18; 350/350 package tests. Risk: as an optional dependency of the bundled sidwave it may be bundled into the c64bridge tarball (~2 MB incl. its source tarball); check the package budget when c64bridge consumes it, or keep it out of the bundle.
- D4 Work packages run in worktrees `c64bridge-wt/sidwave-s1` (S1, branch wip/sidwave-s1) and `c64bridge-wt/sidwave-docs` (README/licensing drafts, wip/sidwave-docs); both merge into feat/sidwave-standalone for PR 1.

## Disproven hypotheses

(none yet)

## Pre-existing failures

- `npm run test:node` at 43f775ba: 6 failures, none SIDWAVE (task-owner fixture, meta/backgroundState, meta/taskOwnership, meta/taskRetention, updateReadme, start.test 'imports src entry under Bun'). Not a CI gate. `npm test` (Bun) is clean.

## Cost rule (user, 2026-11-26)

Check quota with `llm-usage` (13:42: Claude 5h 48 % left, weekly 93 % "conserve"; later 2026-11-26 the user reset Codex quota and asked to use codex more; codex exec -m gpt-6-luna verified working; llm-usage showed a stale 0 %). Watch remaining tokens and burn rate; favour cheaper models where defensible: codex exec (gpt-6-luna) and Haiku for implementation, mechanical edits and runs, Sonnet only to supervise packages needing judgement, top tier only for the final review and calibration design. Keep subagent briefs and returns short.

## Hardware and VICE coordination

- 2026-11-26: user asked to coordinate machine use with the modern-mcp session (peer `c64bridge-64`). It proposed: it uses the U64, this session the C64U. Brief section 2 forbids this session to contact the C64U, so the reply was: no C64U unless the user confirms; time-share the U64, each session asks the other for an all-clear before a session. This session's VICE: monitor ports 6520-6529, Xvfb displays :120-:129 (set VICE_XVFB_DISPLAY=:121 for `test:vice:device`). Attach only to own VICE instances.
- 15:44 peer asked for a 20-minute quiet window (load < 4) for its gate run; agreed: no local VICE/test/build jobs from this session until the peer says the run ended.
- Agreed with peer: U64 time-shared, nobody uses the C64U. Peer holds the U64 until it sends an explicit release; afterwards each side asks for an all-clear before U64 use. Peer VICE: ports 6510-6519, displays :110-:119.

## Backlog (user additions)

- 2026-11-26, user: the public repo `chrisgleissner/sidwave` ("SID Wave") gets a great `README.md`, informative, clear, concise and appealing to musicians and developers alike, and a repository structure similar to the user's other repos (c64bridge, sidflow: look at their top-level layout, README sections, badges, doc/ folder, CI workflows, CHANGELOG, LICENSE). Draft the README in `packages/sidwave/README.md` from S2 onward (a minimal version ships with PR 1, the full one in S9) so the split script carries it. Repository creation itself stays at S9 step 1 as the brief orders (creating it earlier would expose an unfinished package); the user's message confirms the authority for it.

## Next action

2026-11-26 16:10 (session 3): CI run 45852020844 green (ledger). origin/main unchanged since branch point, no rebase needed. Sonnet review of the PR diff running (split-proof retries, repository.url, GPL headers, tarball budget, correctness). Next: fix confirmed findings via codex (Codex 5h empty until ~18:45; small fixes by orchestrator or Haiku), build, PR body, ready, merge.

2026-11-26 15:45 (new session from HANDOVER.md): wip/sidwave-s2 is merged into feat/sidwave-standalone (c68d87c1); the list below is historical. Head 426a08ed, pushed. CI run 45852020844 on #193 pending (watch log `~/.c64bridge/sidwave-standalone/ci-193-45852020844.log`). Quota at session start: Claude 5h 12 % (resets ~17:10), Codex 5h 0 % (resets ~18:45). Paused per cost rule. On resume follow HANDOVER.md "Remaining work" step 1: check that CI result, then Sonnet review of the diff (split-proof retries, repository.url, GPL header list, tarball budget), rebase, build, PR body, ready, merge.

Branches in flight (historical, before the S2 merge) (all local worktrees under c64bridge-wt/):
- `wip/sidwave-s2` (sidwave-s2): S2 worker (CLI, packages/ root files, split script, consumer check). When done: review its report; question the "retry test steps up to three times" in the split proof (must not hide failures: every attempt recorded, any failure reported); merge into feat/sidwave-standalone (squash or rebase, each commit building), push, update PR #193 body.
- `feat/sidwave-engine` (sidwave-engine): engine 95fb8378 + verify T0/T1/A0 481dd4fe. Goes to the sidwave repo after PR 1 merges (D8).
- `feat/sidwave-format` (sidwave-format): formatter/diff/merge f1a97cd0 + transforms ace10ef3 (thin tests: needs more). Same destination.
- `feat/sidwave-sidfile` (sidwave-sidfile): SID file module 4c00c5c1. Same destination.
Then: PR 1 gate = independent review (Sonnet reviewer that wrote none of it), U64 check (ask peer c64bridge-64 for all-clear; it holds the U64 until it releases), CI green, rebase, merge. Then create chrisgleissner/sidwave from the split output (D8), port the three feature branches there as PRs.
Quota at 16:00 local 2026-11-26: Claude 5h 18 % (resets ~17:40), Codex 5h 3 % (resets ~19:10). Pause new agent work until reset.
