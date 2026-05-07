---
name: assembly-program
description: Execute 6502/6510 assembly workflows through c64bridge.
---

## Intent

Use this skill for custom assembly routines, register work, IRQ handlers, and hardware-timed code.

## Inputs

- Hardware focus: VIC-II, SID, CIA, or mixed.
- Memory layout constraints, zero-page usage, and interrupt ownership.
- Validation target: screen state, memory state, or register state.

## Execution

1. Clarify which hardware blocks and memory ranges the routine may touch.
2. Consult `c64://assembly/6510-spec`, `c64://memory/map`, and any hardware-specific resource that applies.
3. Use `c64_rag` with `op: "asm"` when targeted timing tables or code examples are needed.
4. Generate assembly source with explicit labels and memory usage.
5. Execute with `c64_program` using `op: "upload_run_asm"`.

## Validation

1. Use `c64_memory` with `op: "read"` for installed code, vectors, or register checks.
2. Use `c64_memory` with `op: "read_screen"` when the routine produces visible output.
3. Report assembler diagnostics directly if compilation fails.

## Safety

- Confirm before invasive recovery actions such as reset or reboot.
- Pause and resume the machine around manual memory patching when the workflow requires it.

## Escalation

- Switch to `.github/skills/basic-program/SKILL.md` when the task is better served by a high-level loader or a simple BASIC program.
