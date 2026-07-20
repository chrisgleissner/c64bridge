# Hardening 01 - Whole-server Fable bug review

## Baseline

- Review date: 2026-07-19T17:55:22+01:00
- Branch: fix/hardening
- Commit: da8b5c855f6f712471822466618322fd15a9f2b2
- Working tree status: clean except untracked doc/reviews/hardening/
- Review mode: Review only. No implementation.
- Model: Anthropic Fable
- Required artifact: doc/reviews/hardening/01-fable/review.md

## Executive summary

31 confirmed, production-relevant defects across every C64 Bridge subsystem: 5 P1, 18 P2, 8 P3, no P0. The dominant themes are (1) **false success** — Ultimate REST methods report success on any 2xx while ignoring the firmware `errors` array (HARD01-011), `upload_run_asm` runs machine code that never actually executes (HARD01-018) behind a crash-detector that can never fire (HARD01-019), and printer/BASIC generators emit invalid CBM BASIC (HARD01-007) — ; (2) **lifecycle and cancellation gaps** in VICE (no BM response timeout wedges the whole backend, HARD01-012; orphaned VICE/Xvfb on exit, HARD01-013) and in background/detached work (HARD01-022, HARD01-030); (3) **backend-switch and config consistency** (in-flight operations retargeting across `c64_select_backend`, HARD01-016; two divergent config loaders resolving different hosts, HARD01-005; cwd-vs-package path resolution breaking config and RAG for installed users, HARD01-006/025); and (4) **input/physical-state hazards** (blind Tool-Menu RETURN in power_cycle, HARD01-002; VICE joystick writes that do nothing, HARD01-014; keystroke loss on drain timeout, HARD01-009). Also present: a secrets-in-logs leak (HARD01-024) and an artifact path traversal (HARD01-029).

A codebase-wide arithmetic bug (HARD01-032) makes every SID note ~256x too low in pitch because the frequency register formula uses 2^16 instead of the SID's 2^24 phase-accumulator divisor; the wrong formula is also copied into the knowledge docs.

Highest-priority fixes: HARD01-011 (systemic false success on hardware), HARD01-012 (permanent VICE wedge), HARD01-018 (assembly workflow never executes), HARD01-032 (SID pitch off by 256x), HARD01-014 (VICE joystick no-op), HARD01-002 (uncontrolled physical menu action).

## Findings count

| Severity | Count |
|---|---:|
| P0 | 0 |
| P1 | 5 |
| P2 | 19 |
| P3 | 11 |
| Total | 35 |

## Findings by area

| Area | Target | Confirmed |
|---|---:|---:|
| MCP protocol, stdio, tool dispatch, prompts, and resources | 3-5 | 1 |
| Backend selection and platform/capability contract | 3-5 | 6 |
| Ultimate REST, machine control, configuration, and input | 4-6 | 5 |
| VICE Binary Monitor and process lifecycle | 4-6 | 6 |
| Program execution, BASIC, assembler, memory, graphics, and SID | 4-6 | 8 |
| Drives, storage, printers, streams, and state verification | 3-5 | 2 |
| Background tasks, meta workflows, artifacts, and cancellation | 3-5 | 4 |
| RAG, external acquisition, paths, diagnostics, and secrets | 3-5 | 2 |
| Packaging, generated contract, documentation, and broad sweep | 3-5 | 1 |

## Findings index

| ID | Title | Area | Severity | Dimensions | Confidence | Effort | Status |
|---|---|---|---|---|---|---|---|
| HARD01-001 | Documented `--http` mode parsed but never wired | Packaging/docs | P3 | documentation-contract, mcp-protocol | High | S | OPEN |
| HARD01-002 | power_cycle presses RETURN after blind cursor moves; no highlight verification | Ultimate | P1 | device-safety, physical-state, input | High | M | OPEN |
| HARD01-003 | power_cycle failure leaves Ultimate menu open, no cleanup | Ultimate | P2 | device-safety, timeout-cancellation | High | S | OPEN |
| HARD01-004 | Transient probe errors permanently cache machine:input as "unknown" | Backend/capability | P2 | capability, c64u-rest | High | S | OPEN |
| HARD01-005 | Divergent config loaders resolve different hosts | Backend/capability | P2 | config, backend-switching | High | M | OPEN |
| HARD01-006 | `./.c64bridge.json` resolved package-relative, not cwd | Backend/capability | P2 | config, documentation-contract | High | S | OPEN |
| HARD01-007 | Printer quote-doubling is invalid CBM BASIC; runtime SYNTAX ERROR with reported success | Drives/printers | P2 | basic, program-runner | High | S | OPEN |
| HARD01-008 | PETSCII "wait for key" never waits; READY. corrupts rendered screen | Program execution | P3 | basic, graphics | High | S | OPEN |
| HARD01-009 | injectKeyboardQueue silently drops keys on drain timeout | Ultimate/input | P2 | input, timeout-cancellation | High | S | OPEN |
| HARD01-010 | files endpoints double-encode device paths (slashes) | Ultimate | P2 | c64u-rest, filesystem | Medium | S | OPEN |
| HARD01-011 | C64u/U2 facade ignores `errors` array in 200 responses | Ultimate | P1 | c64u-rest, tool-contract | Medium | M | OPEN |
| HARD01-012 | ViceClient lacks response timeout; lost frame wedges all VICE ops | VICE | P1 | vice-monitor, timeout-cancellation | High | M | OPEN |
| HARD01-013 | Managed VICE/Xvfb orphaned on server exit/termination | VICE | P2 | vice-lifecycle, filesystem | High | M | OPEN |
| HARD01-014 | VICE joystick writes CIA ports (no-op); BM Joyport Set unimplemented | VICE | P1 | input, vice-monitor, tool-contract | High | M | OPEN |
| HARD01-015 | checkpointCreate silently adds execute flag to watchpoints | VICE | P3 | vice-monitor, tool-contract | High | S | OPEN |
| HARD01-016 | Platform gating and multi-step flows race with c64_select_backend | Backend/capability | P2 | backend-switching, concurrency | High | M | OPEN |
| HARD01-017 | Write-verify leaves machine paused with success when resume fails | Program execution | P2 | memory-io, physical-state | High | S | OPEN |
| HARD01-018 | upload_run_asm has no SYS/stub entry; ML never executes, success reported | Program execution | P1 | program-runner, 6510 | High | M | OPEN |
| HARD01-019 | ASM crash detection dead: raster/CIA timers make every machine "alive" | Program execution | P2 | program-runner, tool-contract | High | S | OPEN |
| HARD01-020 | ASM polling DMA-reads CIA ICRs, clearing pending IRQs on hardware | Program execution | P2 | memory-io, device-safety | Medium | S | OPEN |
| HARD01-021 | BASIC polling false-fails programs that print "ERROR" | Program execution | P3 | basic, tool-contract | High | S | OPEN |
| HARD01-022 | Persisted running tasks never rescheduled after restart | Background tasks | P2 | background-task, persistence | High | M | OPEN |
| HARD01-023 | drive_mount_and_verify assumes VICE drive shape; fails on hardware | Drives/storage | P2 | drive, c64u-rest | High | M | OPEN |
| HARD01-024 | Debug HTTP logging leaks raw X-Password header | RAG/secrets | P3 | secrets, diagnostics | High | S | OPEN |
| HARD01-025 | RAG paths resolved from cwd; installed server returns empty retrievals | RAG/paths | P2 | rag, filesystem, packaging | High | M | OPEN |
| HARD01-026 | VICE reset reports success even when BASIC never reaches READY | VICE | P2 | vice-lifecycle, tool-contract | High | S | OPEN |
| HARD01-027 | Malformed C64BRIDGE_CONFIG JSON crashes server at startup | Backend/capability | P3 | config, diagnostics | High | S | OPEN |
| HARD01-028 | Background task {success:false} iterations counted as healthy | Background tasks | P3 | background-task, tool-contract | High | S | OPEN |
| HARD01-029 | bundle_run_artifacts path traversal via unsanitised runId | Background tasks | P2 | filesystem, security | High | S | OPEN |
| HARD01-030 | c64_sound generate spawns untracked uncancellable playback loop | Background tasks | P2 | sid-audio, timeout-cancellation | High | M | OPEN |
| HARD01-031 | platform/status resource read blocks on device REST probe | MCP protocol | P3 | mcp-protocol, c64u-rest | High | S | OPEN |
| HARD01-032 | SID frequency formula uses 2^16 not 2^24; notes ~256x too low | Program execution | P2 | sid-audio, tool-contract | High | S | OPEN |
| HARD01-033 | music_generate never re-gates; ADSR attacks only once | Program execution | P3 | sid-audio, tool-contract | High | S | OPEN |
| HARD01-034 | Printer tools gated to c64u only, excluded on u2 despite advertised feature | Backend/capability | P3 | capability, u2-variant | High | S | OPEN |
| HARD01-035 | VICE configSet coerces digit-strings to ints, misapplying string resources | VICE | P3 | config, vice-monitor | Medium | S | OPEN |

## Detailed findings

### HARD01-001 - Documented `--http` server mode is parsed but never wired; `npm start -- --http` silently runs stdio

- **Area:** Packaging, generated contract, documentation, and broad sweep
- **Severity:** P3
- **Dimensions:** documentation-contract, mcp-protocol, packaging
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/mcp-server.ts (`parseCliOptions` line 60, `main` line 80), doc/developer.md:114

**Failure scenario:**
A user follows doc/developer.md ("enable with `npm start -- --http [port]` for manual curl experiments"). The server prints "running on stdio", never opens an HTTP listener, and curl requests fail. Any port argument is silently ignored.

**Current-code evidence:**
`parseCliOptions`/`parsePort` (src/mcp-server.ts:60-78) are defined but never called; `main()` unconditionally constructs `StdioServerTransport` (src/mcp-server.ts:493). `createServer` (node:http) and `StreamableHTTPServerTransport` are imported (lines 3, 8) and never used. `createPromptRegistryGetter` (line 48) is likewise created at line 136 and never used.

**Why production-reachable:**
doc/developer.md documents the flag; the dist entrypoint is the shipped `bin`.

**Why this degrades C64 control, development, or trust:**
Documented troubleshooting path is a no-op; a user debugging MCP issues loses time and may conclude the server is broken.

**Backend and recovery angle:** Backend-independent.

**Relation to existing HARD01 findings:** Independent.

**Minimal fix sketch:** Either wire `parseCliOptions` + `StreamableHTTPServerTransport` into `main`, or remove the dead code and the doc claim.

**Regression test strategy:** Unit test asserting `parseCliOptions(["--http","8080"])` result is honoured by the transport selection function once factored out.

**Fix risk:** Low; dead-code removal or isolated transport branch.

### HARD01-002 - C64U power_cycle presses RETURN after four blind cursor moves; menu verification cannot detect the highlighted item

- **Area:** Ultimate REST, machine control, configuration, and input
- **Severity:** P1
- **Dimensions:** device-safety, physical-state, input, c64u-rest
- **Confidence:** High
- **Effort:** M
- **Status:** OPEN
- **Files/functions reviewed:** src/c64Client.ts `powerCycle` (968-1025), `readVerifiedMenuScreen` (1031-1048), `menuMatrixIncludes` (89-97)

**Failure scenario:**
`c64_system` op `power_cycle` on a C64U/U64 whose Tool Menu has a different item count/order than the hard-coded assumption (firmware revision change, different item set). The code taps `cursor_up_down` exactly 4 times and then taps `return`, activating whatever item is highlighted — potentially a different Tool Menu action — while reporting `success: true, selectedItem: "Power Cycle"`.

**Current-code evidence:**
src/c64Client.ts:1001-1010: a fixed `for (let index = 0; index < 4; ...)` loop; each `readVerifiedMenuScreen` call only checks (a) matrix non-empty, (b) matrix changed vs previous, and (c) the string "POWER CYCLE" appears **anywhere** in the 40×25 character matrix (`menuMatrixIncludes` inspects only characters, never the colour matrix that encodes the highlight). Nothing verifies the *selected* row before the final `return` tap at line 1010.

**Why production-reachable:**
`c64_system power_cycle` is a documented tool op; AGENTS.md explicitly promises it "reads `machine:menu_screen` after every navigation step and stops rather than blindly selecting an unverified item". The implementation verifies screen presence, not selection, so the promise is not kept.

**Why this degrades C64 control, development, or trust:**
Uncontrolled physical state change: activating an arbitrary Tool Menu entry can flash firmware menus, change settings, or leave the device in an unexpected mode; the tool still reports verified success.

**Backend and recovery angle:**
C64U/U64 only (u2 uses REST reboot, VICE restarts the process). No recovery logic exists after the final RETURN.

**Relation to existing HARD01 findings:** Related to HARD01-003 (same flow) but distinct root cause: this is missing selection verification; 003 is missing failure cleanup.

**Minimal fix sketch:** Parse the colour matrix (bytes 1000-1999) to locate the highlighted row and assert it contains "POWER CYCLE" before the final RETURN; abort otherwise.

**Regression test strategy:** Mock-Ultimate test feeding menu_screen matrices where "POWER CYCLE" is visible but a different row is highlighted; assert the flow aborts without the final RETURN input event.

**Hardware validation:** C64U/U64 after fix, using a Tool Menu screen dump.

**Fix risk:** Colour-matrix highlight encoding must be confirmed against firmware; keep abort-on-uncertain semantics.

### HARD01-003 - power_cycle failure paths leave the Ultimate menu open with no cleanup

- **Area:** Ultimate REST, machine control, configuration, and input
- **Severity:** P2
- **Dimensions:** device-safety, physical-state, timeout-cancellation
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/c64Client.ts `powerCycle` (968-1025)

**Failure scenario:**
During Tool Menu navigation, any step fails (screen didn't change, expected text missing, input REST error, network timeout). `powerCycle` throws/returns `success:false` — but the Ultimate menu (and possibly the Tool Menu submenu) remains open on the physical machine. The running C64 program stays frozen behind the menu until a human intervenes; subsequent tools that assume a running machine (screen reads, key input) act on the menu instead.

**Current-code evidence:**
src/c64Client.ts:992-1011: after `facade.menuButton()` opens the menu, every later failure propagates to the catch at 1012-1024, which only classifies the error. There is no compensating `menuButton()`/escape tap or release-all in any failure path.

**Why production-reachable:**
Any transient REST failure or an unexpected menu layout mid-flow triggers it.

**Why this degrades C64 control, development, or trust:**
Machine is left in a menu state the caller did not request; later `read_screen`/`wait_for_text` calls poll the frozen C64 screen (menu overlays are separate) or key input lands in the menu, producing confusing follow-on failures and potentially unintended menu actions.

**Backend and recovery angle:** C64U/U64 only. Recovery requires a human or an explicit follow-up `menuButton` call the agent has no instruction to make.

**Relation to existing HARD01 findings:** Complements HARD01-002; distinct defect (missing failure cleanup vs missing selection verification).

**Minimal fix sketch:** Wrap navigation in try/finally; on failure attempt a best-effort menu close (menu button tap or repeated `runstop`/escape input) and record whether cleanup succeeded in details.

**Regression test strategy:** Mock-Ultimate test forcing a verification failure at each step, asserting a closing menu_button call is issued.

**Hardware validation:** C64U/U64.

**Fix risk:** Cleanup taps must be safe if the menu already closed; keep them idempotent.

### HARD01-004 - Transient probe errors permanently cache machine:input availability as "unknown" until server restart

- **Area:** Backend selection and platform/capability contract
- **Severity:** P2
- **Dimensions:** capability, c64u-rest, backend-switching
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/c64Client.ts `getNativeEndpointCapabilities` (259-276), `machineInputCapabilityProbes` map (197)

**Failure scenario:**
The first read of `c64://platform/status` (or any powerCycle attempt) happens while the C64U is booting or briefly unreachable. The GET `machine:input` probe fails with a timeout (not 404), so the probe promise resolves `"unknown"` — and is cached in `machineInputCapabilityProbes` forever. Every later status read and every `power_cycle` (which requires `"available"`, line 981) reports native input unavailable for the whole server lifetime, even though the device is now healthy.

**Current-code evidence:**
src/c64Client.ts:268-275: the probe promise is stored per DeviceType and never invalidated; `.catch((error) => isMissingEndpoint(error) ? "unavailable" : "unknown")` bakes a transient network error into the cached value. `powerCycle` (980-990) hard-fails on anything but `"available"`.

**Why production-reachable:**
Platform status is the documented pre-flight read for physical input (AGENTS.md), and device boot/network blips are routine.

**Why this degrades C64 control, development, or trust:**
A supported high-value workflow (native input, tool-menu power cycle) is falsely disabled until the MCP server is restarted; agents are explicitly instructed to trust this resource.

**Backend and recovery angle:** C64U only. No recovery path; restart required.

**Relation to existing HARD01 findings:** Independent (capability caching, not menu logic).

**Minimal fix sketch:** Do not cache `"unknown"` results — delete the map entry when the probe resolves to `"unknown"` so the next call retries.

**Regression test strategy:** Unit test with a facade whose `getInputState` rejects with a network error once then succeeds; assert second `getNativeEndpointCapabilities` call reports `"available"`.

**Fix risk:** Slightly more probe traffic on persistently failing devices; bounded by one GET per call.

### HARD01-005 - Two divergent config loaders resolve different hosts for the same configuration files

- **Area:** Backend selection and platform/capability contract
- **Severity:** P2
- **Dimensions:** config, backend-switching, documentation-contract
- **Confidence:** High
- **Effort:** M
- **Status:** OPEN
- **Files/functions reviewed:** src/config.ts `loadConfig` (25-124), src/device.ts `readConfigFile` (179-214), src/mcp-server.ts (86-98), `createFacade` (1098-1162)

**Failure scenario:**
User sets `C64BRIDGE_CONFIG` to a file containing only `{ "vice": {...} }` while `~/.c64bridge.json` contains `{ "c64u": { "host": "10.0.0.5" } }`. `loadConfig` (src/config.ts) stops at the **first parseable file** (line 42-48 `break`), finds no hardware host, and yields the default baseUrl `http://c64u`. `readConfigFile` (src/device.ts) instead **merges sections across all candidate files** (lines 192-212), finds the home-file `c64u` section, and builds a c64u facade for `10.0.0.5`. Result: the startup connectivity probe, `client.baseUrl`-derived stream-capture host resolution (`new URL(this.baseUrl).hostname`, src/c64Client.ts:1299/1569), and the c64u facade all disagree about which device is the target. Additionally, malformed JSON crashes the server in `loadConfig` (rethrow at line 46) but is silently skipped by `readConfigFile` (bare `catch {}` line 211) — two different failure contracts for the same file.

**Current-code evidence:** As above; the two functions also differ in HOME resolution (`process.env.HOME` only vs `HOME || os.homedir()`) and in `import.meta.url` handling (`fileURLToPath` vs raw `.pathname`, the latter broken for paths with spaces or on Windows).

**Why production-reachable:**
`C64BRIDGE_CONFIG` and layered config files are the documented configuration mechanism (AGENTS.md, README).

**Why this degrades C64 control, development, or trust:**
Stream capture targets (`resolveLocalCaptureAddress(host)` from `this.baseUrl`) and the actual REST facade can point at different machines; the startup "Connectivity check succeeded" log can validate a host that no tool will ever use — false confidence and wrong-target diagnostics.

**Backend and recovery angle:** Affects c64u/u2 selection and the c64u video/audio capture address derivation; restart with aligned files required.

**Relation to existing HARD01 findings:** Related to HARD01-006 (config path resolution) but distinct: this is loader-vs-loader divergence, 006 is documented-path vs actual-path.

**Minimal fix sketch:** Make `C64Client`/`device.ts` consume the single parsed config from `loadConfig` (extended to carry sections), deleting `readConfigFile`.

**Regression test strategy:** Unit test with two config files exercising both loaders and asserting identical host/port/password resolution.

**Fix risk:** Precedence unification may change behaviour for users relying on the merge; document the chosen order.

### HARD01-006 - Documented `./.c64bridge.json` lookup actually resolves relative to the installed package, not the working directory

- **Area:** Backend selection and platform/capability contract
- **Severity:** P2
- **Dimensions:** config, documentation-contract, packaging
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/config.ts:31, src/device.ts:185, AGENTS.md "Configure target", README

**Failure scenario:**
A user installs c64bridge as a dependency (the documented VS Code MCP setup runs `node ./node_modules/c64bridge/dist/index.js` from the project root) and creates `./.c64bridge.json` in their project as AGENTS.md instructs ("`C64BRIDGE_CONFIG` → `./.c64bridge.json` → `~/.c64bridge.json` → defaults"). Both loaders resolve the "repo" candidate as `<module dir>/../.c64bridge.json` = `node_modules/c64bridge/.c64bridge.json`, so the project-local file is silently ignored. The server falls back to `~/.c64bridge.json` or default host `c64u` — potentially a *different, reachable* Ultimate device on the network — and tools operate on the wrong machine.

**Current-code evidence:**
src/config.ts:31 `join(dirname(fileURLToPath(import.meta.url)), "..", ".c64bridge.json")`; src/device.ts:185 same pattern. Neither consults `process.cwd()`.

**Why production-reachable:** The npm-installed layout is the primary documented deployment (README/AGENTS VS Code snippet).

**Why this degrades C64 control, development, or trust:**
Silently targeting the default hostname `c64u` when a project config exists is a wrong-target risk for every state-changing tool (reset, config write, drive mount).

**Backend and recovery angle:** All backends (vice section also ignored). Workaround is `C64BRIDGE_CONFIG`, but nothing tells the user their file was skipped.

**Relation to existing HARD01 findings:** Distinct from HARD01-005 (path base vs loader divergence).

**Minimal fix sketch:** Add `process.cwd()/.c64bridge.json` as a candidate (before or instead of the module-relative path) and log which file was loaded.

**Regression test strategy:** Unit test running loadConfig with cwd fixture + module-relative absence, asserting cwd file wins; log assertion for chosen path.

**Fix risk:** Changes resolution for dev checkouts where cwd ≠ repo root; keep module-relative candidate as fallback.

### HARD01-007 - Printer text with double quotes generates invalid CBM BASIC (`""` doubling) that fails at runtime while the tool reports success

- **Area:** Drives, storage, printers, streams, and state verification
- **Severity:** P2
- **Dimensions:** basic, program-runner, tool-contract
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/c64Client.ts `buildPrinterBasicProgram` (2421-2469), `escapeBasicQuotes` (2482-2485), `printTextOnPrinterAndRun` (331-339)

**Failure scenario:**
`c64_printer` print-text with content containing `"` (e.g. `He said "hi"`). `escapeBasicQuotes` doubles the quote, producing `PRINT#1,"HE SAID ""HI"""`. Commodore BASIC V2 has **no** doubled-quote escape — the expression evaluator sees adjacent string constants and raises `?SYNTAX ERROR` at runtime, aborting the program after `OPEN1,4` (printer channel left open). The MCP tool reports success because `uploadAndRunBasic` → `runPrg` only confirms upload/run start.

**Current-code evidence:**
src/c64Client.ts:2482-2485 with the comment "In Commodore BASIC, embed a double quote by doubling it" — true for some Microsoft BASIC dialects, false for CBM BASIC V2 (correct approach: `CHR$(34)`). Nothing downstream validates program completion.

**Why production-reachable:** Any printer text containing a quote character; documented printer workflow (`.github/skills/printer-job`).

**Why this degrades C64 control, development, or trust:**
False success on a physical output job; machine left showing `?SYNTAX ERROR` with file 1 open (subsequent `OPEN1` fails with `FILE OPEN` until CLOSE/reset).

**Backend and recovery angle:** All backends that run BASIC. Recovery needs manual CLOSE1/reset.

**Relation to existing HARD01 findings:** Independent.

**Minimal fix sketch:** Replace embedded quotes by splicing `CHR$(34)` into the PRINT# expression (split chunk into quoted segments joined with `;CHR$(34);`).

**Regression test strategy:** Tokenizer-level unit test that the generated program for quoted text contains no `""` sequence inside string literals; optional VICE screen assertion for `?SYNTAX ERROR` absence.

**Fix risk:** Longer generated lines; keep chunking aware of the expansion.

### HARD01-008 - PETSCII screen program's "wait for key" line never waits, so READY./cursor immediately disturb the rendered screen

- **Area:** Program execution, BASIC, assembler, memory, graphics, and SID
- **Severity:** P3
- **Dimensions:** basic, graphics, program-runner
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/c64Client.ts `buildPetsciiScreenBasic` (2407-2419), `renderPetsciiScreenAndRun` (408-415)

**Failure scenario:**
`renderPetsciiScreenAndRun` generates line `30 GETA$:IFA$<>""THENEND:REM wait for key then end`. `GET` is non-blocking and there is no loop back to 30: whether or not a key is pending, execution falls off the end of the program immediately. BASIC prints `READY.` and the blinking cursor onto the just-rendered artwork, and any subsequent `read_screen` verification sees `READY.` text that the caller did not draw.

**Current-code evidence:** src/c64Client.ts:2416 — single GET with no `GOTO 30`; the comment states the (unimplemented) intent.

**Why production-reachable:** PETSCII/graphics demo workflow (`.github/skills/graphics-demo`).

**Why this degrades C64 control, development, or trust:** Rendered output is visually corrupted right after display; screen-content verification can mismatch, producing false negatives in demo validation.

**Backend and recovery angle:** All backends.

**Relation to existing HARD01 findings:** Independent.

**Minimal fix sketch:** `30 GETA$:IFA$=""THEN30` (then `40 END`), or poke the cursor off and loop forever.

**Regression test strategy:** Unit test on the generated source asserting the wait loop branches back; VICE screen capture shows no `READY.` after render.

**Fix risk:** Program no longer terminates by itself; document that a key press ends it.

### HARD01-009 - injectKeyboardQueue silently drops queued keystrokes when the KERNAL fails to drain, then reports plain success

- **Area:** Ultimate REST, machine control, configuration, and input
- **Severity:** P2
- **Dimensions:** input, timeout-cancellation, memory-io
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/c64Client.ts `injectKeyboardQueue` (1900-1941)

**Failure scenario:**
`c64_input` `key`/`write_text` with more than 10 characters while the machine is paused, busy in a tight ML loop, or showing the Ultimate menu. The drain poll (lines 1932-1939) times out after 2 s with NDX ≠ 0; the loop then **continues to the next chunk anyway**, overwriting `$0277-$0280` with new bytes and forcing NDX to the new chunk length — destroying the unconsumed characters. The method returns `void` with no timeout indication, so every caller reports full text delivery while an arbitrary prefix/suffix of the text was lost or reordered.

**Current-code evidence:**
src/c64Client.ts:1929-1940. The comment says "higher layers can decide whether that is a failure" but no signal (return value, exception, flag) is produced for higher layers to decide with.

**Why production-reachable:** `key`/`write_text` are the documented default input path whenever machine:input is unavailable (AGENTS.md); long strings are routine (`write_text` of a BASIC line is >10 chars).

**Why this degrades C64 control, development, or trust:**
Partial keystroke delivery with reported success corrupts typed programs/commands — e.g. a `RUN` or a POKE line typed half-way — and the agent trusts it happened.

**Backend and recovery angle:** C64U/U64/VICE (shared memory path). No recovery; caller has no failure signal.

**Relation to existing HARD01 findings:** Independent.

**Minimal fix sketch:** Return a result ({delivered, timedOut}) or throw on drain timeout; never overwrite a non-empty queue.

**Regression test strategy:** Unit test with a facade whose NDX read never returns 0; assert an error/flag instead of silent return.

**Fix risk:** Callers must handle the new failure signal; audit call sites.

### HARD01-010 - Ultimate files endpoints double-encode device paths, encoding the path separators themselves

- **Area:** Ultimate REST, machine control, configuration, and input
- **Severity:** P2
- **Dimensions:** c64u-rest, filesystem, tool-contract
- **Confidence:** Medium
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/device.ts `filesInfo`/`filesCreateD64/71/81/Dnp` (380-384), generated/c64/index.ts `filesInfoDetail`/`filesCreateD64Update` (~1307-1340), doc/c64u/c64-openapi.yaml FilePath parameter (line 86)

**Failure scenario:**
`c64_disk create_d64` with `path: "/Usb0/demos/new.d64"`. `C64uBackend.filesCreateD64` calls `encodeURIComponent(p)` producing `%2FUsb0%2Fdemos%2Fnew.d64`; the generated client interpolates it verbatim, so the request line is `PUT /v1/files/%2FUsb0%2Fdemos%2Fnew.d64:create_d64`. The OpenAPI contract models the path as a filesystem path *below* `/v1/files/` with only reserved characters encoded ("Device filesystem path below `/v1/files/`; URL-encode reserved characters"), i.e. slashes remain literal separators (`/v1/files/Usb0/demos/new.d64:create_d64`). Firmware that routes on raw path segments will fail to resolve the target (or create a file with a literal `%2F` name), while the facade still returns `success:true` if the firmware answers 200 with an `errors` body (see HARD01-011).

**Current-code evidence:** src/device.ts:380-384; generated client performs no additional decoding/encoding (`path: \`/v1/files/${path}${info}\``).

**Why production-reachable:** All `c64_disk`/`c64_drive` create/info flows with nested device paths — the normal case, since Ultimate paths start with `/Usb0/...`.

**Why this degrades C64 control, development, or trust:** Disk-image creation/inspection targeting the device filesystem silently misses or fails; the stated inference is that firmware treats `%2F` as an encoded literal rather than a separator, consistent with the spec's modelling of `{path}` as a slash-containing tail.

**Backend and recovery angle:** c64u and u2 facades share the code.

**Relation to existing HARD01 findings:** Interacts with HARD01-011 (error masking) but distinct root cause.

**Minimal fix sketch:** Encode per-segment: `p.split("/").map(encodeURIComponent).join("/")`.

**Regression test strategy:** Mock-Ultimate HTTP capture asserting the request path preserves `/` separators for a nested path with spaces.

**Hardware validation:** One `files:info` call on a real C64U for a nested path.

**Fix risk:** None beyond matching firmware expectations; verify against firmware once.

### HARD01-011 - C64u/U2 facade reports success on any 2xx response, ignoring the firmware's `errors` array in ActionResponse bodies

- **Area:** Ultimate REST, machine control, configuration, and input
- **Severity:** P1
- **Dimensions:** c64u-rest, tool-contract, config, drive
- **Confidence:** Medium
- **Effort:** M
- **Status:** OPEN
- **Files/functions reviewed:** src/device.ts `C64uBackend` (274-385, all `{ success: true, details: res.data }` returns), doc/c64u/c64-openapi.yaml (preamble lines 10-12, `ErrorList` 138-145, `ActionResponse` 252-256, `JsonOk` 501-506)

**Failure scenario:**
Any C64u/U2 REST action where firmware answers HTTP 200 but reports failures in the JSON body. The firmware contract (spec preamble) states "JSON responses include an `errors` array"; `ActionResponse` — the 200 body for every runner/machine/drive/config action — is `allOf: ErrorList` with required `errors`. Example: `configBatchUpdate` applying several items where some are rejected — firmware returns 200 with per-item error strings in `errors`; `C64uBackend.configBatchUpdate` (src/device.ts:376) returns `{ success: true }` and the MCP tool reports the whole batch applied. Same pattern on `runPrg`, `driveMount`, `sidplayFile`, etc.: every method returns `success: true` purely because axios didn't throw.

**Current-code evidence:**
All ~40 `C64uBackend` methods return `{ success: true, details: res.data }` with no inspection of `res.data.errors`. Stated inference (Medium confidence): the firmware does populate `errors` on 200 responses for partially-failed or soft-failed actions, which is exactly why the spec makes `errors` required on the success schema.

**Why production-reachable:** Every Ultimate REST tool op flows through these methods.

**Why this degrades C64 control, development, or trust:** Systemic false success on run/mount/config actions — the highest-value hardware operations — so agents proceed on unapplied state (e.g. believing a config batch or disk mount happened).

**Backend and recovery angle:** c64u and u2. No recovery; verification tools (read-back) are the only mitigation and are not automatic.

**Relation to existing HARD01 findings:** Distinct from HARD01-010 (path encoding); together they can turn a failed file create into a clean success.

**Minimal fix sketch:** Central helper `ensureNoErrors(res.data)` that flips `success:false` (with the error strings in details) when `errors` is a non-empty array; apply in every C64uBackend method.

**Regression test strategy:** Mock-Ultimate returning 200 + `{"errors":["Cannot open file"]}` for mount/run/config; assert tool result isError.

**Hardware validation:** Optional: one deliberately failing `sidplayFile` with a bad path on real firmware to capture the actual status/body.

**Fix risk:** If some firmware endpooints omit `errors`, treat absence as success (only non-empty array fails).

### HARD01-012 - ViceClient has no response timeout; one lost Binary Monitor frame permanently wedges every later VICE operation

- **Area:** VICE Binary Monitor and process lifecycle
- **Severity:** P1
- **Dimensions:** vice-monitor, timeout-cancellation, concurrency, vice-lifecycle
- **Confidence:** High
- **Effort:** M
- **Status:** OPEN
- **Files/functions reviewed:** src/vice/viceClient.ts `send` (208-234), `onData` (150-206); src/device.ts `ViceBackend.withClient` (566-599), `monitorQueue` (403)

**Failure scenario:**
Any Binary Monitor command whose response is never delivered while the socket stays open: a resync in `onData` (line 156-158 skips to the next 0x02 byte, which can be mid-body, dropping a whole frame), a response consumed by the mismatch path without matching, or VICE simply not answering (busy UI dialog, monitor wedged). `send()` registers the pending promise with **no timeout**; `withClient`'s `fn` never resolves; the `finally` that releases `monitorQueue` never runs. Every subsequent VICE tool call awaits `previous` (line 573) forever. All VICE control — including `c64_select_backend`-independent flows like `read_screen` on the vice backend — hangs until the MCP server is restarted. The MCP request itself also never completes (hung request).

**Current-code evidence:**
src/vice/viceClient.ts:223-233 — promise stored in `this.pending`, resolved only by a matching frame, socket error, or close. src/device.ts:566-573 — strict FIFO promise chain with release only in `finally` after `fn` returns.

**Why production-reachable:**
The BM stream parser's resync heuristic (`this.buffer.indexOf(0x02, 1)`) can mis-frame on any body byte equal to 0x02 after a partial/corrupt read; display-get responses carry ~200KB of pixel data where 0x02 bytes are routine, so a single desync cascades. Independently, VICE can stall while holding the socket open.

**Why this degrades C64 control, development, or trust:**
One flaky exchange converts into a total, silent, permanent loss of the VICE backend and a hung MCP request — the worst recovery class short of protocol corruption.

**Backend and recovery angle:** VICE only; restart of the MCP server is the only recovery. Backend switching cannot help because the switch tool works, but every VICE op still queues behind the wedged promise.

**Relation to existing HARD01 findings:** Independent.

**Minimal fix sketch:** Per-request timeout (e.g. 10 s, longer for display) that rejects and deletes the pending entry; on timeout, destroy the socket so `withClient` cleanup runs and the queue releases.

**Regression test strategy:** BM stub server that accepts a command and never responds; assert the client rejects within the timeout and a subsequent operation succeeds.

**Fix risk:** Timeout must exceed slow legitimate operations (autostart, display on slow hosts).

### HARD01-013 - Managed VICE and Xvfb processes are orphaned when the MCP server exits or is terminated

- **Area:** VICE Binary Monitor and process lifecycle
- **Severity:** P2
- **Dimensions:** vice-lifecycle, filesystem, timeout-cancellation
- **Confidence:** High
- **Effort:** M
- **Status:** OPEN
- **Files/functions reviewed:** src/device.ts `ensureCleanupRegistration` (552-564); src/vice/process.ts `stop` (389-405), `terminateProcess` (209-214)

**Failure scenario:**
(a) Normal exit: the only cleanup hook is `process.once("exit", ...)` which calls the async `handle.stop()`. Inside an `exit` handler the event loop never turns again, so only the *synchronous prefix* of `stop()` runs: the first `child.kill("SIGTERM")`. The `await waitForExit(...)` never resolves, so the SIGKILL escalation and — critically — **all Xvfb termination lines never execute**. Every headless/managed session leaks one Xvfb process (and VICE too if it ignores SIGTERM).
(b) Signal termination: no SIGTERM/SIGINT/SIGHUP handlers exist anywhere; when the MCP client (VS Code, Claude) kills the server — the normal lifecycle for stdio MCP servers — Node's default signal handling terminates the process without emitting `exit`, so **no cleanup at all** runs: both VICE and Xvfb are orphaned, still bound to the BM port and X display.

**Current-code evidence:** As cited; `rg -n "process.on(\"SIG" src` returns nothing.

**Why production-reachable:** Managed VICE is the default for local hosts (device.ts:429), Xvfb is the default when no display exists (process.ts:88-98); MCP servers are routinely killed by their client.

**Why this degrades C64 control, development, or trust:**
Orphaned VICE keeps the monitor port occupied; the *next* server session's `tryPingExisting` then adopts a stale emulator with unknown state (loaded programs, checkpoints), and repeated sessions accumulate Xvfb processes and X lock files (`/tmp/.X99-lock`), eventually exhausting the display-number scan.

**Backend and recovery angle:** VICE managed mode. Recovery: manual pkill.

**Relation to existing HARD01 findings:** Independent of HARD01-012 (protocol vs lifecycle).

**Minimal fix sketch:** Install SIGTERM/SIGINT handlers that synchronously `kill()` VICE and Xvfb (child.kill is sync) then `process.exit`; in the `exit` hook, call the sync kills directly instead of the async stop().

**Regression test strategy:** Spawn-mock test asserting registered signal handlers issue kills for both PIDs; integration check that no Xvfb survives server SIGTERM.

**Fix risk:** Double-kill on already-exited children (guarded by exitCode checks).

### HARD01-014 - c64_input joystick on VICE writes CIA data-port registers, which cannot simulate joystick input; success is reported for a no-op

- **Area:** VICE Binary Monitor and process lifecycle
- **Severity:** P1
- **Dimensions:** input, vice-monitor, tool-contract, memory-io
- **Confidence:** High
- **Effort:** M
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/input.ts joystick handler (351-407), JOYSTICK_PORT_ADDRESS (122-125); src/vice/viceClient.ts (no Joyport implementation); doc/vice/vice-binary-monitor-spec.md §0xA2 Joyport Set

**Failure scenario:**
`c64_input` `{op:"joystick", port:2, controls:["right"], action:"tap"}` on the VICE backend. The handler writes `$DC00` (port 2) / `$DC01` (port 1) via BM `memSet`. On a C64 (and in VICE's CIA emulation), `$DC00/$DC01` reads return the *input line state* for bits configured as inputs — writing the port register only sets the output latch (DDR for port B is $00 after reset, so writes are fully invisible to reads; for port A, DDR is $FF and the write actively corrupts the keyboard-scan column selection until the next KERNAL IRQ rewrite). A game polling the joystick sees nothing; the tool reports "Joystick port 2 tapped: right" with `success: true`.

**Current-code evidence:**
src/tools/input.ts:373-401 uses `ctx.client.viceMemSet(addr, ...)`. The in-repo BM spec documents the correct mechanism — command `0xA2 Joyport Set` ("Delegates to `mon_joyport_set_output`") — which `src/vice/viceClient.ts` does not implement at all.

**Why production-reachable:** `joystick` op is gated to `["c64u","vice"]` (input.ts:483) and documented ("VICE writes CIA1 registers", workflowHints line 465), so agents will use it for game control on VICE.

**Why this degrades C64 control, development, or trust:**
Every VICE joystick interaction is a false success; agents testing games conclude the game ignores input or burn cycles retrying. The port-2 write also transiently disturbs keyboard scanning.

**Backend and recovery angle:** VICE only; c64u path uses machine:input correctly.

**Relation to existing HARD01 findings:** Independent.

**Minimal fix sketch:** Implement BM `0xA2 Joyport Set` in ViceClient and use it for press/release/tap (value bitmask per VICE joyport semantics).

**Regression test strategy:** BM stub asserting an 0xA2 command with the expected port/value; optional HIL-style VICE test reading `$DC00` after joyport set.

**Hardware validation:** Managed VICE with a joystick-polling test program.

**Fix risk:** Joyport value encoding must match VICE's expectations (active-low bitmask).

### HARD01-015 - checkpointCreate silently adds the execute flag to load/store-only watchpoints

- **Area:** VICE Binary Monitor and process lifecycle
- **Severity:** P3
- **Dimensions:** vice-monitor, tool-contract, 6510
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/vice/viceClient.ts `checkpointCreate` (287-309); src/tools/debug.ts checkpoint_set handler (339)

**Failure scenario:**
`c64_debug` checkpoint create with `operations: { store: true }` (a store watchpoint on a data address). Line 293: `mask = (load?1:0)|(store?2:0)|(ops.execute === false ? 0 : 0x04)` — because `execute` is `undefined`, the exec bit is set too. If the watched address is ever executed (self-modifying code, data mistaken for code after a crash, or a watch on a code address intended as store-only), VICE stops on execution the user never asked to trap, leaving the machine halted in the monitor and confusing the debugging session.

**Current-code evidence:** As cited; the default only applies when `operations` is absent, but the expression applies it whenever `execute` isn't explicitly `false`.

**Why production-reachable:** `checkpoint_set` accepts partial operations objects from the MCP schema.

**Why this degrades C64 control, development, or trust:** Spurious traps freeze the emulated machine mid-workflow and misattribute behaviour during debugging.

**Backend and recovery angle:** VICE only; recovered by deleting the checkpoint.

**Relation to existing HARD01 findings:** Independent.

**Minimal fix sketch:** `const mask = (ops.load?1:0)|(ops.store?2:0)|(ops.execute?4:0) || 4` — exec only when requested, defaulting to exec solely when no operation flag at all is given.

**Regression test strategy:** Unit test asserting the wire mask for `{store:true}` is exactly 0x02.

**Fix risk:** Callers relying on the accidental exec default; audit debug.ts.

### HARD01-016 - Platform gating and multi-step client flows race with c64_select_backend, allowing operations to land on the wrong target

- **Area:** Backend selection and platform/capability contract
- **Severity:** P2
- **Dimensions:** backend-switching, concurrency, capability, device-safety
- **Confidence:** High
- **Effort:** M
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/types.ts `invoke` (377-407); src/c64Client.ts `switchBackend` (304-316); src/tools/registry/platform.ts select handler (79-113); src/tools/memory.ts `executeWriteMemory` (268-445)

**Failure scenario:**
MCP clients issue tool calls concurrently (nothing serializes CallTool handlers). Request A (`c64_memory` write with verify, active backend vice) passes the platform gate against the platform snapshot, then performs `pause → pre-read → write → post-read` as **separate `ctx.client` calls, each awaiting `this.facadePromise` independently**. Request B (`c64_select_backend {backend:"c64u"}`) runs between A's steps: `switchBackend` swaps `facadePromise` immediately. A's remaining steps now execute against **real C64U hardware** — a write intended for the emulator lands on the physical machine, and the post-read verifies the wrong device (false verification either way). The same window exists inside the select handler itself: between `switchBackend` (line 97) and `setPlatform` (line 98), concurrent requests are gated against the old platform while routed to the new backend.

**Current-code evidence:** As cited. No lock, generation counter, or in-flight-drain exists around `switchBackend`; `C64Client` methods re-resolve `facadePromise` per call (e.g. c64Client.ts:721, 779, 837).

**Why production-reachable:** Runtime backend switching is a headline feature (AGENTS.md "Runtime Backend Switching"); concurrent MCP calls are normal for agent clients that parallelise tool use.

**Why this degrades C64 control, development, or trust:** Wrong-target memory/system writes are a physical-state hazard; verification results become untrustworthy exactly when the user is exercising the documented multi-backend workflow.

**Backend and recovery angle:** All backends. No detection or recovery; the misdirected write is silent.

**Relation to existing HARD01 findings:** Distinct from HARD01-004/005 (static config/capability); this is dynamic switch-vs-in-flight consistency.

**Minimal fix sketch:** Capture the facade once per tool invocation (pass it through ctx), or add a read-write lock: switches wait for in-flight operations to drain and new operations pin the facade they started with.

**Regression test strategy:** Concurrency test with mock facades: start a slow write-verify, switch backend mid-flight, assert all steps hit the original facade.

**Fix risk:** Locking must not deadlock long-running ops (streams, background tasks); pinning per-invocation is safer.

### HARD01-017 - Memory write verification leaves the machine paused (with success reported) when resume fails

- **Area:** Program execution, BASIC, assembler, memory, graphics, and SID
- **Severity:** P2
- **Dimensions:** memory-io, physical-state, timeout-cancellation
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/memory.ts `executeWriteMemory` finally block (420-438)

**Failure scenario:**
`c64_memory` write with `verify: true` on C64U/U2. Pause and verification succeed; the trailing `ctx.client.resume()` fails (transient REST timeout, firmware hiccup). The failure is only logged via `ctx.logger.warn` to stderr; the tool returns the already-built success result ("Wrote N bytes ... (verified)"). The physical machine stays DMA-paused — frozen screen, unresponsive — and neither the agent nor the user is told. Subsequent screen reads/waits poll a frozen machine and time out mysteriously.

**Current-code evidence:** src/tools/memory.ts:420-438 — `finally` swallows both the unsuccessful `resumeResult` and thrown resume errors; the success return from line 410 stands.

**Why production-reachable:** verify is the documented safe-write mode; REST calls to hardware can transiently fail.

**Why this degrades C64 control, development, or trust:** A "verified success" that leaves hardware frozen is a false-success with physical consequence; the failure surfaces later in unrelated tools.

**Backend and recovery angle:** C64U/U2 (vice skips pause). Recovery requires an explicit `c64_system resume`.

**Relation to existing HARD01 findings:** Independent of HARD01-016 (no switch involved).

**Minimal fix sketch:** On resume failure, degrade the result: keep write status but set `success: false`/`machinePaused: true` with instructions to call resume, or retry resume once.

**Regression test strategy:** Mock client with failing resume; assert result flags the paused state.

**Fix risk:** Minor result-shape change for callers.

### HARD01-018 - upload_run_asm produces PRGs with no BASIC/SYS entry mechanism, so pure machine-code programs never execute yet report success

- **Area:** Program execution, BASIC, assembler, memory, graphics, and SID
- **Severity:** P1
- **Dimensions:** program-runner, 6510, tool-contract, basic
- **Confidence:** High
- **Effort:** M
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/translation/assembler.ts (`assemblyToPrgDetailed` 196-215, `buildPrg` 870-880, header comment line 16), src/tools/programRunners.ts `executeUploadRunAsm` (565-640, including the tool's own example at 835-838), src/device.ts `ViceBackend.injectPrg` (625-643), C64uBackend.runPrg (274-278)

**Failure scenario:**
`c64_program` `{op:"upload_run_asm", program:".org $0801\nstart: lda #$01\n sta $0400\n rts"}` — the tool's own published example. The assembler emits raw opcodes at $0801 with **no BASIC stub** (no stub-generation code exists anywhere; the file-header comment "can be run with SYS 2061" describes an intent that was never implemented, and nothing ever issues a SYS). Both execution paths then LOAD + type `RUN`: Ultimate `:run_prg` firmware behaviour, and `ViceBackend.injectPrg` which sets the BASIC pointers and feeds `RUN\r`. `RUN` interprets the ML bytes at $0801 as BASIC line links — the machine code never executes. For sources org'd elsewhere (`.org $C000`), `injectPrg` additionally sets TXTTAB/VARTAB to $C000, corrupting the BASIC workspace. The tool reports "Assembly program assembled, uploaded, and executed successfully", optionally with `verified: true` (see HARD01-019 for why polling cannot catch this).

**Current-code evidence:** As cited; `rg -n "2061|stub"` over src/tools/translation and programRunners matches only the comment.

**Why production-reachable:** upload_run_asm is a core documented workflow (`.github/skills/assembly-program`), and the failing input is the tool's own example.

**Why this degrades C64 control, development, or trust:** The flagship assembly workflow is a systematic false success; users iterate on 6510 code that never runs.

**Backend and recovery angle:** Both C64U/U2 and VICE. VICE additionally leaves corrupted BASIC pointers for non-$0801 loads until reset.

**Relation to existing HARD01 findings:** HARD01-019 explains why the "verified" layer masks this; distinct root causes (missing entry mechanism vs dead crash-detection).

**Minimal fix sketch:** When loadAddress ≤ $0801 emit the standard 12-byte `10 SYS<entry>` stub before code (adjusting org), or after load inject `SYS <entry>` instead of `RUN`; on VICE, only set BASIC pointers for genuine BASIC PRGs.

**Regression test strategy:** VICE integration test asserting `$0400` receives `$01` after running the example source; unit test asserting the emitted PRG starts with a valid BASIC line ending in a SYS to the first instruction.

**Hardware validation:** One run on C64U with a border-colour-writing ML program.

**Fix risk:** Stub insertion shifts code addresses; must keep symbols/entryAddress consistent.

### HARD01-019 - ASM crash detection can never fire: the activity signature includes the VIC raster register, so every powered-on machine is "alive"

- **Area:** Program execution, BASIC, assembler, memory, graphics, and SID
- **Severity:** P2
- **Dimensions:** program-runner, memory-io, tool-contract
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/pollValidator.ts `pollAsmOutcome` (214-336)

**Failure scenario:**
`pollAsmOutcome` computes a CRC over `$D000-$DFFF` plus low memory each poll and declares the program "alive" when consecutive CRCs differ. `$D012` (VIC raster counter) is inside that range and changes on essentially every read, as do CIA timer registers ($DC04-$DC07 count continuously) — so the signature differs on every pair of polls on any powered-on machine, running or crashed. `alive` is set on the second sample unconditionally; the `"crashed"` branch is dead code in practice. Consequently `verified: true` from `upload_run_asm` (programRunners.ts:592-604) asserts nothing, and a genuinely crashed/never-executed program (HARD01-018) is reported as verified success. The jiffy-clock secondary check has the same property (jiffy advances at the READY prompt).

**Current-code evidence:** src/tools/pollValidator.ts:275 (`readMemoryRaw(0xD000, 0x1000)`), 288-299 (signature comparison), no masking of free-running registers.

**Why production-reachable:** Runs on every `upload_run_asm` call.

**Why this degrades C64 control, development, or trust:** A promised verification layer that cannot fail converts every ASM failure into "verified" success.

**Backend and recovery angle:** Both backends (VICE displays the same free-running registers).

**Relation to existing HARD01 findings:** Masks HARD01-018; distinct defect.

**Minimal fix sketch:** Exclude free-running registers ($D011/$D012, CIA timers/TOD) from the signature, or verify a program-specific effect (entry-point PC via VICE, or explicit screen/memory expectations).

**Regression test strategy:** Unit test with a mock client returning identical memory except an incrementing $D012; assert status is "crashed".

**Fix risk:** Overly strict masking could false-crash IRQ-driven programs; document the heuristic.

### HARD01-020 - ASM outcome polling DMA-reads the CIA interrupt-control registers on hardware, clearing pending IRQs in the just-started program

- **Area:** Program execution, BASIC, assembler, memory, graphics, and SID
- **Severity:** P2
- **Dimensions:** memory-io, device-safety, c64u-rest, program-runner
- **Confidence:** Medium
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/pollValidator.ts:275; src/device.ts `C64uBackend.readMemory` (301-316); c64://io/cia/spec knowledge (CIA ICR semantics)

**Failure scenario:**
Every `upload_run_asm` triggers repeated reads of `$D000-$DFFF`, which includes `$DC0D` and `$DD0D` (CIA1/CIA2 interrupt control registers). On real hardware, reading the ICR **clears all pending interrupt flags** — this is fundamental CIA behaviour. The Ultimate's `:readmem` performs genuine DMA bus reads, so a program that has just installed a CIA-timer IRQ (music player, raster/timer mixing, tape/serial timing) can lose interrupts each poll cycle (default 200 ms interval for the 2 s window), causing missed IRQs, audio glitches, or a hung IRQ-wait loop right after upload — precisely while the tool is judging whether the program is alive. Stated inference (Medium): Ultimate DMA reads are electrically real reads and therefore trigger CIA read side effects; this matches the platform's own memory-debug guidance to avoid I/O reads without pause. VICE is unaffected because `memGet` is sent with `sidefx=0`.

**Current-code evidence:** As cited; no exclusion of the I/O page or pause around the polling reads.

**Why production-reachable:** Automatic on every hardware ASM upload.

**Why this degrades C64 control, development, or trust:** The validator itself can break the program it validates — a Heisenberg failure users cannot diagnose.

**Backend and recovery angle:** C64U/U64 (and U2 path) only.

**Relation to existing HARD01 findings:** Same function as HARD01-019, independent defect (side effect vs dead logic).

**Minimal fix sketch:** Read only side-effect-free regions (screen RAM, jiffy via $A0-$A2, selected VIC colour registers), never $DC00-$DD0F.

**Regression test strategy:** Mock-Ultimate asserting no read overlapping $DC0D/$DD0D during polling; HIL check with an IRQ-counting program.

**Hardware validation:** C64U with a CIA-timer IRQ program comparing IRQ counts with/without polling.

**Fix risk:** None significant.

### HARD01-021 - BASIC outcome polling reports failure whenever the program legitimately prints the word "ERROR"

- **Area:** Program execution, BASIC, assembler, memory, graphics, and SID
- **Severity:** P3
- **Dimensions:** basic, program-runner, tool-contract
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/pollValidator.ts `extractBasicError` (121-145), `pollBasicOutcome` (151-206); src/tools/programRunners.ts BASIC error handling

**Failure scenario:**
`upload_run_basic` with a program whose *output or source strings* contain "ERROR" (e.g. a validation utility printing `0 ERRORS FOUND`, or a game HUD). `extractBasicError` matches any screen containing "ERROR"; without the `?TYPE ERROR` pattern it returns `{message:"UNKNOWN ERROR"}`, so `pollBasicOutcome` reports `status:"error"` and the tool returns a failure for a program that ran perfectly. The inverse hazard also exists: real errors printed after the 2 s window (slow init loops) are missed and success is reported — but the false-failure direction is deterministic for the described programs.

**Current-code evidence:** src/tools/pollValidator.ts:125-144 (bare `includes("ERROR")` fallback path returning UNKNOWN ERROR).

**Why production-reachable:** Ordinary user programs printing status text.

**Why this degrades C64 control, development, or trust:** Deterministic false failure on a supported workflow teaches users to distrust tool errors.

**Backend and recovery angle:** All backends.

**Relation to existing HARD01 findings:** Same file as 019/020 but a distinct heuristic and direction.

**Minimal fix sketch:** Require the leading `?` (BASIC's error prefix at column start) and known KERNAL/BASIC error names before classifying as an error.

**Regression test strategy:** Unit test with screens containing "0 ERRORS FOUND" (ok) and "?SYNTAX  ERROR IN 20" (error).

**Fix risk:** Slightly weaker detection of exotic error strings.

### HARD01-022 - Persisted "running" background tasks are never rescheduled after restart, so list_tasks reports live tasks that do nothing

- **Area:** Background tasks, meta workflows, artifacts, and cancellation
- **Severity:** P2
- **Dimensions:** background-task, persistence, tool-contract
- **Confidence:** High
- **Effort:** M
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/meta/background.ts `ensureTasksLoaded` (128-147), `fromPersistedTask` (83-102), `scheduleNextRun` (228-258), `list_background_tasks` (382-412)

**Failure scenario:**
A background task (e.g. recurring `read_screen`) is started; state is persisted with `status:"running"`. The MCP server restarts (routine for stdio servers). On the next task tool call, `ensureTasksLoaded` reads `tasks.json` and rebuilds each task with `_timer:null` — but **never calls `scheduleNextRun`**. The task is now a zombie: `list_tasks` reports it `status:"running"` with a stale `nextRunAt`, yet no timer exists and it will never fire again. `stop_all_background_tasks` then marks it "stopped" as if it had been running.

**Current-code evidence:** src/tools/meta/background.ts:83-102 (`_timer:null`, no scheduling); 128-147 (`ensureTasksLoaded` only populates the map). No code path re-arms persisted running tasks.

**Why production-reachable:** Task persistence is the tool's entire purpose (`getTaskStateFilePath`, per-task folders); server restarts are normal.

**Why this degrades C64 control, development, or trust:** `list_tasks` is a false status source — the agent believes recurring diagnostics are running when they are dead; downstream decisions (e.g. "monitoring is active, safe to proceed") are wrong.

**Backend and recovery angle:** Backend-independent. Recovery: stop and restart each task manually.

**Relation to existing HARD01 findings:** Independent.

**Minimal fix sketch:** In `ensureTasksLoaded`, for each task loaded with `status:"running"`, either re-arm via `scheduleNextRun` (needs a ctx) or downgrade to `"stopped"`/`"interrupted"` so status is honest.

**Regression test strategy:** Unit test: persist a running task, reset module state, reload, assert either a timer is armed or status is not "running".

**Fix risk:** Re-arming needs a client/ctx not available at load time; the honest-downgrade path is safer.

### HARD01-023 - drive_mount_and_verify assumes the VICE drive shape, so power-on and verification silently fail on C64U/U2 hardware

- **Area:** Drives, storage, printers, streams, and state verification
- **Severity:** P2
- **Dimensions:** drive, c64u-rest, u2-variant, tool-contract
- **Confidence:** High
- **Effort:** M
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/meta/filesystem.ts `drive_mount_and_verify` (690-799); src/device.ts `C64uBackend.drivesList` (363) vs `ViceBackend.drivesList` (806-826); doc/c64u/c64-openapi.yaml `DriveListResponse`/`DriveInfo` (284-295, 257-277)

**Failure scenario:**
`drive_mount_and_verify` on C64U/U2. `C64uBackend.drivesList` returns the firmware body verbatim: `{ errors, drives: [ { "<driveId>": { enabled, image_file, image_path, type, ... } } ] }` — an **object with a `.drives` array of id-keyed maps**. The meta tool does `Array.isArray(drives)` on that object (false), so `targetDrive` is `null`, and with `powerOnIfNeeded` (default true) it throws "Drive not found in firmware drive list" — the mount never happens. Even bypassing power-on, the verify step reads `targetDrive.image`/`.power`, fields that exist only on the **VICE** facade's synthetic `{id, power, image, type}` shape (device.ts:814-819). The tool therefore works only on VICE and hard-fails on real hardware, which is its primary target.

**Current-code evidence:** As cited; `storageModule.drives_list` also returns the raw c64u object untouched (storage.ts:207-211), so the two facades expose different drive schemas with no normalisation layer.

**Why production-reachable:** `c64_disk`/drive management on hardware is a core documented workflow.

**Why this degrades C64 control, development, or trust:** A reliability-branded mount tool (retries + verification) is unusable on the very platform it targets, failing before it mounts.

**Backend and recovery angle:** C64U/U2 broken; VICE works. Users must fall back to the lower-level `drive_mount`.

**Relation to existing HARD01 findings:** Distinct from HARD01-011 (errors-array) — this is drive-list schema divergence.

**Minimal fix sketch:** Add a facade-level `drivesList` normaliser returning a common `{id, power, image, type}` shape for all backends; have meta/storage consume that.

**Regression test strategy:** Mock-Ultimate returning the real DriveListResponse shape; assert drive_mount_and_verify locates the drive and verifies image_path.

**Hardware validation:** C64U `drives_list` capture to confirm exact field names.

**Fix risk:** Field mapping (`image_path` vs `image`, `enabled` vs `power`) must match firmware.

### HARD01-024 - Debug-level HTTP logging writes the raw X-Password header to stderr and the diagnostics file

- **Area:** RAG, external acquisition, paths, diagnostics, and secrets
- **Severity:** P3
- **Dimensions:** secrets, diagnostics, security
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/loggingHttpClient.ts `handleResponse`/`handleError` (59-64, 90-95, meta.headers capture at ~28); src/device.ts `buildC64uHeaders` (1373-1375); src/c64Client.ts constructor headers (205)

**Failure scenario:**
The MCP server is run with `LOG_LEVEL=debug` (a documented troubleshooting step). Every Ultimate REST request logs `request <method> <path>` with `headers: meta.headers`, and `meta.headers` is a shallow copy of the axios request headers **including `X-Password: <networkPassword>`** in cleartext. These lines go to stderr and, via the diagnostics event stream, potentially to the on-disk diagnostics file — exposing the device network password to anyone who can read the logs.

**Current-code evidence:** src/loggingHttpClient.ts:28 (`headers: request.headers ? { ...request.headers } : undefined`) and 60-62/90-92 log those headers unredacted. No key-based redaction exists (`rg -n "redact|X-Password" src/logger.ts src/loggingHttpClient.ts` finds none).

**Why production-reachable:** Debug logging is the standard way to diagnose REST issues; network protection with a password is the documented secure configuration.

**Why this degrades C64 control, development, or trust:** Secret disclosure through diagnostics — the review's explicit "do not disclose X-Password" concern realised in the product's own logs.

**Backend and recovery angle:** C64U/U2 (password auth). VICE unaffected.

**Relation to existing HARD01 findings:** Independent.

**Minimal fix sketch:** Redact sensitive header keys (`x-password`, `authorization`) before logging, replacing values with `***`.

**Regression test strategy:** Unit test capturing debug output for a request with X-Password; assert the value is masked.

**Fix risk:** None; redaction is display-only.

### HARD01-025 - RAG initialization resolves all knowledge paths from process.cwd(), so the packaged server returns empty retrievals when started elsewhere

- **Area:** RAG, external acquisition, paths, diagnostics, and secrets
- **Severity:** P2
- **Dimensions:** rag, filesystem, packaging
- **Confidence:** High
- **Effort:** M
- **Status:** OPEN
- **Files/functions reviewed:** src/rag/init.ts (module-level `path.resolve("external"|"data/..."|"doc"|"AGENTS.md"|".github/prompts")` lines 13-21, `resolveEmbeddingsDir` 23-24), `loadIndexes` (src/rag/indexer.ts 865-885, best-effort try/catch)

**Failure scenario:**
The documented VS Code MCP config launches `node ./node_modules/c64bridge/dist/index.js` with the user's **project** as cwd. Every RAG path is `path.resolve("data/...")` = `<project>/data/...`, not the package's bundled `data/`. `loadIndexes` wraps each read in `try {} catch {}`, so all embedding files are missing → the retriever loads with empty indexes and returns no snippets. `c64_rag` and every prompt/resource enrichment silently yields nothing; the failure is swallowed (no throw), so the agent gets empty knowledge with no error.

**Current-code evidence:** src/rag/init.ts:13-21 use bare `path.resolve(...)` (cwd-relative); indexer's `loadIndexes` silently ignores read failures.

**Why production-reachable:** npm-installed usage with project cwd is the primary deployment (package.json ships `data/**`, `doc/**` precisely so the server can read them from the package dir).

**Why this degrades C64 control, development, or trust:** The RAG/knowledge subsystem — a headline capability — is silently empty for installed users, degrading BASIC/ASM assistance with no diagnostic.

**Backend and recovery angle:** Backend-independent. Workaround: run with cwd = package root, undocumented.

**Relation to existing HARD01 findings:** Same cwd-vs-package root theme as HARD01-006 (config); distinct subsystem and impact.

**Minimal fix sketch:** Resolve knowledge/data/doc paths relative to the module (`fileURLToPath(import.meta.url)` + package root), with cwd as an optional override.

**Regression test strategy:** Run initRag from a temp cwd and assert indexes still load from the package data dir.

**Fix risk:** Dev checkouts that rely on cwd must still work; keep an env override.

### HARD01-026 - VICE reset() reports success even when BASIC never reaches the READY prompt

- **Area:** VICE Binary Monitor and process lifecycle
- **Severity:** P2
- **Dimensions:** vice-lifecycle, program-runner, tool-contract
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/device.ts `ViceBackend.reset` (697-713); src/vice/readiness.ts `waitForBasicReady` (120-166)

**Failure scenario:**
`c64_system reset` (or `reboot`, which delegates to reset) on VICE. `reset()` calls `waitForBasicReady` and captures its `{pointersOk, promptOk}` result but **ignores both flags**, then returns `{ success: true }` unconditionally. If the machine never reached a usable BASIC prompt within 20 s (stuck autostart, prior crash, monitor desync), the tool still reports a clean reset. The very next `upload_run_basic`/`injectPrg` (which only does a best-effort `waitForBasicReady`) then types into a machine that is not at READY, silently losing the program.

**Current-code evidence:** src/device.ts:709-712 — `readiness` is read and only logged under debug; success is hardcoded. Contrast `ViceBackend.ensureProcessInternal` (477-491) which *does* throw when readiness fails.

**Why production-reachable:** reset/reboot are core ops used before every program run.

**Why this degrades C64 control, development, or trust:** False "reset succeeded" hides a wedged emulator, cascading into silent program-run failures.

**Backend and recovery angle:** VICE only. C64U/U2 resets are fire-and-forget firmware calls.

**Relation to existing HARD01 findings:** Independent of HARD01-012 (timeout) though both concern VICE readiness.

**Minimal fix sketch:** Return `{ success: readiness.pointersOk && readiness.promptOk, details: readiness }` so callers see the failure.

**Regression test strategy:** BM stub where pointers never settle; assert reset returns success:false.

**Fix risk:** Callers currently assuming success:true on VICE reset must handle failure.

### HARD01-027 - Config resolution reads C64BRIDGE_CONFIG as JSON but throws the whole server on any non-ENOENT error (malformed JSON, EACCES)

- **Area:** Backend selection and platform/capability contract
- **Severity:** P3
- **Dimensions:** config, packaging, diagnostics
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/config.ts `loadConfig` (36-49); src/mcp-server.ts `main` load_config span (86)

**Failure scenario:**
A user's `~/.c64bridge.json` (or `C64BRIDGE_CONFIG` file) contains a trailing comma or is not readable (permissions). In `loadConfig`, `JSON.parse(readFileSync(...))` throws `SyntaxError` (or an `EACCES` error); the loop rethrows anything that is not `ENOENT` (line 45-47). `loadConfig` is called synchronously in `main` before the transport connects, so the process exits with a fatal error and the MCP server never starts — with a raw parse error rather than actionable guidance. `device.ts`'s parallel `readConfigFile` swallows the same error (bare `catch {}`), so the two loaders disagree on whether a bad file is fatal.

**Current-code evidence:** src/config.ts:44-48 rethrow on non-ENOENT; src/device.ts:211 `catch {}`.

**Why production-reachable:** Hand-edited JSON config with a syntax slip is common.

**Why this degrades C64 control, development, or trust:** A one-character config typo takes the whole server down at startup with an opaque error, instead of falling back to defaults with a warning.

**Backend and recovery angle:** All backends; server won't boot.

**Relation to existing HARD01 findings:** Related to HARD01-005/006 (config loaders) but distinct: this is the fatal-on-malformed behaviour and its inconsistency with device.ts.

**Minimal fix sketch:** Catch parse/read errors, log a clear warning, and continue with defaults (matching device.ts leniency), or fail fast in both loaders consistently.

**Regression test strategy:** Unit test: malformed JSON at C64BRIDGE_CONFIG; assert loadConfig returns defaults with a warning rather than throwing.

**Fix risk:** Silent fallback could mask a real misconfiguration; emit a prominent warning.

### HARD01-028 - Background task iterations that return `{success:false}` are counted as successful; only thrown errors are recorded

- **Area:** Background tasks, meta workflows, artifacts, and cancellation
- **Severity:** P3
- **Dimensions:** background-task, tool-contract
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/meta/background.ts `scheduleNextRun` (232-257), `runOperation` (205-226)

**Failure scenario:**
A background task runs `read`/`write`/`menu_button`, whose `C64Client` methods **return** `{ success:false, details }` on failure rather than throwing (client swallows errors into normaliseError). `scheduleNextRun` awaits `runOperation`, then unconditionally increments `iterations`, logs `iteration=N`, and reschedules — never inspecting `.success`. A task pointed at an unreachable device or wrong backend logs a growing "healthy" iteration count while every iteration actually failed; `lastError` stays null.

**Current-code evidence:** src/tools/meta/background.ts:235-247 — no check of the resolved value's `success`.

**Why production-reachable:** Any background monitor against a device that intermittently fails.

**Why this degrades C64 control, development, or trust:** Task status/iteration count is a false health signal; failing monitors look healthy.

**Backend and recovery angle:** All backends.

**Relation to existing HARD01 findings:** Same file as HARD01-022, distinct defect (success accounting vs reschedule-on-restart).

**Minimal fix sketch:** Inspect the resolved result's `success`; on false, set `lastError` and optionally `status:"error"` or a failure counter.

**Regression test strategy:** Unit test with a client returning `{success:false}`; assert the task records the failure.

**Fix risk:** Deciding stop-vs-continue policy; make it configurable, default to recording without stopping.

### HARD01-029 - bundle_run_artifacts writes files outside the requested output directory via an unsanitised runId (path traversal)

- **Area:** Background tasks, meta workflows, artifacts, and cancellation
- **Severity:** P2
- **Dimensions:** filesystem, security, background-task
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/meta/artifacts.ts `bundle_run_artifacts` (30-104), `bundleRunArtifactsArgsSchema` (9-28)

**Failure scenario:**
`c64_program bundle_run` / `bundle_run_artifacts` with `{runId:"../../../../home/chris/.config/evil", outputPath:"/tmp/artifacts"}`. `runId` is validated only as `minLength:1` (no character/`..` restriction). `resolvePath(joinPath(outputPath, runId))` normalises the `..` segments and escapes `/tmp/artifacts` entirely; the tool then `fs.mkdir(runPath, {recursive:true})` and writes `screen.txt`, `memory/range_*.hex`, `debugreg.json`, and `manifest.json` into the attacker/agent-chosen location, creating directories and overwriting files anywhere the process can write.

**Current-code evidence:** src/tools/meta/artifacts.ts:47-54 (runId joined and resolved without containment check); schema line 12 (no pattern). The memory filename also interpolates `range.address` unsanitised (line 74).

**Why production-reachable:** `bundle_run` is a documented program-orchestration op; runId is free-form text an LLM composes from user input.

**Why this degrades C64 control, development, or trust:** Arbitrary file/directory creation and overwrite outside the intended artifacts tree — a filesystem-integrity/security defect in an automated agent context.

**Backend and recovery angle:** Backend-independent (host filesystem).

**Relation to existing HARD01 findings:** Independent; complements HARD01-025/006 (path handling) but this is an escape from a user-supplied base, not a base-resolution bug.

**Minimal fix sketch:** Reject runId containing path separators or `..` (or slugify it), and after resolving assert `runPath` is contained within `outputPath` (`runPath.startsWith(outputPath + sep)`).

**Regression test strategy:** Unit test with `runId:"../escape"`; assert the tool errors and writes nothing outside outputPath.

**Fix risk:** None; tighter validation only.

### HARD01-030 - c64_sound generate launches an untracked, uncancellable background playback loop that keeps writing device state after the call returns

- **Area:** Background tasks, meta workflows, artifacts, and cancellation
- **Severity:** P2
- **Dimensions:** sid-audio, background-task, timeout-cancellation, backend-switching
- **Confidence:** High
- **Effort:** M
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/audio.ts `music_generate` (851-930, `void (async () => {...})()` at 890); src/c64Client.ts `sidNoteOn`/`sidSetVolume` (via facadePromise); src/device.ts ViceBackend.withClient monitorQueue

**Failure scenario:**
`c64_sound {op:"generate", steps:64, tempoMs:500}` returns immediately ("Scheduled …") but spawns a **detached** async loop that writes SID registers once per step for up to `steps*tempoMs` (32 s here). Nothing tracks or can stop this loop: `c64_system stop_all_tasks` does not know about it, server shutdown does not await it, and a `c64_select_backend` mid-playback makes the remaining `sidNoteOn` writes resolve against `this.facadePromise` — i.e. they play onto whatever backend is now active (potentially real hardware the user just switched to). On VICE, each note acquires the `monitorQueue`, so a long arpeggio serializes behind/ahead of every other VICE operation for its whole duration. The tool's `success:true` claims completion while playback is still ongoing and unmanaged.

**Current-code evidence:** src/tools/audio.ts:890-914 — fire-and-forget IIFE with only a `catch` that logs; no handle, cancellation token, or task registration.

**Why production-reachable:** `generate` is a documented quick-playback op; long step counts are permitted by the schema.

**Why this degrades C64 control, development, or trust:** Unmanaged live device work that outlives the request, can retarget across a backend switch (physical-state hazard), monopolizes the VICE monitor, and cannot be stopped except by `sid_reset`.

**Backend and recovery angle:** All backends. Recovery: `c64_sound reset`/`silence_all`, if the loop hasn't retargeted.

**Relation to existing HARD01 findings:** Shares the switch-retarget mechanism with HARD01-016 but is a distinct lifecycle/cancellation defect (untracked detached work).

**Minimal fix sketch:** Pin the facade at call time and pass it through the loop; register the loop as a cancellable task (integrate with the background-task registry) and stop it on shutdown/backend switch.

**Regression test strategy:** Unit test asserting a switch during playback does not route later notes to the new facade; test that shutdown awaits/cancels the loop.

**Fix risk:** Changing to a tracked task alters the fire-and-forget contract; keep the immediate return but add a stop handle.

### HARD01-031 - Reading the c64://platform/status resource performs a blocking device REST probe, so a slow/unreachable Ultimate stalls the resource channel

- **Area:** MCP protocol, stdio, tool dispatch, prompts, and resources
- **Severity:** P3
- **Dimensions:** mcp-protocol, c64u-rest, capability, timeout-cancellation
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/mcp-server.ts ReadResource handler (197-251) → `renderPlatformStatusMarkdown` (523-578) → `client.getNativeEndpointCapabilities` (src/c64Client.ts:259-276) → `C64uBackend.getInputState` (src/device.ts:349-353, 10 s http timeout at 251)

**Failure scenario:**
An MCP client reads the `c64://platform/status` resource (the documented pre-flight for native input). On the c64u backend, `renderPlatformStatusMarkdown` `await`s `getNativeEndpointCapabilities()`, which issues a live `GET machine:input` against the device using the facade's 10 s Axios timeout. If the Ultimate is booting, unreachable, or slow, the ReadResource call blocks for up to 10 s (and, per HARD01-004, poisons the cached result to "unknown" permanently). Resource reads are expected to be cheap, side-effect-free metadata fetches; clients that prefetch resources can stall, and the probe is a real device interaction hidden behind a "status" read.

**Current-code evidence:** As cited; the ReadResource handler has no timeout of its own and awaits the device probe inline.

**Why production-reachable:** Agents are explicitly told to read this resource before native input (AGENTS.md); device boot/network latency is routine.

**Why this degrades C64 control, development, or trust:** A metadata resource performing a blocking, side-effecting, permanently-cached device call couples MCP resource latency to hardware reachability and violates the "read status before acting" guidance it is meant to support.

**Backend and recovery angle:** c64u only (u2/vice return static capability values). Compounds HARD01-004's permanent caching.

**Relation to existing HARD01 findings:** Distinct from HARD01-004 (that is the cache poisoning; this is the resource-read blocking/side-effect surface).

**Minimal fix sketch:** Give the probe a short timeout (e.g. 1-2 s) independent of the 10 s facade timeout, and/or make the status resource report "unknown/not-yet-probed" without blocking, probing lazily in the background.

**Regression test strategy:** Test with a facade whose getInputState never resolves; assert ReadResource returns within the short timeout with a non-blocking status.

**Fix risk:** Shorter probe timeout could report "unknown" on a merely-slow device; pair with the non-caching fix from HARD01-004.

### HARD01-032 - SID frequency register formula uses 2^16 instead of the SID's 2^24 divisor, so every generated note is ~256x too low in pitch

- **Area:** Program execution, BASIC, assembler, memory, graphics, and SID
- **Severity:** P2
- **Dimensions:** sid-audio, memory-io, tool-contract, documentation-contract
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/c64Client.ts `hzToSidFrequency` (2190-2195), `sidNoteOn` (856-906); src/sidwaveCompiler.ts `hzToSidFrequency` (190-193); src/knowledge.ts SID formula doc (line 100); c64://sound/sid/spec

**Failure scenario:**
`c64_sound {op:"note_on", note:"A4"}` (or `frequencyHz:440`, or `music_generate`, or any sidwave compilation). `hzToSidFrequency` computes `round(hz * 65536 / phi2)`. The SID oscillator is a **24-bit** phase accumulator: the correct register value is `Fn = Fout * 2^24 / Fclk` (Fclk≈985248 PAL), i.e. the divisor constant must be 16777216 (2^24), not 65536 (2^16). For A4=440 Hz the code yields `round(440*65536/985248) = 29` (`$001D`), which plays back as `29*985248/2^24 ≈ 1.7 Hz` — sub-audible — instead of the correct `Fn≈7493` (`$1D45`). Every note is a factor of 256 too low. The tool reports success and the register write happens; only the pitch is wrong.

**Current-code evidence:** src/c64Client.ts:2192 `Math.round((hz * 65536) / phi2)`; identical error in src/sidwaveCompiler.ts:192; and src/knowledge.ts:100 documents the same wrong formula (`freq_value = (frequency_Hz × 65536) / clock_rate`), so the mistake is codebase-wide and self-consistent. The audio test (test/audioModule.test.mjs:455) only asserts the call succeeds, never the register value, so it does not catch it.

**Why production-reachable:** `sid_note_on`, `music_generate`, and sidwave compilation are the documented SID-playback paths.

**Why this degrades C64 control, development, or trust:** The SID melodic feature is fundamentally broken — notes are inaudible/wrong-octave — while reporting success; a user composing music gets no usable pitch.

**Backend and recovery angle:** All backends that write SID registers (C64U/U2 firmware and VICE memory).

**Relation to existing HARD01 findings:** Independent of HARD01-034 (envelope gating) though both affect SID playback.

**Minimal fix sketch:** Replace the `65536` constant with `16777216` (2^24) in both `hzToSidFrequency` implementations and correct the knowledge.ts formula; clamp to 16-bit as today.

**Regression test strategy:** Unit test asserting `hzToSidFrequency(440,"PAL") ≈ 7493` and that `sid_note_on note:"A4"` writes `$45 $1D` to `$D400/$D401`.

**Hardware validation:** Play A4 on real hardware / VICE and confirm audible ~440 Hz.

**Fix risk:** None arithmetically; verify NTSC constant (1022727) with the same 2^24 divisor.

### HARD01-033 - music_generate never releases the gate between notes, so the ADSR envelope only attacks once and later notes do not articulate

- **Area:** Program execution, BASIC, assembler, memory, graphics, and SID
- **Severity:** P3
- **Dimensions:** sid-audio, tool-contract
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/audio.ts `music_generate` playback loop (890-914); src/c64Client.ts `sidNoteOn` (856-906), `sidNoteOff` (908-920)

**Failure scenario:**
`c64_sound {op:"generate", steps:8}` plays an arpeggio by calling `sidNoteOn` once per step with GATE set (control bit 0 = 1) and **never calling `sidNoteOff` between notes**. The SID envelope generator only (re)starts its attack/decay when it sees a rising edge on GATE; because GATE stays continuously high across all steps, only the first note articulates (attack→decay→sustain) and every subsequent note merely changes frequency while the envelope sits in sustain. With `sustain:15, release:0`, successive notes blur together with no re-attack — not the intended arpeggio articulation.

**Current-code evidence:** src/tools/audio.ts:893-909 — loop of `sidNoteOn` with a single trailing `sidNoteOff(1)`; no gate-off between steps.

**Why production-reachable:** `generate` is the documented quick-playback op.

**Why this degrades C64 control, development, or trust:** Musical output does not match the promised note sequence; combined with HARD01-032 the feature is doubly broken.

**Backend and recovery angle:** All backends.

**Relation to existing HARD01 findings:** Distinct from HARD01-032 (pitch) and HARD01-030 (lifecycle).

**Minimal fix sketch:** Between notes, clear GATE (write control with bit0=0) briefly before the next `sidNoteOn`, or expose a per-note gate-retrigger.

**Regression test strategy:** Unit test asserting the register write sequence includes a gate-low write between successive notes.

**Fix risk:** Minor timing change to playback.

### HARD01-034 - Printer tools are gated to c64u only, so they are unavailable on U2 despite the platform advertising printer-integration

- **Area:** Backend selection and platform/capability contract
- **Severity:** P3
- **Dimensions:** capability, u2-variant, documentation-contract
- **Confidence:** High
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/tools/printer.ts `printerModule` (295-...) and src/tools/registry/printer.ts `printerModuleGroup` (170-...) — both omit `supportedPlatforms`; src/tools/types.ts `defineToolModule` default (338-340) → `["c64u"]`; src/platform.ts `PLATFORM_FEATURES.u2` (23-26) lists `printer-integration`

**Failure scenario:**
Active backend u2. Invoking `c64_printer` (any op) fails with `ToolUnsupportedPlatformError` because both printer modules default their `supportedPlatforms` to `["c64u"]` (neither sets it). Yet the `c64://platform/status` resource lists `printer-integration` as an active feature for u2 (PLATFORM_FEATURES.u2), and printing is just a BASIC program run to device 4 that U2 firmware supports. The capability advertisement and the runtime gate contradict each other, and a real, supported u2 printing workflow is blocked.

**Current-code evidence:** As cited — printer modules never call `supportedPlatforms`, so the `["c64u"]` module default applies; platform.ts advertises printer-integration for u2.

**Why production-reachable:** U2-family users following the platform-status capability list.

**Why this degrades C64 control, development, or trust:** Advertised capability is unusable on u2; the status resource misleads.

**Backend and recovery angle:** U2 blocked; c64u works; VICE has no printer (correctly excluded).

**Relation to existing HARD01 findings:** Distinct capability/gating mismatch from HARD01-004/016.

**Minimal fix sketch:** Set `supportedPlatforms: ["c64u","u2"]` on the printer modules (or align PLATFORM_FEATURES if u2 truly lacks printing).

**Regression test strategy:** Platform-capability test asserting c64_printer is in u2's supported-tools list iff printer-integration is advertised for u2.

**Fix risk:** None if U2 firmware runs the printer BASIC (it runs arbitrary BASIC); confirm device-4 availability on U2.

### HARD01-035 - VICE configSet/configBatchUpdate coerce any digit-only string to an integer, misapplying or rejecting string resources

- **Area:** VICE Binary Monitor and process lifecycle
- **Severity:** P3
- **Dimensions:** config, vice-monitor, tool-contract
- **Confidence:** Medium
- **Effort:** S
- **Status:** OPEN
- **Files/functions reviewed:** src/device.ts `ViceBackend.configSet` (908-915), `configBatchUpdate` (917-935); src/vice/viceClient.ts `resourceSet` (417-443) and BM spec §0x52 (type mismatch → 0x81)

**Failure scenario:**
`c64_config set` on VICE for a **string** resource whose value happens to be all digits (e.g. a directory/image path or label like `"1541"` used as text). `configSet` does `const numValue = Number(value); parsed = !isNaN(numValue) && value.trim()!=="" ? numValue : value`, so `"1541"` becomes the integer `1541` and is sent to `resourceSet` as an int payload. Per the BM spec, if the underlying VICE resource is a string, the monitor returns `0x81` (type mismatch) — or, for a resource that accepts ints, the wrong type is silently applied. The user's explicit string value is lost with no signal at the tool layer.

**Current-code evidence:** src/device.ts:909-910 and 924-925 apply the same `isNaN(Number(...))` heuristic to every value; `configBatchUpdate` records the per-item error but `configSet` surfaces only a generic failure.

**Why production-reachable:** Any VICE `c64_config` set/batch where the intended string value is numeric text.

**Why this degrades C64 control, development, or trust:** Config values are silently type-coerced; string resources cannot be set to numeric-looking strings, and failures may be misclassified.

**Backend and recovery angle:** VICE only (c64u sends values as strings to firmware).

**Relation to existing HARD01 findings:** Independent.

**Minimal fix sketch:** Look up the resource's declared type (VICE `resourceGet` reports int vs string) before coercing, or expose an explicit value-type argument; do not infer type from the value's shape.

**Regression test strategy:** BM stub asserting a string resource set to `"1541"` sends a string payload, not an int.

**Fix risk:** Requires a resource-type probe or schema; keep the numeric fast-path for known int resources.

## Suggested fix batches

### Batch A - Ultimate REST truthfulness
- HARD01-011 (ignore `errors` array), HARD01-010 (path double-encoding), HARD01-017 (paused-on-resume-failure), HARD01-002/003 (power_cycle verification + cleanup)
- Rationale: all concern C64uBackend/powerCycle reporting success without confirming device state; one mock-Ultimate harness returning 200+errors, nested paths, and menu matrices protects the group.

### Batch B - VICE lifecycle and transport
- HARD01-012 (BM response timeout), HARD01-013 (orphaned processes), HARD01-014 (joystick Joyport), HARD01-026 (reset readiness), HARD01-015 (checkpoint mask)
- Rationale: shared ViceClient/ViceBackend/process.ts surface; one BM stub + managed-process test harness covers timeout, signal cleanup, joyport, readiness.

### Batch C - Backend-switch and config consistency
- HARD01-004, HARD01-005, HARD01-006, HARD01-016, HARD01-025, HARD01-027
- Rationale: single config source of truth + facade pinning + module-relative asset resolution; one multi-backend mock-facade harness plus a config-fixture suite.

### Batch D - Program-execution truthfulness
- HARD01-018, HARD01-019, HARD01-020, HARD01-021, HARD01-007, HARD01-008
- Rationale: assembler entry mechanism + poll validator rewrite + BASIC generators; VICE fixture asserting real program effects.

### Batch E - SID audio correctness
- HARD01-032 (frequency formula), HARD01-033 (gate re-trigger), HARD01-030 (untracked playback)
- Rationale: all in the SID playback path (hzToSidFrequency, music_generate); one register-write assertion fixture plus a real-frequency HIL/VICE check covers pitch and articulation.

### Batch F - Background/meta lifecycle, artifacts, secrets, capability
- HARD01-022, HARD01-028, HARD01-029, HARD01-024, HARD01-023, HARD01-031, HARD01-034, HARD01-035
- Rationale: task persistence/accounting, path containment, log redaction, drive-shape normalisation, resource-probe timeout, printer u2 gating, VICE config coercion.

## Recommended validation gate

- **Mock-Ultimate error-array test**: 200 responses carrying non-empty `errors` for run/mount/config must yield tool `isError` (HARD01-011); nested-path request line preserves `/` separators (HARD01-010).
- **Concurrent backend-switch harness** with mock c64u/u2/vice facades: a slow write-verify started on one backend must complete against the facade it began with despite an interleaved `c64_select_backend` (HARD01-016); capability probe caching retries after a transient failure (HARD01-004).
- **VICE BM stub**: unanswered command rejects within the request timeout and the monitor queue releases (HARD01-012); reset returns success:false when readiness fails (HARD01-026); an 0xA2 Joyport command is emitted for joystick ops (HARD01-014).
- **Managed/unmanaged VICE lifecycle**: SIGTERM to the server leaves no orphaned VICE/Xvfb (HARD01-013).
- **Config-fixture suite**: layered files resolve identical host/port/password through both loaders (HARD01-005); a project-cwd `.c64bridge.json` is honoured (HARD01-006); malformed JSON falls back with a warning (HARD01-027).
- **Program fixtures**: VICE run of the `upload_run_asm` example writes `$01` to `$0400` (HARD01-018); poll validator reports "crashed" when only free-running registers change (HARD01-019) and never reads `$DC0D/$DD0D` on hardware (HARD01-020); generated printer program contains no `""` inside string literals (HARD01-007).
- **Filesystem/secrets**: `runId:"../escape"` is rejected (HARD01-029); RAG loads bundled indexes from a foreign cwd (HARD01-025); debug logs mask `X-Password` (HARD01-024).
- **Background tasks**: reloaded "running" tasks are re-armed or downgraded (HARD01-022); `{success:false}` iterations are recorded as failures (HARD01-028).
- Controlled HIL validation (C64U/U64/U2, managed VICE) only after fixes land; never during this review.

## Leads not yet proven

- **Lead:** `mergePlatforms` unions module and tool `supportedPlatforms`, so a tool can never *narrow* below its module default.
  - **Area:** Backend selection and platform/capability contract
  - **Why it matters:** A future tool that sets a narrower `supportedPlatforms` than its module would be exposed/allowed on unsupported platforms.
  - **Evidence so far:** src/tools/types.ts:488-504 unions the sets; no current tool narrows (all either match or widen), so it is latent, not live.
  - **Next check:** Confirm no grouped tool relies on narrowing, then treat as a hardening change.

- **Lead:** Tool results attach a top-level `metadata` field (src/tools/responses.ts, src/mcp-server.ts `toCallToolResult`) rather than the MCP `_meta`.
  - **Area:** MCP protocol
  - **Why it matters:** Spec-compliant clients ignore `metadata`; rich per-tool metadata may be silently dropped (though `structuredContent` duplicates most of it).
  - **Evidence so far:** `toCallToolResult` copies `metadata` verbatim; MCP CallToolResult defines `_meta`.
  - **Next check:** Confirm the installed MCP SDK result schema is passthrough (harmless) vs strict (rejects), and whether any client consumes `metadata`.

- **Lead:** `injectKeyboardQueue` writes the 10-byte KERNAL buffer at `$0277` then NDX at `$00C6` as two separate DMA writes; a mid-write KERNAL IRQ could observe a partially updated buffer.
  - **Area:** input
  - **Why it matters:** Rare keystroke corruption independent of HARD01-009's drain issue.
  - **Evidence so far:** src/c64Client.ts:1926-1927 orders bytes-before-count (mitigates most cases) but does not pause the machine.
  - **Next check:** Determine whether Ultimate `:writemem` is atomic relative to the C64 IRQ; if not, quantify the window.

- **Lead:** Video-frame grouping keys on the 16-bit `frameNumber`, which wraps at 65536; a very long reuse-session capture could merge packets from two distinct frames that share a number.
  - **Area:** streaming / graphics
  - **Why it matters:** Corrupt reconstructed frame after prolonged capture.
  - **Evidence so far:** src/streamCapture.ts `groupVideoPackets` groups by raw frameNumber; capture windows are currently short (count ≤ 32), so it is latent.
  - **Next check:** Confirm firmware frame-number wrap behaviour and whether reuse sessions can accumulate >65536 frames.

## Important limitations

- Review is static/source-only per scope: no state-changing MCP calls, no hardware, and no VICE process were exercised. Medium-confidence findings (HARD01-010, HARD01-011, HARD01-020) rest on the documented firmware/CIA/OpenAPI contracts plus one explicitly stated inference each; a mock-Ultimate or HIL check would raise them to High.
- The generated OpenAPI client (`generated/c64/index.ts`) and the embeddings JSON were read selectively, not exhaustively; the packaging sweep confirmed `files`/entry wiring but did not build or install the package.
- Test files were consulted only to confirm why a defect is not already covered, not audited for their own bugs.
- 31 findings exceed the ≥30 objective; the count is not capped by source quality — additional lower-severity robustness items remain (see Leads) but were left as leads rather than padded into main findings.

## Commands run

- git status --short; git rev-parse --abbrev-ref HEAD; git rev-parse HEAD; date -Iseconds
- find src -maxdepth 2 -type d; wc -l src/*.ts; find src -type f -name '*.ts' | xargs wc -l | sort -rn
- Read: src/mcp-server.ts, src/config.ts, src/bootstrap/stdio-logger.ts, src/device.ts, src/c64Client.ts, src/platform.ts
- Read: src/vice/viceClient.ts, src/vice/process.ts, src/vice/readiness.ts, doc/vice/vice-binary-monitor-spec.md
- Read: src/tools/types.ts, src/tools/input.ts, src/tools/machineControl.ts, src/tools/memory.ts, src/tools/pollValidator.ts, src/tools/responses.ts
- Read: src/tools/registry/{index,system,platform,utils,input,stream,disk,sound,program}.ts, src/tools/storage.ts, src/tools/audio.ts
- Read: src/tools/meta/{background,filesystem,artifacts}.ts, src/tools/translation/basicTokenizer.ts, src/tools/programRunners.ts
- Read: src/rag/{init,externalFetcher,urlUtils}.ts (selective), src/loggingHttpClient.ts, src/logger.ts (grep)
- rg/sed/nl over doc/c64u/c64-openapi.yaml, doc/u2/u2-openapi.yaml, generated/c64/index.ts, package.json, doc/developer.md
- rg surveys: supportedPlatforms, operationPlatforms, drivesList consumers, X-Password handling, path/traversal sinks

- git status --short; git rev-parse --abbrev-ref HEAD; git rev-parse HEAD; date -Iseconds
- find src -maxdepth 2 -type d; wc -l src/*.ts
