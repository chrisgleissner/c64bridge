# Hardening 02 — implementation brief for the lead (Opus 5.5) with Sonnet 5.5 workers

Repository: `/home/chris/dev/c64/c64bridge` (C64 Bridge MCP server, version 1.0.7)
Baseline commit: `781b040` on `main`
This file: `doc/reviews/hardening/02-fable/prompt.md`

## Summary

You are the lead engineer for the second hardening round of the C64 Bridge MCP server. A review at
`781b040` produced 55 work items in five groups: security and safety (S), resilience (R),
tool-surface correctness and usability (T), small features (F), and packaging, CI and
documentation (Q). Every item below names the defect, the evidence, the
required change and the test that proves it. Your job is to land all of them on one branch,
`fix/hardening-2`, as one pull request with one commit per item, using at most three Sonnet 5.5
workers at a time for the coding while you plan, review, integrate and verify.

The server already went through one hardening round (`doc/reviews/hardening/01-fable/`, PR #143,
findings HARD01-001 to HARD01-036). Nothing from that round needs redoing. Several items here touch
code that round changed on purpose; where that is the case the item says so and you must read the
history before changing it.

Nothing in this brief authorises contact with real hardware, a release, a version bump, a tag, a
merge to `main` or an npm publish. Open items that need the owner's decision are listed in
"Deferred" at the end; do not implement them.

## Your role and how to spend effort

You are expensive and the workers are cheap. Spend your own effort on:

- reading the code paths before you brief a worker, so each brief is precise;
- deciding designs where this brief leaves a choice;
- reviewing every worker diff line by line and rejecting anything outside its item;
- proving each test can fail (see "Definition of done per item");
- integration, conflict resolution and the final adversarial pass.

Delegate the typing: implementation, tests, mock-server routes, documentation edits.

Workers:

- Spawn them with the Agent tool and `model: "sonnet"`. Never more than three running at once.
- Each worker gets its own git worktree and branch (`git worktree add ../c64bridge-wt/<item-group> -b h2/<item-group> fix/hardening-2`). Do not use `git stash`. Two workers never edit the same file at the same time; the wave plan below is partitioned by file for that reason.
- A worker starts with no context. Each brief must contain: the item IDs and their full text from this file, the files it may edit, the files it must not edit, the test pattern to follow (see "Baseline facts"), the commands to run, the hardware rules below, and the exact report you want back (diff summary, test names added, command output tail, anything it could not do).
- A worker's report is a claim, not evidence. Check the diff and run the tests yourself before integrating.
- Integrate by cherry-picking or merging the worker branch into `fix/hardening-2`, then rebuild (see "Generated files").

## Hard rules

1. **No real hardware.** Do not call any `mcp__c64bridge__*` tool. Do not send requests to `c64u`, `u64`, `u2` or any other device host. Do not switch any power outlet. All verification uses the mock servers. Where an item needs hardware confirmation, record it in the final report under "Needs hardware confirmation" and do not attempt it. Put this rule in every worker brief.
2. **VICE only headless and only through the existing npm scripts** (`npm run test:vice:mock`; `npm run test:vice:device` if `x64sc` is installed). Never start a visible emulator. Always `VICE_VISIBLE=false`.
3. **Git.** Work on `fix/hardening-2` branched from `main`. One commit per item, message `fix: …` or `feat: …` in the style of `git log --oneline`, with the item ID in the body. No attribution lines. Do not rewrite published history. Do not merge to `main`. When all exit criteria hold, push the branch and open one pull request; do not merge it. The pull request description must open with a summary of the whole change including open items, and must separate previous behaviour, defect, change, verification and rejected alternatives for each group.
4. **No version bump, no `CHANGELOG.md` edit, no tag, no publish.** Releases are a separate process (`npm run release:prepare`). List user-visible behaviour changes in the pull request description instead.
5. **Backward compatibility.** Existing tool names, `op` names and parameter names keep working. A behaviour change is allowed only where this brief states one. New parameters are optional. Where a default changes, the item says so.
6. **Minimal change.** Fix the item; do not refactor neighbouring code, rename things or reformat files. No new runtime dependency. If an item cannot be done without one, stop and record it.
7. **Archaeology before deletion.** Before removing or loosening any guard, run `git log -S` on it and read the commit that introduced it. Several odd-looking checks are half of a HARD01 fix.
8. **Destructive shell commands.** No `rm -rf` on variable paths, no `git reset --hard`, no `git clean`. Remove worktrees with `git worktree remove`.
9. **GitHub polling** at most once every five minutes (`gh run watch --interval 300`).
10. If an item turns out to be wrong (the defect does not exist at the baseline), do not invent a change. Record the evidence and skip it.

## Orientation (do this first, yourself)

1. Read `AGENTS.md`, `doc/developer.md`, and the first 150 lines of `CHANGELOG.md`.
2. Read the "Background" section of `doc/reviews/hardening/01-fable/prompt-handover.md`. It explains the three bench devices, that `c64u` and `u2` are the same electrical machine, and why `pollValidator.ts` never reports blind success (HARD01-036). Item T-01 depends on it.
3. Run the baseline: `npm run build`, `npm run test -- --platform=c64u --target=mock`, `npm run test:vice:mock`. Record pass counts and `tools/list` size (see T-09) before any change.
4. Create `fix/hardening-2` and the worktree parent directory.

## Baseline facts (verified at `781b040`)

- Build: `npm run build` (about 17 s). It regenerates `README.md` and `mcp/*.json`; the tree stays clean at baseline.
- Tests: `npm run test -- --platform=c64u --target=mock` (1095 tests, about 33 s) and `npm run test:vice:mock` (24 tests, about 14 s). Two tests are skipped by design (real device).
- Known flake: `test/sidwaveAudio.test.mjs:107` ("a gap ends at the note onset") failed in one of two runs. It depends on a randomised `sidplayfp` power-on delay. See item Q-06. Do not treat this failure as caused by your change, and do not ignore any other failure.
- Test conventions: tests are `.mjs` files in `test/`, importing `test` from `#test/runner` and `assert` from `#test/assert`, and importing sources as `../src/*.js`. Runner: `scripts/run-tests.ts`.
- Test patterns to copy:
  - client level: `test/c64Client.test.mjs`, `test/device.test.mjs` (start `startMockC64Server()` / `startViceMockServer()`);
  - tool-module level: `test/machineControl.test.mjs`, `test/viceModule.test.mjs` (stub client, call `module.invoke(name, args, ctx)`);
  - MCP integration level: `test/mcpServerIntegration.test.mjs`, `test/suites/*`, `test/helpers/mcpTestHarness.mjs`.
- Mock servers: `scripts/mockC64Server.mjs` (REST) and `src/vice/mockServer.ts` (Binary Monitor). A new REST route or monitor command needs a mock route in the same commit.
- Generated files: `README.md` tool tables and `mcp/*.json` are generated by the build and checked by `test/updateReadme.test.mjs` and `test/generateMcpInterface.test.mjs`. **Never hand-merge them.** After integrating any worker branch, run `npm run build` on `fix/hardening-2` and commit the regenerated output with the item that caused it.
- Grouped tools are discriminated unions on `op`; ops are registered in `src/tools/registry/*.ts` and implemented in `src/tools/*.ts` and `src/tools/meta/*.ts`. Per-op backend support is `operationPlatforms` / `supportedPlatforms`.
- `src/sidplayRunner.ts` and `src/viceRunner.ts` are used only by tests. Leave them alone.
- Line numbers below are from `781b040`. Locate by symbol if they have moved.

## Design decisions already made

These are fixed. Implement them as stated; if one proves unworkable, stop and record why.

**D1 — Host path confinement.** One helper, `src/hostPaths.ts`, exporting `resolveHostPath(input, { purpose: "read" | "write", maxBytes? })`. Every tool argument that becomes a local path goes through it.
- Allowed roots by default: the current working directory, `~/.c64bridge`, and `os.tmpdir()`. The working directory is not an allowed root when it is the user's home directory or `/`.
- `C64BRIDGE_ALLOWED_DIRS` (entries separated by `path.delimiter`) adds roots. The single value `*` disables confinement.
- Resolution: `path.resolve`, then `fs.realpath` of the deepest existing ancestor, then a containment check on the real path. This rejects `..` traversal and symlink escapes.
- For `read`, check file size against `maxBytes` before reading (default 16 MiB; disk images 64 MiB).
- A rejection is a `ToolValidationError` that names the rejected path, the allowed roots and `C64BRIDGE_ALLOWED_DIRS`.
- Reuse the idea of `containedPath` in `src/tools/meta/artifacts.ts:114`; do not duplicate it.
- This is an intended behaviour change. Document it in `README.md` (through the generator's source, not the generated block) and `AGENTS.md`.

**D2 — Operation effect classification.** Every op gets one `effect`: `"read"`, `"write"` (changes machine or emulator state that a reset undoes, or writes a host file) or `"destructive"` (survives a reset or interrupts availability: power off, power cycle, reboot, flash save or load or reset-to-default, drive ROM load, disk image creation, debug register write, config restore with flash). Declare it next to `operationPlatforms`. A test fails if any op lacks an `effect`.

**D3 — Access mode.** `C64BRIDGE_ACCESS=full | no-destructive | read-only`, default `full` (no behaviour change by default). The check runs once, in the central dispatch (`toolRegistry.invoke`, `src/tools/registry/index.ts`, and the `c64_batch` and background-task paths), using D2. A blocked call returns a validation error naming the op, its effect, the active mode and the variable. An unknown value of the variable fails closed to `read-only` with a warning on stderr. `c64://platform/status` reports the active mode.

**D4 — MCP tool annotations.** Derive from D2 per grouped tool: `readOnlyHint` true only if every op is `read`; `destructiveHint` true if any op is `destructive`; `idempotentHint` false unless trivially true; `openWorldHint` false. Additionally tag each op line in the tool description with its effect when it is not `read`.

**D5 — Device request serialisation.** All REST requests to one Ultimate device run one at a time, in arrival order, through a single queue owned by `C64uBackend` (an axios request interceptor or a small promise chain). Probes with short timeouts use the same queue. The VICE backend already serialises in `withClient`; do not add a second queue there.

**D6 — Pause ownership.** A per-facade pause depth counter. A tool that pauses for its own purpose increments; its `finally` decrements; the device `resume` is sent only when depth returns to zero and the machine was not already paused by an explicit `c64_system pause`. An explicit `pause` sets a flag that only an explicit `resume` clears. All such tools pin the facade at call start (`pinFacade`, as `src/tools/memory.ts:300` does) so a backend switch during the call cannot send the resume to another backend.

## Work items

Each item: **ID — title.** Evidence. Required change. Proof.

### Wave 1 — three workers, disjoint files

#### Worker A: host paths (`src/hostPaths.ts` new; path sinks listed below)

**S-01 — Tool arguments become unconfined host file writes and reads.** `path.resolve` is the only processing. Write sinks: `src/tools/memory.ts:754-757` (`save_memory`), `src/tools/meta/memory.ts:194,242,245,259`, `src/tools/meta/config.ts:42,55`, `src/tools/meta/graphics.ts:288-292,417-418`, `src/tools/meta/artifacts.ts:61`, `src/tools/meta/program.ts:407,603,662,712,754,864`, `src/tools/meta/compilation.ts:56-127`. Read sinks: `src/tools/meta/config.ts:64,88`, `src/tools/programRunners.ts:698` (`symbolsFile`), `src/device.ts:732` (VICE `runPrgFile`), `src/device.ts:943` (VICE mount). A model can write chosen bytes into C64 RAM and then dump them with `asPrg:false` to `~/.bashrc`. Change: implement D1 and route every sink through it. Grep for further sinks (`writeFile`, `readFile`, `mkdir`, `createWriteStream`, `readFileSync`) under `src/tools` and `src/device.ts` and list in your report any sink you found that is not in this list. Proof: a table-driven test of `resolveHostPath` (traversal, symlink escape, home-directory working directory, `*`, extra roots, size cap) and one tool-level test per sink family showing a path outside the roots is rejected with the roots in the message and nothing is written.

**S-02 — Config restore leaks file content through parse errors.** `src/tools/meta/config.ts:64,88` reads any file; a non-JSON file produces a `JSON.parse` message that may quote its first bytes. Confirm whether the message reaches the tool result. Change: after D1, catch the parse error and return a validation error that names the path only. Proof: test with a non-JSON file asserting the result text contains none of the file's content.

#### Worker B: lifecycle and background tasks (`src/mcp-server.ts` transport and process sections, `src/tools/meta/background.ts`, `scripts/start.mjs`)

**R-01 — HTTP mode fails after the first request.** `src/mcp-server.ts:493-511` creates one `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` for the process; SDK 1.32.1 rejects reuse of a stateless transport, so the second request returns 500 (reproduced: `initialize` 200, then `tools/list` 500). Change: create the transport per request in stateless mode, or use stateful sessions; choose the one the installed SDK documents for this transport, and say which in the commit. Proof: an integration test that starts `--http` on an ephemeral port and performs `initialize`, `tools/list` and one `tools/call` in sequence.

**S-03 — HTTP mode accepts any Host and Origin.** Same code. A page that rebinds DNS to 127.0.0.1 can call every tool. Change: reject requests whose `Host` header is not `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` with 403; reject any request carrying an `Origin` header that is not one of those origins; if `C64BRIDGE_HTTP_TOKEN` is set, require `Authorization: Bearer <token>` (constant-time compare). Proof: tests for a foreign Host, a foreign Origin, a missing token and the accepted cases.

**R-02 — The server does not exit when the client goes away while a background task runs.** `src/tools/meta/background.ts:221-222` schedules timers that are never `unref`'d, and `src/mcp-server.ts` has no handler for stdin `end`/`close`. Reproduced: start a task, close stdin, the process is still alive and still writing to the device. Change: one idempotent `shutdown()` that stops all background tasks, stops any capture session, stops a managed VICE process and exits; call it on stdin `end`/`close`, `SIGTERM`, `SIGINT` and `SIGHUP`. Keep the existing VICE `stopSync` handlers (`src/device.ts:600-618`) working; do not register a second set that races them. `unref()` the task timers. Proof: an integration test that starts a task, closes stdin and asserts exit within 3 s.

**R-03 — `scripts/start.mjs` does not forward signals to its child.** `scripts/start.mjs:63-85`. Change: forward `SIGTERM`, `SIGINT`, `SIGHUP` and exit with the child's code. Proof: a test that spawns the launcher against the mock, sends `SIGTERM` and asserts the child pid is gone.

**R-04 — Background tasks follow a backend switch.** `src/tools/meta/background.ts:176-188` resolves the active facade on every tick, so a write task started against the C64U writes to VICE after `c64_select_backend` (`src/tools/registry/platform.ts:99`). Change: pin the facade at task start; record the backend in the task state and in `list_tasks`. Proof: test with two stub facades.

**T-02 — Background tasks accept any operation and discard results.** `src/tools/meta/background.ts:230-231` returns `{ success: true }` for an unknown operation; a `write` task with no arguments writes `$00` to `$0400` every interval (defaults at lines 213-221); results are thrown away (`:244-262`). Change: validate `operation` against the implemented set at `start_task` and reject others with the allowed list; require `address` and `bytes` for `write`; store the last result and last error per task and return them from `list_tasks` (add a `get_task` op returning one task with its last result if that is the smaller change). Proof: tests for each.

**R-05 — Background task limits and persistence.** `intervalMs` minimum is 1 with no cap on iterations or task count (`:292-293`); `ensureTasksLoaded` sets its flag before reading (`:106-122`), so a concurrent first call sees an empty registry; `persistTasks` rewrites every task on every tick with non-atomic writes and a load failure silently resets the registry (`:166-173`); `log.txt` grows without bound; a stop that arrives during an iteration can be overwritten by `completed`. Change: `intervalMs` minimum 100, at most 16 concurrent running tasks, `maxIterations` capped at 100000; await one load promise; write through a temporary file and `rename`; persist only the changed task; cap `log.txt` (keep the last 256 KiB); do not overwrite a `stopped` status; on an unparseable state file, move it aside as `tasks.json.corrupt-<timestamp>` and log it. Proof: tests for the limits, the concurrent first load, the stop race and the corrupt file.

#### Worker C: schema and error surface (`src/tools/types.ts`, `src/tools/errors.ts`, `src/tools/registry/batch.ts`, `src/tools/registry/platform.ts`, `src/platform.ts`, the `ListTools` and status-resource handlers in `src/mcp-server.ts`)

Worker B and Worker C both touch `src/mcp-server.ts` in different functions. Brief both about the other's region and integrate B first.

**T-03 — The published top-level schema contradicts per-op schemas.** `src/tools/types.ts:185-189` merges properties first-wins. Consequences found by diffing every property across ops: `c64_sound.preset` is published as `enum ["classic","expression"]` although `play_preset` takes `fuer_elise`; `c64_sound.verify` default; `c64_memory.length` max 4096 although `copy_memory`/`fill_memory`/`compare_memory` allow 16384; `c64_extract.length` min 63; `c64_input.durationMs` min and default; `c64_printer.secondaryAddress` enum `[0,7]` although `print_bitmap` allows 0–7; also `waveform`, `analysisDurationSeconds`, `waitBeforeCaptureMs`, `durationSeconds`, `voice`, `sidwave`/`cpg`/`expectedSidwave`, `c64_config.value`, `c64_graphics.text`, `c64_debug.enabled`. A validating client rejects valid calls. Change: when variants disagree on a property, the merged property must accept every variant's values (union of enums, widest range, no default, `anyOf` for differing types) and its description must say that limits depend on `op`. Runtime per-op validation is unchanged. Proof: a test that, for every grouped tool, validates every published example and every per-op schema's own bounds against the merged schema.

**T-04 — `c64_config op:"batch_update"` is undocumented and rejected by the published schema.** `src/tools/developer.ts:101-111` takes categories as top-level keys while the flattened schema has `additionalProperties:false` (`src/tools/types.ts:205-215`); the README row shows no inputs. Change: accept `updates: { <category>: { <item>: <value> } }` as the documented form, keep top-level category keys working, and publish a schema that admits both. This item edits `src/tools/developer.ts` too. Proof: tests for both shapes and the schema.

**T-05 — Validation errors omit the valid values.** `src/tools/errors.ts:89-96` reads only `details.message`. Observed texts: `c64_memory does not support op "nope" (at $.op)`, `Value is above maximum (at $.length)`, `Value must be one of the allowed options`. Change: append `allowed`, `minimum`, `maximum` and the received value from `details` to the text. Proof: tests asserting the allowed op list and the bound appear in the text content.

**T-06 — Unsupported-backend errors name internal handlers and give no remedy.** `src/tools/types.ts:388` and `resolveUnsupportedToolName` produce "Tool drive_remove is not available on platform vice". Change: "`c64_disk` op `unmount` requires backend c64u or u2 (active: vice). Use `c64_select_backend` to switch." Only suggest backends that are configured. Proof: test per message shape.

**T-07 — Per-op backend support is not discoverable.** `c64://platform/status` and the `c64_select_backend` result list whole tools as supported and ignore `operationPlatforms` (`src/mcp-server.ts:547`, `src/tools/registry/platform.ts:60-65`, `src/platform.ts:70-86`). Change: in each tool description, tag an op with its backends when it is not available on all three; in the status resource, list unavailable ops for the active backend. Proof: `test/mcpServerPlatformStatusResource.test.mjs` and `test/platform.test.mjs` extended.

**T-08 — `c64_batch` reports success when commands failed, and is unbounded.** `src/tools/registry/batch.ts:179` returns no `isError` when `failed > 0`. Change: `isError: true` when any command failed (results stay in the payload); at most 64 commands; keep the allowed list in per-command errors. Proof: `test/batchAndDisplayState.test.mjs`.

**T-09 — `tools/list` is about 159 KB, of which about 83 KB duplicates every per-op schema under `x-c64bridge-operations`.** Consumers of that key: `src/tools/types.ts`, `scripts/update-readme.ts`, `test/updateReadme.test.mjs`, `test/inputModule.test.mjs`, `test/toolsTypes.test.mjs`. A client passes the whole schema to its model on every session. Change: keep the per-op data available to the README generator internally, but stop sending the duplicate over the wire; the published description must still state, per op, the required and optional parameter names. Record `tools/list` size before and after in the commit; target under 90 KB. If any shipped client documentation relies on the key, keep it behind `C64BRIDGE_VERBOSE_SCHEMA=1`. Proof: an integration test asserting the size bound and that each op's required parameters appear in the description.

**T-10 — Error classification.** `basicToPrg` and `src/tools/programRunners.ts:277-284` throw plain `Error` ("Expected line number…", "Line number out of range"), reported as `kind:"unknown"`; unknown tool and unknown prompt errors do not list valid names. Change: validation errors with paths; list valid names. `programRunners.ts` belongs to Worker E in wave 2; do the `basicToPrg` part there and the unknown-name part here. Proof: tests.

### Wave 2 — three workers

#### Worker D: device transport (`src/device.ts`, `src/config.ts`, `src/vice/viceClient.ts`, `src/vice/process.ts`, capture sections of `src/c64Client.ts`, pause call sites in `src/tools/meta/memory.ts` and `src/tools/meta/graphics.ts`)

**R-06 — Requests to the Ultimate are not serialised.** `C64uBackend.writeMemoryBlocks` runs `Promise.all` over up to eight writes (`src/device.ts:326-329`); `compare_memory` issues two parallel reads (`src/tools/memory.ts:701`); the config snapshot issues three (`src/tools/meta/config.ts:43`); concurrent MCP calls run in parallel. The firmware's REST server is single-threaded. Change: D5. Proof: a test with a mock that records concurrent in-flight requests and asserts the maximum is 1 under parallel tool calls, and that write order equals call order.

**R-07 — Pause and resume are not paired across concurrent calls.** `src/tools/meta/memory.ts:105,170,198,263` and `src/tools/meta/graphics.ts:252,311,369,433` pause, work and resume in `finally` on the unpinned client, ignore the `{ success:false }` that `C64Client.resume` returns, and undo an explicit user pause. Change: D6; warn in the result when resume fails, as `src/tools/memory.ts:439` does. Proof: tests for two overlapping calls, an explicit pause that survives a tool call, a backend switch during a call, and a failed resume.

**R-08 — With only `C64U_HOST` set and the device offline at startup, VICE becomes the active backend.** `src/device.ts:1322-1385` falls back to VICE after a 1.5 s probe when no config section exists; `createAllFacades` (`:1388-1392`) drops the caller's base URL unless `C64_MODE=u2`. Later calls then try to start an emulator instead of reporting an unreachable device, and the choice is never re-evaluated. Change: any `C64U_*` or `U2_*` endpoint variable counts as explicit selection of that backend, as the config-file branch does. Keep the unconfigured fallback. Proof: test with the variable set and an unreachable port.

**R-09 — The reachability probe requests `GET /`.** `src/device.ts:249-257,1375`. axios rejects non-2xx by default, so the `< 500` comparison never applies, and the probe ignores a path prefix in `baseUrl`. Whether the firmware answers `GET /` with 2xx is unconfirmed. Change: probe `GET <baseUrl>/v1/version` with `validateStatus: () => true` and treat any HTTP response as reachable; send `X-Password` when configured (see commit `d7119c6`). Proof: mock returning 404 and 403 on the probe path; add "Needs hardware confirmation".

**R-10 — Invalid host and port values are silently replaced by defaults.** `src/config.ts:200-215`: a bare IPv6 host makes `new URL` throw and the host becomes `c64u`; `C64U_PORT=80x` or `99999` becomes 80; a malformed `C64BRIDGE_CONFIG` file logs one line and the next candidate file is used (`:79-92`), which may be a different machine. Change: bracket bare IPv6 before parsing; an invalid port or host is a startup error naming the variable and value; a `C64BRIDGE_CONFIG` file that exists but cannot be parsed is a startup error (the other candidates keep their fall-through). Read commits `780d7a6` and `d7119c6` first. Proof: `test/config.test.mjs` cases.

**R-11 — VICE monitor connect has no timeout.** `src/vice/viceClient.ts:94-112`; a host that drops SYN blocks `monitorQueue` (`src/device.ts:623-630`) for the OS timeout. Change: 5 s connect timeout that destroys the socket. Proof: test against a non-accepting listener or a stubbed socket.

**R-12 — `keyboardFeed` writes its length as one byte.** `src/vice/viceClient.ts` (`bytes.length & 0xff`). Change: chunk text longer than 255 bytes in order; reject empty. Proof: test with the mock for 600 bytes.

**S-04 — `c64_config` on VICE bypasses the `c64_vice` resource allowlist.** `c64_vice` restricts names to safe prefixes (`src/tools/vice.ts:34-43`, `ensureSafeResourceName`), but `ViceBackend.configSet` and `configBatchUpdate` (`src/device.ts:1062-1088`) pass any name to `resourceSet`, including resources that name host files. `test/backendCapabilities.test.mjs:334` sets `WarpMode` through this path; keep that working by adding the needed prefix to the shared list if it is safe. Change: apply the same check in `configGet`, `configSet` and `configBatchUpdate`; one shared list. Proof: tests for a rejected and an accepted name on each path.

**R-13 — Video capture error handling.** `src/c64Client.ts:1568-1575`: a failed `streamStop` in `finally` discards a successful capture and masks the primary error. `:1911-1932`: `resolveLocalCaptureAddress` falls back to `127.0.0.1`, so the device is told to stream to itself and the user sees a timeout. `:1544-1555`: packets are accepted from any source address. Change: keep the primary error and report the stop failure as a warning; fail with a clear message when no local address is found; accept packets only from the device address. Read issue-151 history (`test/issue151Regression.test.mjs`) first. Proof: tests.

**R-14 — VICE port already in use.** `src/vice/process.ts:102-122,334-345`: unconfirmed that a foreign listener on the monitor port makes `waitForPort` succeed. Confirm by reading and with the mock. If confirmed: check the port is free before spawning, and fail with the port number. If not confirmed, record and skip. Proof: test.

#### Worker E: program, assembler and memory tool correctness (`src/tools/programRunners.ts`, `src/tools/pollValidator.ts`, `src/tools/translation/*`, `src/tools/memory.ts`, `src/tools/meta/screen.ts`, `src/tools/input.ts`, `src/tools/registry/printer.ts`, `src/petscii.ts`, `readScreen` in `src/c64Client.ts`)

Worker D and Worker E both touch `src/c64Client.ts` in different functions; brief both.

**T-01 — `upload_run_asm` reports a crash for any program that does not change screen RAM.** `src/tools/programRunners.ts:595-602`, `src/tools/pollValidator.ts:284-320`. A SID player, a border effect or a program that ends in `JMP *` returns `isError` "appears to have crashed". **History:** this check was made unconditional by HARD01-036 because the U2 firmware answers `run_prg` with success without loading or running anything; do not restore blind success. Change: make the evidence stronger and the wording accurate. (1) After the upload, read back the first bytes at the load address and compare with the PRG; a mismatch is an error "program was not loaded" on every backend, and this is the check that catches the U2 case. (2) Liveness beyond screen RAM: sample `$D012` twice and a 16-byte window of the program's own zero-page or stack use only if cheap; the screen CRC stays. (3) If the program is loaded but no liveness is seen: with `verify:true` return an error; with `verify:false` return a non-error result with `execution: "unconfirmed"` and a sentence saying the program loaded and no screen change was observed. Update the `verify` description (`:296-304`). Proof: update `test/pollValidator.test.mjs` and `test/programRunnersModule.test.mjs`; the three HARD01-036 tests must still express that a never-loaded program is an error.

**T-11 — `upload_run_basic` rewrites and re-runs programs on error with no opt-out.** `src/tools/programRunners.ts:404`: on a detected BASIC error it appends quotes or parentheses and runs again, so a program with side effects runs twice; with `verify:false` it reports "executed successfully" from one immediate screen read. Change: add `autoFix` (default `true`, unchanged behaviour) that disables the rewrite when `false`; when a rewrite happened, say so in the result with the changed lines; word the unverified result as "started". Proof: tests.

**T-12 — The assembler emits wrong bytes without an error.** `src/tools/translation/assembler.ts`. Confirmed by running: `lda ($1000),y` gives `B1 00`; `lda #256` gives `A9 00`; `.byte 256` gives `00`; `.byte -129` gives `7F`; `.word 70000` is truncated; `*=$FFFE` followed by three `NOP` produces a 65538-byte PRG with load address `$0000`. Change: range-check immediates (−128..255), `.byte` (−128..255), `.word` (−32768..65535), require a zero-page operand for `(zp),y` and `(zp,x)`, and error when output passes `$FFFF`. Read commits `629db1a` and `c996b64` first. Proof: `test/assembler.test.mjs` case per input, asserting the error names the line.

**T-13 — Assembler diagnostics and advertised directives.** `jmp nowhere` gives "Undefined expression" without the symbol; a duplicate label gives a pass-mismatch message. `data/assembly/assembly-spec.md:40,485` and `data/context/bootstrap.md:165` advertise `.equ`, `.fill`, `.align`, `.text`/`.ascii`, none of which exist (`DIRECTIVE_ALIASES`, `assembler.ts:208-225`). Change: name the undefined symbol and the duplicate label with both line numbers; implement `.equ`, `.fill count[,value]`, `.text`/`.ascii` (ASCII to PETSCII, state the mapping) and `.align n[,fill]`. Proof: tests per directive and message.

**T-14 — `disassemble` reads too few bytes and invents operands.** `src/tools/memory.ts:392-400`: `instructionCount` is documented as overriding `length`, yet only `length` (default 64) bytes are read. `src/tools/translation/disassembler.ts` `formatOperand` renders a truncated trailing instruction with zero operand bytes. Change: read `min(3 × instructionCount, bytes to $FFFF)`; render a truncated instruction as `.byte` data; add the lines to `structuredContent`. Proof: `test/disassembler.test.mjs`.

**T-15 — Address parsing differs between ops and misreads bare hex.** `read`/`write` use the client parser (`src/c64Client.ts:927-948`): `C000` fails as an execution error, and `0400` is read as decimal 400. The other memory ops use `parseAddressArg`, which lacks `%` binary. Change: one shared parser for every address and length argument; accepted forms `$C000`, `0xC000`, `%…`, decimal; a string of hex digits containing A–F without a prefix is a validation error suggesting `$`; a decimal string with a leading zero is a validation error stating the ambiguity; range errors are validation errors raised before any device call. Read `test/addressParsing.test.mjs` and the fix in PR #124 first. Proof: extend that test file and `test/c64ClientInvalidInputs.test.mjs`.

**T-16 — `wait_for_text` can hang the server and reports timeouts poorly.** `src/tools/meta/screen.ts:38-41` builds a `RegExp` from the argument and matches on the event loop; `(a+)+$` against a screen of `A` blocks the process; an invalid pattern surfaces as `kind:"unknown"`; `timeoutMs` and `intervalMs` have no bounds (`:18-19`); a timeout result omits the screen. Change: validate the pattern (length at most 200, compile inside try/catch as a validation error, reject nested quantifiers such as a quantified group that itself contains a quantifier); `timeoutMs` at most 120000, `intervalMs` at least 20; include the last screen text in the timeout result. Proof: `test/meta/screen.test.mjs`.

**T-17 — `read_screen` assumes `$0400` and the upper-case character set.** `src/c64Client.ts:899-904`, `src/petscii.ts:89-130`. With the lower-case set active, letter case is inverted; a moved screen is not followed. Change: derive the screen base from `$D018` and `$DD00` and the character set from `$D018` bit 1 (the display-state code already reads both); decode accordingly; report base and character set in the result. Keep one extra read at most. Proof: tests for both character sets and a moved screen.

**T-18 — `write_text` mangles input silently.** `src/tools/input.ts:295-299` masks each character with `& 0xFF`; an unknown `{TOKEN}` is typed literally (`:114`); `\n` is not mapped. The `key` op says "or hold it" although `durationMs` is a delay between presses. Change: reject characters with no PETSCII mapping, naming the character and position; reject unknown tokens with the list of valid tokens; map `\n` to RETURN; correct the description. Proof: `test/inputModule.test.mjs`.

**T-19 — Truncation is not reported.** `search_memory` and `compare_memory` stop at `maxResults`/`maxDiffs` with no flag and `diffCount` is the capped count; `stop_all_tasks.count` is the total, not the number stopped. Change: add `truncated` and the true total where it is known without extra device calls; fix the count. Proof: tests.

**T-20 — A published example does not validate.** `src/tools/registry/printer.ts:194` uses `ensureReturn`, which is not a parameter; the config example path `./snapshots/c64_json`. Change: fix both; T-03's test covers examples from then on.

#### Worker F: access mode and annotations (`src/tools/types.ts`, `src/tools/registry/*.ts`, `src/tools/registry/index.ts`, `ListTools` handler) — starts after Worker C's wave-1 work is integrated

**S-05 — No access mode and no annotations.** Reachable without any guard: `c64_system poweroff`/`reset`/`power_cycle` (`src/tools/registry/system.ts:59-74`), config `reset_defaults`/`save_flash`/`load_flash` (`src/tools/registry/config.ts:123-144`), snapshot restore with `applyToFlash` (`src/tools/meta/config.ts:78`), `load_rom` (`src/tools/storage.ts:476`), `create_image`, `write_debugreg`, memory writes. `tools/list` carries no annotations (`src/mcp-server.ts:254-265`). Change: D2, D3, D4. Proof: a test that every op has an effect; tests that each mode blocks exactly its set, including through `c64_batch` and `start_task`; a `tools/list` test for annotations.

**S-06 — `poweroff` leaves the machine unrecoverable by software.** After `poweroff`, power must be restored at the outlet, and the machine starts by itself only if automatic startup on power restoration is enabled. Change: state this in the op description and in the result text. Do not add config writes. Proof: test of the text.

### Wave 3 — three workers

#### Worker G: small features

**F-01 — Wait for ready after reset.** `c64_system reset`, `reboot` and `power_cycle` return before the machine is usable; `src/tools/machineControl.ts` has no wait. Change: optional `waitForReady` (default `false`) with `readyTimeoutMs` (default 15000, max 120000); polls reachability and then the screen for `READY.`, reusing the `wait_for_text` logic; result says whether ready was reached. Proof: tool-level tests with a stub client.

**F-02 — `c64_system pause`/`resume` on VICE.** Marked unsupported in `ViceBackend` (`src/device.ts`, near line 855). The monitor stops the CPU while a client is in the monitor and `exitMonitor` (0xAA) resumes. Read `c64://vice/binary-monitor-spec` (`data/`) and how `c64_debug` `continue_execution` and `get_monitor_state` already hold and release the monitor; implement pause and resume on the same mechanism so the two tools agree on state, including D6's explicit-pause flag. If the existing connection handling (`withClient` sends `exitMonitor` in `finally`) makes a held pause impossible without restructuring, stop and record it. Proof: `test/viceModule.test.mjs`-style tests against the mock.

**F-03 — `c64_program load_prg` on VICE.** `ViceBackend.loadPrg(bytes)` exists (`src/device.ts:723`) while the op is not enabled for VICE and the file-path variant is unsupported (`:729`). Change: enable it, reading the host file through D1. Proof: mock test.

**F-04 — `c64_disk find_paths`.** `find_paths_by_name` exists at `src/tools/meta/filesystem.ts:364` and is unreachable; `find_and_run_program_by_name` builds `//**` for root `/` (`:564`) while `buildSearchPattern` handles it. Change: expose `find_paths` (search without running), use `buildSearchPattern` in both, cap results with `truncated`. Proof: tests with the mock's `/v1/files` route.

**F-05 — Hex dump format for `c64_memory read`.** Optional `format: "hex" | "dump"` (default `hex`, unchanged); `dump` gives 16 bytes per line with address and a printable column using the PETSCII decoder. Proof: test.

**F-06 — Per-category flash operations.** The firmware has `PUT /v1/configs/{category}:load_from_flash`, `:save_to_flash` and `:reset_to_default` (`doc/c64u/c64-openapi.yaml`; check `doc/u2/u2-openapi.yaml` and set platforms accordingly); only the whole-device forms are wired (`src/device.ts` near 422). Change: optional `category` on the three existing ops; add mock routes. Effect stays `destructive`. Proof: client and tool tests.

**F-07 — `capture_frame` and `capture_samples` return megabytes of base64 by default.** `src/tools/registry/graphics.ts:36-60,123-175`: `includePixels` defaults to `true`, `count` up to 32, about 100 KB per frame, emitted in both text and `structuredContent`; the response type cannot carry an image block. Change (default change, intended): `includePixels` default `false`; new `format: "png"` returning MCP image content (use the existing `jimp` dependency and the palette already in the repo), at most 4 images per call; when raw pixels are requested, reject a response above 2 MiB with a message naming `count`. Apply the same size cap to `capture_samples`. Proof: `test/graphicsModule.test.mjs`, including a decoded PNG's dimensions.

**F-08 — BASIC listing from memory (do last; drop if the wave runs long).** No detokenizer exists; `src/tools/translation/basicTokenizer.ts` holds the token table. Change: `c64_memory op:"list_basic"` that reads `$2B/$2C` and `$2D/$2E`, walks link pointers with a loop guard and a 64 KiB bound, and returns the listing; effect `read`. Proof: round-trip tests through the tokenizer and a corrupt-link test.

#### Worker H: diagnostics, packaging, CI, documentation

**Q-01 — Diagnostics grow without limit and are group-readable.** `src/diagnostics.ts:125,383,393-396`: one file per session, synchronous append per event, no retention, default modes. The owner's directory holds about 10 000 files. Change: create the directory `0700` and files `0600`; at startup delete diagnostics files beyond the newest 200 or older than 30 days (`C64BRIDGE_DIAGNOSTICS_KEEP` overrides the count); deletion is best-effort, limited to files matching the diagnostics naming pattern inside that directory, and never follows symlinks. Test only against a temporary directory. Proof: tests for retention and modes.

**Q-02 — `prepack` is not under `scripts`.** `package.json:107` has it as a top-level key, so it never runs. Change: move it. Check `scripts/check-package.mjs` still passes.

**Q-03 — Package contents.** The tarball ships `doc/plans/**`, `doc/reviews/**`, `scripts/compare-rest/*.json` and screenshots, and omits `.github/skills/**` although `src/prompts/registry.ts` names the skills as the source of truth for execution. `fastify` is a runtime dependency with no import. `octokit` is imported only by `src/rag/discover.ts` (build time). `c64_disk._meta.prompts` names `drive-management` while the prompt is `drive-manager`. Change: narrow `files` (keep what `doc/troubleshooting-mcp.md`, the OpenAPI files and the README images need; verify with `npm pack --dry-run` and `npm run check:package`), add `.github/skills/**`, remove `fastify`, move `octokit` to `devDependencies` after confirming nothing in `dist/` reachable from the server entry imports it, fix the prompt name. Proof: `check:package` and `test/promptsRegistry.test.mjs`.

**Q-04 — CI.** `ci.yaml` runs `docker-build.yaml` on pull requests with `packages: write`, pushing `mcp-builder:latest` (`docker-build.yaml:19-24`), which `release.yaml:23-30` then runs inside with `id-token: write`; `build-and-test.yaml` and `package-check.yaml` have no `permissions` block; no `.dockerignore` while the Dockerfile does `COPY . .`; `.c8rc.json` sets 90 % thresholds that `scripts/run-coverage.mjs` does not enforce; `npm audit --omit=dev` and `check:node-compat` run only at release or not at all. Change: push the image only on `push` to `main` (pull requests build without pushing); top-level `permissions: contents: read` in every workflow, with per-job additions where needed; `persist-credentials: false` on checkouts that do not push; add `.dockerignore` (`.git`, `node_modules`, `dist`, `coverage`, `artifacts`, `external`, `.env*`, `.c64bridge.json`); enforce the thresholds in `run-coverage.mjs` only if current coverage meets them, otherwise set the enforced values to the current floor rounded down and say so; add `npm audit --omit=dev` and `check:node-compat` to the pull request workflow. Do not pin actions by SHA in this round. Proof: workflow YAML parses (`node -e` with the `yaml` package) and the coverage script exits non-zero on a synthetic low report.

**Q-05 — Documentation drift.** `AGENTS.md` capability list omits `c64_input`, `c64_debug`, `c64_vice`, `c64_stream`, `c64_extract`, `c64_batch` and six memory ops; `doc/vice/support-matrix.md` lists supported memory ops as unsupported; `PLANS.md` describes the 0.9.2 release; `WORKLOG.md` and `worklog.md` differ only by case and collide on case-insensitive file systems. Change: update `AGENTS.md` and the matrix from the code; `git mv worklog.md doc/plans/vice-backend-switch/worklog.md` and `git mv PLANS.md doc/plans/release-0.9.2/plan.md` without content edits; document every new variable (`C64BRIDGE_ALLOWED_DIRS`, `C64BRIDGE_ACCESS`, `C64BRIDGE_HTTP_TOKEN`, `C64BRIDGE_DIAGNOSTICS_KEEP`, and `C64BRIDGE_VERBOSE_SCHEMA` if added) in `README.md`, `AGENTS.md` and `server.json`; update the affected `.github/skills/*/SKILL.md` for new ops and parameters. This worker runs last in the wave.

**Q-06 — Flaky audio test.** `test/sidwaveAudio.test.mjs:107`. Read commits `e7639ad` and `add0362`. Measure first: run the file 20 times through the project runner and record the failure rate. Fix the cause only if you can show the rate drop to 0 in 40 runs; otherwise record the measurement and leave the test.

#### Worker I (optional, only if a slot is free): `src/c64Client.ts` and `src/tools/audio.ts`

**S-07 — Stream target and microphone.** `src/tools/streaming.ts:22-25` passes any string as the stream target. Change: validate as an IPv4 address or hostname with optional port; state in the description that the device sends UDP to that address. `src/tools/audio.ts:296-300` records from the host microphone on non-C64U backends: state this in the op description. No blocking of public addresses in this round.

## Definition of done per item

1. The change is limited to the item.
2. A test exists that fails without the fix. **You** verify this: revert the production change for that item in a scratch worktree (or `git stash`-free equivalent such as `git checkout <base> -- <file>` in a throwaway worktree), run the new test, see it fail, restore. Record "fails when reverted: yes" per item. A test that passes with the fix reverted is not accepted.
3. `npm run build` leaves no uncommitted generated changes.
4. `npm run test -- --platform=c64u --target=mock` and `npm run test:vice:mock` pass (the Q-06 flake excepted until Q-06 is resolved; rerun once and record it).
5. One commit, item ID in the body.

## Exit criteria for the round

- Every item is done, or skipped with recorded evidence, or blocked with a recorded reason.
- Full test matrix passes on the final branch head: both mock runs twice in a row, and `npm run coverage` if `x64sc` is available.
- `npm run check:package` passes and `npm pack --dry-run` shows no `doc/plans`, `doc/reviews` or test files.
- Final adversarial pass by you, not a worker, over the whole `main..fix/hardening-2` diff: look for a guard that was added in one path and missed in a sibling path (every path sink through D1, every dispatch path through D3, every pausing tool through D6), for changed defaults not listed in this brief, and for any stdout write outside the MCP protocol. You may give one fresh Sonnet reviewer the diff without your conclusions for an independent read.
- The pull request is open, checks are green, and it is not merged.

## Final report (in the pull request description and as your last message)

1. Summary of the whole change, including open items.
2. Table: item ID, status (done, skipped, blocked), commit, test name, "fails when reverted".
3. Behaviour changes a user will notice (D1 confinement, `capture_frame` default, stricter address and config parsing, batch `isError`, schema changes, package contents).
4. Needs hardware confirmation: R-09 (what the firmware returns for `/v1/version` without a password and for `GET /`), T-01 (load readback on U2), F-02, F-06, whether `create_image` overwrites an existing image, R-13 on a real stream.
5. `tools/list` size before and after.
6. Anything you found that is not in this brief, as a list for the owner; do not fix it.

## Deferred — owner decision required, do not implement

- Result payload shape: every result carries the data in text, in `structuredContent.data` and in a non-standard top-level `metadata` (`src/tools/responses.ts`, `src/mcp-server.ts:692-715`). Changing it breaks clients.
- `./.c64bridge.json` in the working directory can name the VICE executable (`src/config.ts:50-55`, `src/device.ts:455-484`). Restricting it breaks existing setups.
- Marking device, disk and RAG text in results as untrusted content.
- Blocking public stream targets.
- Moving destructive ops into a separate tool.
- VICE snapshots (monitor commands 0x41 and 0x42), memspace and bank selection for VICE memory access, `machine:measure`, `/v1/help`, drive `unlink`, upload variants of mount and `run_crt`.
- Adopting a linter, `noUncheckedIndexedAccess`, and pinning GitHub Actions by SHA.
- `src/rag/externalFetcher.ts:575` builds a shell string for `unzip` (build-time script only).
