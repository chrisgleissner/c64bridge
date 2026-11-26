---
name: system-control
description: Use when the user wants to pause, resume, reset, reboot or power off the machine, manage background tasks, or read or change Ultimate configuration.
---

## Intent

Use this skill for pause/resume, reset, reboot, power, menu actions, background tasks, and configuration workflows.

## Inputs

- Desired machine action or configuration change.
- Any task name, configuration category, or configuration item involved.
- Whether state persistence or flash save is required.

## Execution

1. Use `c64_system` with `op: "pause"`, `op: "resume"`, `op: "reset"`, `op: "reboot"`, `op: "poweroff"`, `op: "power_cycle"`, or `op: "menu"` as needed. `power_cycle` verifies C64U/U64 Tool Menu screens between injected keys; it uses REST reboot on U2-family cartridges and a fresh VICE start on VICE.
   `reset`, `reboot` and `power_cycle` accept `waitForReady: true` (with `readyTimeoutMs`, default 15000) to wait for the BASIC READY. prompt; a timeout is reported as `ready=false`, not as an error. `pause` and `resume` also work on VICE: `pause` holds the binary monitor connection open, which stops the CPU, until `resume`. `reset`, `reboot`, `power_cycle` and `poweroff` end the pause.
2. Use `c64_system` task operations for background task lifecycle management. Stop running tasks before `op: "delete_task"`; deletion removes a finished task and its artifacts. Default state lives under `C64BRIDGE_STATE_DIR` (otherwise `~/.c64bridge`); concurrent server sessions own their tasks separately.
   To run one long operation in the background (any client), use `op: "start_task"` with `operation` set to an allowlisted `tool.op` key and its `arguments`, then `op: "task_result"` with `name` and `waitMs` (0-60000) to collect the result. Keys: `c64_memory.wait_until`, `c64_memory.wait_for_text`, `c64_debug.wait_for_state`, `c64_sound.capture_samples`, `c64_sound.pipeline`, `c64_graphics.capture_frame`, `c64_program.batch_run`, `c64_program.bundle_run`. Example for `c64_system`: `{"op":"start_task","name":"wait-ready","operation":"c64_memory.wait_until","arguments":{"condition":{"type":"screen_text","text":"READY."},"timeoutMs":60000}}`, then `c64_system` `{"op":"task_result","name":"wait-ready","waitMs":30000}`. `stop_task` cancels it. A capture or batch task blocks conflicting writes, resets and capture calls on that backend until it ends. Tasks are not kept across a server restart.
3. Use `c64_config` REST operations for all C64U/U64/U2 configuration reads, writes, snapshots, diffs, and status checks. `load_flash`, `save_flash` and `reset_defaults` take an optional `category` to limit the operation to one configuration category. Do not navigate configuration menus through injected keyboard input.
4. Use `c64_input` `key` only for single PETSCII/KERNAL-queue keys and `keyboard` only for physical C64 key chords on Ultimate REST input. Firmware-menu navigation is an exception only when REST has no equivalent, such as the machine code monitor, visual SID editor, or Tool Menu.

## Validation

1. Confirm the resulting machine or configuration state in the summary.
2. When configuration changes are involved, report the category and item that changed.

## Safety

- Require explicit confirmation before reset, reboot, poweroff, flash save, or destructive config resets.
- Never leave the system paused without telling the user.
