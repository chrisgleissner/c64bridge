# Worklog

## 2026-03-26 17:05 - Refactor start

Started the repository-wide skill architecture refactor. Confirmed that execution logic currently lives in multiple places: the legacy agent-specific skill directory, `.github/prompts`, `src/prompts/registry.ts`, `AGENTS.md`, `.github/copilot-instructions.md`, `.github/agents/c64.agent.md`, and `data/context/fast-paths.md`.

Confirmed the required cleanup scope for anthem-facing content. The public prompt registry, generated MCP metadata, agent instructions, context docs, and `src/tools/meta/audio.ts` all expose the old preset name or anthem wording today.

## 2026-03-26 17:12 - Skill catalog created

Created the new `.github/skills` catalog as the single planned home for execution guidance. The catalog covers prompt-backed flows and the extra operational domains that previously existed only as Claude-local skills, so the repository no longer depends on agent-specific skill paths.

## 2026-03-26 17:28 - Routing layers refactored

Rewrote every prompt file under `.github/prompts` to point at a matching skill instead of describing tool sequences. Replaced the MCP prompt registry implementation with a routing-only model that references `.github/skills`, preserved prompt arguments, and renamed the public preset prompt to neutral music-demo naming.

## 2026-03-26 17:36 - Preset compatibility and cleanup

Made `fuer_elise` the only public preset while keeping the legacy caller path as an internal alias that normalizes to the same preset. Removed the legacy duplicate skill files, rebuilt the project to regenerate README and MCP metadata, and confirmed that generated artifacts no longer expose the removed prompt or preset names.

## 2026-03-26 17:46 - Prompt regression fix and final validation

Restored argument-aware routing notes in `src/prompts/registry.ts` so MCP prompt responses remain routing-only while still surfacing SID- and sprite-specific guidance for prompt arguments. Rebuilt generated MCP artifacts, reran the targeted prompt and preset tests, and completed a clean `npm run test:matrix` run.

## 2026-03-27 13:10 - MCP Registry OIDC migration analysis

Inspected the release pipeline and found the MCP Registry publish path in `.github/workflows/release.yaml` still used a secret-backed GitHub authentication path rather than OIDC. Confirmed the required migration scope: remove the secret-backed env var, add `id-token: write` to the release job permissions, keep the npm publish and release-note flow intact, and leave the MCP publish ordering as `validate -> login github-oidc -> publish` after npm package visibility.

Verified registry compatibility inputs before changing the workflow: `package.json` now exposes `mcpName` as `io.github.chrisgleissner/c64bridge`, and `server.json` exists at the repository root with matching `name`, `version`, npm package identifier, and stdio transport.

## 2026-03-27 13:24 - MCP Registry OIDC migration validation

Updated `.github/workflows/release.yaml` to use GitHub OIDC by adding `id-token: write`, removing the secret-backed env binding, and switching the MCP auth step to `./mcp-publisher login github-oidc`. Updated `doc/developer.md` to document the OIDC flow and added `.mcpregistry_github_token` to `.gitignore` so local scratch tokens do not reappear in commit candidates.

Validation evidence:

- Static search target reduced to zero secret-backed MCP auth references in the release workflow, while preserving the required `login github-oidc` command.
- `server.json` validates with `mcp-publisher validate server.json`.
- `package.json` `mcpName` and `server.json` `name` remain aligned on `io.github.chrisgleissner/c64bridge`.
- The release workflow still preserves the existing order for npm publication, changelog extraction, release-note updates, package visibility wait, MCP manifest validation, OIDC login, and MCP publish.

## 2026-03-27 13:42 - Release script regression fix

The first full `npm run test:matrix` pass exposed a regression in `test/scripts/prepare-release.test.mjs`: the temporary fixture intentionally omits a root `server.json`, but `scripts/prepare-release.mjs` had started requiring one unconditionally. Updated the release script to refresh `server.json` only when that file exists, preserving the new registry-manifest versioning in this repository while remaining backward-compatible for fixture repositories and older consumers.

Follow-up validation for this regression is to rerun the targeted prepare-release test and then rerun the full matrix.

## 2026-03-27 13:58 - Release workflow command review

Reviewed the critical release workflow commands added for MCP Registry publication.

- Verified `curl -L ... | tar xz mcp-publisher` downloads and extracts a working publisher binary.
- Verified `./mcp-publisher validate server.json` succeeds against the current root manifest.
- Verified `./mcp-publisher publish server.json` accepts the positional manifest argument; local execution stops at registry authentication as expected outside GitHub Actions.
- Verified `./mcp-publisher logout` succeeds.
- Verified the installed CLI accepts `login github-oidc` as a supported login mode.

The npm visibility polling loop originally had one real shell bug under GitHub Actions' default `bash -e -o pipefail`: `PUBLISHED_VERSION=$(npm view ...)` would terminate the step on the first 404 instead of retrying. Updated the loop to capture lookup failures without aborting, so it now retries until the version appears or the timeout is reached.

Revalidated after the fix:

- Targeted `test/scripts/prepare-release.test.mjs` passed.
- Full `npm run test:matrix` completed with exit code 0.

Additional shell verification:

- Ran the exact lookup command under strict Bash (`bash -eo pipefail -c 'PACKAGE_VERSION=0.8.0; npm view "c64bridge@${PACKAGE_VERSION}" version --json'`) and it returned `"0.8.0"`.
- Ran the retry-fragment form for an unpublished version under strict Bash and confirmed it produced an empty `PUBLISHED_VERSION` without aborting the shell.
- Set `defaults.run.shell: bash` on the release job so GitHub Actions executes the polling loop and variable expansion with explicit Bash semantics instead of relying on the runner default.

## 2026-05-07 13:08 - PR convergence steering and compatibility fixes

Applied a small steering refinement to the active PR convergence work by appending a coverage-specific TODO to `PLANS.md` and immediately executing the related fixes needed to keep the pull request mergeable.

Changed `src/tools/types.ts` so flattened discriminated-union schemas remain strict with `additionalProperties: false`, and updated `src/tools/memory.ts` so memory reads keep the short text summary and metadata fields while still exposing `hexData` through `structuredContent` for Claude-compatible JSON access.

Validation: updated the focused schema and memory tests to cover the restored behavior, then reran those targeted checks to confirm strict schema output, backward-compatible memory read responses, and continued structured JSON access before proceeding to broader validation.

Broader validation completed afterward: `npm run build` passed cleanly, and `npm run coverage` finished with `lines.pct = 90.79`, keeping the repository above the required 90% threshold after the convergence fixes.
