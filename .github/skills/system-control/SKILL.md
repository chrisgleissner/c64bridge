---
name: system-control
description: Control machine lifecycle, background tasks, and configuration state.
---

## Intent

Use this skill for pause/resume, reset, reboot, power, menu actions, background tasks, and configuration workflows.

## Inputs

- Desired machine action or configuration change.
- Any task name, configuration category, or configuration item involved.
- Whether state persistence or flash save is required.

## Execution

1. Use `c64_system` with `op: "pause"`, `op: "resume"`, `op: "reset"`, `op: "reboot"`, `op: "poweroff"`, `op: "power_cycle"`, or `op: "menu"` as needed. `power_cycle` verifies C64U/U64 Tool Menu screens between injected keys; it uses REST reboot on U2-family cartridges and a fresh VICE start on VICE.
2. Use `c64_system` task operations for background task lifecycle management.
3. Use `c64_config` REST operations for all C64U/U64/U2 configuration reads, writes, snapshots, diffs, and status checks. Do not navigate configuration menus through injected keyboard input.
4. Use `c64_input` `key` only for single PETSCII/KERNAL-queue keys and `keyboard` only for physical C64 key chords on Ultimate REST input. Firmware-menu navigation is an exception only when REST has no equivalent, such as the machine code monitor, visual SID editor, or Tool Menu.

## Validation

1. Confirm the resulting machine or configuration state in the summary.
2. When configuration changes are involved, report the category and item that changed.

## Safety

- Require explicit confirmation before reset, reboot, poweroff, flash save, or destructive config resets.
- Never leave the system paused without telling the user.
