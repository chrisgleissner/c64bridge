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

- Route names: no tool argument can change the REST route. Configuration category and item names and device file paths reject `.` and `..` segments (also percent-encoded, in any letter case), control characters and backslashes; device paths also reject empty inner segments, and category names reject `/`. Item names may contain `/` (the firmware item `Bus Sharing - I/O1`); it is sent as `%2F` inside one segment. Rejection is a validation error before any request.
- REST: a response body is limited to 16 MiB, and every request has a total deadline of 120 s in addition to the 10 s idle timeout (a call with a longer timeout keeps it as its deadline). Reachability probes are limited to 1 MiB. A memory read that returns a different number of bytes than requested, or a JSON body without data, is an error.
- Video stream: packets must have width 1 to 512, lines within 0 to 512, 4 bits per pixel, encoding 0 and the payload their header announces; other datagrams (including palette packets) are ignored. A line counts toward a complete frame only when its pixels arrived. A reusable capture session keeps at most 4096 packets. Ignored datagrams are reported in diagnostics at most once per 10 s, with the count (`ignoredPackets`).
- VICE monitor: a response frame above 4 MiB ends the monitor session.

Labels belong to one program on one backend. They are cleared after every successful program start except `load_prg` (BASIC, assembly, PRG, CRT, find-and-run, shuffle, batch runs, compile cycle, PETSCII and art rendering, greeting, SID, MOD and compiled music), after reset, reboot, power cycle, power off and VICE restart, and on a backend switch. A failed start keeps them. A label named `__proto__` is returned like any other.

`render_petscii_text` prints its text as data: quotes, NUL, `<`, `:` and `{` are spliced as `CHR$`, each line break starts a new printed line, and long lines are split so every BASIC line stays short. Text that would need more than 63999 as a line number is rejected.

## Limits and knowledge

Raw graphics/audio output is capped at 2 MiB, PNG captures at four images, including aggregate batch output. Artifact snapshots accept at most 256 memory ranges and 2 MiB of aggregate raw memory before reading the device. SIDWAVE input is limited to 4096 bars. Regex waits on runtimes without interruptible evaluation enforce a conservative repetition budget. Knowledge queries (`c64_rag` operations `basic`, `asm`, `docs`) are limited to 500 characters and lexical ranking to 32 distinct terms.

Unknown resource URIs return MCP resource-not-found (`-32002`). The knowledge index refers to public grouped operations. Developer maintenance prompts are excluded from distributed packages and RAG indexes. Node launchers preserve the caller's working directory and configuration resolution, handle installation paths containing URL metacharacters, and forward termination signals.

## Validation limits

Mock and headless VICE tests do not establish Ultimate firmware behavior. Remaining device checks are recorded in [the hardening review](reviews/hardening/03-fable/review.md#needs-hardware-confirmation): I/O visibility, timing of network configuration changes, wildcard responses, ROM-bank reads and joystick timing. No real hardware is required by the automated suites.
