# SIDWAVE standalone: state

Resume instructions for a fresh agent: read `prompt.md` (the brief), then this file, then the tail of `evidence/ledger.jsonl`. Do not repeat work recorded here.

## Current stage

S0 Baseline (in progress), on branch `feat/sidwave-standalone` from `origin/main` `43f775ba`.

## Environment notes

- `bun install --frozen-lockfile` fails here (`segfault-handler` needs `node-gyp`). Use `npm ci` for dependency installs.
- Tools present: node 24.22.1, bun 1.3.1, `/usr/bin/sidplayfp`, `/usr/local/bin/x64sc`, `git-filter-repo`, `codex`, `gh` (logged in).
- Bulky artifacts and logs: `~/.c64bridge/sidwave-standalone/`.

## Decisions

(see prompt.md section 4; additional decisions below)

## Disproven hypotheses

(none yet)

## Pre-existing failures

- `npm run test:node` at 43f775ba: 6 failures, none SIDWAVE (task-owner fixture, meta/backgroundState, meta/taskOwnership, meta/taskRetention, updateReadme, start.test 'imports src entry under Bun'). Not a CI gate. `npm test` (Bun) is clean.

## Hardware and VICE coordination

- 2026-11-26: user asked to coordinate machine use with the modern-mcp session (peer `c64bridge-64`). It proposed: it uses the U64, this session the C64U. Brief section 2 forbids this session to contact the C64U, so the reply was: no C64U unless the user confirms; time-share the U64, each session asks the other for an all-clear before a session. This session's VICE: monitor ports 6520-6529, Xvfb displays :120-:129 (set VICE_XVFB_DISPLAY=:121 for `test:vice:device`). Attach only to own VICE instances.
- Agreed with peer: U64 time-shared, nobody uses the C64U. Peer holds the U64 until it sends an explicit release; afterwards each side asks for an all-clear before U64 use. Peer VICE: ports 6510-6519, displays :110-:119.

## Backlog (user additions)

- 2026-11-26, user: the public repo `chrisgleissner/sidwave` ("SID Wave") gets a great `README.md`, informative, clear, concise and appealing to musicians and developers alike, and a repository structure similar to the user's other repos (c64bridge, sidflow: look at their top-level layout, README sections, badges, doc/ folder, CI workflows, CHANGELOG, LICENSE). Draft the README in `packages/sidwave/README.md` from S2 onward (a minimal version ships with PR 1, the full one in S9) so the split script carries it. Repository creation itself stays at S9 step 1 as the brief orders (creating it earlier would expose an unfinished package); the user's message confirms the authority for it.

## Next action

Finish S0: baseline script `scripts/sidwave-baseline.mjs`, run it, record Bun and Node test totals, coverage, package contents, MCP schemas, startup time; resolve prompt section 3.6.
