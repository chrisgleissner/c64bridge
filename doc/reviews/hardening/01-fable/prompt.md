# Hardening 01 implementation

Repository: `/home/chris/dev/c64/c64bridge`

Implement every confirmed finding in [review.md](./review.md): **HARD01-001 through HARD01-035**. This is an implementation task, not a second review. The review's executive-summary/count prose is stale in places; the findings index and detailed findings are authoritative. Do not omit a finding because it is P3, Medium confidence, or shares a file with another finding.

## Outcome

Deliver a coherent, production-safe hardening change that eliminates the false-success, wrong-target, lifecycle, input, file-system, SID, and packaging failures described in the review. Preserve the public MCP contract except where an existing success result is demonstrably false; in those cases, return a clear failure with actionable details. Add focused automated regression tests for every finding, update generated artifacts only when the source/contract change requires it, and leave the working tree with all relevant checks passing.

Do not perform state-changing operations against real Ultimate hardware. Use unit tests, mock Ultimate HTTP servers, Binary Monitor stubs, and managed VICE only where the repository's existing test setup makes that safe and deterministic. Do not expose passwords or other secrets in logs, tests, fixtures, errors, or documentation.

## Start correctly

1. Read `AGENTS.md` and the entire adjacent `review.md` before editing. Follow the repository's `.github/skills/*/SKILL.md` instructions for any C64 execution workflow. In particular, read `c64://vice/binary-monitor-spec`/`doc/vice/vice-binary-monitor-spec.md` before changing VICE monitor framing or commands.
2. Inspect the existing test conventions, package scripts, generated-artifact workflow, public MCP schemas, and call sites before changing result shapes or shared facade APIs.
3. Keep changes narrow but solve root causes. Do not paper over a failure with logging, an unchecked cast, a longer timeout, or a test-only special case.
4. Work in logical batches, but run targeted tests after each batch and the complete relevant suite before handoff. Do not claim hardware validation unless it was actually performed with explicit authorization.

## Cross-cutting implementation rules

- Treat Ultimate REST responses as unsuccessful when their JSON `errors` array is non-empty, even when HTTP status is 2xx. Preserve the firmware error strings in structured details. Missing `errors` remains compatible success.
- Pin backend/facade identity for the full lifetime of a tool invocation and any spawned work. A backend switch may affect later invocations but must never retarget an operation already underway.
- Never silently drop input, swallow a failed state-restoration operation, or report a physical action as verified when the required state cannot be observed. Report uncertainty/failure explicitly and include recovery guidance where useful.
- Keep monitor queues and background work cancellable and recoverable. A timeout or shutdown must release subsequent work rather than permanently wedging a backend.
- Use package-relative paths for assets shipped with the package and process-cwd paths only for deliberately user/project-local inputs. Use `fileURLToPath`, not raw URL pathnames.
- Validate and contain all user-influenced host filesystem paths after resolution. Never rely solely on string prefix checks that permit sibling-prefix escapes; use `path.relative`/platform-aware containment.
- Retain backward compatibility deliberately. If a formerly `void` method must signal a timeout, propagate an explicit typed result or error through every caller rather than silently discarding it.

## Required fixes and acceptance criteria

### HTTP transport, configuration, platform status, and package paths

- **HARD01-001:** Make `--http [port]` real, or remove the dead parser/imports and the documented option together. Prefer wiring the existing parsed CLI options to a clearly factored transport-selection path using `StreamableHTTPServerTransport`; retain stdio as the default. Test that `--http 8080` selects/listens on the HTTP path and that default invocation selects stdio. Ensure MCP server/prompt registry wiring is actually used or remove the dead path.
- **HARD01-004:** Capability probing must not cache a transient error as `unknown`. Cache confirmed availability/unavailability as appropriate, but evict/retry uncertain results. Test failure-once then success.
- **HARD01-005, HARD01-006, HARD01-027:** Replace divergent configuration loading with one typed, authoritative loader and pass its parsed backend sections to all consumers/facade creation. Candidate precedence must match documented behavior: `C64BRIDGE_CONFIG`, then `process.cwd()/.c64bridge.json`, then home config, then defaults; retain a package-relative legacy fallback only if necessary and document its lower precedence. Resolve home via `os.homedir()` fallback and module paths through `fileURLToPath`. A malformed/unreadable candidate must produce a prominent redacted warning that identifies the file and problem, then continue to the next candidate/defaults rather than crashing or silently disagreeing. Test layered/contradictory configs, project-cwd config under an installed-style foreign package cwd, malformed config fallback, and identical host/port/password selection by startup and facade code.
- **HARD01-016:** Establish an invocation-scoped backend snapshot/facade lease. Platform gating, all operations in a multi-step tool flow, verification, and background work must use that pinned facade. Make switching atomic with platform publication so no request is gated with one platform and sent to another. Avoid a global lock that deadlocks streams or long-running work; a reference-counted/read lease or a façade captured in tool context is preferable. Add a deterministic concurrent mock-facade test where a slow write/verify is interleaved with `c64_select_backend` and every write/read/resume step remains on the original backend.
- **HARD01-025:** Resolve all shipped RAG data, docs, embeddings, AGENTS/prompt assets relative to the installed package/module root, not `process.cwd()`. If an override is supported, make it explicit and test it. Do not silently return an empty index merely because a bundled path was calculated incorrectly; surface a useful diagnostic when an expected bundled index cannot load. Test initialization from a foreign cwd.
- **HARD01-031:** `c64://platform/status` must not block on a normal 10-second live REST probe. Return cached/static/not-yet-probed capability state quickly, or use a bounded short probe that cannot poison the cache. Test a never-resolving probe and assert a prompt resource result within the short bound.

### Ultimate REST, input, physical-state safety, drive shape, and logging

- **HARD01-002 and HARD01-003:** Rework C64U/U64 `power_cycle` to be fail-closed. Before sending final RETURN, positively determine from the menu screen's actual selection/highlight encoding that `POWER CYCLE` is selected; visible text anywhere on screen is insufficient. Confirm firmware color-matrix semantics from repository/device contract and abort on uncertainty. On every post-menu-open failure, make a safe, best-effort, idempotent attempt to close/escape the menu and return cleanup status in failure details. Never report a selected power cycle unless verification succeeds. Test different highlighted rows, all navigation-step failures, no final RETURN on mismatch, and cleanup attempts.
- **HARD01-009:** Do not overwrite an undrained KERNAL queue. Make keyboard queue injection return a typed completion result or throw a typed timeout/error, then update every input tool call site to report partial/non-delivery accurately. Test a permanently nonzero NDX, assert no subsequent chunk overwrite, and assert the user-visible result is failure rather than success.
- **HARD01-010:** Encode Ultimate device filesystem paths segment-by-segment so nested slash separators remain separators while special characters in segments are encoded exactly once. Cover leading slash and spaces in an HTTP request-capture test.
- **HARD01-011:** Centralize `ActionResponse` error-array handling in the C64U/U2 backend; apply it to every action, configuration, drive, program, file, and playback method rather than hand-patching a few call sites. Nonempty `errors` must result in `success: false` and retain useful response details. Mock 200+errors for mount, run, and config operations and assert the MCP/tool layer reports failure.
- **HARD01-017:** If write verification paused a machine and resume fails, do not let the original write success escape as a clean success. Return/throw a failure that records write/verification outcome, `machinePaused: true`, the resume failure, and clear recovery instructions; an appropriately bounded retry is acceptable. Test return and thrown resume failures.
- **HARD01-023:** Normalize `drivesList` at the facade boundary into one documented internal shape (at least `id`, `power`, `image`, `type`, plus any needed raw details), for both VICE and Ultimate/U2. Decode the actual Ultimate `{ errors, drives: [{ id: info }] }` response rather than leaking it. Make `drive_mount_and_verify` use that normalized contract and verify the correct image-path/power fields. Test the real firmware-shaped mock response.
- **HARD01-024:** Redact sensitive HTTP request/response diagnostic metadata case-insensitively before it reaches stderr or diagnostics persistence. At minimum mask `X-Password` and authorization/cookie-equivalent secrets. Test that a known test secret never appears while the header key/placeholder may remain useful for diagnosis.
- **HARD01-034:** Align printer module runtime gates with advertised U2 capability: support `c64u` and `u2` if device-4 BASIC printing is actually supported by the stated contract, otherwise remove the advertised U2 feature and explain it. The likely intended fix is explicit `supportedPlatforms: ["c64u", "u2"]` on both relevant modules. Add capability/gating coverage.

### VICE monitor, emulator lifecycle, input, and config

- **HARD01-012:** Add per-request Binary Monitor response deadlines that reject, remove the pending request, and reset/destroy the unhealthy socket so the serialized monitor queue always releases. Use a considered timeout policy (normal versus large display transfer if needed), clear timers on response/error/close, and avoid unhandled rejections or request-ID reuse confusion. The parser must preserve framing correctness during resynchronization; do not scan arbitrary payload bytes as a new frame unless the protocol framing permits it. A stub server that accepts but never answers must prove bounded rejection and a subsequent operation must succeed after reconnect.
- **HARD01-013:** Ensure managed VICE and Xvfb are stopped on normal exit and SIGINT/SIGTERM/SIGHUP. Since async work cannot complete in `exit`, expose/use a synchronous best-effort kill path there; signal handlers should coordinate bounded async shutdown where viable and then exit without recursive/double cleanup. Guard already-exited children. Add tests around registered handlers/child termination and, where reliable in CI, an integration check proving no managed child survives SIGTERM.
- **HARD01-014:** Implement VICE Binary Monitor `0xA2` Joyport Set from the in-repo spec, including correctly encoded port and active-low control mask. Route VICE joystick press/release/tap through it; do not write CIA data-port registers to simulate input. Test exact BM bytes for press/release/tap and retain C64U physical-input behavior unchanged.
- **HARD01-015:** Construct checkpoint masks so explicitly provided operations are exactly honored; default to execute only when no load/store/execute flag was requested. Test `{store:true}` serializes `0x02` and other combinations.
- **HARD01-026:** Make VICE reset/reboot success contingent on `waitForBasicReady`'s required readiness signals. Return structured `success:false` with readiness diagnostics when it does not reach READY; update callers/tests accordingly.
- **HARD01-035:** Stop coercing values solely because they look numeric. Determine VICE resource type from the monitor/resource API (or add an explicit value type where the public schema supports it) and send a string payload for numeric-looking string resources such as `"1541"`. Test both resource types and batched behavior.

### Program execution, BASIC generation, and validation

- **HARD01-007:** Generate valid Commodore BASIC V2 printer output for strings containing quotes. Do not use doubled quotes. Split expressions and emit `CHR$(34)` (while preserving all other literal characters), maintain line-length/chunking correctness, close the printer channel on normal/error paths where feasible, and ensure the tool does not claim completed printing merely because load/run started. Add generator/tokenizer-level coverage for quoted text and a VICE-facing regression if the suite supports it.
- **HARD01-008:** Make the PETSCII screen program actually wait for a key without immediately falling through to `READY.`. Use a valid GET loop and preserve intended termination behavior. Test generated source and, if possible, rendered-screen behavior before a key press.
- **HARD01-018:** Make `upload_run_asm` execute assembled code on every supported backend. Establish one robust contract for entry address and PRG layout: either emit a valid BASIC SYS stub for applicable loads while keeping labels/address accounting correct, or inject/run the PRG then explicitly `SYS` the assembled entry in a backend-safe manner. Do not point VICE BASIC pointers at arbitrary non-BASIC ML. Test the published `$0801` example by observing its intended memory/screen effect and test a non-$0801 origin does not corrupt BASIC workspace. Keep symbol and verification metadata truthful.
- **HARD01-019 and HARD01-020:** Replace the ASM liveness heuristic so it neither treats free-running VIC/CIA values as activity nor reads side-effectful CIA ICRs on hardware. Prefer program-specific expected effects/explicit verification where supplied; any fallback must restrict reads to side-effect-free addresses, mask volatile registers, and honestly describe its confidence. Test a memory stream differing only at `$D012` as non-alive/crashed and assert hardware polling never overlaps `$DC0D`/`$DD0D` (or the I/O ranges whose reads have side effects).
- **HARD01-021:** Detect BASIC runtime errors only using actual BASIC error syntax/patterns, not arbitrary occurrences of the word `ERROR`. Test `0 ERRORS FOUND` as successful and a canonical `?SYNTAX ERROR IN 20` as failure.

### Background work, artifacts, and SID playback

- **HARD01-022:** On reload, persisted tasks marked `running` must never remain zombie status. Either safely re-arm them once execution context is available or mark them `interrupted`/`stopped` with a restart explanation; choose and document one deterministic policy. Test persisted reload and task listing/state.
- **HARD01-028:** Treat resolved `{ success:false }` operation results as failed task iterations, recording `lastError` and truthful status/failure counts. Decide whether retry continues; if it does, make the continued/retry status explicit. Test both thrown and returned failures.
- **HARD01-029:** Reject unsafe `runId` and all artifact-derived filenames before writing. Resolve the output base and candidate then prove containment with `path.relative`; reject separators, traversal, absolute paths, empty normalized names, and unsafe range components. Test `../escape`, absolute/sibling-prefix escapes, and verify no out-of-tree file is created.
- **HARD01-030:** Replace detached `music_generate` playback with tracked, cancellable work. Pin its facade/backend at creation, expose an existing-compatible stop/cancel path (integrate with the background task registry or a dedicated playback registry), stop/cancel on shutdown and before/when backend switches according to a documented policy, and do not monopolize VICE's queue beyond individual note operations. Preserve immediate scheduling response only if it truthfully says playback is scheduled/running rather than completed. Test that switching backends cannot redirect later notes and cancellation prevents future writes.
- **HARD01-032:** Correct every SID frequency formula to the 24-bit phase accumulator: `round(hz * 16777216 / phi2)` with existing valid 16-bit clamp. Update both production implementations and knowledge/spec text, including PAL and NTSC handling. Test A4/PAL is approximately 7493 (`$1D45`) and that note-on writes low/high bytes correctly.
- **HARD01-033:** Retrigger the SID envelope between generated notes by writing gate-low for an appropriate bounded interval before the next gate-high/note-on. Do not leave a permanently high gate except where an explicit legato contract asks for it. Test register-write sequence includes gate clearing between successive notes.

## Test and validation gate

At a minimum, add/extend automated tests that demonstrate every numbered acceptance criterion above. Group them sensibly (config/path, Ultimate mock HTTP, VICE BM stub/lifecycle, program generation/validation, background/SID), but name cases with the HARD01 IDs or titles so coverage is auditable. Run:

1. formatter/linter/typecheck and the repository's normal test command;
2. focused tests for every changed subsystem;
3. package/build and generated-contract checks when applicable;
4. a final `git diff --check` and review of all changed public schemas/docs/skills.

If an existing test harness cannot safely perform a desired managed-VICE or device-level assertion, retain a deterministic stub/unit test and report the exact unperformed HIL validation as a limitation. Do not weaken a requirement merely because production hardware is unavailable.

## Documentation and handoff

Update docs, generated metadata, schemas, and `.github/skills` only where behavior, supported platform, failure/recovery behavior, or invocation semantics changed. In particular, keep `AGENTS.md`, README/developer docs, platform-status capabilities, and MCP descriptions consistent with the implementation. Do not edit `review.md` to hide findings.

At handoff, provide:

- a concise mapping of HARD01 IDs to the implemented change and tests;
- commands run and their outcomes;
- any intentionally deferred hardware-only validation, with reason;
- an explicit statement that all 35 findings were implemented, or a precise list of any remaining IDs and the blocker. Do not claim completion while any HARD01-001..035 finding remains unresolved.
