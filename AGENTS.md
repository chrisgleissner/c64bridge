# Agent Integration Guide

LLM-facing reference for using this MCP server. Keep it simple: start the server, discover tools safely, and route execution through `.github/skills`.

## Quick Start

1) Install and run

```bash
npm install
npm start
```

On startup the server probes connectivity (REST + zero-page read) and announces it is running on stdio.

2) Configure target (optional)

The server resolves config in this order: `C64BRIDGE_CONFIG` → `./.c64bridge.json` → `~/.c64bridge.json` → defaults (`host=c64u`, `port=80`). A `C64BRIDGE_CONFIG` file that does not exist is an error, not a fallback.

Example C64U/U64 configuration:

```json
{ "c64u": { "host": "c64u", "port": 80, "networkPassword": "secret" } }
```

U2, U2+, and U2+L use the `u2` profile, which is a firmware-defined subset of the C64U/U64 API:

```json
{ "u2": { "host": "u2", "port": 80, "networkPassword": "secret" } }
```

Use `C64_MODE=u2` to select that profile. U2-family cartridges support the shared REST operations, including configuration and `machine:menu_screen`, but not `machine:input`, debug-register access, power-off, or streaming.

When Ultimate firmware network protection is enabled, `networkPassword` is sent as the `X-Password` header on every REST request.

### Host File Access

Tool arguments that become host file paths (memory dumps, config snapshots, sprite/charset exports, run artifacts, `symbolsFile`, VICE PRG and disk image paths) must lie inside the working directory (not when it is `~` or `/`), `~/.c64bridge`, or the system temp directory. Other locations are rejected with an error that lists the allowed roots; use a path inside one of them rather than retrying elsewhere. The operator can add roots with `C64BRIDGE_ALLOWED_DIRS` (entries separated by the path delimiter; `*` disables the check).

### Environment Variables

| Variable | Effect |
| --- | --- |
| `C64BRIDGE_ALLOWED_DIRS` | Extra directories for host file paths in tool arguments, separated by the path delimiter; `*` disables the check. |
| `C64BRIDGE_ACCESS` | `full` (default), `no-destructive` or `read-only`. Limits which operations may be called; read on every call. |
| `C64BRIDGE_HTTP_TOKEN` | Bearer token required (`Authorization: Bearer <token>`) by the optional HTTP transport (`--http`), which also accepts only loopback Host and Origin headers. Without a token, any local process that can reach 127.0.0.1 on the port can call every tool. |
| `C64BRIDGE_DIAGNOSTICS_KEEP` | Number of diagnostics files kept at startup (default 200; files older than 30 days are always removed). |
| `C64BRIDGE_VERBOSE_SCHEMA` | Set to `1` to include the full per-operation schemas in `tools/list` (omitted by default to keep it small). |
| `C64BRIDGE_TASK_INLINE_MS` | Milliseconds a task-capable call waits for its result before moving to the background (0-600000, default 1000). |
| `C64BRIDGE_TASK_TTL_MS` | Milliseconds a finished task and its result are kept (0-86400000, default 600000). |
| `C64BRIDGE_SKILLS_PAGE_SIZE` | Skills per `skills/list` page (default 100). |

### Runtime Backend Switching

When any combination of `c64u`, `u2`, and `vice` is configured, the server can keep the configured backends live at the same time.
Use `c64_select_backend` to switch the active backend without restarting the MCP server.
The `c64://platform/status` resource always reports the currently active backend and the configured backend set.
Before using physical `machine:input`, `machine:menu_screen`, or C64U/U64 `power_cycle`, read it for native endpoint availability. If `machine:input` is unavailable or unknown, use `key` or `write_text` for ordinary C64 input; do not attempt physical matrix injection. `machine:menu_screen` is only confirmed while an Ultimate menu is visible.
State the desired backend directly in the prompt when you want to pin execution, for example: `use vice`, `vice: load this PRG`, `use c64u`, or `run this on hardware`.
When using the VS Code `C64` agent, keep the backend request in the same prompt so tool routing can call `c64_select_backend` before backend-specific operations.

### Fast Discovery Rules

When the prompt is already specific and backend-pinned, execute the matching skill immediately instead of re-reading general documentation.
Example: `vice: write a small BASIC program that clears the screen and prints HELLO VICE` should route straight to `.github/skills/hello-world/SKILL.md` and use that skill's minimal path.
If the current agent cannot directly see `c64bridge` MCP tools such as `c64_program`, immediately hand the request to the `C64` agent instead of inspecting repository files or MCP manifests first.
For a visible single-backend VICE greeting, prefer a no-probe fast path and avoid screenshot capture or Binary Monitor verification unless the user explicitly requests confirmation artifacts.
Once the MCP server is connected and tools are available in-session, do not spend extra turns inspecting README sections or tool manifests for routine `c64_select_backend`, `c64_program`, or `c64_memory` operations.

3) VS Code (GitHub Copilot Chat, MCP)

Add to `.vscode/mcp.json` (top-level key `servers`, `type` is required):

```json
{
  "servers": {
    "c64bridge": { "type": "stdio", "command": "npx", "args": ["-y", "c64bridge@latest"] }
  }
}
```

Start the server from the entry shown above it; tools are discovered automatically in the chat session.

4) Shared agent instructions

`AGENTS.md` is the canonical cross-tool contract for this repository.
`CLAUDE.md` imports it for Claude Code, and Copilot/Codex-style agents can read it directly.

5) Skill architecture

Execution logic lives only in `.github/skills/*/SKILL.md`.
Prompt files under `.github/prompts/` and MCP prompts from `src/prompts/registry.ts` are routing-only.
If a workflow description starts listing tool calls outside `.github/skills`, treat that as stale and move it into the matching skill.

## MCP Discovery & Calling

- Discover tools with the client’s ListTools.
- Discover resources and prompts with ListResources and ListPrompts.
- Use the matching skill in `.github/skills/` to decide the actual tool sequence, validation, and safety behavior.
- After discovery has already happened for the active session, prefer execution over repeated rediscovery for unambiguous requests.
- When the request targets the `vice` backend, read `c64://vice/binary-monitor-spec` before executing so Binary Monitor framing, single-client limits, and trap/resume side effects are in scope.
- Treat `c64_program`, `c64_memory`, `c64_graphics`, `c64_sound`, `c64_system`, `c64_config`, `c64_rag`, `c64_extract`, and similar grouped MCP tools as discriminated unions: every direct call must include `op`.
- Never call a grouped tool with `{}` or with only secondary arguments. Choose the sub-operation first, then send `{ op: "...", ... }`.
- When a skill tells you to execute a grouped tool, copy the exact `op` string from the skill instead of inferring it from the tool name.

## Capabilities

- Program runners: `c64_program` (`upload_run_basic`, `upload_run_asm`, `load_prg`, `run_prg`, `run_crt`, `bundle_run`, `batch_run`). `upload_run_basic` observes the run, and repairs a missing closing quote or parenthesis and reruns once, only with `verify: true`; pass `autoFix: false` for programs with side effects. `run_crt`, `run_prg`, `load_prg` and disk mount take `location: "host"` to upload a host file to an Ultimate. `upload_run_asm` reads `.include`/`.incbin` host files and reports assembler `warnings`.
- Fast demo workflow: `c64_program` (`cross_platform_greeting`) for one-call greetings on VICE and/or C64U with screenshot capture and verification
- Screen & memory: `c64_memory` (`read`, `write`, `read_screen` (graphics characters appear as U+2592), `wait_for_text`, `wait_until` (waits until a typed condition on memory, the screen or a VICE checkpoint holds; `timeoutMs` is required; the cap and a read failure end the wait with a result, see the tool description), `list_basic`, `disassemble`, `copy_memory`, `fill_memory`, `search_memory`, `compare_memory`, `save_memory`; on Ultimate these skip or refuse `$D000-$DFFF` unless `includeIo: true`). `read` accepts `bank` (VICE only) and `format: "hex"` (default) or `"dump"` (addresses plus a PETSCII column); `list_basic` lists the BASIC program in memory as text.
- System control: `c64_system` (`pause`, `resume`, `reset`, `reboot`, `poweroff`, `power_cycle`, `menu`, tasks: `start_task`, `task_result`, `stop_task`, `list_tasks`, `delete_task`). `reset`, `reboot` and `power_cycle` accept `waitForReady` and `readyTimeoutMs` to wait for the BASIC READY. prompt. `pause` and `resume` also work on VICE: `pause` holds the binary monitor connection open, which stops the CPU, until `resume`. `reset`, `reboot`, `power_cycle` and `poweroff` end the pause.
- Input: `c64_input` (`write_text`, `key`, `keyboard`, `joystick`, `release_all`, `state`)
- Configuration: `c64_config` (get/set, `batch_update`, `snapshot`, `restore`, `diff`, `shuffle`, `load_flash`, `save_flash`, `reset_defaults`). The flash operations take an optional `category`.
- Drives & files: `c64_disk` (including `find_paths`, which returns `results` and `truncated`; limit with `maxResults`), `c64_drive`
- SID / music: `c64_sound` (`play_preset`, playback, generate, analyze, `capture_samples`). `play_preset` and `pipeline` do not verify unless `verify: true`; without `system`, note frequencies follow the machine's PAL/NTSC flag at `$02A6`; `set_volume` takes `filterMode`
- SIDWave offline (`c64_sound`, no playback): `formats`, `inspect`, `convert`, `validate`, `lint`, `format`, `compile` (PRG, PSID or game build), `compose`, `complete`, `transform`, `retarget`, `reconstruct`, `analyze_music`, `compare`, `sid_info`. Each takes `inputPath` or inline `sidwave`, writes a new file below `artifacts/sidwave/` unless `outputPath` is given, and replaces a file only with `overwrite: true`. Report losses and the `reconstruct` verdict unchanged. `forDevice: true` (`compile`, `retarget`) uses the machine's clock and, on Ultimate hardware with a socket chip at `$D400`, its SID model
- Graphics: `c64_graphics` (PETSCII, sprites, `capture_frame`). `capture_frame` omits raw pixels unless `includePixels: true`; `format: "png"` returns viewable images (at most 4 frames; raw output is capped at 2 MiB, as for `capture_samples`).
- Debugging (VICE): `c64_debug` (checkpoints, registers, stepping, `wait_for_state`), `c64_vice` (resources, `snapshot_save`, `snapshot_restore`, `version`)
- Streaming and extraction: `c64_stream` (C64U), `c64_extract` (sprites, charset, memory dump, firmware health)
- Batching: `c64_batch` runs several tool calls in one request
- Knowledge & RAG: `c64_rag` (`basic`, `asm`, `docs`; queries at most 500 characters)
- Backend selection: `c64_select_backend`

Tools and parameters are listed dynamically via ListTools. The [hardening behavior guide](doc/hardening-behavior.md) describes host path restrictions, bounded arguments, task retention, cancellation and verification semantics.

### Configuration and menu navigation

Change C64U/U64/U2 configuration through `c64_config` REST operations; do not navigate configuration menus with injected keyboard input.
`c64_input` `key` is PETSCII/KERNAL-queue input, while `keyboard` sends physical key combinations through Ultimate REST input.
Keyboard menu navigation is reserved for device features with no REST equivalent, for example the machine code monitor, visual SID editor, or Tool Menu.
`power_cycle` is the deliberate Tool Menu exception on C64U/U64: it reads `machine:menu_screen` after every navigation step and stops rather than blindly selecting an unverified item. It uses REST reboot on U2-family cartridges and a fresh VICE start on VICE.

## Skills and Tasks

Skills are served through the MCP Skills extension (`skills/list`, `skills/get`, `skill://<name>/SKILL.md`) and as `c64://skills/<name>` resources, from one catalogue. Read the resource when the client does not surface the extension.

Long operations (`c64_memory` `wait_until` and `wait_for_text`, `c64_debug` `wait_for_state`, `c64_sound` `capture_samples` and `pipeline`, `c64_graphics` `capture_frame`, `c64_program` `batch_run` and `bundle_run`) can run as tasks. A client that declares the Tasks extension gets a task handle after the inline window and uses `tasks/get` and `tasks/cancel`. Any other client calls `c64_system` `start_task` with `operation` set to the key (for example `c64_memory.wait_until`) and `arguments`, then `task_result` with `waitMs`. Tasks live in memory only and do not survive a restart. Details: [hardening behavior guide](doc/hardening-behavior.md).

## Skill Routing

| Intent | Skill |
| --- | --- |
| Ultra-fast hello world or smoke test | `.github/skills/hello-world/SKILL.md` |
| Quick visible greeting or smoke test | `.github/skills/cross-platform-demo/SKILL.md` |
| Custom BASIC program | `.github/skills/basic-program/SKILL.md` |
| Custom assembly routine | `.github/skills/assembly-program/SKILL.md` |
| SID demo, composition, conversion, reconstruction or game music | `.github/skills/sid-music/SKILL.md` |
| Graphics workflow | `.github/skills/graphics-demo/SKILL.md` |
| Memory inspection or patching | `.github/skills/memory-debug/SKILL.md` |
| Disk and drive management | `.github/skills/drive-manager/SKILL.md` |
| Game development (modern Ultimate by default, or stock C64) | `.github/skills/game-development/SKILL.md` |
| Existing software launch | `.github/skills/software-launch/SKILL.md` |
| Printer workflow | `.github/skills/printer-job/SKILL.md` |
| Streaming workflow | `.github/skills/stream-control/SKILL.md` |
| Machine or config control | `.github/skills/system-control/SKILL.md` |

## Knowledge Resources

Use ListResources to discover built-in knowledge, then read specific URIs to enrich context before coding:

- `c64://gamedev/index` — start here for any C64 game request (modern Ultimate by default, or stock C64); it lists which of `c64://gamedev/{architecture,techniques,toolchain}` and `c64://ultimate/{hardware,uci,reu,upic}` to read
- `c64://basic/spec` — BASIC v2 tokens, syntax, device I/O
- `c64://basic/rom-routines` — BASIC ROM routines, parser/evaluator helpers, numeric/string machinery
- `c64://assembly/6510-spec` — 6510 opcodes, addressing, zero-page strategy
- `c64://graphics/vic/spec` — raster timing, sprites, colour RAM, bitmap modes
- `c64://sound/sid/spec` — SID registers, waveforms, ADSR
- `c64://memory/map` — full 64 KB address map
- `c64://memory/zero-page-and-workspace` — zero page, stack, page-2 buffers, page-3 vectors
- `c64://vice/binary-monitor-spec` — mandatory reference when targeting VICE; covers Binary Monitor transport, command framing, and debugger side effects
- `c64://basic/pitfalls` — quoting, line length, token pitfalls
- `c64://kernal/rom-routines` — KERNAL ROM routines, jump table, vectors, serial/tape/screen services
- `c64://io/spec` — memory-mapped VIC-II, SID, CIA, colour RAM, and expansion I/O registers
- `c64://io/cia/spec` — CIA timers, keyboard matrix, serial bus, TOD, IRQ/NMI details
- `c64://graphics/petscii/style-guide` — readable PETSCII, colour/dither guidance

Every skill is also readable as the resource `c64://skills/<name>` (use it when `.github/skills` is not available to the client).

Pull RAG snippets via `c64_rag` (ops `basic`/`asm`/`docs`) for targeted examples.

## Operating Rule

Prefer stdio transport end to end.
For execution details, follow the matching skill rather than duplicating tool steps in prompts, agent files, or ad hoc instructions.

## Safety Notes

- Some tools affect device state (power, reboot, drive ops). Use deliberately.
- Every operation has an effect (`read`, `write`, `destructive`). `C64BRIDGE_ACCESS=full|no-destructive|read-only` (default `full`) limits what may be called; a blocked call returns a validation error naming the operation, effect and mode. Do not try to work around a block; ask the user to change the variable. `c64://platform/status` shows the active mode.
- `poweroff` does not restore power by software. The machine returns only when power is restored at the outlet, and starts by itself only if automatic startup on power restoration is enabled.
- Logs emit to stderr; stdout is reserved for the MCP protocol.

## Personas

Use these starting points to seed agent context. Templates live in `.github/prompts/`; the primer is `data/context/bootstrap.md`.

| Persona | Focus | Starter prompt |
| --- | --- | --- |
| BASIC Agent | Commodore BASIC v2 and simple I/O | [.github/prompts/basic-program-session.prompt.md](.github/prompts/basic-program-session.prompt.md) |
| ASM Agent | 6502/6510 assembly, raster, sprites, IRQs | [.github/prompts/assembly-routine-session.prompt.md](.github/prompts/assembly-routine-session.prompt.md) |
| SID Composer | SID playback and composition | [.github/prompts/sid-music-session.prompt.md](.github/prompts/sid-music-session.prompt.md) |
| Drive Manager | Disk images and drive state | [.github/prompts/drive-management-session.prompt.md](.github/prompts/drive-management-session.prompt.md) |
| VIC Painter | PETSCII, bitmap art, and sprites | [.github/prompts/petscii-art-session.prompt.md](.github/prompts/petscii-art-session.prompt.md) |
| Software Launcher | Existing PRG, CRT, or disk software | [.github/prompts/play-classic-game.prompt.md](.github/prompts/play-classic-game.prompt.md) |
