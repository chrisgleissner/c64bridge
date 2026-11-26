# Manual client checklist (unverified)

None of these checks has been run. They need an interactive Claude Code session that supports MCP 2026-07-28, MCP skills and tasks, and a backend that can be reached (VICE is enough). Record the Claude Code version and the result of each item.

Setup: start Claude Code in a checkout of this branch, approve the project `c64bridge` server (from `.mcp.json`), and select the VICE backend (`use vice`). Run `/mcp` and confirm `c64bridge` is connected.

## 1. Skills appear and load

Steps:
1. Ask Claude Code to list the available skills, or open the skills list in the UI.
2. Ask it to use the `hello-world` skill.

Expected:
- Thirteen skills appear with the prefix `c64bridge:` (for example `c64bridge:hello-world`, `c64bridge:memory-debug`). `pr-converge` is not listed.
- Using one loads its instructions and the model follows them (a greeting runs on the active backend).
- Unverified: whether the UI shows the skills from `skills/list` or only the `c64://skills/<name>` resources.

## 2. Long call moves to the background

Steps:
1. Ask Claude Code to call `c64_memory` with `op: "wait_until"`, `condition: {"type":"equals","address":"$C000","bytes":"$DEAD"}` (a value that is not present) and `timeoutMs: 180000`, and to report when it finishes.
2. Watch the session for about two minutes.
3. Wait until three minutes have passed since the call started.

Expected:
- After about two minutes Claude Code reports that the call continues in the background and the session accepts new input.
- Within a few seconds after the three-minute timeout the result arrives with `met: false` and `reason: "timeout"`.
- Unverified: the two-minute figure is a Claude Code behaviour, not something the server controls. The server returns a task handle one second after the call starts (`C64BRIDGE_TASK_INLINE_MS`).

## 3. Cancellation

Steps:
1. Start the same `wait_until` call with `timeoutMs: 180000`.
2. After it has moved to the background, cancel it from Claude Code (stop the background task).
3. Ask Claude Code to call `c64_memory` with `op: "write"` (a harmless address such as `$C000`) and then `c64_system` with `op: "list_tasks"`.

Expected:
- The task shows as cancelled within a few seconds, not after 180 seconds.
- The write succeeds (no `resource_conflict`; `wait_until` holds only a shared lease).
- Unverified: `list_tasks` shows only the legacy interval and `start_task` tasks, so a native task may not be listed there. Record what it shows.

## 4. Fallback path (any client)

Steps:
1. In the same session ask for `c64_system` `op: "start_task"` with `name: "w1"`, `operation: "c64_memory.wait_until"` and the arguments from item 2, using `timeoutMs: 20000`.
2. Call `c64_system` `op: "task_result"` with `name: "w1"` and `waitMs: 5000`, then again with `waitMs: 30000`.

Expected:
- `start_task` returns `started: true` at once.
- The first `task_result` returns `done: false` after about five seconds. The second returns `done: true` with `met: false` and `reason: "timeout"`.
