# Repository Cleanliness Audit Plan

## Current Branch

- `copilot/cleanup-dead-unused-code`
- PR context: `#135 Audit repository artifacts and remove stray local config state`

## Current Task Status

- Status: completed
- Worktree baseline: clean when audit restarted on 2026-05-08
- Prior PR conclusion: useful starting point, not accepted without revalidation
- Corrected during execution:
  - stale runner-specific absolute paths in root task docs
  - stale completed-state language in root task docs
  - incorrect `**` glob handling in `scripts/audit-unused-artifacts.mjs`
  - repeated text-file rereads and deleted-file handling in the audit script
  - committed volatile generated audit output strategy
  - stale packaged timestamped REST comparison output

## Baseline Assumptions

- `build` is the primary project wrapper for build, test, and coverage validation.
- `dist/`, `generated/`, `mcp/`, `data/`, and `doc/` may be intentional package, runtime, MCP, or historical artifacts until disproven.
- Published package contents are defined by `package.json`, `.npmignore`, build scripts, and `npm pack --dry-run --json`.
- Historical documentation may be retained when it still provides architectural or traceability value.

## Conservative Cleanup Policy

1. Remove only artifacts that are high-confidence dead, stale, local-only, misleading, or obsolete.
2. Do not remove artifacts solely because they are generated, weakly referenced, large, or old.
3. Treat package contract, runtime assets, MCP-backed files, tests, fixtures, release tooling, and historical docs as live until disproven.
4. When evidence is mixed, keep the artifact and document why removal was rejected.
5. Prefer small safe deletions and documentation hardening over broad scrubs.
6. Keep committed audit output deterministic and repo-relative.

## Audit Strategy

1. Inspect branch, PR, prior cleanup commits, and current worktree state.
2. Re-check package contract, build scripts, CI workflows, MCP registration, runtime asset loading, and generated-code inputs.
3. Fix or replace the audit tooling before relying on it for removal decisions.
4. Classify suspicious artifacts using at least three independent evidence sources where practical.
5. Remove only high-confidence stale artifacts.
6. Write a durable audit summary in `doc/audit/` for both removals and intentional retentions.
7. Re-run build, test, coverage, package, and pack validation and record exact outcomes.

## Candidate Artifact Categories

- Generated but required
- Generated and removable
- Runtime asset
- MCP surface backing artifact
- Package contract
- Test fixture or helper
- Historical documentation retained intentionally
- Stale task artifact
- Local-only tracked config
- Dead internal artifact
- Ambiguous, retained conservatively

## Evidence Requirements

For any removal candidate, require evidence from the relevant subset of:

- static references: imports, exports, dynamic imports, requires, path joins, basename references, markdown links
- package contract: `files`, `bin`, `main`, scripts, `.npmignore`, `npm pack --dry-run --json`
- build and release flow: `build`, prebuild/postbuild scripts, package verification, generated-code inputs and outputs
- MCP surface: registered tools, prompts, resources, backing files, generated interface snapshots
- runtime asset loading: config resolution, JSON copies to `dist`, prompt/resource reads, dynamic file reads
- tests and fixtures: direct references, glob discovery, helper loading
- CI workflows and release automation
- git history where historical intent or stale status is ambiguous

## Commands To Run

Baseline and post-change validation targets:

- `npm install --no-audit --no-fund`
- `./build build`
- `./build test --platform c64u --target mock`
- `./build test --platform vice --target mock`
- `./build test:matrix`
- `./build coverage`
- `npm run check:package`
- `npm pack --dry-run --json`
- `node scripts/audit-unused-artifacts.mjs`

Focused audit commands as needed:

- `git status --short --branch`
- `git log --oneline main..HEAD`
- `git log --follow -- <path>`
- `rg` searches for direct and basename references

## Validation Plan

1. Capture baseline command results before substantive cleanup decisions.
2. Fix audit tooling or explicitly remove it if it does not merit retention.
3. Re-run the audit tooling after cleanup decisions.
4. Run the full post-change validation set.
5. Record exact failures, distinguish environmental or pre-existing failures, and avoid overstating success.

## Deliverables

- Updated `PLANS.md` and `WORKLOG.md` with repo-relative paths only
- Hardened or intentionally removed `scripts/audit-unused-artifacts.mjs`
- Durable audit summary under `doc/audit/`
- Any high-confidence stale/local artifacts removed
- Explanations for retained suspicious artifacts
- Final cleanup commit

## Completion Summary

- Removed `doc/audit/unused-artifacts-report.json` and replaced it with `doc/audit/dead-artifact-cleanup.md` plus ignored generated output under `artifacts/audit/`.
- Removed `scripts/compare-rest/rest-compare-2025-11-01T00-25-21-830Z.json` as stale generated output that was leaking into the package.
- Hardened `scripts/audit-unused-artifacts.mjs` so it now:
  - scans git-tracked files only
  - caches text reads once
  - self-tests glob handling, including `**`
  - avoids volatile timestamps and absolute paths in committed outputs
  - writes default generated output outside the packaged doc tree
- Retained ambiguous artifacts such as `generated/c64`, `dist`, `src/rag/discover.config.json`, `worklog.md`, `doc/plans/**`, `data/embeddings_*.json`, and `mcp/**` with explicit rationale in `doc/audit/dead-artifact-cleanup.md`.

## Validation Outcome

- `npm install --no-audit --no-fund` — PASS
- `./build build` — PASS
- `./build test --platform c64u --target mock` — PASS
- `./build test --platform vice --target mock` — PASS
- `./build test:matrix` — FAIL due to existing `test/c64Client.test.mjs:644:11` runtime-switching assertion, outside the touched cleanup files
- `./build coverage` — PASS (`90.63%` line coverage)
- `npm run check:package` — PASS
- `npm pack --dry-run --json` — PASS; removed stale artifacts are absent from the package
- `node scripts/audit-unused-artifacts.mjs` — PASS
