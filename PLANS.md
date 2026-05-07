# MCP Resource URI Namespace Cleanup

## Objective

Audit and refactor the C64 Bridge MCP resource URI namespace so the active resource surface is domain-first, lowercase, hyphenated, predictable, and maintainable.

## Current findings

- The canonical resource registry lives in `src/rag/knowledgeIndex.ts`.
- MCP resource listing and reading flow through `listKnowledgeResources()` and `readKnowledgeResource()` in `src/mcp-server.ts`.
- Generated snapshots and docs surfaces include `mcp/resources.json`, `mcp/prompts.json`, and README resource tables generated from the same registry.
- Old resource URIs are also hard-coded in prompt metadata, tool metadata, skill docs, agent docs, and README guidance.
- The current namespace mixes redundant names (`basic/basic-spec`, `printer/printer-spec`, `vice/vice-binary-monitor-spec`), context-oriented grouping (`context/*`), chip docs, and prompt material without a fully consistent path scheme.

## Canonical URI mapping

| Old URI | Canonical URI |
| --- | --- |
| `c64://index` | `c64://guide/index` |
| `c64://context/bootstrap` | `c64://guide/bootstrap` |
| `c64://context/fast-paths` | `c64://guide/fast-paths` |
| `c64://vice/vice-binary-monitor-spec` | `c64://vice/binary-monitor-spec` |
| `c64://basic/basic-spec` | `c64://basic/spec` |
| `c64://basic/basic-pitfalls` | `c64://basic/pitfalls` |
| `c64://assembly/assembly-spec` | `c64://assembly/6510-spec` |
| `c64://sound/sid-spec` | `c64://sound/sid/spec` |
| `c64://sound/sidwave` | `c64://sound/sidwave/spec` |
| `c64://sound/sid-file-structure` | `c64://sound/sid/file-format` |
| `c64://sound/sid-programming-best-practices` | `c64://sound/sid/best-practices` |
| `c64://graphics/vic-spec` | `c64://graphics/vic/spec` |
| `c64://graphics/character-set` | `c64://graphics/character-set` |
| `c64://graphics/petscii-style-guide` | `c64://graphics/petscii/style-guide` |
| `c64://graphics/sprite-charset-best-practices` | `c64://graphics/sprite-charset/best-practices` |
| `c64://memory/memory-map` | `c64://memory/map` |
| `c64://memory/low-memory-map` | `c64://memory/zero-page-and-workspace` |
| `c64://memory/kernal-memory-map` | `c64://kernal/rom-routines` |
| `c64://io/io-spec` | `c64://io/spec` |
| `c64://io/cia-spec` | `c64://io/cia/spec` |
| `c64://printer/printer-spec` | `c64://printer/spec` |
| `c64://printer/printer-commodore` | `c64://printer/commodore/text` |
| `c64://printer/printer-commodore-bitmap` | `c64://printer/commodore/bitmap` |
| `c64://printer/printer-epson` | `c64://printer/epson/text` |
| `c64://printer/printer-epson-bitmap` | `c64://printer/epson/bitmap` |
| `c64://printer/printer-prompts` | `c64://printer/prompt-guide` |

## Breaking-change decision

- This is a deliberate breaking change.
- Old resource URIs will be removed from active resource registration.
- No legacy alias layer will be added unless a test or implementation constraint makes it unavoidable.
- If any old URI string remains after implementation, it must be limited to migration notes, negative assertions, or this plan.
- Final decision: the canonical active resource surface is the new domain-first set above, with `c64://graphics/vic/spec` used by request.
- Removed URIs: `c64://index`, `c64://context/*`, `c64://vice/vice-binary-monitor-spec`, `c64://basic/basic-*`, `c64://assembly/assembly-spec`, `c64://sound/sid-*`, `c64://graphics/vic-spec`, `c64://graphics/petscii-style-guide`, `c64://graphics/sprite-charset-best-practices`, `c64://memory/*`, `c64://io/*`, and `c64://printer/printer-*`.
- No aliases were added because the registry is centralized and the tests now explicitly verify that removed URIs are absent or rejected.
- Remaining old URI strings are acceptable only in this plan and in negative-assertion tests that prove removal.

## Files to inspect

- `src/rag/knowledgeIndex.ts`
- `src/mcp-server.ts`
- `src/prompts/registry.ts`
- `src/tools/**/*.ts`
- `test/knowledgeIndex.test.mjs`
- `test/suites/mcpServerResourcesContentSuite.mjs`
- `.github/agents/c64.agent.md`
- `.github/skills/*/SKILL.md`
- `README.md`
- `AGENTS.md`
- `mcp/resources.json`
- `mcp/prompts.json`
- `mcp/tools.json`
- `scripts/generate-mcp-interface.ts`
- `scripts/update-readme.ts`

## Implementation steps

1. Update the central knowledge resource registry to use only canonical URIs.
2. Update related resource links, prompt metadata, tool metadata, and any generated-surface inputs that still reference old URIs.
3. Update tests to assert canonical listing/reading and rejection or absence of old URIs.
4. Regenerate derived MCP interface artifacts and README tables if the build pipeline owns them.
5. Sweep docs and skills so the canonical namespace is the only active documented surface.

## Test plan

- Run targeted resource tests first:
  - `bun test test/knowledgeIndex.test.mjs`
  - `bun test test/suites/mcpServerResourcesContentSuite.mjs`
- Run repo validation commands that exist and are appropriate:
  - `npm run build`
  - `npm test`
  - `npm run test:matrix`
  - `npm run lint` if available
- Run repository searches after changes to confirm old URIs are absent from active code and docs.

## Commands run

- `rg "c64://[A-Za-z0-9/_-]+" ...`
- `rg "listKnowledgeResources|readKnowledgeResource|KnowledgeResource" src`
- `rg "resources.json|prompts.json|listKnowledgeResources\\(" src scripts test`
- `view PLANS.md`
- `view src/rag/knowledgeIndex.ts`
- `view src/mcp-server.ts`
- `view README.md`
- `view mcp/resources.json`
- `view mcp/prompts.json`
- `npm run build`
- `npm test`
- `npm run test -- --platform=c64u --target=mock`
- `npm run test:matrix`
- `npm run lint`
- `npm run rag:rebuild`
- `bun test ...` (direct targeted invocation was unreliable in this environment and recursively mis-resolved test paths; used repo test scripts instead)

## Results

- Central registry located and confirmed as the source of truth.
- Generated MCP interface files confirmed to derive from the registry/build pipeline.
- Hard-coded old URIs confirmed across tool metadata, prompts, skills, agent docs, README, and generated artifacts.
- Canonical graphics URI adjusted during implementation to `c64://graphics/vic/spec` per user direction.
- Added `src/rag/resourceUris.ts` as the single canonical URI source used by the registry and tests.
- Updated the knowledge resource registry, prompt metadata, tool metadata, generated MCP artifacts, resource content markdown, and user-facing docs to use only canonical URIs.
- Regenerated the RAG embedding bundles so embedded provenance URIs also use the canonical namespace.
- Added and updated tests that verify canonical resource listing, canonical reads, removed-URI absence, and removed-URI rejection.
- Literal repository sweeps now show removed URIs only in this plan and in negative tests that intentionally assert rejection.
- Validation results:
  - `npm run build` — PASS
  - `npm test` — PASS
  - `npm run test -- --platform=c64u --target=mock` — PASS on retry
  - `npm run test:matrix` — PASS
  - `npm run lint` — PASS
  - `npm run rag:rebuild` — PASS
  - Final post-rebuild `npm run build && npm test` — PASS
  - Direct `bun test` file-by-file invocation — not reliable in this repo/runtime; it recursively mis-resolved paths and produced `EMFILE`/module-resolution errors unrelated to the refactor, so repo-owned test scripts were used for validation instead.

## Blockers

- None.

## Remaining work

- None.
