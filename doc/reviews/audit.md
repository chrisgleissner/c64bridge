# C64 Bridge MCP Server Audit

## Scope

This audit reviews the C64 Bridge repository as an MCP server for C64 Ultimate/C64U REST devices and VICE emulator control. It covers server initialization, tool/resource/prompt registration, tool schemas and results, device-control safety, VICE integration, C64 Ultimate integration, documentation consistency, and test/coverage architecture.

## Assumptions

- The local repository is the source of truth for supported behavior.
- The current branch is `fix/readme`.
- Pre-existing modified `data/**` files are user-owned unless a finding specifically requires editing them.
- Real hardware is not required for fixes where mock or emulator tests cover the behavior.
- Compatibility aliases for removed legacy resource URIs are not required; tests already assert legacy URI rejection.

## Methodology

1. Inspected repository layout, package scripts, README, AGENTS instructions, skill routing, and MCP generated artifacts.
2. Inspected `src/mcp-server.ts`, tool registries, schema utilities, knowledge resource registry, VICE backend, C64U backend, and client device-control helpers.
3. Ran baseline install/build/test/coverage commands.
4. Scanned for top-level tool schema combinators, stale resource URIs, broad validation gaps, and hidden-result patterns.
5. Classified findings with the requested severity model and mapped fixes to tests.

## Repository Areas Inspected

- `src/mcp-server.ts`
- `src/tools/**`
- `src/rag/resourceUris.ts`
- `src/rag/knowledgeIndex.ts`
- `src/c64Client.ts`
- `src/device.ts`
- `src/vice/**`
- `src/prompts/registry.ts`
- `scripts/run-coverage.mjs`
- `scripts/run-tests.ts`
- `README.md`
- `AGENTS.md`
- `.github/skills/**`
- `mcp/**`
- `test/**`

## MCP Server Design Review

The server uses the official TypeScript MCP SDK and registers `resources/list`, `resources/read`, `tools/list`, `tools/call`, `prompts/list`, and `prompts/get` handlers over stdio. Diagnostics are written to stderr/files, leaving stdout for the MCP protocol. Tool errors are returned as tool results with `isError`, which matches MCP expectations for model-visible tool failures.

Confirmed non-issue: optional HTTP CLI parsing exists but current `main()` always connects stdio; the README describes stdio as canonical. No fix is required for this audit because no HTTP server path is advertised as the normal agent transport.

## Tool Design Review

Most public tools are grouped under names such as `c64_program`, `c64_memory`, `c64_config`, and `c64_sound` with an `op` discriminator. The shared `discriminatedUnionSchema` intentionally flattens operations to avoid top-level `oneOf`, which is correct for common MCP/LLM client compatibility.

Confirmed issue: `c64_input` is an outlier and still exposes top-level `oneOf` plus `discriminator`. Its metadata also references `c64://specs/assembly` and `c64://specs/memory-map`, which are not registered resources.

## Resource URI Design Review

Canonical resources use the `c64://` scheme with concise namespaces such as `guide`, `basic`, `assembly`, `graphics`, `sound`, `memory`, `io`, `printer`, `vice`, and `platform`. The registered resource list is stable, discoverable, and documented in README-generated sections. Tests assert old legacy URI forms are rejected.

Confirmed non-issue: legacy resource aliases do not need to be preserved because repository tests already reject legacy direct reads.

Confirmed issue: tool metadata in `c64_input` points to stale `c64://specs/*` URIs outside the canonical resource set.

## Device-Control Safety Review

The tool layer generally bounds address lengths, file image parameters, stream names, joystick values, and grouped operations. Memory mutation paths support verification and C64U pause/resume where applicable.

Confirmed issue: lower-level client parsing accepts partial numeric literals through `parseInt`, so values such as `$04ZZ` can resolve to `$0004`. Hex byte parsing can also silently truncate through `Buffer.from(value, "hex")`, so malformed data such as `$AAZZ` can become `$AA`. Raw memory helpers do not consistently reject address ranges that cross `$FFFF` before calling a backend.

## VICE Integration Review

VICE support is separated through `ViceBackend`, `ViceClient`, readiness helpers, and Binary Monitor guidance resources. Tests cover monitor framing, single-client behavior, process launch, readiness, resource get/set, mock and device smoke paths. Joystick simulation is correctly marked VICE-only at operation-platform level.

Confirmed issue: `c64_input` schema compatibility affects VICE joystick discoverability in some clients.

## C64 Ultimate REST Integration Review

C64U REST base URLs are normalized through config and environment handling. Network passwords are sent as `X-Password`. HTTP clients use timeouts. Tests cover mock REST endpoints, password behavior, memory, runners, drives, config, streams, and files.

Possible issue requiring external confirmation: local option-list validation for arbitrary C64U configuration values is limited because firmware-provided option inventories are not fully represented in repository data. The current safe approach is to list/read config first and rely on firmware rejection for unknown values. This was not fixed without a reliable local option source.

## Error Handling Review

Tool errors are normalized through `ToolValidationError`, `ToolExecutionError`, `toolErrorResult`, and `unknownErrorResult`. Tool-level failures are model-visible rather than protocol-level except for unknown tool lookup through registry invocation.

Confirmed issue: memory parse failures for partial literals are not reliably raised today, reducing the value of this error-handling layer for device safety.

## Schema/Input Validation Review

Most grouped tools use flattened schemas with enum-constrained `op`. String, number, boolean, array, object, and optional schema helpers enforce runtime validation.

Confirmed issue: `c64_input` still has a top-level `oneOf`.

Confirmed issue: C64Client numeric and hex parsing needs stricter validation below the tool layer so public methods and internal raw paths fail safely.

## Documentation Review

README, AGENTS, skills, and generated `mcp/**` files are broadly consistent with current grouped tool names and canonical resource URIs. README resource lists are generated.

Confirmed issue: generated `mcp/tools.json` and schema output inherit the stale `c64_input` resources and top-level `oneOf` until source is fixed and generation reruns.

## Test Architecture and Coverage Review

The repository has broad unit, integration, MCP harness, VICE mock, and VICE device tests. `npm test` passes. Coverage is intended to be enforced by `scripts/run-coverage.mjs` and `.c8rc.json` with 90% thresholds.

Confirmed issue: baseline `npm run coverage` failed after passing shards because the wrapper attempted to copy a missing `coverage/lcov.info` for the VICE device shard.

## Findings

| ID | Severity | Area | Finding | Evidence | Impact | Recommended fix | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MCP-AUDIT-001 | High | Device-control safety | Numeric and hex parsing can accept partial malformed input, and raw memory access lacks consistent 64 KB range guards. | `src/c64Client.ts` uses `parseInt`; `hexStringToBuffer` and `src/tools/memory.ts` parse hex through `Buffer.from(..., "hex")`; raw reads/writes do not consistently validate range overflow. | Malformed addresses or bytes can target the wrong memory location or write truncated data before a device call fails. | Enforce full-literal parsing, strict hex validation, and range checks before memory reads/writes. Add regression tests. | Planned |
| MCP-AUDIT-002 | High | MCP schema/resource metadata | `c64_input` exposes top-level `oneOf`/`discriminator` and stale `c64://specs/*` resources. | `src/tools/input.ts`; generated `mcp/tools.json` and `mcp/schemas/c64_input.schema.json`. | Some MCP/LLM clients may fail to call the tool, and metadata points agents to resources that cannot be read. | Use flattened `discriminatedUnionSchema` and canonical resources. Regenerate MCP artifacts and tests. | Planned |
| MCP-AUDIT-003 | Medium | Coverage architecture | Coverage command fails with `ENOENT` copying `coverage/lcov.info` after VICE device shard. | Baseline `npm run coverage` failed in `scripts/run-coverage.mjs:181`. | Required coverage verification cannot complete reliably even when tests pass. | Make the wrapper robust to Bun temporary LCOV output and add script regression tests. | Planned |
| MCP-AUDIT-004 | Low | Dependency hygiene | `npm install` reports 1 moderate and 1 high vulnerability. | Baseline install output. | Potential dependency risk, but not enough local evidence to safely upgrade during this audit. | Defer to a dependency/security review with package upgrade testing. | Deferred |
| MCP-AUDIT-005 | Trivial | Formatting | Some inspected source has indentation inconsistencies. | `src/rag/knowledgeIndex.ts`, `src/tools/memory.ts`. | Cosmetic only. | Defer unless adjacent to required edits. | Deferred |

## Fix Plan Mapped To Findings

- MCP-AUDIT-001: update strict parsers and range guards in `src/c64Client.ts` and `src/tools/memory.ts`; update `test/c64ClientInvalidInputs.test.mjs` and `test/memory.test.mjs`.
- MCP-AUDIT-002: update `src/tools/input.ts`; update input/schema tests; regenerate `README.md` and `mcp/**` via `npm run build`.
- MCP-AUDIT-003: update `scripts/run-coverage.mjs`; update `test/scripts/run-coverage.test.mjs`.

## Confirmed Issues

- MCP-AUDIT-001
- MCP-AUDIT-002
- MCP-AUDIT-003

## Possible Issues Requiring External Confirmation

- Full local option-list validation for C64U firmware configuration values depends on firmware-provided category/item/value metadata not present in repository evidence.

## Non-Issues

- Legacy resource URI aliases are intentionally absent.
- Stdio-first transport is consistent with repository instructions.
- VICE Binary Monitor reference is present and routed through canonical resource and skills.

## Trivialities Intentionally Deferred

- Formatting-only indentation cleanup not adjacent to required edits.

## Final Status After Implementation

Implementation has not yet started. This section will be updated after fixes and final verification.
