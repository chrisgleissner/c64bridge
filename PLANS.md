# C64 Bridge MCP Server Audit Plan

## Current Branch and Repository State

- Branch: `fix/readme`
- Started: `2026-05-08T08:31:39+01:00`
- Package: `c64bridge@0.9.1`
- Package manager declared by repository: `bun@1.3.1`
- Initial worktree state: dirty before this audit started.
- Pre-existing modified files not owned by this audit:
  - `data/context/bootstrap.md`
  - `data/context/fast-paths.md`
  - `data/graphics/petscii-style-guide.md`
  - `data/graphics/sprite-charset-best-practices.md`
  - `data/sound/sid-file-structure.md`
  - `data/sound/sid-programming-best-practices.md`
  - `data/vice/vice-binary-monitor-spec.md`
- Audit-owned files created or updated so far:
  - `PLANS.md`
  - `WORKLOG.md`
  - `doc/refuels/audit.md` planned

## Audit Phases

- [completed] Phase 1 - Repository orientation
- [completed] Phase 2 - Baseline verification
- [completed] Phase 3 - Deep audit and audit document
- [in progress] Phase 4 - Fix planning
- [pending] Phase 5 - Implementation
- [pending] Phase 6 - Verification
- [pending] Phase 7 - Finalization

## Commands Run

- `pwd && git branch --show-current && git status --short` - PASS; recorded current directory, branch, and pre-existing dirty state.
- `rg --files -g '!*node_modules*' | sed -n '1,160p'` - PASS; sampled repository layout.
- `date -Is` - PASS; recorded start timestamp.
- `sed -n '1,220p' PLANS.md` - PASS; inspected prior plan before replacing it with this audit plan.
- `sed -n '1,220p' package.json` - PASS; identified package metadata and scripts.
- `ls -la doc doc/refuels 2>/dev/null || true` - PASS; confirmed `doc/refuels` did not exist.
- `sed -n '1,260p' README.md` - PASS; inspected setup, backend, generated MCP API docs, and resource list.
- `sed -n '1,620p' src/mcp-server.ts` - PASS; inspected stdio MCP server initialization, resources, prompts, tools, diagnostics, and transport setup.
- `find src/tools src/prompts src/rag src/vice -maxdepth 2 -type f | sort` - PASS; mapped source areas.
- `find .github/skills -maxdepth 2 -type f | sort` - PASS; confirmed skill routing files.
- `npm install` - PASS; dependencies up to date; npm audit reports 1 moderate and 1 high vulnerability.
- `npm run build` - PASS; TypeScript compile plus README/MCP generation completed.
- `npm test` - PASS; 735 broad Node tests, MCP batches, and Bun-only tests passed with expected skips.
- `npm run coverage` - FAIL; test shards passed, but `scripts/run-coverage.mjs` failed copying missing `coverage/lcov.info` for the VICE device shard.
- `sed -n '1,280p' scripts/run-coverage.mjs` - PASS; inspected coverage wrapper.
- `rg -n "oneOf|allOf|anyOf|c64://specs|c64://[a-z0-9/-]+" ...` - PASS; found `c64_input` top-level `oneOf` schema and stale `c64://specs/*` resource URIs.
- `node` registry inspection for top-level schema combinators - PASS; confirmed only `c64_input` currently exposes top-level `oneOf`.
- `sed` inspections of `src/tools/types.ts`, registry modules, `src/tools/input.ts`, `src/tools/memory.ts`, `src/c64Client.ts`, and `src/device.ts` - PASS; found memory validation and schema issues.
- `mkdir -p doc/refuels` - PASS; created required audit document directory.

## Findings

| ID | Severity | Area | Finding | Status |
| --- | --- | --- | --- | --- |
| MCP-AUDIT-001 | High | Device-control safety | Numeric address/length parsing accepts partial literals and hex byte parsing can silently truncate malformed bytes; raw memory reads/writes do not consistently reject address-space overflows before device calls. | Planned |
| MCP-AUDIT-002 | High | MCP tool schema/resource metadata | `c64_input` is the only grouped tool still exposing top-level `oneOf`/`discriminator`, and its metadata points at non-existent `c64://specs/*` resources. | Planned |
| MCP-AUDIT-003 | Medium | Coverage architecture | `npm run coverage` can fail after passing test shards because the wrapper assumes every Bun coverage shard leaves `coverage/lcov.info`; the VICE device shard produced no copied report in baseline. | Planned |
| MCP-AUDIT-004 | Low | Documentation/process | `npm install` reports 1 moderate and 1 high dependency audit vulnerability. | Deferred: separate dependency/security review |
| MCP-AUDIT-005 | Trivial | Source formatting | Several inspected source files have minor indentation inconsistencies. | Deferred |

## Fix Decisions

- Do not touch pre-existing modified data files unless audit evidence proves they must change for a non-trivial issue.
- Use repository scripts for generated MCP metadata and README sections where applicable.
- Add or update tests for every behavioral or public API fix.
- Do not make commits.
- Fix MCP-AUDIT-001 by enforcing strict numeric and hex parsing plus 64 KB range checks before memory device calls.
- Fix MCP-AUDIT-002 by using the existing flattened `discriminatedUnionSchema` helper for `c64_input` and replacing stale resources with canonical resource URIs.
- Fix MCP-AUDIT-003 in the coverage wrapper so missing per-shard LCOV is handled deterministically and covered by script tests.

## Actionable TODOs

- [pending] MCP-AUDIT-001 acceptance: invalid partial numeric values such as `$04ZZ` and malformed hex such as `$AAZZ` fail before device writes; read/write ranges that pass `$FFFF` fail locally; tests cover high-level and raw memory paths.
- [pending] MCP-AUDIT-002 acceptance: `c64_input` schema is flattened, `op` is enum-constrained, top-level `oneOf`/`discriminator` are absent, operation metadata remains present, and resources are valid canonical URIs.
- [pending] MCP-AUDIT-003 acceptance: coverage wrapper no longer fails with `ENOENT` when a shard leaves only temporary LCOV output; script tests cover fallback behavior; final coverage command completes.

## Test Results

- `npm install` - PASS.
- `npm run build` - PASS.
- `npm test` - PASS.
- `npm run coverage` - FAIL in wrapper after passing shards; see MCP-AUDIT-003.

## Coverage Results

- Baseline final coverage unavailable because `npm run coverage` failed before final merge.
- Partial prior `coverage/lcov.info` existed after the failed run but cannot be treated as authoritative.

## Remaining Blockers

- No hard blockers.
- Coverage command failure is a confirmed repository issue and planned fix, not an external blocker.
