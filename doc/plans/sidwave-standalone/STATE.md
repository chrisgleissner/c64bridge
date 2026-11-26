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

## Backlog (user additions)

- 2026-11-26, user: the public repo `chrisgleissner/sidwave` ("SID Wave") gets a great `README.md`, informative, clear, concise and appealing to musicians and developers alike, and a repository structure similar to the user's other repos (c64bridge, sidflow: look at their top-level layout, README sections, badges, doc/ folder, CI workflows, CHANGELOG, LICENSE). Draft the README in `packages/sidwave/README.md` from S2 onward (a minimal version ships with PR 1, the full one in S9) so the split script carries it. Repository creation itself stays at S9 step 1 as the brief orders (creating it earlier would expose an unfinished package); the user's message confirms the authority for it.

## Next action

Finish S0: baseline script `scripts/sidwave-baseline.mjs`, run it, record Bun and Node test totals, coverage, package contents, MCP schemas, startup time; resolve prompt section 3.6.
