# Hardening behavior guide

The MCP schemas are the authority for each operation's accepted arguments and platform support. The Hardening 3 changes tighten these contracts and report partial failures explicitly.

## Host files and configuration

Tool-supplied host paths must resolve inside the working directory, the C64 Bridge state directory, the system temporary directory, or roots added with `C64BRIDGE_ALLOWED_DIRS` (separated by the platform path delimiter). Symlinks are resolved before confinement checks. Hidden path components are rejected by default; `C64BRIDGE_ALLOW_HIDDEN_PATHS=1` permits them. Configuration files and the server's own state remain protected even with that opt-out: the task registry, its lock directory, background task folders (`tasks/`), the find/run state (`meta/`) and the diagnostics directory. These follow `C64_TASK_STATE_FILE` and `C64BRIDGE_DIAGNOSTICS_DIR`; a protected directory that contains the working directory is not protected. Generated run directories (`runs/`) stay usable. `C64BRIDGE_ALLOWED_DIRS=*` disables root confinement and hidden-component restrictions, but does not disable direct protected-file checks.

Bitmap input is read through the same host-file boundary, accepts files rather than URLs, and is limited to 4096 by 4096 pixels. Default host reads are limited to 16 MiB (disk images: 64 MiB). Existing files inside permitted roots may be overwritten; applications sharing a writable root must protect it from untrusted local users.

`C64BRIDGE_ACCESS=full|no-destructive|read-only` controls operations, including nested batches. Starting tasks inherits the effect of the scheduled operation; stopping tasks remains available in read-only mode so monitoring can be stopped. Deleting finished tasks requires write access. Network configuration writes that could disconnect the device require destructive access. Credentials in configuration updates are redacted in logs and diagnostics without replacing arbitrary substrings of program data or other tool results.

## State, tasks and cancellation

`C64BRIDGE_STATE_DIR` selects the state root (default `~/.c64bridge`). Default batch, shuffle and compile-cycle artifacts use unique directories under `runs/`. Startup retains at most 200 generated run directories, removing those older than 30 days; explicit output directories and runs owned by another live server process are protected from pruning.

Task status changes are persisted immediately; repeated iteration snapshots and logs are coalesced to at most once a second. The registry retains at most 200 finished tasks. `c64_system` with `op: "delete_task"` removes a finished task and its artifacts; stop a running task first. Task records and folders identify the owning process/session so separate server processes do not interrupt or overwrite each other's live work.

Wait and workload limits appear in the schemas. MCP cancellation stops further work at supported boundaries and returns a cancellation result. An operation already sent to the device may have taken effect; cancellation does not undo a launched program or completed writes. Temporary capture cleanup restores the user's previous stream, including when requests overlap or are cancelled. Captures serialize with stream changes.

Over the HTTP transport, a pre-2026 client that closes its connection also cancels its running call. This needs the server to run under Node, the supported runtime: Bun's `node:http` server does not report the disconnect, so under Bun the call runs until its own timeout, and the server prints a warning at startup.

## Tasks

One task engine serves two kinds of task. Interval tasks are the `c64_system` `start_task` operations that repeat a fixed operation (`read`, `write`, `read_screen`, `menu_button`); they are persisted as described above. Call tasks are single detached runs of an allowlisted operation. Only these operations can become call tasks: `c64_memory` `wait_until` and `wait_for_text`, `c64_debug` `wait_for_state`, `c64_sound` `capture_samples`, `pipeline`, `convert`, `reconstruct`, `render`, `analyze_music` and `compare`, `c64_graphics` `capture_frame`, `c64_program` `batch_run` and `bundle_run`. The five offline SIDWave operations hold no lease, but the resource gate still treats them like other calls: while another task holds the exclusive lease, `convert`, `reconstruct` and `render` are refused, and on VICE `analyze_music` and `compare` are refused too. They run on the server's event loop, and the SID engine yields between render slices, so polling and cancelling work while it renders. Other operations are not allowlisted because they are short, or because their work runs on the server's event loop and a detached run would not move it (`c64_sound` `sample_render`, `analyze` and `record_analyze`).

**States.** A task is `working`, then `completed`, `failed` or `cancelled`. A terminal state is final: a late completion never overwrites a cancellation, and a repeated cancel reports the existing state. The legacy `c64_system` status strings are `running`, `completed`, `error` and `stopped` for these four states. An operation result with `isError: true` makes the engine state `failed` and keeps the result. The native Tasks adapter reports that as `completed` with the result, as a direct call would have returned it, and reserves `failed` with a JSON-RPC `error` for a thrown error without a result.

**Inline window.** A task-capable call waits up to `C64BRIDGE_TASK_INLINE_MS` (default 1000, 0 to 600000, read on each call) for the operation to finish. If it finishes, the caller receives the ordinary tool result and no task record remains, so validation errors, access denials, resource conflicts and fast results are identical for every client. Otherwise a client that declared the Tasks extension on a 2026-07-28 connection receives a task handle. Other clients wait for the result as before and their request signal stays linked. At the working-task limit, a Tasks-declaring request runs as an ordinary direct call.

**Start-time checks.** The access mode, argument validation, address and symbol resolution and backend pinning happen at submission, with the access mode and symbol table of that moment. Submission is rejected with `task_not_allowed`, `task_name_in_use`, `too_many_tasks` or `resource_conflict`. At most 16 tasks owned by this process can be `working` at once. Interval and call tasks share one name space per process.

**Expiry and retention.** A finished call task is kept for `C64BRIDGE_TASK_TTL_MS` (default 600000) after it reached a terminal state, and at most 64 finished call tasks are kept (oldest removed first). A later `tasks/get` for an expired or unknown id answers `-32602`. The native `ttlMs` is `null` while the task works and counts from `createdAt` once it has finished.

**Cancellation.** Until the call is handed over (a task handle returned, or `started: true` from `start_task`), cancelling the request cancels the task. Afterwards only `tasks/cancel`, `c64_system` `stop_task` or `stop_all_tasks` stops it. Cancellation is cooperative: the operation stops at its next step, and an operation already sent to the device may have taken effect. `c64_graphics` `capture_frame` and `c64_program` `bundle_run` ignore the abort signal and are bounded instead (at most 32 frames with a capture timeout; at most 256 memory ranges and 2 MiB). After a cancel they report `cancelled` at once, and their lease stays held until the underlying call has returned.

**Persistence.** Call tasks are held in memory only. They are never persisted and never resumed after a restart; the server cancels its working tasks on shutdown. Native Tasks call tasks have no name, are omitted by `list_tasks` and `stop_all_tasks`, and are still cancelled on process shutdown. Interval tasks keep their persisted format and owner rules.

**Legacy path.** `c64_system` `start_task` accepts an allowlist key such as `c64_memory.wait_until` as `operation`, with `arguments` holding that operation's arguments without `op`. `intervalMs` and `maxIterations` are rejected for call tasks. `task_result` takes `name` and `waitMs` (0 to 60000, default 0) and returns the status, `done`, and `result` or `error`. `stop_task`, `stop_all_tasks`, `list_tasks` and `delete_task` cover call tasks as well. Starting a call task inherits the effect of its operation for the access mode.

## Resource coordination

Foreground operations are classified as `passive-read`, `interrupting-read` (VICE monitor reads, which stop the CPU), `memory-write`, `program-start`, `reset-power`, `input`, `capture`, `configuration`, `backend-switch` or `host-only`. An operation without a specific class is classified by its effect: a read is `passive-read` (`interrupting-read` on VICE), anything else is `memory-write`.

A task holds a lease on its backend from submission until it reaches a terminal state. A task's own calls bypass only that task's lease; they are still checked against every other lease. Backend selection checks leases when the switch occurs, and selecting the already active backend is always allowed. A call task whose backend changes during submission is rejected with `resource_conflict`.

- An `observe` lease is shared and never blocks a foreground call. The monitoring tasks (`wait_until`, `wait_for_text`, `wait_for_state`) hold it. `wait_until` works on a backend pinned at submission, so a backend switch is allowed while it runs. `wait_for_text` and `wait_for_state` read through the active backend on every step, so a backend switch is rejected while they run.
- An `exclusive` lease is held by `capture_samples`, `pipeline`, `capture_frame`, `batch_run` and `bundle_run`. While it is held on a backend, a second exclusive task and calls of class `memory-write`, `program-start`, `reset-power`, `input`, `capture`, `configuration`, `backend-switch` and `interrupting-read` are rejected with a `resource_conflict` error that names the task and how to cancel it. `passive-read` and `host-only` calls stay allowed. Calls are not queued. Interval starts are classified by their operation and rejected if they conflict with an exclusive lease; each blocked interval iteration is skipped and logged.

The guarantee is process-local. It does not cover other MCP server processes or other users of the device.

## Conditional waits (`c64_memory` `wait_until`)

`wait_until` is a `read` operation. `timeoutMs` (1 to 3600000) is mandatory; `pollIntervalMs` is 50 to 60000 (default 250) and `maxIterations` 1 to 100000 (default 10000). Unknown keys are validation errors with the path of the key.

- **Resolution and pinning.** Addresses and symbols are resolved once at the start, and the backend facade is pinned once. A later backend switch or program start does not retarget the wait. Every address and length must stay at or below `$FFFF`. On Ultimate hardware a read that overlaps `$D000-$DFFF` is refused unless `includeIo: true`.
- **Iterations.** An iteration starts only after the previous one finished, so slow reads never overlap. The deadline always allows one last read.
- **Results.** `met: true` has reason `condition_met`. `timeout` and `max_iterations` are normal results with `met: false`. A failed read ends the wait with reason `communication_failure` and an error result that still carries the observation fields; the wait does not retry. A cancelled wait returns an error result with `cancelled: true`. Progress is reported after each unmet iteration.
- **`changed` and `screen_changed`** compare with the first read of the same wait, so the first iteration is never met.
- **`checkpoint`** is available on VICE only; other backends give a validation error. It creates a non-stopping checkpoint that does not halt the CPU, reads its hit count on each iteration (met at one or more hits), and deletes the checkpoint on every exit including cancellation. A failed removal is reported in `warnings`. At shutdown the server cancels running waits and gives their cleanup up to 1 second, so the checkpoint is normally removed; it can remain set only if VICE does not answer within that second; a VICE instance started by c64bridge is terminated at shutdown.

## Skills

The skill catalogue reads `.github/skills/*/SKILL.md` (without the developer-only `pr-converge`). A skill is served only if its frontmatter has a `name` equal to its directory name, following the Agent Skills naming rules (1 to 64 lowercase letters, digits and single hyphens), and a non-empty `description` of at most 1024 characters. Invalid or duplicate skills are left out and reported as diagnostics. Supporting files are served only when their names match `[A-Za-z0-9_][A-Za-z0-9._-]*`; dotfiles are skipped; symlinks that point outside the skill directory are skipped, and a `SKILL.md` that is such a symlink excludes the whole skill. A skill is limited to 512 files and 16 MiB. The bytes of each skill are produced once and used for `c64://skills/<name>` and `skill://<name>/SKILL.md`; the digest (`sha256:`) and size in `skills/list` are computed over those bytes. `skill://` resources are readable through `resources/read` but are not repeated in `resources/list`. `C64BRIDGE_SKILLS_PAGE_SIZE` sets the page size of `skills/list` (default 100); an unknown `skills/get` uri or an invalid cursor answers `-32602`.

## Protocol negotiation

The server serves both protocol eras on stdio and on the stateless HTTP transport (loopback Host and Origin checks and the bearer token apply as before). Capabilities are decided for each request from its own envelope: a request declares the Tasks extension only if it carries protocol version 2026-07-28 and `io.modelcontextprotocol/tasks` in its client capabilities. The server never decides by client name. A request that did not declare the extension never receives a task handle; it waits for the result. `tasks/get`, `tasks/update` and `tasks/cancel` from such a request answer `-32021` with `data.requiredCapabilities`. The extensions are advertised in the `server/discover` result only; the pre-2026 `initialize` result has no `extensions` key.

**Compatibility: differences for pre-2026 clients.** These are error paths only; the new codes are the ones the 2026-07-28 specification assigns, and the SDK error encoder produces them for every protocol version. An unknown resource answers `-32602` with `data.uri` instead of `-32002`, because the SDK encoder maps `-32002` to `-32602` for every protocol version. Invalid `tools/call` params answer `-32602` instead of `-32603`. An HTTP request using 2026 envelope keys without `MCP-Protocol-Version` gets HTTP 400. The message text for unknown resources keeps the earlier `MCP error <code>: ` prefix.

**Task handle details.** The SDK adds an empty `content` array and `_meta` server information to a task handle. The handle does not need them, and clients that read `resultType` first can ignore them.

## Verification and device behavior

A launch acknowledgement does not establish successful execution or completion. Program runners, bundles and shuffle record failed launches and failed artifact reads. BASIC verification requires evidence from the new run. Printer text treats mnemonic-looking text literally; its bounded screen check reports a launch and observed errors rather than guaranteeing a completed print job. Silent or unavailable audio cannot establish accurate playback.

Memory/layout checks reject graphics or charset spans over `$D000-$DFFF` I/O. The assembler rejects implicit zero-filled gaps across `$D000-$DFFF`; use separate blocks rather than a contiguous PRG across I/O. Sprite rendering sets the pointer for the selected VIC bank without clearing the display. Bare numbers that could be hexadecimal or decimal, such as `0400` (leading zero) or `beef`, are rejected as ambiguous by `c64_memory` and `c64_debug`; write `$0400` or `0x0400` for hexadecimal and `1024` for decimal. VICE resource names are validated case-insensitively and unsafe file-backed resources remain blocked. Keyboard feed failures and debug-stop timeouts are errors.

Ultimate firmware file discovery is single-directory and returns at most one match per pattern. `fs_stats` and shuffle use this same contract; they do not recursively enumerate the device filesystem. Returned matched filenames are used for launching rather than echoed wildcards. Disk mount verification failures are reported.

## Programs and labels (Hardening 4)

`c64_program` `run_prg` and `load_prg` take an optional `location`: `auto` (default, unchanged: Ultimate device path on c64u/u2, host path on VICE), `host` (on Ultimate, the file is read through the host-file boundary and uploaded; 2 to 65,538 bytes, checked before any request) or `device` (rejected on VICE). Results report `location` and, for uploaded files, `loadAddress`.

`symbolsFile` is read on every backend and accepts VICE (`al C:0810 .name`), 64tass/ACME (`name = $0810`, bare digits decimal) and KickAssembler (`.label name=$0810`) label files. When it is given, the result carries `symbolsLoaded`; 0 adds a warning naming the accepted formats. `upload_run_asm` returns its labels (`symbols`, at most 256, `symbolsTruncated` when cut) and registers them on every backend. `run_prg` without `symbolsFile` clears earlier labels on every backend; `load_prg` keeps them. `disassemble` annotates with registered labels on every backend.

Address arguments of `c64_memory` and of `c64_debug` checkpoints and `wait_for_state` accept a registered label. Order: numeric literal, then the ambiguous bare-hex rejection (a label such as `beef` cannot replace it), then loaded labels, then documented names such as `screen`. A loaded label therefore takes precedence over a documented name of the same spelling; results show the resolved address.

The HTTP transport prints a stderr warning at startup when `C64BRIDGE_HTTP_TOKEN` is not set.

## Untrusted device data and routes (Hardening 5)

The device, the emulator and their network path are treated as untrusted input.

- Route names: no tool argument can change the REST route. Configuration category and item names and device file paths reject `.` and `..` segments (also percent-encoded, in any letter case), control characters and backslashes; device paths also reject empty inner segments, and category names reject `/`. Item names may contain `/` (the firmware item `Bus Sharing - I/O1`); it is sent as `%2F` inside one segment. Rejection is a validation error before any request. The rejection is defence: measured on Ultimate 64 Elite, firmware 3.15a, 2026-11-20, the firmware does not decode `%3A` in a route name (it answers 404) and does not normalise `..`, but it does decode escapes inside a path or category segment.
- REST: a response body is limited to 16 MiB, and every request has a total deadline of 120 s in addition to the 10 s idle timeout (a call with a longer timeout keeps it as its deadline). Reachability probes are limited to 1 MiB. A memory read that returns a different number of bytes than requested, or a JSON body without data, is an error.
- Video stream: packets must have width 1 to 512, lines within 0 to 512, 4 bits per pixel, encoding 0 and the payload their header announces; other datagrams (including palette packets) are ignored. A line counts toward a complete frame only when its pixels arrived. A reusable capture session keeps at most 4096 packets. Ignored datagrams are reported in diagnostics at most once per 10 s, with the count (`ignoredPackets`).
- VICE monitor: a response frame above 4 MiB ends the monitor session.

Labels belong to one program on one backend. They are cleared after every successful program start except `load_prg` (BASIC, assembly, PRG, CRT, find-and-run, shuffle, batch runs, compile cycle, PETSCII and art rendering, greeting, SID, MOD and compiled music), after reset, reboot, power cycle, power off and VICE restart, and on a backend switch. A failed start keeps them. A label named `__proto__` is returned like any other.

`render_petscii_text` prints its text as data: quotes, NUL, `<`, `:` and `{` are spliced as `CHR$`, each line break starts a new printed line, and long lines are split so every BASIC line stays short. Text that would need more than 63999 as a line number is rejected.

## Round 6 (Hardening 6)

Each item gives the previous behaviour, the new behaviour and what the caller does differently. Details of the arguments are in the MCP schemas.

### Configuration and credentials

- **Missing configuration file.** Previously a file named by `C64BRIDGE_CONFIG` that did not exist was skipped, and the server read `./.c64bridge.json` or `~/.c64bridge.json`, which may name another machine and password. Now `loadConfig` throws an error that names the path. Fix or unset `C64BRIDGE_CONFIG`.
- **`U2_HOST` and the C64U password.** Previously the U2 profile borrowed the `c64u` section (or the legacy top-level fields) and `C64U_PASSWORD`, and sent that password as `X-Password` to the host in `U2_HOST`. Now, when `U2_HOST` is set, the borrowed password is dropped and `C64U_PASSWORD` is not used. `U2_PASSWORD` and an explicit `u2` section still apply. Without `U2_HOST`, the U2 profile is the C64U device itself and keeps its password. Set `U2_PASSWORD` or a `u2` section when the U2 needs one.
- **Redirects.** Previously the REST client followed up to five redirects, resending the `X-Password` header and body to the redirect target. Now no redirect is followed (`maxRedirects: 0`); the HTTP status is reported as the result, and the reachability probe still counts such a server as reachable.
- **VICE environment.** Previously the emulator and Xvfb inherited the full server environment. Now `C64BRIDGE_*` variables and variables named like `PASSWORD`, `TOKEN`, `SECRET` or `API_KEY` are not passed on.
- **VICE binary and startup.** A `VICE_BINARY` or `vice.exe` setting that points to a missing file is an error when a launch is needed; it no longer falls back to `x64sc` on the path. On the VICE backend the startup probe does not start the emulator unless prewarm is configured.
- **Configuration restore.** `c64_config` `restore` outside full access compares the snapshot's network categories with the device and requires destructive access when they differ.

### Programs

- **Host files for CRT and disk images.** `c64_program` `run_crt` and the disk mount operation accept `location: "host"` on Ultimate. The file is read through the host-file boundary and uploaded; the image type comes from the extension (`.d64 .g64 .d71 .g71 .d81`) unless `type` is given. A verified mount with `location: "host"` is rejected, so pass `verify: false`. The `run_crt` result text says CRT, not PRG.
- **Assembler includes.** `.include` and `.incbin` in `upload_run_asm` are resolved relative to the including file and read through the host-file boundary (same allowed roots, hidden-path and size rules). Previously they were not wired to the tools.
- **Warnings and replaced lines.** `upload_run_asm` lists assembler warnings (for example a zero-filled gap or trailing `.res` of 1024 bytes or more, lowercase letters in `.text`) in the text and in `warnings`. `upload_run_basic` names line numbers that appear more than once (`replacedLines`); the later text replaces the earlier text.
- **Verification.** Previously `upload_run_basic` read the screen straight after starting, before the RUN was processed, and `upload_run_asm` polled by default. Now both observe the program only with `verify: true`. Without it, `upload_run_basic` reports that the outcome was not observed, and `upload_run_asm` checks the load with one memory read and reports `execution` as unconfirmed. `autoFix` takes effect only with `verify: true`. Pass `verify: true` when the result matters.
- **Generated SID sequences.** `run_prg`, `load_prg`, `reset`, `reboot` and `power_cycle` stop a running `music_generate` sequence, so it no longer writes into the next program's SID registers.
- **Labels.** `run_prg` and `load_prg` results name the labels they loaded. `render_sprite` accepts an optional `dataAddress` (a multiple of 64 in the current VIC bank, not character ROM or I/O).

### Assembler dialect

The built-in assembler accepts the spellings of ACME, 64tass, ca65 and Kick Assembler where each can be sourced to that assembler's manual. The header comment of `src/tools/translation/assembler.ts` states whose semantics each spelling follows.

- **Unsupported directives.** `.scr`, `.screen`, `.petscii` and `.endr` are errors that name the spelling to use (`!scr`; `!pet` or `.text`; `.endrept` or `.endrep`). `.dw` is an error because Kick Assembler's `.dw` is a 4-byte `.dword`; use `.word` for 2 bytes. Other unsupported directives fail before operand parsing and list the supported ones. Unsupported features such as anonymous labels, `.repeat` counters, `.pc =` and ca65 `@` labels fail with a message naming the feature.
- **ACME text directives.** `!text`, `!tx`, `!txt` and `!raw` now emit characters unchanged (previously they folded letters). `!pet` swaps case as ACME does (`A-Z` to `$C1-$DA`, `a-z` to `$41-$5A`). `!scr` maps `a-z` to screen codes 1-26 and leaves `A-Z` unchanged. `!binary` takes SIZE then SKIP. `{name}` codes are not read in ACME strings.
- **`.text` and `.ascii`.** These keep this assembler's rule (letters fold to `$41-$5A`, `\n` is RETURN, `{name}` accepted). Because 64tass and Kick Assembler differ, lowercase letters in `.text` add a warning.
- **Labels.** A name without a colon in column 0 that nothing references is reported as an unknown instruction, so a mistyped mnemonic such as `rts2` is no longer silently taken as a label.
- **Disassembler operands.** `disassemble` keeps assemblable operands (`$D000`); a matching label is in the `operandLabel` field and in a `; LABEL` comment.

### BASIC and PETSCII

- **Control codes.** Names in `{name}`, `{$xx}` and `{nn}` come from one table in `src/petscii.ts` (checked against mist64/c64ref `control_codes_c64.txt`), also used by `c64_input` tokens, so names such as `{GRY2}` and `{HEART}` work in both. An unknown `{name}` in a BASIC string is an error that names the line; `{$00}` is refused. Names for codes 7 and 10 are still accepted as input, but listings write `{$07}` and `{$0A}`.
- **Listing round trip.** Listing a program and tokenising it again reproduces the same bytes after `REM`, in `DATA`, in code and at line ends. Bytes the tokeniser would not read back unchanged are written as `{name}` or `{$xx}`; a space at either end of a line is `{$20}`.
- **Characters.** The pound sign is `$5C`, pi is `$DE` in text and token `$FF` in code, and other non-ASCII characters are an error with line and character. Previously they became Latin-1 bytes.
- **`read_screen`.** Graphics screen codes are shown as U+2592 (a placeholder); letters, digits and punctuation are unchanged. A screen full of block graphics therefore no longer reads as blank. Use `c64_memory` `read` on screen RAM when the exact codes are needed.

### Memory

- **I/O area on Ultimate.** Reading `$D000-$DFFF` on Ultimate hardware reaches the I/O chips; reading `$DC0D` or `$DD0D` can clear pending interrupts of the running program (inferred, not confirmed on hardware). `search_memory` now skips that range and reports `skippedIo`. `compare_memory`, the `copy_memory` source and `save_memory` refuse a range that overlaps it. Pass `includeIo: true` to read it anyway. VICE reads have no side effects and are unchanged.
- **Addresses.** `c64_memory` and `c64_debug` use one address parser with KERNAL names, offsets and suggestions for misspelt names. Default lengths stop at `$FFFF`.

### Sound

- **Verification is opt-in.** Previously `play_preset` verified by default and `c64_sound` `pipeline` recorded silence before and after playback. Now `play_preset` has `verify: false`, and `pipeline` has `verifySilenceBefore` and `verifySilenceAfter` false. The analysis capture of `pipeline` stays on. Without a capture backend, `pipeline` plays, skips the checks and returns `playing: true` with a warning instead of failing. Pass `verify: true` for a measurement.
- **PAL or NTSC.** Previously `sid_note_on` and `music_generate` assumed PAL. Without `system`, they read the KERNAL flag at `$02A6` (1 = PAL, 0 = NTSC; Mapping the Commodore 64), state the source in the result, and fall back to PAL with a notice if the read fails. `music_generate` also accepts `system`.
- **Volume and filter.** `set_volume` accepts `filterMode` (0 to 15, `$D418` bits 4 to 7). Without it, the filter bits are cleared. Note off clears only the gate bit.
- **Analysis.** `analyze_audio` always records, and its `request` text is optional.
- **Another sound operation.** `sid_note_on`, `sid_note_off`, `sidplay_file`, `modplay_file` and a non-dry `music_compile_and_play` stop a running `music_generate` sequence.

### MCP layer

- **Skills as resources.** Every packaged skill is listed and readable as `c64://skills/<name>`, and is also served through the Skills extension (see Skills). Prompts and served knowledge name that URI instead of `.github/skills/<name>/SKILL.md`, which a client outside the repository cannot read. Read the resource.
- **Initialize instructions.** The `initialize` response carries short instructions: `op` on grouped calls, platform status, backend selection, skills, the game-development index, RAG, address syntax, host paths and `location: "host"`, labels and progress.
- **Prompts and annotations.** `prompts/get` carries tool names and resource references in `_meta` instead of full tool descriptors. `destructiveHint` is true for every tool that has a write or destructive operation. Invalid prompt arguments are reported as InvalidParams.

### Debugging and VICE

- **`set_registers`.** Previously a value wider than the register was masked silently (`A=300` wrote 44). Now it is refused with the allowed range. A value may also be a string in the address syntax (`"$C000"`, a loaded label, `label+n`), so the program counter can be set to a label.
- **Debug results.** `step` and `step_return` return the PC and registers they stopped at. `get_registers`, `get_monitor_state` and `wait_for_state` report the CPU as `stopped` or `running`; a stopped CPU also lists the enabled execute checkpoints whose range contains the PC. Every register has a hex value, and 8-bit status registers list their flags.
- **`wait_for_state`.** Previously `expectedPC` with a CPU stopped at another address polled until the timeout (up to 60 s). Now the call returns at once with `matched: false`, `timedOut: false`, `stoppedElsewhere: true` and the reason.
- **`load_prg` on VICE.** A load at `$0801` moves BASIC's end pointers behind the program, so `list_basic` sees it; the result reports `reset`, `loadAddress`, `endAddress` and `basicPointersSet`. A PRG that does not load at `$0801` is started with `SYS <load address>` instead of `RUN`. A PRG that runs past `$FFFF` is refused before the reset.
- **Restarted emulator.** When VICE had exited and the next call started a new one, that call returned the state of a freshly reset machine without notice. Now the first operation after such a restart fails once with a session-lost error. Repeat the call.
- **Frames.** VICE frames are cropped to the inner area VICE reports instead of by pixel content; `includeBorder` returns the whole canvas. Only an empty frame is retried; other errors are reported at once.
- **`waitForReady`.** `reset`, `reboot` and `power_cycle` no longer wait a fixed 3 s when the screen equals the old one. A backend result with `promptOk: true` counts as the observed prompt, and the wait ends when a read differs from the old screen.

### Streams, printer and greeting

- **Audio capture.** Previously a capture whose datagrams never arrived could block for minutes (171 s for 65536 pairs) while holding the stream lock. Now the wait is three times the capture duration plus 1.5 s, and the capture fails after 1.5 s with "No audio datagram arrived" when none came from the device.
- **Video capture.** Frames are assembled as packets arrive, so capturing many frames at the firmware rate no longer drops datagrams and times out.
- **Printer bitmaps.** Previously a row of more than 255 columns stopped the generated BASIC program with `?STRING TOO LONG ERROR` while the tool reported success. Rows are now sent in strings of at most 255 bytes. Rows up to 255 columns send the same bytes as before. The Epson builder prints each row once per line by default, matching the reported `timesPerLine` of 1.
- **Greeting.** The direct-write greeting maps all upper-case-set characters (previously `(`, `#`, `+`, `=`, `@` and others became spaces) and wraps at spaces over up to 21 rows. Characters without a glyph are listed in `details.warnings`.

### Validation, MCP and knowledge

- **Validation errors.** A pattern mismatch names the field's description, the expected pattern, an example and the received value. An unexpected property names the closest valid property and lists the allowed ones. This check runs before the required-property check, so a misspelt required name is reported as misspelt.
- **Progress.** When `tools/call` carries `_meta.progressToken`, the server sends `notifications/progress` every 10 s and handlers can report step progress, so SDK clients with a 60 s request timeout no longer cancel long waits. `c64_batch` reports one step per command.
- **Resources.** `resources/templates/list` returns an empty list instead of an error. A `#fragment` in a resource link, as returned by `c64_rag`, is ignored when reading.
- **Result text.** The text of a result carries the result data as compact JSON after the message. Above 16 KiB, long strings that the text already holds are replaced by a note in `structuredContent`. Error results redact secrets per value, not per substring, so a short password no longer corrupts other hex data.
- **VICE snapshots and version.** `c64_vice` has the operations `snapshot_save` and `snapshot_restore` (the path is confined to the allowed host roots) and `version`.
- **VICE memory banks.** `c64_memory` `read` takes an optional `bank` on VICE. The name is matched case-insensitively against the banks VICE reports; an unknown name lists the valid ones. Ultimate rejects `bank` with a validation error.
- **Keyboard cancellation.** `c64_input` `write_text` and `key` pass the request's abort signal on, so cancelling the call stops waiting for the keyboard queue to drain.
- **HTTP transport.** In stateless `--http` mode, requests other than POST get 405 with `Allow: POST` (previously `GET /mcp` stayed open as an event stream). The HTTP transport code is loaded only with `--http`.
- **Shutdown.** When the client closes its end of stdout, the server runs its normal shutdown and exits with code 0 (previously an unhandled EPIPE exited with code 1 and skipped cleanup of tasks, capture streams and VICE sessions).
- **Prompt arguments.** `prompts/get` with an unsupported argument value answers InvalidParams (-32602) with the validation message, not an internal error (-32603).

- **`c64_rag`.** All scopes search every index and rank with BM25. Result text keeps line breaks. A query of only spaces is a validation error. Developer documents (`AGENTS.md`, `doc/hardening-behavior.md` and others) are not indexed.
- **`c64_sound` SIDWAVE.** A song that reaches 20000 notes in one voice is rejected before arranging. An unquoted `~` in a groove is a tie. Numeric strings in pattern length, transpositions and reverb delay are stored as numbers.

## Limits and knowledge

Raw graphics/audio output is capped at 2 MiB, PNG captures at four images, including aggregate batch output. Artifact snapshots accept at most 256 memory ranges and 2 MiB of aggregate raw memory before reading the device. SIDWAVE input is limited to 4096 bars. Regex waits on runtimes without interruptible evaluation enforce a conservative repetition budget. Knowledge queries (`c64_rag` operations `basic`, `asm`, `docs`) are limited to 500 characters and lexical ranking to 32 distinct terms.

Unknown resource URIs return MCP resource-not-found: JSON-RPC `-32602` with `data: { uri }` (the SDK maps the earlier `-32002` to this code on every protocol era). The knowledge index refers to public grouped operations. Developer maintenance prompts are excluded from distributed packages and RAG indexes. Node launchers preserve the caller's working directory and configuration resolution, handle installation paths containing URL metacharacters, and forward termination signals.

## Validation limits

Mock and headless VICE tests do not establish Ultimate firmware behavior. Remaining device checks are recorded in [the hardening review](reviews/hardening/03-fable/review.md#needs-hardware-confirmation): I/O visibility, timing of network configuration changes, wildcard responses, ROM-bank reads and joystick timing. No real hardware is required by the automated suites.
