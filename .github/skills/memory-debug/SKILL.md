---
name: memory-debug
description: Use when the user wants to read, search, compare, patch, disassemble or save C64 memory, read the screen, or wait for on-screen text.
---

## Intent

Use this skill for RAM inspection, screen reads, polling for output, and carefully scoped memory writes.

## Inputs

- Address range or text pattern to inspect.
- Whether the operation is read-only or mutating.
- Any expectation about program state before or after the change.

## Execution

1. For direct memory inspection, use `c64_memory` with `op: "read"`.
   Pass `format: "dump"` for a 16-bytes-per-line listing with addresses and a PETSCII column; the default `"hex"` returns one hex string.
2. For screen output, use `c64_memory` with `op: "read_screen"`. To see the BASIC program in memory as text, use `op: "list_basic"`.
3. To wait for on-screen text, use `c64_memory` with `op: "wait_for_text"`. To wait for a memory value, a screen change or a VICE checkpoint, use `op: "wait_until"` instead of reading in a loop. `timeoutMs` is required; a timeout is a normal result with `met: false`.
   Example: `{"op":"wait_until","condition":{"type":"masked","address":"$D012","mask":128,"value":128},"timeoutMs":10000}`. Condition types: `equals`, `not_equals`, `masked`, `range`, `threshold`, `changed`, `screen_text`, `screen_changed`, `checkpoint` (VICE only). A call that runs longer than the inline window can continue as a background task; see `system-control`.
4. For writes, use `c64_memory` with `op: "write"` only after confirming the target range and side effects.
5. When a program crashed, hangs or shows a black screen on VICE, use `c64_debug` with `op: "diagnose"` before reading memory by hand. Pass `codeRange: {"start": ..., "end": ...}` (addresses or loaded labels) to detect a PC in data, and `frameCounter` for a 16-bit counter the program increments.
   Verdicts: `jam` (JAM opcode, halted until reset), `pc_outside_code` (every sample outside `codeRange`; the note names the caller), `stack_low` (SP below `$10`), `stuck_pc` (the PC was the same in every sample; the note shows the instruction. VICE takes samples at frame boundaries, so an intentional wait loop can look the same: pass `frameCounter`, and a counter that changes gives `running`), `running` (none of these). The operation leaves a running CPU running and a paused CPU paused; a paused CPU gets one sample and cannot report `stuck_pc`. `diagnose` has no hardware path yet.
6. To measure raster time, make the routine write a marker colour to `$D020` at entry and the idle colour at exit, then use `c64_debug` with `op: "profile_border"`, `markers: [{"name": "music", "color": 2}]` and `idleColor` (VICE with a running CPU, or the video stream on `c64u`). `lines` is the longest contiguous run of picture rows in the marker colour (`splitFrames` counts frames with further runs) and `approxCycles` multiplies it by 63 (PAL) or 65 (NTSC) without subtracting bad lines. `overrun: true` means the colour reached the first or last visible row, so the real duration can be longer than reported. Time spent outside the visible picture is not measured.

Artifact memory snapshots are limited to 256 ranges and 2 MiB aggregate raw data. Explicit address strings such as `0400` are hexadecimal. Host exports follow the [host path restrictions](../../../doc/hardening-behavior.md).

## Validation

1. Re-read the same memory range after every write.
2. Summarize the before and after state when patching memory.

## Safety

- Warn before writes in I/O or ROM-adjacent regions.
- Use pause and resume workflows when live execution makes writes risky.
