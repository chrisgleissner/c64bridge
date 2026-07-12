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

The server resolves config in this order: `C64BRIDGE_CONFIG` → `./.c64bridge.json` → `~/.c64bridge.json` → defaults (`host=c64u`, `port=80`).

Example:

```json
{ "c64u": { "host": "c64u", "port": 80, "networkPassword": "secret" } }
```

When Ultimate firmware network protection is enabled, `networkPassword` is sent as the `X-Password` header on every REST request.

### Runtime Backend Switching

When both `c64u` and `vice` are configured, the server can keep both backends live at the same time.
Use `c64_select_backend` to switch the active backend without restarting the MCP server.
The `c64://platform/status` resource always reports the currently active backend and the configured backend set.
State the desired backend directly in the prompt when you want to pin execution, for example: `use vice`, `vice: load this PRG`, `use c64u`, or `run this on hardware`.
When using the VS Code `C64` agent, keep the backend request in the same prompt so tool routing can call `c64_select_backend` before backend-specific operations.

### Fast Discovery Rules

When the prompt is already specific and backend-pinned, execute the matching skill immediately instead of re-reading general documentation.
Example: `vice: write a small BASIC program that clears the screen and prints HELLO VICE` should route straight to `.github/skills/hello-world/SKILL.md` and use that skill's minimal path.
If the current agent cannot directly see `c64bridge` MCP tools such as `c64_program`, immediately hand the request to the `C64` agent instead of inspecting repository files or MCP manifests first.
For a visible single-backend VICE greeting, prefer a no-probe fast path and avoid screenshot capture or Binary Monitor verification unless the user explicitly requests confirmation artifacts.
Once the MCP server is connected and tools are available in-session, do not spend extra turns inspecting README sections or tool manifests for routine `c64_select_backend`, `c64_program`, or `c64_memory` operations.

3) VS Code Copilot Chat (MCP)

Add to Settings (JSON):

```json
{
  "github.copilot.chat.experimental.mcp": {
    "servers": [
      { "name": "c64bridge", "command": "node", "args": ["./node_modules/c64bridge/dist/index.js"], "type": "stdio" }
    ]
  }
}
```

Keep the server running; tools are discovered automatically in the chat session.

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

- Program runners: `c64_program` (`upload_run_basic`, `upload_run_asm`, `run_prg`, `run_crt`, `bundle_run`, `batch_run`)
- Fast demo workflow: `c64_program` (`cross_platform_greeting`) for one-call greetings on VICE and/or C64U with screenshot capture and verification
- Screen & memory: `c64_memory` (`read`, `write`, `read_screen`, `wait_for_text`)
- System control: `c64_system` (`pause`, `resume`, `reset`, `reboot`, `poweroff`, `menu`, tasks)
- Configuration: `c64_config` (get/set, `batch_update`, `snapshot`, `restore`, `diff`, `shuffle`)
- Drives & files: `c64_disk`, `c64_drive`
- SID / music: `c64_sound` (`play_preset`, playback, generate, analyze)
- Graphics: `c64_graphics` (PETSCII, sprites)
- Knowledge & RAG: `c64_rag` (BASIC and ASM lookups)

Tools and parameters are listed dynamically via ListTools.

## Skill Routing

| Intent | Skill |
| --- | --- |
| Ultra-fast hello world or smoke test | `.github/skills/hello-world/SKILL.md` |
| Quick visible greeting or smoke test | `.github/skills/cross-platform-demo/SKILL.md` |
| Custom BASIC program | `.github/skills/basic-program/SKILL.md` |
| Custom assembly routine | `.github/skills/assembly-program/SKILL.md` |
| SID demo or composition | `.github/skills/sid-music/SKILL.md` |
| Graphics workflow | `.github/skills/graphics-demo/SKILL.md` |
| Memory inspection or patching | `.github/skills/memory-debug/SKILL.md` |
| Disk and drive management | `.github/skills/drive-manager/SKILL.md` |
| Existing software launch | `.github/skills/software-launch/SKILL.md` |
| Printer workflow | `.github/skills/printer-job/SKILL.md` |
| Streaming workflow | `.github/skills/stream-control/SKILL.md` |
| Machine or config control | `.github/skills/system-control/SKILL.md` |

## Knowledge Resources

Use ListResources to discover built-in knowledge, then read specific URIs to enrich context before coding:

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

Pull RAG snippets via `c64_rag` (ops `basic`/`asm`) for targeted examples.

## Operating Rule

Prefer stdio transport end to end.
For execution details, follow the matching skill rather than duplicating tool steps in prompts, agent files, or ad hoc instructions.

## Safety Notes

- Some tools affect device state (power, reboot, drive ops). Use deliberately.
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
