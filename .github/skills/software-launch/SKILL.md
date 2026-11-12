---
name: software-launch
description: Load and run existing C64 software through c64bridge.
---

## Intent

Use this skill for existing PRG, CRT, or disk-image based software rather than newly authored programs.

## Inputs

- Media type: PRG, CRT, or disk image.
- File path or image path.
- Target backend and any drive-slot requirement.

## Execution

1. Confirm connectivity before launch when the environment looks uncertain.
2. For loose files, use `c64_program` with `op: "run_prg"` or `op: "run_crt"`. `load_prg` loads a PRG without running it on C64U, U2 and VICE (on VICE the path is a host-local file); `run_crt` is not available on VICE.
3. For disk images, use `.github/skills/drive-manager/SKILL.md` to mount the image first, then launch the correct program.
4. Use `c64_disk` with `op: "find_and_run"` when the user needs discovery inside an image.

## Validation

1. Use `c64_memory` with `op: "read_screen"` after launch when visible output is expected.
2. Summarize the loaded media, backend, and observed first-run state.

## Safety

- Confirm target drive slot before mutating disk state.
- Warn before power or reset actions that would interrupt the launch flow.
