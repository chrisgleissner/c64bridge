# Release 0.9.2 Preparation Plan

## Goal
Prepare `/home/runner/work/c64bridge/c64bridge` for release `0.9.2` without publishing, tagging, committing, or pushing release artifacts.

## Assumptions
- The correct comparison base is tag `0.9.1` if it exists.
- The top-level `./build` script is the authoritative documented build tool from `README.md`.
- Release metadata should follow the existing `0.9.1` convention by updating `package.json`, `package-lock.json`, `mcp.json`, and `server.json`, then keeping generated static metadata in sync where the build regenerates it.
- The changelog entry should stay concise, use the existing `## version - YYYY-MM-DD` heading style, and prefer `Highlights` / `Fixes` sections when that matches recent entries.

## Files Inspected
- `/home/runner/work/c64bridge/c64bridge/README.md`
- `/home/runner/work/c64bridge/c64bridge/CHANGELOG.md`
- `/home/runner/work/c64bridge/c64bridge/package.json`
- `/home/runner/work/c64bridge/c64bridge/package-lock.json`
- `/home/runner/work/c64bridge/c64bridge/mcp.json`
- `/home/runner/work/c64bridge/c64bridge/server.json`
- `/home/runner/work/c64bridge/c64bridge/mcp/server.json`
- `/home/runner/work/c64bridge/c64bridge/build`
- `/home/runner/work/c64bridge/c64bridge/scripts/prepare-release.mjs`
- `/home/runner/work/c64bridge/c64bridge/scripts/generate-changelog.mjs`

## Repository Investigation
- Current branch: `copilot/prepare-release-092`
- Worktree state at start of this task: clean
- Repository was initially shallow; unshallowed with tags before comparing release history.
- Recent tags after fetch: `0.9.1`, `0.9.0`, `0.8.1`, `0.8.0`, ...
- Current package version before edits: `0.9.1`
- Existing release notes file: `/home/runner/work/c64bridge/c64bridge/CHANGELOG.md`
- Chosen comparison base: `0.9.1`

## README-Derived Build and Release Commands
- Build tool: `./build`
- Build command: `./build build`
- Test matrix command: `./build test:matrix`
- Coverage command: `./build coverage`
- Full CI-equivalent default command: `./build`
- Release preparation command documented in README: `./build release --version 1.2.3`
- README does not document a separate formatter, linter, or standalone typecheck command; `./build build` performs TypeScript compile plus README/MCP generation.

## Changelog Style Notes
- File uses top-level heading `# Changelog`.
- Recent entries use `## <version> - <YYYY-MM-DD>`.
- Recent releases prefer concise `### Highlights` and `### Fixes` sections; some older releases also use `Other`, `Features`, or `Bug Fixes`.
- Tone is brief and user-facing, with bullets ordered from most important changes to smaller fixes.
- Contributor acknowledgements appear only when relevant and are not mandatory.

## Candidate 0.9.2 Themes from `0.9.1..HEAD`
- Expanded translation tooling with a stronger assembler, shared opcode inventory, a full disassembler, BASIC tokenization, and VICE symbol support.
- Improved grouped input-tool schema compatibility and aligned resource metadata with current docs.
- Hardened memory validation and coverage/test tooling, with an additional README polish fix.

## Commands Run
- `git --no-pager status --short --branch && git --no-pager tag --sort=-version:refname | head -20` — PASS
- `git rev-parse --is-shallow-repository && git --no-pager log --oneline -n 15` — PASS
- `git fetch --unshallow origin --tags` — PASS
- `git branch --show-current && git rev-parse --is-shallow-repository && git --no-pager status --short && git --no-pager tag --sort=-version:refname | head -10 && git --no-pager log --oneline --decorate 0.9.1..HEAD && git --no-pager diff --stat 0.9.1..HEAD` — PASS
- `./build build` — PASS
- `./build test:matrix` — FAIL on baseline run; one flaky network-dependent `downloads GitHub repo zip via default fetcher` test failed during the c64u/mock suite.
- `./build coverage` — FAIL on baseline run because the same network-dependent fetch test failed in a coverage shard.

## Validation Notes
- The documented build path is healthy.
- Baseline test/coverage failures appear pre-existing and unrelated to release metadata; they currently point to a flaky GitHub fetcher test rather than the release-preparation files.
- Re-run validation after metadata/changelog updates to confirm the release-preparation changes did not introduce new failures.

## Changelog Decisions
- Use `0.9.1` as the comparison base.
- Keep the new `0.9.2` entry short and user-facing.
- Lead with assembler/disassembler and translation improvements.
- Include schema/resource compatibility and validation/tooling hardening as fixes.
- Exclude internal plan/worklog/audit file churn from release notes.
- Do not copy raw commit subjects or include commit hashes.

## Remaining Work
- [in progress] Update version metadata for `0.9.2` using the documented release workflow as the basis, then refine any generated output manually as needed.
- [pending] Add a polished `0.9.2` entry to `/home/runner/work/c64bridge/c64bridge/CHANGELOG.md`.
- [pending] Verify whether generated static metadata needs regeneration after the version bump.
- [pending] Re-run the relevant documented `./build` validation commands and record final results.
- [pending] Confirm the worktree contains only intentional release-preparation changes.

## Blockers
- No hard blocker yet.
- Current risk: flaky network-dependent GitHub fetch test may continue to make `./build test:matrix` and `./build coverage` nondeterministic.
