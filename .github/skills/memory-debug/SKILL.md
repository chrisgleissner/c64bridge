---
name: memory-debug
description: Inspect, patch, and validate C64 memory safely.
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
3. For polling, use `c64_memory` with `op: "wait_for_text"`.
4. For writes, use `c64_memory` with `op: "write"` only after confirming the target range and side effects.

## Validation

1. Re-read the same memory range after every write.
2. Summarize the before and after state when patching memory.

## Safety

- Warn before writes in I/O or ROM-adjacent regions.
- Use pause and resume workflows when live execution makes writes risky.
