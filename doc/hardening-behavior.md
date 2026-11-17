# Hardening behavior guide

The MCP schemas are the authority for each operation's accepted arguments and platform support. The Hardening 3 changes tighten these contracts and report partial failures explicitly.

## Host files and configuration

Tool-supplied host paths must resolve inside the working directory, the C64 Bridge state directory, the system temporary directory, or roots added with `C64BRIDGE_ALLOWED_DIRS` (separated by the platform path delimiter). Symlinks are resolved before confinement checks. Hidden path components are rejected by default; `C64BRIDGE_ALLOW_HIDDEN_PATHS=1` permits them. Configuration files and the task registry remain protected even with that opt-out. `C64BRIDGE_ALLOWED_DIRS=*` disables root confinement, but does not disable these protected-file checks.

Bitmap input is read through the same host-file boundary, accepts files rather than URLs, and is limited to 4096 by 4096 pixels. Default host reads are limited to 16 MiB (disk images: 64 MiB). Existing files inside permitted roots may be overwritten; applications sharing a writable root must protect it from untrusted local users.

`C64BRIDGE_ACCESS=full|no-destructive|read-only` controls operations, including nested batches. Starting, stopping and deleting tasks change state. Network configuration writes that could disconnect the device require destructive access. Credentials in configuration updates are redacted in logs and diagnostics without replacing arbitrary substrings of program data or other tool results.

## State, tasks and cancellation

`C64BRIDGE_STATE_DIR` selects the state root (default `~/.c64bridge`). Default batch, shuffle and compile-cycle artifacts use unique directories under `runs/`. Startup retains at most 200 generated run directories, removing those older than 30 days; explicit output directories are not pruned.

Task status changes are persisted immediately; repeated iteration snapshots and logs are coalesced to at most once a second. The registry retains at most 200 finished tasks. `c64_system` with `op: "delete_task"` removes a finished task and its artifacts; stop a running task first. Task records and folders identify the owning process/session so separate server processes do not interrupt or overwrite each other's live work.

Wait and workload limits appear in the schemas. MCP cancellation stops further work at supported boundaries and returns a cancellation result. An operation already sent to the device may have taken effect; cancellation does not undo a launched program or completed writes. Temporary capture cleanup restores the user's previous stream, including when requests overlap or are cancelled. Captures serialize with stream changes.

## Verification and device behavior

A launch acknowledgement does not establish successful execution or completion. Program runners, bundles and shuffle record failed launches and failed artifact reads. BASIC verification requires evidence from the new run. Printer text treats mnemonic-looking text literally; its bounded screen check reports a launch and observed errors rather than guaranteeing a completed print job. Silent or unavailable audio cannot establish accurate playback.

Memory/layout checks reject graphics or charset spans over `$D000-$DFFF` I/O. Assembler gaps remain unwritten instead of zero-filling across registers. Sprite rendering sets the pointer for the selected VIC bank without clearing the display. Ambiguous four-digit hexadecimal address strings such as `0400` mean `$0400`; use explicit numeric values when decimal intent matters. VICE resource names are validated case-insensitively and unsafe file-backed resources remain blocked. Keyboard feed failures and debug-stop timeouts are errors.

Ultimate firmware file discovery is single-directory and returns at most one match per pattern. `fs_stats` and shuffle use this same contract; they do not recursively enumerate the device filesystem. Returned matched filenames are used for launching rather than echoed wildcards. Disk mount verification failures are reported.

## Limits and knowledge

Raw graphics/audio output is capped at 2 MiB, PNG captures at four images, including aggregate batch output. Artifact snapshots accept at most 256 memory ranges and 2 MiB of aggregate raw memory before reading the device. SIDWAVE input is limited to 4096 bars. Regex waits on runtimes without interruptible evaluation enforce a conservative repetition budget. Knowledge queries (`c64_rag` operations `basic`, `asm`, `docs`) are limited to 500 characters and lexical ranking to 32 distinct terms.

Unknown resource URIs return MCP resource-not-found (`-32002`). The knowledge index refers to public grouped operations. Developer maintenance prompts are excluded from distributed packages and RAG indexes. Node launchers preserve the caller's working directory and configuration resolution, handle installation paths containing URL metacharacters, and forward termination signals.

## Validation limits

Mock and headless VICE tests do not establish Ultimate firmware behavior. Remaining device checks are recorded in [the hardening review](reviews/hardening/03-fable/review.md#needs-hardware-confirmation): I/O visibility, timing of network configuration changes, wildcard responses, ROM-bank reads and joystick timing. No real hardware is required by the automated suites.
