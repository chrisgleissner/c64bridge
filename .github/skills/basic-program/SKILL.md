---
name: basic-program
description: Execute bespoke Commodore BASIC v2 programs through c64bridge.
---

## Intent

Use this skill when the user needs a custom BASIC program rather than a one-call demo.

## Inputs

- Desired behavior, inputs, and expected output.
- Target backend or backend preference.
- Whether current machine state must be preserved.

## Execution

1. If the request is only a hello-world, greeting, or smoke test, delegate to `.github/skills/hello-world/SKILL.md` instead of generating bespoke BASIC.
2. Clarify missing requirements before generating code when the request is not already specific enough to execute.
3. Consult `c64://basic/spec` and `c64://guide/bootstrap` only when syntax or workflow constraints matter.
4. Generate uppercase, line-numbered BASIC.
5. For VICE-backed local runs, assume the user should see a real visible emulator window unless CI or the lack of a framebuffer/display session forces headless operation.
6. When running visible VICE BASIC manually, do not immediately follow the run with `read_screen` or `wait_for_text` unless the user explicitly asks for machine verification after the visible output has rendered.
7. Use `c64_rag` with `op: "basic"` only when targeted BASIC examples are needed.

## Validation

1. For normal non-visual runs, call `c64_memory` with `op: "read_screen"` after execution.
2. For visible VICE runs, prefer user-visible confirmation first and only do monitor-based reads after the screen has clearly rendered or when the user asks for explicit verification.
3. Use `c64_memory` with `op: "read"` around the BASIC program area only when tokenization or memory placement needs verification.
4. Summarize expected versus observed output.

## Safety

- Confirm before reset, reboot, or other disruptive recovery actions.
- Preserve existing machine state when the user requests it.

## Escalation

- Switch to `.github/skills/assembly-program/SKILL.md` when performance, raster timing, or direct register control becomes the primary need.
