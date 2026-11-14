---
name: game-development
description: Develop a Commodore 64 game with c64bridge, targeting a modern C64U/Ultimate device (default) or a stock C64.
---

## Intent

Use this skill to write, port or extend a C64 game. Knowledge lives in MCP resources; this skill only sequences the work. Read the resources by reading plan, not all at once.

## Inputs

- Target: `modern` (C64U / Ultimate 64 family, default) or `authentic` (stock PAL/NTSC C64). Ask only when the request is ambiguous; otherwise state the chosen target in the first reply.
- Genre or game idea. Ask only if missing and it changes the reading plan.
- Backend: `vice` for logic and debugging, `c64u` for turbo, UCI, REU, Upic and real timing.

## Execution

1. Read `c64://gamedev/index`. Follow its target decision and its reading plan row for the game type; read only the listed resources (architecture, techniques, toolchain, `c64://ultimate/*`, VIC, SID, CIA, memory map).
2. Choose the toolchain from `c64://gamedev/toolchain`. For small programs use the built-in assembler through `c64_program` with `op: "upload_run_asm"`; for larger projects build a PRG externally.
3. Fix the memory map and frame budget from `c64://gamedev/architecture` before writing code. Keep all addresses in one place.
4. Build a minimal playable loop first (display, one controllable sprite or character, input, frame timing), then add features one at a time.
5. Iterate on VICE: `c64_select_backend` with `op: "select"` and `backend: "vice"`. Load with `c64_program` using `op: "load_prg"` or `op: "run_prg"` (or `upload_run_asm` for small code). Read `c64://vice/binary-monitor-spec` before using `c64_debug`; set breakpoints with `op: "create_checkpoint"` and wait with `op: "wait_for_state"`.
6. Drive the game with `c64_input` (`op: "joystick"` or `op: "key"`) and verify with `c64_memory` (`op: "read"`, `op: "read_screen"`, `op: "wait_for_text"`) and `c64_graphics` with `op: "capture_frame"` and `format: "png"`.
7. Modern target only: before using turbo, the Command Interface or the REU, enable them with `c64_config` (`op: "get"`, then `op: "set"` for `Turbo Control`, `Command Interface`, `RAM Expansion Unit`; exact items and values are in `c64://ultimate/hardware`, `c64://ultimate/uci`, `c64://ultimate/reu`). Switch with `c64_select_backend` to `c64u`, run, and capture a frame. The game must detect each feature and print a clear fallback message when it is missing.
8. Authentic target: use none of the Ultimate features, count cycles at 1 MHz, and finish on VICE `x64sc` timing before any hardware run.
9. Use `c64_rag` with `op: "docs"` (curated game, Ultimate and hardware docs) or `op: "asm"` for a targeted lookup instead of reading a whole resource again.

## Validation

1. The game starts from reset on the chosen backend and a captured frame shows the expected screen.
2. Input changes game state, checked through `c64_memory` reads or a second frame capture.
3. Modern features are verified on `c64u`; VICE does not model turbo timing, UCI or REU DMA cost.
4. Report assembler or build diagnostics directly if they fail.

## Safety

- Do not change Ultimate configuration (turbo, REU, Command Interface) beyond what the game needs, and say which items were changed.
- Confirm before reset, reboot or power operations that interrupt other work on the device.
- Respect the host file path roots described in `AGENTS.md` for PRG and snapshot paths.

## Escalation

- Switch to `.github/skills/assembly-program/SKILL.md` for isolated routines that are not part of a game.
- Switch to `.github/skills/software-launch/SKILL.md` to run existing games rather than develop one.
- Switch to `.github/skills/sid-music/SKILL.md` or `.github/skills/graphics-demo/SKILL.md` for stand-alone music or graphics work.
