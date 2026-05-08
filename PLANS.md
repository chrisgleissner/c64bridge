# Repository Cleanup Audit Plan

## Status

In progress.

## Goals

- Perform a conservative repository-wide audit of `/home/runner/work/c64bridge/c64bridge`.
- Remove only artifacts that are demonstrably dead, stale, redundant, or obsolete.
- Preserve runtime behavior, MCP surface, package contents, build behavior, tests, and coverage expectations.
- Produce an evidence trail in `/home/runner/work/c64bridge/c64bridge/PLANS.md`, `/home/runner/work/c64bridge/c64bridge/WORKLOG.md`, and a machine-readable audit report.

## Non-goals

- No feature work, architecture redesign, or broad refactoring.
- No public MCP tool/resource/schema renames.
- No speculative deletion of ambiguous files.
- No dependency upgrades unless required to keep the existing validation suite working.

## Repository assumptions

- The working repository is `/home/runner/work/c64bridge/c64bridge`.
- The top-level `./build` wrapper is the primary documented build/test entry point.
- Checked-in `dist/`, `generated/`, `mcp/`, `data/`, and `doc/` content may be intentional package/runtime artifacts until proven otherwise.
- This repository is an npm package, so `package.json`, `.npmignore`, `files`, `bin`, and pack output are part of the live contract.

## Cleanup categories

1. Live
2. Public contract
3. Test fixture
4. Generated but required
5. Generated and removable
6. Stale documentation
7. Redundant documentation
8. Dead internal artifact
9. Ambiguous

## Investigation method

1. Inspect repository structure, package metadata, build/test scripts, TypeScript config, packaging rules, and CI workflow.
2. Record baseline validation results before cleanup.
3. Create a repository-local audit tool that scans for incoming references and emits JSON.
4. Manually verify every suspicious artifact with `rg`, file inspection, package metadata review, CI inspection, and documentation review.
5. Remove only high-confidence dead/stale artifacts and update references if needed.
6. Re-run build, tests, coverage, package checks, and startup-related verification.

## Baseline commands

- `cd /home/runner/work/c64bridge/c64bridge && git --no-pager status --short --branch`
- `cd /home/runner/work/c64bridge/c64bridge && npm install --no-audit --no-fund`
- `cd /home/runner/work/c64bridge/c64bridge && ./build build`
- `cd /home/runner/work/c64bridge/c64bridge && ./build test:matrix`
- `cd /home/runner/work/c64bridge/c64bridge && ./build coverage`

## Baseline results

- `npm install --no-audit --no-fund` — PASS.
- `./build build` — PASS.
- `./build test:matrix` — FAIL in the `vice/device` leg because `x64sc` is unavailable in this environment; mock legs ran substantially before the failure.
- `./build coverage` — FAIL in shard `c64u-mock/all-03` before merge completion; coverage output was partial only.

## Candidate artifact list

| Artifact | Category | Evidence summary | Decision | Confidence | Notes |
| --- | --- | --- | --- | --- | --- |
| `/home/runner/work/c64bridge/c64bridge/generated/c64` | Generated but required | Imported by source, referenced by package verification, generated from `doc/c64u/c64-openapi.yaml`, and included in package rules. | Keep. | High | Explicit decision completed. |
| `/home/runner/work/c64bridge/c64bridge/dist` | Generated but required | Published via `package.json` `files`, used by runtime/package entry points. | Keep. | High | Checked-in compiled output appears intentional. |
| `/home/runner/work/c64bridge/c64bridge/src/rag/discover.config.json` | Live | Initially surfaced as a zero-ref heuristic candidate; manual review found path-based use in `src/rag/discover.ts` and copy-to-dist in `scripts/postbuild.mjs`. | Keep. | High | False positive from the first audit pass. |
| `/home/runner/work/c64bridge/c64bridge/worklog.md` | Ambiguous but retained | Historical lowercase worklog at repo root still has a checked-in reference from `doc/plans/vice-backend-switch/plan.md`. | Keep. | Medium | Removing it would leave historical planning documentation broken. |
| `/home/runner/work/c64bridge/c64bridge/doc/plans/**` | Historical documentation | Historical planning documents appear intentionally retained as design records. | Keep. | Medium | No high-confidence stale or broken whole-document removal found. |
| `/home/runner/work/c64bridge/c64bridge/.c64bridge.json` | Dead local artifact | Local-only repo config was accidentally committed by a mandatory progress checkpoint and is not intended as a tracked project file. | Remove and ignore. | High | Prevent repeat accidental commits by adding `.c64bridge.json` to `.gitignore`. |
| `/home/runner/work/c64bridge/c64bridge/PLANS.md` and `/home/runner/work/c64bridge/c64bridge/WORKLOG.md` | Stale documentation | Both files contained unrelated historical task state and no longer matched this cleanup task. | Replace with current audit records. | High | Required by the task and reduces misleading repository state. |

## Per-artifact evidence

### `/home/runner/work/c64bridge/c64bridge/generated/c64`

- `package.json` includes `generated/**/*.js` in published files.
- `package.json` exposes `api:generate` for regenerating `/home/runner/work/c64bridge/c64bridge/generated/c64` from `/home/runner/work/c64bridge/c64bridge/doc/c64u/c64-openapi.yaml`.
- `tsconfig.json` includes `generated/**/*.ts`.
- Source imports `/home/runner/work/c64bridge/c64bridge/generated/c64/index.js` from:
  - `/home/runner/work/c64bridge/c64bridge/src/c64Client.ts`
  - `/home/runner/work/c64bridge/c64bridge/src/device.ts`
  - `/home/runner/work/c64bridge/c64bridge/src/loggingHttpClient.ts`
- `/home/runner/work/c64bridge/c64bridge/scripts/verify-package.mjs` asserts `/home/runner/work/c64bridge/c64bridge/generated/c64/index.js` exists in the package.

### `/home/runner/work/c64bridge/c64bridge/worklog.md`

- The file exists at the repo root and contains historical notes from a prior task.
- At least one checked-in document currently refers to lowercase `worklog.md`: `/home/runner/work/c64bridge/c64bridge/doc/plans/vice-backend-switch/plan.md`.
- Decision: keep. Removing it would leave the historical plan document with a broken reference.

### `/home/runner/work/c64bridge/c64bridge/src/rag/discover.config.json`

- The first audit pass surfaced this file as a likely dead artifact.
- Manual review found live path-based usage in `/home/runner/work/c64bridge/c64bridge/src/rag/discover.ts` (`resolveRagAsset('discover.config.json')`).
- `/home/runner/work/c64bridge/c64bridge/scripts/postbuild.mjs` explicitly copies `discover.config.json` into `dist/rag/`.
- `/home/runner/work/c64bridge/c64bridge/scripts/check-package.mjs` and `/home/runner/work/c64bridge/c64bridge/scripts/verify-package.mjs` require `dist/rag/discover.config.json` in the packaged output.

### `/home/runner/work/c64bridge/c64bridge/.c64bridge.json`

- A repository-root config file was unintentionally committed by the mandatory progress checkpoint tool during this task.
- The file is local-environment state, not a checked-in contract, and is already treated as a repo-local config path by runtime code and tests.
- Decision: delete it from the repository state and add `.c64bridge.json` to `/home/runner/work/c64bridge/c64bridge/.gitignore`.

## Verification commands

- `cd /home/runner/work/c64bridge/c64bridge && ./build build`
- `cd /home/runner/work/c64bridge/c64bridge && ./build test:matrix`
- `cd /home/runner/work/c64bridge/c64bridge && ./build coverage`
- `cd /home/runner/work/c64bridge/c64bridge && npm run check:package`
- `cd /home/runner/work/c64bridge/c64bridge && npm pack --dry-run --json`

## Results

- Added `/home/runner/work/c64bridge/c64bridge/scripts/audit-unused-artifacts.mjs`.
- Generated `/home/runner/work/c64bridge/c64bridge/doc/audit/unused-artifacts-report.json`.
- Replaced stale root audit/task logs in `/home/runner/work/c64bridge/c64bridge/PLANS.md` and `/home/runner/work/c64bridge/c64bridge/WORKLOG.md`.
- Removed the accidentally committed `/home/runner/work/c64bridge/c64bridge/.c64bridge.json`.
- Added `.c64bridge.json` to `/home/runner/work/c64bridge/c64bridge/.gitignore` to prevent future accidental commits.
- Restored `/home/runner/work/c64bridge/c64bridge/package-lock.json` to undo unrelated incidental drift captured by the mandatory progress checkpoint.
- No additional high-confidence dead checked-in product/doc/test/package artifacts were removed after the repository-wide audit.

## Remaining risks

- The `vice/device` validation leg depends on `x64sc`, which is absent in this environment.
- The merged coverage run is not currently green because coverage shard `c64u-mock/all-03` still fails the pre-existing `Streaming tools operate via MCP` test before LCOV merge completes.
- Historical planning/worklog documents may be intentionally retained; ambiguous cases will be kept and documented.
