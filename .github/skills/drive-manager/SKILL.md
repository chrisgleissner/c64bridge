---
name: drive-manager
description: Manage disk images and drive state through c64bridge.
---

## Intent

Use this skill for disk image mounts, blank media creation, drive resets, power changes, and mode changes.

## Inputs

- Desired action: inspect, mount, create, unmount, reset, power cycle, or mode change.
- Target drive slot.
- Any image path, format, or verification requirement.

## Execution

1. Call `c64_disk` with `op: "list_drives"` before any mutation.
2. For image mounts or unmounts, use `c64_disk` with `op: "mount"` or `op: "unmount"`.
3. For new media, use `c64_disk` with `op: "create_image"` and then verify the result.
4. For drive hardware state, use `c64_drive` with `op: "reset"`, `op: "power_on"`, `op: "power_off"`, or `op: "set_mode"`.
5. To locate files by name on the device, use `c64_disk` with `op: "find_paths"` (`nameContains`, optional `root`, `extensions`, `maxResults`); a `truncated: true` result means more matches exist and the search should be narrowed.
6. Use `c64_disk` with `op: "file_info"` or `op: "find_and_run"` when inspection or launch is part of the task.

## Validation

1. Re-run `c64_disk` with `op: "list_drives"` after each mutation.
2. Confirm the final drive slot, mounted image, and mode in the summary.

## Safety

- Warn before power changes, resets, or other actions that may interrupt running software.
- Confirm destructive or stateful actions before executing them.
