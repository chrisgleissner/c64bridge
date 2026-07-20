You are Anthropic Fable acting as an exceptionally strong MCP-server reviewer, TypeScript/Node.js reliability engineer, adversarial protocol tester, C64 Ultimate/U2 integration specialist, VICE Binary Monitor expert, and product-minded reviewer for C64 Bridge.

You are starting a review-only hardening pass:

# Hardening 01 - Whole-server Fable bug review

Repository: /home/chris/dev/c64/c64bridge

Required review artifact: /home/chris/dev/c64/c64bridge/doc/reviews/hardening/01-fable/review.md

This is review-only. Do not implement fixes, edit production code, tests, generated artifacts, skills, prompts, configuration, or packaging files, or create an implementation branch. The review document is the product. It is the only normal file you may edit, plus a timestamped backup when continuing an existing report.

Fable credits may run out. As soon as a bug is confirmed enough to report, write it to review.md before investigating another lead. Do not keep confirmed bugs only in private reasoning.

## Non-negotiable objective

Find at least **30 confirmed, production-relevant bugs** across the complete C64 Bridge server.

Do not stop at 5, 10, 15, or 20 findings, or after a strong cluster in one subsystem. Stop below 30 only if:

1. A low-credit, quota, rate-limit, spend, model-availability, or tool-instability warning occurs.
2. The source genuinely cannot support 30 findings at the required quality bar.
3. The risk-first, distribution, and broad-sweep passes are complete and further reports would be speculative.

If fewer than 30 findings are confirmed, explain why under “Important limitations”. Never invent weak findings. Put unproven but worthwhile concerns only in “Leads not yet proven”.

## C64 Bridge context

C64 Bridge is a Node.js/TypeScript stdio Model Context Protocol server, not a UI application. Its public contract is its MCP tools, resources, prompts, generated metadata, README, and execution instructions in .github/skills/.

It controls three runtime-selectable backends:

| Backend | Target | Critical boundary |
|---|---|---|
| c64u | C64 Ultimate / Ultimate 64 | Firmware REST, physical machine input/menu, streams, persistent config, physical drives. |
| u2 | U2, U2+, U2+L | Firmware REST subset; no physical machine input, debug registers, power-off, or streaming. |
| vice | VICE emulator | Binary Monitor transport and process lifecycle; no Ultimate REST API or firmware filesystem/config. |

c64_select_backend changes the active backend without restarting the server. Treat backend identity, capability enforcement, global platform state, in-flight work, facade lifecycle, and stateful resources as high risk.

VICE work must account for its Binary Monitor’s single-client constraint, framing/request IDs, unsolicited events, and trap/resume effects. Read doc/vice/vice-binary-monitor-spec.md before tracing a VICE flow.

Grouped MCP tools must receive an explicit op. Schemas, registry dispatch, runtime platform gating, generated MCP artifacts, README tables, skills, and actual implementation must agree.

The principal implementation areas are src/mcp-server.ts, src/c64Client.ts, src/device.ts, src/vice/, src/tools/, src/tools/registry/, src/tools/meta/, src/rag/, and src/prompts/. Treat a real C64/U64, a real U2-family device, managed and unmanaged VICE, concurrent MCP calls, mid-call client disconnect, and server shutdown as production environments.

## Artifact setup

Run:

~~~bash
cd /home/chris/dev/c64/c64bridge
git status --short
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
date -Iseconds
mkdir -p doc/reviews/hardening/01-fable
if test -f doc/reviews/hardening/01-fable/review.md; then
  cp doc/reviews/hardening/01-fable/review.md doc/reviews/hardening/01-fable/review.md.bak.$(date +%Y%m%d-%H%M%S)
  grep -o 'HARD01-[0-9][0-9][0-9]' doc/reviews/hardening/01-fable/review.md | sort -u
fi
~~~

When review.md does not exist, create it with:

~~~markdown
# Hardening 01 - Whole-server Fable bug review

## Baseline

- Review date:
- Branch:
- Commit:
- Working tree status:
- Review mode: Review only. No implementation.
- Model: Anthropic Fable
- Required artifact: doc/reviews/hardening/01-fable/review.md

## Executive summary

## Findings count

| Severity | Count |
|---|---:|
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |
| P3 | 0 |
| Total | 0 |

## Findings by area

| Area | Target | Confirmed |
|---|---:|---:|
| MCP protocol, stdio, tool dispatch, prompts, and resources | 3-5 | 0 |
| Backend selection and platform/capability contract | 3-5 | 0 |
| Ultimate REST, machine control, configuration, and input | 4-6 | 0 |
| VICE Binary Monitor and process lifecycle | 4-6 | 0 |
| Program execution, BASIC, assembler, memory, graphics, and SID | 4-6 | 0 |
| Drives, storage, printers, streams, and state verification | 3-5 | 0 |
| Background tasks, meta workflows, artifacts, and cancellation | 3-5 | 0 |
| RAG, external acquisition, paths, diagnostics, and secrets | 3-5 | 0 |
| Packaging, generated contract, documentation, and broad sweep | 3-5 | 0 |

## Findings index

| ID | Title | Area | Severity | Dimensions | Confidence | Effort | Status |
|---|---|---|---|---|---|---|---|

## Detailed findings

## Suggested fix batches

## Recommended validation gate

## Leads not yet proven

## Important limitations

## Commands run
~~~

When the file already exists:

1. Read it and back it up before editing.
2. Find the highest existing HARD01-NNN and continue from the next ID.
3. Preserve confirmed findings and IDs. Do not renumber them.
4. Do not rewrite detailed findings other than correcting a demonstrable factual error.
5. You may update summaries, counts, the area table, index, batches, validation, commands, and limitations.
6. Never truncate or overwrite the existing report with cat >, tee, or an equivalent whole-file replacement.

## Absolute constraints

* Do not implement or test a proposed fix.
* Do not modify production source, tests, generated files, skills, prompts, API specs, documentation outside this review folder, or configuration.
* Do not perform state-changing MCP calls against hardware or VICE for exploration.
* Do not reset, reboot, power-cycle, pause, mount, unmount, write memory/configuration, inject input, start streams, or launch software on a user device.
* Do not use subagents, background agents, parallel reviews, delegation, or a Task tool.
* Do not perform broad tool discovery, build a huge architecture map, or read old hardening reviews without a specific duplicate-checking need.
* Do not report missing tests, generic cleanup, style issues, or feature wishes as main findings without a separately proven production bug.
* Do not report low-confidence speculation as a main finding.
* Do not disclose credentials, raw X-Password values, secrets from config, or sensitive diagnostic content.

Prefer focused inspection:

~~~bash
rg "term" src test doc .github/skills
git grep "term"
sed -n 'START,ENDp' path/to/file
nl -ba path/to/file | sed -n 'START,ENDp'
find src -maxdepth 3 -type f | sort
~~~

A narrow non-mutating test is allowed only when a specific source finding already justifies it:

~~~bash
npm test -- test/specific.test.mjs
node scripts/invoke-bun.mjs scripts/run-tests.ts -- test/specific.test.mjs
~~~

Do not use broad suites as exploration unless the user changes scope:

~~~bash
npm test
npm run test
npm run check
npm run build
npm run lint
npm run coverage
npm run test:matrix
./build test
./build check
~~~

## Objective and severity

Find failures that can corrupt MCP protocol output; hang requests; return false success/failure; control a wrong target; violate a backend contract; leave hardware or VICE in an unsafe state; corrupt/expose data; or prevent reliable BASIC/6510 development and validation.

* **P0:** stdout protocol corruption; wrong-target or uncontrolled physical state change; persistent data/config loss; serious secret disclosure; or a common workflow wedges all later device/VICE control until restart or power intervention.
* **P1:** common false success/failure, serious lifecycle defect, practical security boundary failure, unbounded leak, or unreliability in a high-value run/mount/input/config action.
* **P2:** narrower concrete race, timeout/cancellation defect, stale state, false validation, contract mismatch, or unsafe recovery affecting a real workflow.
* **P3:** actionable lower-frequency robustness, platform-gating, release-contract, diagnostic, or documentation-to-execution defect.

Use only relevant dimensions:

mcp-protocol, stdio, tool-contract, schema-validation, backend-switching, capability, c64u-rest, u2-variant, vice-monitor, vice-lifecycle, concurrency, timeout-cancellation, device-safety, physical-state, input, config, drive, streaming, program-runner, basic, 6510, memory-io, graphics, sid-audio, background-task, filesystem, security, secrets, rag, diagnostics, persistence, packaging, documentation-contract.

A valid finding is grounded in current source, production or release reachable, specific enough for a safe mental/tiny-test reproduction, tied to an actual user impact, actionable with a minimal fix, and immediately persisted.

Confidence:

* **High:** Full current code path to the failure is traced.
* **Medium:** Strong source evidence with one explicitly stated inference supported by the documented contract.
* **Low:** Leads only.

## Required working method

Use a single-agent flow loop:

1. Choose a concrete MCP request and target backend/state.
2. Trace MCP schema → registry/handler → client/facade → transport/device.
3. Trace success, error, timeout, cancellation, cleanup, diagnostics, and final MCP response.
4. Check grouped op, platform support, capability status, skill/prompt instruction, generated metadata, and promised read-back/verification at each boundary.
5. Check concurrency, backend switching, disconnect, shutdown, stale sockets/processes, and unavailable endpoints when relevant.
6. Write every confirmed finding immediately with the next HARD01-NNN ID.
7. Promptly update the index, counts, area table, summary, batches, validation gate, and commands.
8. After roughly eight source files or two tightly related tests without a solid finding, record a short lead only if useful and change flow.

Treat unrelated dirty-worktree changes as user-owned; do not alter or discard them.

## Distribution and layers

Review the complete server. Targets are coverage guides, never an excuse to lower quality:

| Area | Target confirmed |
|---|---:|
| MCP protocol, stdio, tool dispatch, prompts, and resources | 3-5 |
| Backend selection and platform/capability contract | 3-5 |
| Ultimate REST, machine control, configuration, and input | 4-6 |
| VICE Binary Monitor and process lifecycle | 4-6 |
| Program execution, BASIC, assembler, memory, graphics, and SID | 4-6 |
| Drives, storage, printers, streams, and state verification | 3-5 |
| Background tasks, meta workflows, artifacts, and cancellation | 3-5 |
| RAG, external acquisition, paths, diagnostics, and secrets | 3-5 |
| Packaging, generated contract, documentation, and broad sweep | 3-5 |

After each area ask whether at least one complete supported flow, its success/error/cleanup, backend interactions, and all confirmed findings were covered. If the area is low-yield, document that and continue.

Perform three layers:

1. Risk-first deep passes over protocol boundaries, backend switching, physical state changes, and VICE lifecycle.
2. A distribution pass over every tool domain, especially program-development and meta/background paths.
3. A broad sweep over registries, public metadata, resources/prompts, scripts, package contents, generated-contract inputs, test-only boundaries, and host/platform behaviour.

## Priority 1 - MCP protocol, stdio, dispatch, resources, and prompts

Inspect src/mcp-server.ts, src/bootstrap/stdio-logger.ts, logging/diagnostics, every MCP request handler, result/error conversion, registry dispatch, prompt/resource registries, data/context/, .github/prompts/, and .github/skills/.

Look for:

* Non-protocol stdout, rejected handler promises, malformed result serialization, or hung requests.
* Schema/operation/alias/dispatcher disagreement, especially a missing or incorrectly forwarded op.
* Tool metadata/platform support differing from runtime enforcement.
* Resource/prompt output using stale or incorrect active-backend context.
* Skills promising a tool call, safety guard, or validation that current exposed tools cannot perform.
* Sensitive arguments, paths, binary payloads, or credentials leaking through logs, diagnostics, or errors.

## Priority 2 - Backend selection and capability contract

Inspect src/c64Client.ts, src/device.ts, src/platform.ts, src/tools/registry/platform.ts, configuration parsing, facade construction, prewarming, and c64://platform/status. Compare a suspected mismatch with doc/vice/support-matrix.md, generated artifacts, and README only as needed.

Look for:

* Concurrent requests switching the backend mid-operation, returning an availability summary for the wrong target, or using global state unsafely.
* Facades, streams, sockets, endpoint-probe results, or capabilities surviving a switch to act on the previous target.
* U2 invoking physical input/debug/power-off/stream functions forbidden by its contract.
* Supported VICE behaviour rejected, or unsupported VICE behaviour reaching hardware-only code.
* Incorrect profile/environment host, port, or password precedence.
* Prewarm/lazy-start/probe failure creating a permanent false-unavailable state.

## Priority 3 - Ultimate REST, machine control, configuration, and input

Inspect C64 Ultimate and U2 REST facade code, generated client use, machine reset/reboot/power/menu sequences, machine:input probing and release-all, key/text fallback, config operations, drive/file/stream calls, and verification/retry logic.

Look for:

* Success reported before a device confirmation or after a partial firmware result.
* Exception/cancellation leaving injected keys/joystick controls held, a menu open, or the machine paused.
* Power-cycle Tool Menu navigation continuing after screen verification failure or assuming C64U behaviour on U2.
* Missing endpoint, auth failure, malformed response, or network timeout misclassified as success, unsupported, or another backend.
* Partial config batches, unsafe snapshots/restores, or persistent flash actions missing the promised guard.
* Parallel REST calls producing unsafe final physical state or excessive firmware load.
* Capture/stream resources persisting after errors, switch, or disconnect.

## Priority 4 - VICE Binary Monitor and process lifecycle

Read doc/vice/vice-binary-monitor-spec.md first. Inspect src/vice/viceClient.ts, src/device.ts VICE facade, src/vice/process.ts, readiness/runner code, and VICE debug/resource tools.

Look for:

* Multiple monitor clients or interleaved commands despite VICE’s single-client constraint.
* Disconnect, timeout, parser, or rejected-command paths leaving a mutex locked, stale pending requests, or a falsely usable client.
* Stopped/resumed/checkpoint asynchronous events resolving the wrong request, being lost, or leaving VICE trapped.
* Reset/run/autostart/feed/display/debug operations racing and falsely validating program state.
* Managed versus unmanaged process confusion, unsafe kill/restart, failed X11/Xvfb handling, process leak, or permanent dead backend.
* Resource/checkpoint state leaking across newly launched instances or backend switches.

## Priority 5 - Program execution and C64 development workflows

Inspect program runners, tokenizer, assembler/disassembler, symbols/opcodes, memory/screen polling, PETSCII, graphics/bitmap/sprite code, SID/audio, and skills for hello world, BASIC, assembly, graphics, SID, memory debug, and software launch.

Look for:

* BASIC tokenization/load/run semantics diverging from claims: quoting, control codes, line numbers, pointers, or termination.
* Assembler, branch/address, undocumented-opcode, symbols, PRG header/load-address bugs reporting successful but corrupt code.
* Unsafe writes to live ROM/I/O/shared/code memory without the promised pause/read-back.
* Screen/memory verification false positive/negative due to charset, PETSCII, display timing/mode, pause, or stale data.
* VIC-II/SID/CIA functionality claiming portable behaviour where a backend differs.
* A workflow overwriting a session, repeating after timeout, leaving a machine paused, or validating another backend.
* Capture encoding/timeouts/artifacts misrepresenting results or leaking resources.

## Priority 6 - Drives, storage, printers, streams, and verification

Inspect disk/drive/storage registries, mount/unmount/create/find/run, VICE drive resources, printer routines, stream start/stop, capture/artifact paths, and the related skills.

Look for:

* Wrong drive/backend targets, unverified final state, or retry loops duplicating mount/reset/physical work.
* Firmware, host-local, and VICE paths being confused or crossing a trust boundary.
* VICE drive-resource behaviour treated as Ultimate filesystem behaviour.
* Stream/capture sockets, printer work, or temporary artifacts persisting after stop/error/disconnect.
* Program launch assuming drive state that another tool can mutate.

## Priority 7 - Background tasks, meta workflows, artifacts, and cancellation

Inspect src/tools/meta/, task persistence/lifecycle, batch runs, artifact bundles, snapshots, diagnostics reports, compilation/filesystem helpers, server shutdown, and signal behaviour.

Look for:

* Cancelled/stopped tasks continuing device or child-process work.
* Success reported while a nested tool failed, or a failure hiding a completed destructive action.
* Concurrent tasks mixing backends, results, logs, or artifact paths; duplicate task starts; lost task state; unbounded live work.
* Artifacts/snapshots escaping their intended path, overwriting unrelated files, or presenting incomplete/stale data as valid.
* Batch/assertion flows continuing destructive steps after failure or timeout.
* Diagnostic/report calls exposing unrelated filesystem or session data.

## Priority 8 - RAG, external acquisition, paths, diagnostics, and secrets

Inspect src/rag/, URL normalisation/fetch/index/retrieval/rate limiting, knowledge resources, configuration resolution, filesystem/storage/extraction, logging HTTP client, diagnostics, and package data paths.

Look for:

* SSRF, unsafe URL schemes/redirects, local-network access, archive traversal, arbitrary file read/write, path traversal, or workspace/home escape.
* Lazy cache or fetch/index failure poisoning all later calls, blocking requests, duplicating work, or returning incorrect source content.
* Concurrent initialisation/rate limiting leaking promises or stalling service.
* Host/password/backend-profile precedence errors or secrets in errors/diagnostics/logs.
* Diagnostic destination failure crashing the server or allowing retrieval of unrelated local data.

## Priority 9 - Packaging, generated contract, documentation, and broad sweep

Inspect package.json, entry scripts, build/generation scripts, mcp/, generated OpenAPI clients, README generated blocks, server.json, .mcp.json, VS Code config, all registries, and public operations not already covered.

Look for:

* An installed package that cannot start, exposes a different tool set from source, or omits required runtime files.
* Generated API/MCP/README metadata drifting from runtime enforcement or the VICE support matrix.
* Public examples starting an incorrect entrypoint, writing logs to stdout, silently selecting a target, or failing on claimed host platforms.
* Mock-only/probe/experimental behaviour exposed publicly, or required VICE functionality only working in mocks.
* Unsafe/unusable environment parsing or cross-platform script assumptions.

## Duplicate handling

Keep findings separate when user flow, backend, transport/endpoint, physical consequence, persistence, lifecycle, recovery, fix location, or regression test differs. Combine only identical root causes with the same visible failure.

Before adding one, check the index and relevant details. If related but distinct, explicitly say why.

## Required finding format

Use HARD01-001, HARD01-002, and so on.

~~~markdown
### HARD01-00N - Title

- **Area:**
- **Severity:**
- **Dimensions:**
- **Confidence:** High/Medium
- **Effort:** S/M/L
- **Status:** OPEN
- **Files/functions reviewed:**

**Failure scenario:**  
Concrete MCP request, backend state, and user-visible result.

**Current-code evidence:**  
Precise file/function/line anchors. No large code blocks.

**Why production-reachable:**  
Supported client, documented workflow, or release/runtime path.

**Why this degrades C64 control, development, or trust:**  
Protocol, safety, emulator, program correctness, data, or security impact.

**Backend and recovery angle:**  
Relevant C64U/U64, U2, VICE, switch, timeout, disconnect, or restart behaviour.

**Relation to existing HARD01 findings:**  
Independent or related, and why still distinct.

**Why existing tests missed it:**  
Only if known from focused inspection.

**Minimal fix sketch:**  
Smallest defensible change. Do not implement it.

**Regression test strategy:**  
Specific focused unit, integration, VICE-BM, mock, or HIL test.

**Hardware validation:**  
Only if relevant: C64U, U64, U2, managed VICE, or unmanaged VICE.

**Fix risk:**  
Principal regression risk.
~~~

Immediately update counts, area totals, index, summary, batches, validation gate, and commands after each finding.

## Suggested fix batches and validation gate

Create coherent fix batches once several related findings emerge. Example:

~~~markdown
### Batch A - Backend-switch and capability isolation

- HARD01-001
- HARD01-006
- HARD01-014

Rationale:
- They share active-backend isolation and capability reporting.
- One multi-backend integration harness can protect the group.
~~~

Maintain a targeted—not generic—validation gate tied to findings. Appropriate entries include:

* Focused schema/platform/error-conversion tests.
* An stdio MCP request checking framing and error semantics.
* A concurrent backend-switch test using mock configured C64U/U2/VICE facades.
* A VICE BM stub test covering disconnect, unsolicited events, timeout, and queue release.
* Managed and unmanaged VICE lifecycle checks where relevant.
* Mock Ultimate tests for missing endpoint, auth/partial response, and input release cleanup.
* A BASIC/assembler/memory fixture with specific screen/memory assertions.
* URL/path/diagnostic-redaction tests.
* A controlled HIL validation only after a fix where hardware is indispensable; never perform it during this review.

## Leads not yet proven

Use only for concise, important unconfirmed leads:

~~~markdown
- **Lead:**
  - **Area:**
  - **Why it matters:**
  - **Evidence so far:**
  - **Next check:**
~~~

## Session survival protocol

On a low-credit, quota, rate-limit, spend, model-availability, or tool-instability warning—or if allowance becomes uncertain—stop analysis immediately and finalise review.md.

Finalisation means every confirmed finding is on disk; counts, area totals, and index are correct; each finding has severity/confidence/effort/status; batches and validation are current; limitations explain any count below 30; and a recommended next step is recorded. Do not hunt one more bug after the warning.

## Final response

Return only:

* Review document path.
* Backup path, if any.
* Findings by severity and area.
* Full findings index with every ID and title.
* Suggested fix batches.
* Recommended validation gate.
* Commands run.
* Important limitations.

Do not give a long narrative or only the top five findings.

