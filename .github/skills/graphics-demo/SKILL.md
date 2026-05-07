---
name: graphics-demo
description: Execute PETSCII, sprite, bitmap, and frame-capture graphics workflows.
---

## Intent

Use this skill when the user wants visual output on the C64, whether generated directly through graphics tools or through supporting BASIC or assembly loaders.

## Inputs

- Desired visual mode: PETSCII, text banner, sprite, bitmap, or frame capture.
- Artistic direction, palette constraints, and target backend.
- Whether the user wants a preview, a rendered asset, or a running program.

## Execution

1. For direct graphics generation, use `c64_graphics` with the relevant operation such as `render_petscii_art`, `render_petscii_text`, `render_sprite`, `render_bitmap`, or `capture_frame`.
2. When the request needs custom loader logic, delegate code generation to `.github/skills/basic-program/SKILL.md` or `.github/skills/assembly-program/SKILL.md`.
3. Reference `c64://graphics/vic/spec` and any character-set or PETSCII resources needed for the chosen mode.

## Validation

1. Use `c64_memory` with `op: "read_screen"` for text-mode validation.
2. Use `c64_graphics` with `op: "capture_frame"` for full-frame verification.
3. Summarize the resulting mode, palette choices, and any captured assets.

## Safety

- Confirm before resets or teardown steps that would disrupt the current display state.
