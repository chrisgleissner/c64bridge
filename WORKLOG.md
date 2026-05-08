# Repository Cleanliness Audit Worklog

## 2026-05-08

1. Confirmed active branch is `copilot/cleanup-dead-unused-code`.
2. Confirmed the worktree was clean at audit restart.
3. Fetched remotes and PR head refs, including `origin/pull/135/head` into local ref `pr-135`.
4. Confirmed `pr-135` points at the current branch head commit.
5. Reviewed repository memory notes relevant to packaging, VICE validation, and generated runtime assets.
6. Read the current root task docs: `PLANS.md`, `WORKLOG.md`, and `worklog.md`.
7. Read the prior cleanup tooling and metadata: `scripts/audit-unused-artifacts.mjs`, `.gitignore`, and `package.json`.
8. Listed `.github/workflows/` and `scripts/` to scope build, release, package, and audit entry points.
9. Identified immediate correctness issues in the inherited cleanup state:
   - root task docs contained stale completed-state conclusions
   - root task docs used runner-specific absolute paths instead of repo-relative paths
   - `scripts/audit-unused-artifacts.mjs` still implemented `**` with a plain `.*` replacement
   - the prior audit approach treated several top-level areas as effectively live by heuristic rather than evidence
10. Replaced the stale root task docs with the current cleanup plan and this worklog before making further substantive changes.
11. Rewrote `scripts/audit-unused-artifacts.mjs` to scan git-tracked files only, cache text reads, self-test glob handling, classify CI and agent workflow artifacts correctly, and emit deterministic output without timestamps or absolute roots.
12. Removed `doc/audit/unused-artifacts-report.json` because it was a volatile committed generated report with absolute runner paths and no durable documentation value.
13. Added `doc/audit/*.generated.json` to `.gitignore` during the transition away from committed audit JSON output.
14. Validated the rewritten audit script with `node scripts/audit-unused-artifacts.mjs --stdout` and corrected its deleted-file handling so it can run before commit while tracked deletions are still present.
15. Manually re-checked suspicious retained artifacts against package, build, MCP, and runtime evidence:
   - `generated/c64`
   - `dist`
   - `src/rag/discover.config.json`
   - `worklog.md`
   - `doc/plans/**`
   - `data/embeddings_*.json`
   - `mcp/**`
16. Identified `scripts/compare-rest/rest-compare-2025-11-01T00-25-21-830Z.json` as stale generated output: the compare tool writes reports to `artifacts/rest-compare/`, the checked-in sample had a timestamp and device-specific URLs, and no code/docs/tests consumed it.
17. Removed `scripts/compare-rest/rest-compare-2025-11-01T00-25-21-830Z.json`.
18. Ran `npm install --no-audit --no-fund` — PASS.
19. Ran `./build build` — PASS.
20. Ran `./build test --platform c64u --target mock` — PASS.
21. Ran `./build test --platform vice --target mock` — PASS.
22. Ran `npm run check:package` — PASS.
23. Ran `node scripts/audit-unused-artifacts.mjs` — PASS; generated output now writes to `artifacts/audit/unused-artifacts-report.generated.json`.
24. Ran `./build test:matrix` — FAIL with an existing assertion in `test/c64Client.test.mjs:644:11` (`both configured initialises both facades and switchBackend swaps the active facade`, `false !== true`). This failure is outside the touched cleanup files.
25. Ran `./build coverage` — PASS with final line coverage `90.63%`.
26. Ran `npm pack --dry-run --json` and confirmed the package no longer includes the removed committed audit report or the removed timestamped compare-rest sample.
27. Added the durable summary `doc/audit/dead-artifact-cleanup.md` with retained-artifact rationales, validation results, and remaining risks.
