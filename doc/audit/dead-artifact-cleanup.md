# Dead Artifact Cleanup Audit

## Scope

This audit continues PR `#135` on branch `copilot/cleanup-dead-unused-code`.

Goal: remove only artifacts that are demonstrably dead, stale, local-only, misleading, or obsolete, while retaining anything that still participates in package contents, runtime behavior, MCP surfaces, tests, release flow, or useful historical context.

## Methodology

The final decisions were based on multiple evidence sources, not a single heuristic pass:

1. Static reference audit using `scripts/audit-unused-artifacts.mjs` against git-tracked files only.
2. Package contract audit using `package.json`, `.npmignore`, `npm run check:package`, and `npm pack --dry-run --json`.
3. Build and runtime asset audit using `build`, `scripts/postbuild.mjs`, `scripts/check-package.mjs`, and `scripts/verify-package.mjs`.
4. MCP surface audit using `src/mcp-server.ts`, `src/prompts/registry.ts`, `src/tools/registry/index.ts`, and `scripts/generate-mcp-interface.ts`.
5. Git history checks for historical task artifacts such as `worklog.md` and the timestamped REST comparison JSON.

## Conservative Cleanup Policy

1. Remove only high-confidence artifacts.
2. Do not remove generated, large, or weakly referenced files by appearance alone.
3. When evidence is mixed, keep the artifact and document the reason.
4. Prefer concise durable documentation plus reproducible generated output over committed volatile reports.

## Tool Limitations

- The audit script is heuristic and not a proof of deadness.
- The script scans git-tracked files only; it intentionally ignores untracked local scratch state.
- Large files above 1 MiB and `data/embeddings_*.json` are excluded as text-reference sources to avoid noisy false positives, so those artifacts were cross-checked manually.
- Packaged docs, prompts, scripts, and MCP snapshots require manual judgment because package inclusion alone does not prove runtime necessity.

## Removed Artifacts

| Artifact | Why it looked suspicious | Evidence checked | Why removal was safe |
| --- | --- | --- | --- |
| `doc/audit/unused-artifacts-report.json` | Generated audit output, 107k lines, contained `generatedAt`, absolute runner root, and many self-references. | Script source, git history, package dry-run, grep for direct references. | Replaced by this durable markdown audit plus ignored on-demand output under `artifacts/audit/`. No code, docs, tests, or packaging contract required the committed JSON file. |
| `scripts/compare-rest/rest-compare-2025-11-01T00-25-21-830Z.json` | Timestamped comparison output stored under `scripts/`, contained device-specific URLs and generated metadata. | `scripts/compare-rest-apis.mjs`, grep for references, git history, package dry-run. | The compare tool writes reports to `artifacts/rest-compare/`, not `scripts/compare-rest/`. No code, docs, or tests consumed the checked-in sample, and it polluted the shipped package via `scripts/**`. |

No other deletions met the required confidence bar.

## Retained Suspicious Artifacts

| Artifact | Why it looked suspicious | Evidence checked | Why removal was rejected | Future removal trigger | Confidence |
| --- | --- | --- | --- | --- | --- |
| `generated/c64` | Generated client code and ignored by default in local workflows. | `src/c64Client.ts`, `src/device.ts`, `src/loggingHttpClient.ts`, `package.json`, `scripts/verify-package.mjs`, `scripts/postbuild.mjs`, `doc/c64u/c64-openapi.yaml`. | Runtime imports and package verification require `generated/c64/index.js`, and the build syncs the generated runtime artifacts intentionally. | Only if runtime imports move away from the generated client and package verification stops requiring it. | High |
| `dist` | Checked-in compiled output often indicates stale build artifacts. | `package.json` `main`/`files`, `scripts/cli.js`, `build`, `scripts/check-package.mjs`, `scripts/verify-package.mjs`, `npm pack --dry-run --json`. | `dist/index.js` is the published entrypoint and packaged runtime assets under `dist/rag/` are explicitly required. | Only if the repository stops shipping prebuilt output and the package contract changes accordingly. | High |
| `src/rag/discover.config.json` | JSON under `src/` looked like local config or stale source input. | `src/rag/discover.ts`, `scripts/postbuild.mjs`, `scripts/check-package.mjs`, `scripts/verify-package.mjs`, package dry-run. | The discovery tool resolves this file at runtime, postbuild copies it to `dist/rag/`, and package checks require the packaged copy. | Only if discovery configuration moves to a different packaged asset path. | High |
| `scripts/audit-unused-artifacts.mjs` | One-off audit tooling is often not worth keeping. | Current task requirements, script implementation, self-tests, package dry-run. | The script was hardened rather than left as throwaway code: it now scans git-tracked files, caches text reads, self-tests glob behavior, and writes deterministic ignored output. | Remove only if repository owners decide future audits should be manual or the script stops being maintained. | Medium |
| `PLANS.md` | Root task-state artifact. | `.github/prompts/steer.prompt.md`, current task requirements, current contents. | Required by the current workflow and now accurately reflects the finished cleanup. | Remove only if the repository stops using root execution plans for active agent work. | Medium |
| `WORKLOG.md` | Root task-state artifact. | `.github/prompts/steer.prompt.md`, current task requirements, current contents. | Required by the current workflow and now records the actual commands and results with repo-relative paths only. | Remove only if the repository stops using root worklogs for active agent work. | Medium |
| `worklog.md` | Lowercase historical worklog at repo root looked stale and weakly referenced. | Git history, `doc/plans/vice-backend-switch/plan.md`, current contents. | It is the companion execution record for the retained historical backend-switch plan. Removing it would strip context from that historical design trail. | Only if the historical plan and its companion record are intentionally archived elsewhere together. | Medium |
| `doc/plans/**` | Historical plans can easily become stale clutter. | Directory review, grep references, content inspection. | The subtree still functions as historical design context. No whole-plan subtree was clearly misleading enough to justify deletion. | Remove only when a specific plan is proven obsolete and non-useful as history. | Medium |
| `data/embeddings_*.json` and related large `data/**` corpora | Large generated-looking data files are common cleanup targets. | `src/rag/indexer.ts`, `src/rag/init.ts`, `src/context.ts`, `scripts/verify-package.mjs`, `README.md`, `data/README.md`. | These files back shipped RAG behavior and are required package contents, not scratch outputs. | Only if the repository switches to on-demand embedding generation or a different packaged corpus layout. | High |
| `mcp/**`, `mcp.json`, `server.json` | Static MCP metadata snapshots can look redundant next to dynamic registration code. | `scripts/generate-mcp-interface.ts`, `src/mcp-server.ts`, `src/prompts/registry.ts`, `src/tools/registry/index.ts`, `scripts/update-readme.ts`, package dry-run. | These files are intentionally regenerated snapshots used for packaging, documentation, and client-facing static inspection. | Only if maintainers explicitly drop the checked-in static MCP interface. | High |
| Weakly referenced utility scripts such as `scripts/c64-cli.mjs`, `scripts/capture-backend-switch-screenshots.mjs`, `scripts/sid2wav.sh`, and `scripts/vice/vice-bm-bench.ts` | Manual utility scripts can look like dead leftovers because they have few inbound references. | Audit script output, file naming, package surface review, lack of contradictory runtime/test failures. | They may still be intentionally human-invoked maintenance tools. The evidence was not strong enough to delete them safely. | Remove only after verifying they are unused by maintainers and no longer part of the intended repo toolbelt. | Low |

## Validation Results

| Command | Result | Notes |
| --- | --- | --- |
| `npm install --no-audit --no-fund` | PASS | Dependencies already up to date. |
| `./build build` | PASS | Build, postbuild, README refresh, and MCP interface generation succeeded. |
| `./build test --platform c64u --target mock` | PASS | Completed with exit code `0`. |
| `./build test --platform vice --target mock` | PASS | Completed with exit code `0`. |
| `./build test:matrix` | FAIL | Existing failure outside the cleanup slice: `test/c64Client.test.mjs:644:11` (`both configured initialises both facades and switchBackend swaps the active facade`, `false !== true`). The touched files in this cleanup are docs, `.gitignore`, and `scripts/audit-unused-artifacts.mjs`; the focused mock legs still passed. |
| `./build coverage` | PASS | Completed with exit code `0` and final line coverage `90.63%`. |
| `npm run check:package` | PASS | Required packaged files present, no duplicates. |
| `npm pack --dry-run --json` | PASS | 258 packaged entries, unpacked size `4943169`; removed compare-rest sample and removed audit JSON are absent. |
| `node scripts/audit-unused-artifacts.mjs` | PASS | Writes deterministic ignored output to `artifacts/audit/unused-artifacts-report.generated.json`. |

## Remaining Risks

1. The audit script is intentionally conservative, so some weakly referenced packaged docs, data examples, and utility scripts remain.
2. `./build test:matrix` still reports the pre-existing `test/c64Client.test.mjs` failure noted above.
3. The package still intentionally ships broad `doc/**`, `data/**`, `scripts/**`, and `mcp/**` surfaces, so future cleanup opportunities depend on narrowing that package contract rather than deleting files opportunistically.

## Outcome

The cleanup intentionally stopped after two high-confidence removals and audit-tool hardening. Uncertain removals were avoided on purpose.