# C64 Bridge: MCP 2026-07-28, native Skills and Tasks, conditional monitoring

Status: implemented in 1.4.0 (PR #194, released 2026-11-26). This is the original implementation brief, kept as the design record; the shipped behaviour is described in `doc/hardening-behavior.md` and the README.

## 1. Goal

Bring c64bridge (currently 1.3.3, `@modelcontextprotocol/sdk` 1.32.1) onto MCP protocol revision 2026-07-28 and deliver, in one coherent change set:

1. Protocol 2026-07-28 on stdio and HTTP, with unchanged behaviour for clients on earlier revisions.
2. The Skills extension (`io.modelcontextprotocol/skills`), served from the existing `.github/skills/*/SKILL.md` files.
3. The Tasks extension (`io.modelcontextprotocol/tasks`), backed by the same engine as the existing `c64_system` task operations.
4. A conditional monitoring operation ("wait until memory, screen or a checkpoint satisfies a condition"), usable synchronously, as a native task, and through the legacy task operations.
5. Task-backed execution for the existing long operations where that is safe and cheap to add.

Rule for every feature: implement it once in protocol-independent code, then expose it through thin adapters (2026-07-28 native, and the pre-2026 fallback). No client-name checks anywhere; decide from declared capabilities only.

Priorities, in order: correctness and concurrency safety, backward compatibility, simplicity, user benefit, then token and time cost. Work autonomously until section 9 is satisfied. Do not stop after planning, after the SDK migration, or after Skills alone. If one feature is blocked externally, finish everything independent of it and report the blocker precisely.

## 2. Facts established on 2026-11-26

Treat these as the starting baseline. Do not repeat this research; verify only the open items in 2.4 and anything that turns out to contradict the SDK source.

### 2.1 Protocol (sources: modelcontextprotocol.io/specification/2026-07-28 and its changelog, modelcontextprotocol.io/extensions/tasks/overview, skills.extensions.modelcontextprotocol.io/specification/beta/skills)

- 2026-07-28 removes `initialize`/`notifications/initialized` and `Mcp-Session-Id`. Each request carries `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` in `params._meta`. Servers MUST implement `server/discover`. Capabilities gain an `extensions` map. Every result has `resultType`. List and read results carry `ttlMs` and `cacheScope`. Streamable HTTP POSTs carry `Mcp-Method` and `Mcp-Name` headers; the GET stream and `resources/subscribe` are replaced by `subscriptions/listen`. Resource-not-found is now `-32602`. Elicitation moved to `inputRequests`/`inputResponses` on results.
- Tasks extension, listed as "Beta, to Core": the client declares it per request; the server advertises it in `server/discover`. A server may answer `tools/call` with a task handle (`resultType: "task"`) without a per-request flag, but only when that request declared the extension. Methods: `tasks/get`, `tasks/update`, `tasks/cancel`. There is no `tasks/list` and no `tasks/result`; the final result or error is returned by `tasks/get`. Statuses: `working`, `input_required`, `completed`, `failed`, `cancelled`. Fields include `taskId`, `ttlMs`, `pollIntervalMs`. The 2025-11-25 experimental Tasks design is different and must not be implemented.
- Skills extension, beta: server declares `extensions["io.modelcontextprotocol/skills"]` (optional `directoryRead`) and must also declare `resources`. Required methods: `skills/list` (paginated; entries have `uri`, `frontmatter`, `resources`) and `skills/get`. Files are read with `resources/read`. Preferred URI `skill://<name>/SKILL.md`; the last path segment before the file must equal frontmatter `name`. Each listed file has `digest` (`sha256:` over the raw served bytes) and `size`. Limits: 512 files and 16 MiB per skill. Clients without the extension see `skill://` resources as ordinary resources.

### 2.2 SDK and clients

- TypeScript SDK v2 is the stable line for 2026-07-28: `@modelcontextprotocol/server` 2.4.0 (with `@modelcontextprotocol/core`, depends on `zod ^4.2`, Node >= 20). Its bundle contains legacy handling for 2025-11-25 and earlier revisions and a skills helper (`dist/ext/skills`). Migration guide: ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2. The v1 line (latest 1.32.2) is not known to speak 2026-07-28.
- Claude Code (installed: 2.1.332; docs: code.claude.com/docs/en/mcp): negotiates 2026-07-28 and falls back to the older handshake. MCP skills appear as `<server>:<skill>`, limited to 100 skills per server, 100 KB per text file and 400 KB per skill; not available in `claude -p`, cloud sessions, GitHub Actions or the Agent SDK. MCP tasks need a 2026-07-28 connection; a call still running after two minutes moves to the background and the agent continues; one-shot `claude -p` gets no tasks (stream-json sessions can with `CLAUDE_AUTO_BACKGROUND_TASKS=1`). Elicitation supports form and URL modes.
- Codex CLI (installed: 0.171.0): support for 2026-07-28, Skills and Tasks is not established.

### 2.3 Repository

- `src/mcp-server.ts` (965 lines): low-level `Server` with `setRequestHandler`, capabilities `resources`, `tools`, `prompts`. HTTP mode is stateless: one `Server` and one `StreamableHTTPServerTransport` per POST, loopback-only, optional bearer token, GET returns 405.
- `src/mcp/skills.ts`: lists skills from `.github/skills`, excludes `pr-converge`, parses frontmatter with a regular expression, serves `c64://skills/<name>` with repository paths rewritten. 13 published skills, 27 KB in total, no supporting files. The `yaml` package is already a dependency.
- `src/tools/meta/background.ts` (824 lines) with `src/taskStateLock.ts`: interval tasks limited to six fixed operations, persisted under the state root, owned by pid and session, pinned to a backend facade at start, at most 16 running. Exposed as `c64_system` `start_task`, `stop_task`, `stop_all_tasks`, `list_tasks`, `delete_task`. Effects come from `taskOperationEffect` in `src/tools/access.ts`.
- Existing waits and long operations: `c64_memory wait_for_text`, `c64_debug wait_for_state`, `waitForReady` on reset operations, `c64_sound capture_samples` and `pipeline`, `c64_graphics capture_frame`, `c64_program batch_run` and `bundle_run`, SIDWAVE render and analysis. Progress notifications and cancellation already exist (`src/mcp/progress.ts`, `ctx.signal`).
- Tests: `test/*.test.mjs` on a Bun and a Node runner, wire-level suites in `test/suites/`, task tests in `test/meta/`. Gates: `npm run check`, `npm run test:node`, `npm run check:node-compat`, `npm run check:package`, `npm run coverage`, `npm run test:vice:mock`, `npm run test:vice:device`, `npm run test:stress`. Generated artifacts: `npm run mcp:generate` and the README sections written by the build.

### 2.4 Open items to verify first (one research package, at most 600 words returned)

1. The normative Tasks specification in github.com/modelcontextprotocol/ext-tasks: exact schemas, `tasks/update` semantics, `ttlMs` and expiry rules, notification delivery.
2. The SDK v2 server API for extensions, tasks, skills and serving pre-2026 clients on stdio and stateless HTTP, read from the installed package source and the migration guide.
3. Agent Skills naming rules (agentskills.io) against the 13 skill directories and frontmatter names.
4. Codex and GitHub Copilot support, from their documentation only.

Record source URLs and versions in the ledger. Do not invent methods or SDK APIs, and do not build on unreleased packages.

## 3. Decisions already made

- **SDK**: migrate to SDK v2 (`@modelcontextprotocol/server` 2.x). Start with a time-boxed spike on a branch: the existing wire suites must pass unchanged for a pre-2026 client on stdio and HTTP, on both Bun and Node, with no material startup regression. If the spike fails, keep SDK v1, deliver the protocol-independent parts (skill catalogue, task engine, monitoring, legacy operations) and report the blocker. Keep the migration inside the MCP layer; tool implementations and generated contracts do not change.
- **Skills**: one catalogue module replaces the current listing. It parses frontmatter with `yaml`, validates name and description, and serves each skill twice from the same file: `skill://<name>/SKILL.md` through the extension with digests computed over the bytes actually served, and the existing `c64://skills/<name>` resource, which stays for every client. Prompts and server instructions keep working. Reject path traversal and symlinks that leave the skill directory. Rewrite each skill `description` so a client can decide when to load it (state the trigger, not only the topic), and correct skill bodies where tool names, `op` strings or backend limits are stale. Do not lengthen skills otherwise.
- **Tasks**: refactor `background.ts` into one task engine with explicit states and transitions (terminal states are final; a late completion never overwrites a cancellation). The engine captures at submission: pinned facade, access mode check, validated arguments, resolved addresses, limits and an `AbortSignal` that is independent of the submitting request. The existing interval tasks, their persisted format and their `c64_system` operations run on this engine unchanged. The native adapter maps engine states to the extension and returns a task handle only for requests that declared the extension; everyone else receives the ordinary tool result. Task IDs are unguessable; over HTTP the bearer token and loopback checks still apply. Interrupted hardware-mutating work is never resumed after restart.
- **Which calls become tasks**: an explicit allowlist of operations, not arbitrary tools. Start with conditional monitoring, `wait_for_text`, `wait_for_state`, audio and frame capture, `pipeline`, `batch_run`, `bundle_run` and SIDWAVE render or analysis. Add each only if it can be cancelled or bounded and its resource use is safe; record the others as deferred with the reason. Measure event-loop blocking for CPU-heavy work before claiming it runs in the background.
- **Conditional monitoring**: one new operation in an existing grouped tool (no new top-level tool) with a typed condition schema: byte equals or differs, masked compare, range compare, change against the initial snapshot, numeric threshold with explicit width and signedness, screen text appears or disappears, screen changed, and VICE checkpoints where available. Arguments use the existing address and symbol syntax, a poll interval, a mandatory bounded timeout and an iteration cap. The result reports the resolved target, expected and observed values, first and last observation, iterations, elapsed time (monotonic clock), backend and completion reason, and distinguishes "condition not met in time" from communication failure. Iterations never overlap. No arbitrary predicates. Legacy clients reach it through the synchronous call with progress, and through `start_task` plus a bounded wait or result operation added to `c64_system`.
- **Resource coordination**: add only what asynchronous execution needs. Classify operations as passive read, execution-interrupting read (VICE monitor), memory write, program start, reset or power, input, capture, configuration, or host-only. A task holds what it needs for its whole run; a conflicting call is rejected with a message that names the task, or queued with a bound. No silent invalidation, no cross-process locking beyond what exists, and state plainly that guarantees are process-local.
- **Elicitation and other extensions**: evaluate confirmation for existing destructive operations only. Implement it if it is small and does not interrupt autonomous use; otherwise record the deferral. File Uploads is not released and is out of scope.

## 4. Out of scope

A regression DSL, a general orchestration engine, a persistent daemon, distributed locking, multi-instance VICE management, MCP Apps, remote hosting or cloud authentication, extracting SIDWAVE, unrelated refactoring or dependency upgrades, documentation rewrites, new top-level tools without a demonstrated need, version bumps, releases, pushes and pull requests.

## 5. Team and cost

- The session model orchestrates: it owns decisions, the dependency graph, integration and acceptance, and writes little code itself.
- Sonnet subagents supervise one work package each. They delegate bounded edits to Haiku subagents or to `codex exec -m gpt-6-luna -C <worktree> -s workspace-write "<task>"`, then review and verify the result themselves.
- Use the top-tier model at high effort only for the SDK go or no-go decision, the task state machine and resource model, and the final security and concurrency review. Reviewers do not review code they wrote.
- At most three workers at a time. One writer per file. Use git worktrees for parallel implementation; the orchestrator merges. Never run two dependency installs, generators or hardware sessions concurrently.
- Each brief states the objective, paths, the applicable decisions from section 3, write scope, acceptance tests and the output format, and asks for a result of at most 500 words: outcome, changed files, tests run, open risks. Do not forward this whole prompt.
- Keep one ledger at `~/.c64bridge/modern-mcp/ledger.md` (never committed): baseline revision and gate results, verified protocol facts with sources, interface contracts, package status, file ownership, blockers. Workers read the relevant part instead of repeating research or inventory.
- Prefer scripts and compiler output over model reading for mechanical checks. Keep long logs in files. Suggested packages: (A) open-item research, (B) baseline gates and SDK spike, (C) skill catalogue and native Skills, (D) task engine and legacy adapter, (E) native Tasks adapter, (F) conditional monitoring and the allowlist, (G) contract tests, documentation, packaging, (H) independent review. C and D can start as soon as B has decided the SDK question.

## 6. Engineering rules

- Follow `AGENTS.md`. Work on a local branch `feat/modern-mcp` with small commits. Do not push, open a pull request, bump the version or publish.
- Test first for new behaviour: write the failing test, see it fail, implement, see it pass. For behaviour-preserving refactoring, confirm that existing tests cover the code before changing it.
- Tests use real JSON-RPC over stdio and HTTP where the wire matters, fake clocks and controlled scheduling for concurrency, and no arbitrary sleeps. Parameterise rather than copy.
- Run targeted tests during a package, the affected suites when it completes, and the full gate list from 2.3 once at baseline and once at the end. Never weaken a test, assertion or coverage threshold.
- Preserve: the install commands, stdio and HTTP behaviour and HTTP access checks, `C64BRIDGE_ACCESS` enforcement for every path into an operation, host path restrictions, secret redaction, existing limits, shutdown behaviour (`stopAllBackgroundTasks`), Node 24 and Bun compatibility, and the `c64bridge` package contents checked by `scripts/check-package.mjs` (extend its required list for anything new).
- Hardware: only the bench Ultimate 64 and VICE. Do not contact the C64U. No power-off, power-cycle, flash, outlet or other destructive operation. Mock results are never reported as hardware results.

## 7. Required tests

- **Negotiation**: pre-2026 client; 2026-07-28 client with no extensions, Skills only, Tasks only and both; unknown extension; malformed capability metadata; `server/discover`; stdio and stateless HTTP. A client that did not declare Tasks never receives a task result.
- **Skills**: ordering, exclusion of `pr-converge`, YAML errors, invalid or duplicate names, digest and size equal to the served bytes, pagination, unknown URI, traversal and symlink escape, same content through `skill://` and `c64://skills/`, prompts unchanged, skills present in the packed npm tarball and within the Claude Code size limits.
- **Task engine**: immediate and delayed completion, concurrent tasks, cancel before and during a run, cancel racing completion and timeout, repeated cancel, backend failure, late results, ownership across processes, corrupt and legacy persisted state, retention and the running limit, resource acquire and release on every terminal path, conflicting foreground calls, backend switch and symbol changes during a task, shutdown with no leftover timers or child processes.
- **Shared contract**: one parameterised suite run against the native adapter and the legacy operations, comparing normalised outcomes for success, validation error, backend error, cancellation, timeout, access denial in `read-only` and `no-destructive` modes, and resource conflict.
- **Monitoring**: every condition type, immediate, delayed and never-matching cases, boundary values, invalid addresses, masks and lengths, symbols, screen encoding, communication failure versus timeout, cancellation, non-overlapping iterations, backend pinning.
- **Clients**: exhaustive checks with a deterministic 2026-07-28 client (SDK v2 client as a dev dependency) and the existing harness for the older revision. Then at most a few real sessions: Claude Code with an isolated configuration, and Codex for the fallback path. Skills and auto-backgrounded tasks cannot be exercised through `claude -p`; where an interactive session is required, write a short manual checklist for the user and mark the item unverified.

## 8. Documentation and review

- Update the README sections, `AGENTS.md`, `doc/hardening-behavior.md`, server instructions, tool descriptions, the affected skills, generated MCP interface files and `CHANGELOG.md` following the existing conventions. Keep always-loaded text short and put detail in skills. Distinguish "works through the fallback" from "native protocol support", and do not describe a client as lacking background execution because it lacks native Tasks.
- After implementation, run one independent review of the diff focused on: capability advertisement that does not match behaviour, task results sent to clients that did not ask, request cancellation that kills a detached task, a backend switch that retargets a task, stale symbol resolution, foreground calls that corrupt a task, leaked leases, timers or workers, overwritten terminal states, access-mode bypass through the task path, files missing from the package, and tests that pass with the implementation broken (prove by reverting the fix). Every finding names the file and line, the violated invariant, a concrete failure sequence and a regression test. Fix confirmed findings, add the test, and re-review only the changed code. Finish when no confirmed critical or high finding remains and the rest have a recorded disposition.

## 9. Done when

- A pre-2026 client sees no behavioural change; the existing suites pass unmodified or with changes justified in the report.
- A 2026-07-28 client can discover and read all 13 skills through the extension, and receives task handles for allowlisted long operations, with correct status, cancellation, result and expiry.
- There is one skill catalogue and one task engine, and the contract suite passes against both adapters.
- Conditional monitoring works on VICE and on the Ultimate 64 (or the hardware run is reported as blocked), in synchronous, native task and legacy task form.
- All gates in 2.3 pass, the package check passes from an installed tarball outside the checkout, and no critical or high review finding is open.

## 10. Final report

Write the report to `~/.c64bridge/modern-mcp/report.md` and summarise it in the final message. Start with a summary of the whole report including open items. Then: what was implemented, with one usage example per new capability; a compatibility table per client and feature using only the labels verified native, verified fallback, specification only, unsupported, unverified or blocked, with tested versions; how duplication was avoided; tests added and gate results with counts; measurements taken (startup, `tools/list` size, task overhead, backend request volume during monitoring); review findings and dispositions; deferred operations and reasons; decisions made without user input; models and agents used and token or cost figures only where the runtime reports them.
