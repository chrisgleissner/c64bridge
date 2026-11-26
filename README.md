# C64 Bridge

**Give your coding agent a C64 it can test on.**

C64 Bridge is a Model Context Protocol (MCP) server that connects coding agents such as Claude Code and Codex to VICE or Ultimate hardware. Your agent can run a PRG, read the screen or RAM, and use the results to debug.

A built-in, searchable knowledge base gives it access to C64 programming and hardware expertise.

![Logo](./doc/img/logo.png)

[![npm](https://img.shields.io/npm/v/c64bridge.svg)](https://www.npmjs.com/package/c64bridge)
[![Build](https://img.shields.io/github/actions/workflow/status/chrisgleissner/c64bridge/ci.yaml)](https://github.com/chrisgleissner/c64bridge/actions/workflows/ci.yaml)
[![codecov](https://codecov.io/github/chrisgleissner/c64bridge/graph/badge.svg?token=AS9D41Y5EG)](https://codecov.io/github/chrisgleissner/c64bridge)
[![License: GPL v2](https://img.shields.io/badge/License-GPL%20v2-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-forestgreen)](doc/developer.md)

## Contents

<!-- AUTO-GENERATED:TOC-START -->

- [Quick start](#quick-start)
- [Project showcases](#project-showcases)
- [Configuration](#configuration)
- [Protocol support, skills and tasks](#protocol-support-skills-and-tasks)
- [HTTP invocation](#http-invocation)
- [Build and test](#build-and-test)
- [Documentation](#documentation)
- [Runtime environment variable reference](#runtime-environment-variable-reference)
- [MCP API Reference](#mcp-api-reference)

<!-- AUTO-GENERATED:TOC-END -->

## Quick start

You need Node.js 24 or later with npm, an MCP client, and either VICE or a reachable Ultimate device. [Node.js downloads](https://nodejs.org/en/download)

Install C64 Bridge by registering it with your client. The client launches `npx -y c64bridge@latest`, which fetches the npm package as needed and starts the local server over stdio.


### 1. Choose a target

C64 Bridge connects your coding agent to VICE or Ultimate hardware.

| Target | Requirements |
| --- | --- |
| **C64 Ultimate / Ultimate 64** | Device reachable at hostname `c64u` (port 80). [C64 Ultimate](https://www.commodore.net/) · [Ultimate 64](https://ultimate64.com/) |
| **U2 / U2+ / U2+L** | Cartridge reachable at hostname `u2` (port 80). [Setup guide](https://1541u-documentation.readthedocs.io/en/latest/quick_guide.html) |
| **VICE** | VICE with C64 ROMs installed, or an existing Binary Monitor endpoint. [VICE](https://vice-emu.sourceforge.io/) |

The installation examples assume these hostnames. If your hardware uses a different hostname or IP address, set `C64U_HOST` or `U2_HOST` accordingly in your MCP configuration. For password-protected devices, also set `C64U_PASSWORD` or `U2_PASSWORD`.

### 2. Install and start

Choose your client and target. All methods run the latest published C64 Bridge using `npx -y c64bridge@latest`.

#### Installation shortcuts

[![Use with Claude Code](https://img.shields.io/badge/Use_with-Claude_Code-D97757?style=flat-square&logo=anthropic&logoColor=white)](#terminal-clients)
[![Install in Cursor](https://img.shields.io/badge/Install_in-Cursor-000000?style=flat-square&logoColor=white)](https://cursor.com/install-mcp?name=io.github.chrisgleissner%2Fc64bridge&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImM2NGJyaWRnZUBsYXRlc3QiXSwiZW52Ijp7IkM2NF9NT0RFIjoiYzY0dSIsIkM2NFVfSE9TVCI6ImM2NHUifX0%3D)
[![Install in Visual Studio](https://img.shields.io/badge/Install_in-Visual_Studio-C16FDE?style=flat-square&logo=visualstudio&logoColor=white)](https://vs-open.link/mcp-install?%7B%22name%22%3A%22c64bridge%22%2C%22type%22%3A%22stdio%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22c64bridge%40latest%22%5D%2C%22env%22%3A%7B%22C64_MODE%22%3A%22c64u%22%2C%22C64U_HOST%22%3A%22c64u%22%7D%7D)
[![Install in VS Code](https://img.shields.io/badge/Install_in-VS_Code-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=io.github.chrisgleissner%2Fc64bridge&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22c64bridge%40latest%22%5D%2C%22env%22%3A%7B%22C64_MODE%22%3A%22c64u%22%2C%22C64U_HOST%22%3A%22c64u%22%7D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/Install_in-VS_Code_Insiders-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=io.github.chrisgleissner%2Fc64bridge&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22c64bridge%40latest%22%5D%2C%22env%22%3A%7B%22C64_MODE%22%3A%22c64u%22%2C%22C64U_HOST%22%3A%22c64u%22%7D%7D&quality=insiders)

The editor installation badges configure **C64 Ultimate**. For other targets, adjust the installed configuration as described below.

#### Terminal clients

Copy the command matching your client and target:

| Client | C64 Ultimate | U2 / U2+ / U2+L | VICE |
| --- | --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/mcp) | `claude mcp add c64bridge --scope user -e C64_MODE=c64u -- npx -y c64bridge@latest` | `claude mcp add c64bridge --scope user -e C64_MODE=u2 -e U2_HOST=u2 -- npx -y c64bridge@latest` | `claude mcp add c64bridge --scope user -e C64_MODE=vice -- npx -y c64bridge@latest` |
| [Codex CLI](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | `codex mcp add c64bridge --env C64_MODE=c64u -- npx -y c64bridge@latest` | `codex mcp add c64bridge --env C64_MODE=u2 --env U2_HOST=u2 -- npx -y c64bridge@latest` | `codex mcp add c64bridge --env C64_MODE=vice -- npx -y c64bridge@latest` |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) | `copilot mcp add c64bridge --env C64_MODE=c64u -- npx -y c64bridge@latest` | `copilot mcp add c64bridge --env C64_MODE=u2 --env U2_HOST=u2 -- npx -y c64bridge@latest` | `copilot mcp add c64bridge --env C64_MODE=vice -- npx -y c64bridge@latest` |

Verify with `claude mcp list`, `codex mcp list`, or `copilot mcp list`.

Claude Code commands use `--scope user` for availability across projects. Omit it for the current project only.

This repository's `.mcp.json` launches the local checkout and takes precedence over Copilot CLI's user-level configuration.

#### Editor and desktop clients

Configure C64 Bridge as a local **stdio** server with command `npx`, arguments `-y` and `c64bridge@latest`, and the appropriate environment variables:

| Target | Environment |
| --- | --- |
| C64 Ultimate | `C64_MODE=c64u` |
| U2 / U2+ / U2+L | `C64_MODE=u2`, `U2_HOST=u2` |
| VICE | `C64_MODE=vice` |

| Client | Setup |
| --- | --- |
| [Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers) | **Settings → Developer → Edit Config**. Update `claude_desktop_config.json` and restart. |
| [Cursor](https://cursor.com/docs/mcp) | Use the badge above or **Customize → MCP**. Alternatively, edit `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global). |
| [GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app) | Uses MCP servers configured for Copilot CLI or the current repository. Alternatively, select **Customize → MCP → Add custom server**. |
| [Visual Studio](https://learn.microsoft.com/en-us/visualstudio/ide/mcp-servers?view=visualstudio) | Use the badge above or **Copilot Agent mode → Tools → + → Add custom MCP server**. |
| [VS Code / VS Code Insiders](https://code.visualstudio.com/docs/agent-customization/mcp-servers) | Use the badge above or **Chat: Open Customizations → MCP Servers → Add Server → Command (stdio)**. Select **Copilot Global** for use across compatible Copilot clients on the same machine. |

For manual JSON configuration in Claude Desktop or Cursor, use:

```json
{
  "mcpServers": {
    "c64bridge": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "c64bridge@latest"],
      "env": {
        "C64_MODE": "c64u"
      }
    }
  }
}
```

Change the `env` values according to the target table above. If your client cannot find `npx`, use its absolute path.

### 3. Run Hello World

Open your coding agent and give it a target, a task, and a result to check.

> Use C64 Bridge on VICE. Run a short BASIC program that clears the screen, prints HELLO VICE, and reads the text screen back to confirm it.

For a C64 Ultimate or Ultimate 64, ask for the `c64u` backend. For a U2-family cartridge, ask for `u2`. You can change the greeting to match.

![VICE text screen displaying HELLO VICE](doc/img/backend-switch/hello-vice.png)

The agent should report seeing `HELLO VICE` on the emulated screen. The bridge runs the program and returns the observed text. The same run-and-check loop lets the agent catch a wrong value in RAM or confirm that a game reacts to input.

If the tools are missing, check that your client has enabled `c64bridge` and can find Node.js 24 or later. If a call fails, check the active backend in `c64://platform/status`. [Troubleshooting](doc/troubleshooting-mcp.md)

## Project showcases

Try one of these after the tour. Each example gives the agent a concrete task and a way to inspect the result.

### Develop a game

Tell your agent whether you’re targeting a stock PAL or NTSC C64, or an Ultimate with features such as turbo and REU. It can use the bundled game development manual to plan the frame budget, memory layout, and asset loading.

Start with a small 6510 routine or bring a PRG and its symbol file. In VICE, the agent can break at your labels, step through code, send joystick input, and inspect RAM. Switch to hardware to check raster timing and Ultimate features. [Program tools](#c64_program) · [VICE debugger](#c64_debug)

> Run my PRG in VICE with its symbol file. Break at the player update routine, then resume and check whether pressing fire spawns a projectile.

### Compose for the SID

Give your agent a score or a musical idea. It can use the SIDWAVE manual to turn instruments, patterns, and sections into a playable arrangement. Compile to check the arrangement and lint findings before listening to it on your target. [Sound tools](#c64_sound)

Export a PRG or PSID. Use PRG for layouts with more than three SIDs. A compatible Ultimate setup can address up to ten SIDs, depending on the model and fitted chips.

> Play Stereo Echo on my Ultimate, then show me how the score places its lead and echoes across the two SIDs.

Listen to **Arp Ballad**, **Drum and Bass**, or **Stereo Echo** and open the matching YAML to see how each was built. [Audio downloads](https://github.com/chrisgleissner/c64bridge/releases) · [Example scores](data/sound/examples/)

### Use Ultimate hardware

Tell your agent what you want the machine to do. It can use the hardware manuals to check what your program needs to detect and which settings to inspect before a run. [Configuration tools](#c64_config)

| Feature | What you can build |
| --- | --- |
| Turbo and REU | Use more CPU time per frame or transfer level data and graphics into C64 RAM. |
| Ultimate Command Interface (UCI) | Load files, save high scores, or use the network from your C64 program. |
| UPIC | Draw full-colour graphics into the border with timed colour changes. |

> Add REU level loading to my game. Check for the REU at startup and test the loader on my C64 Ultimate.

You can also upload PRGs, launch CRTs, mount disks, and capture video or stereo audio on C64U/U64. Check the tool tables for platform support. [Programs](#c64_program) · [Disks](#c64_disk) · [Streaming](#c64_stream)

## Configuration

### Configuration files and overrides

The bridge uses the first readable, parseable JSON configuration in this order:

1. The file named by `C64BRIDGE_CONFIG`.
2. `.c64bridge.json` in the server process's working directory.
3. `~/.c64bridge.json`.
4. A legacy `.c64bridge.json` next to the package or source checkout.

Keep all JSON backend profiles in the same file. An explicitly named file must exist and parse, or startup fails.

Environment variables override their corresponding JSON settings, with built-in defaults filling in the rest. See the [runtime environment variable reference](#runtime-environment-variable-reference) for the available settings.

The following config makes both Ultimate profiles and VICE available. Omit any unused profile. Replace the hosts as needed, and add `"networkPassword": "your-password"` to a hardware profile only if network protection is enabled.

```json
{
  "c64u": { "host": "c64u", "port": 80 },
  "u2": { "host": "u2", "port": 80 },
  "vice": {}
}
```

Hardware settings can also come from `C64U_HOST`, `C64U_PORT`, and `C64U_PASSWORD`, or their `U2_` counterparts. Give each device its own profile when using both hardware families.

Without a `u2` section, the U2 backend can use C64U settings. If you supply a separate `U2_HOST`, supply that device’s password with `U2_PASSWORD` as needed.

### Initial target and runtime switching

`C64_MODE` pins the initial target. Without it, the server prefers configured backends in this order: `c64u`, `u2`, `vice`. With none configured, it probes the default Ultimate endpoint at `c64u:80` and selects VICE if the probe fails.

Use `c64_select_backend` to switch among the available backends without restarting. Include the target in each prompt when switching, for example `u2: list drives` or `c64u: run this PRG`. The `c64://platform/status` resource shows which backend is active and which are available.

The same screen check can run on hardware. [C64 Ultimate greeting screenshot](doc/img/backend-switch/hello-c64u.png)

### VICE setup

C64 Bridge reuses a running Binary Monitor at the configured endpoint if one is available. For a local endpoint, it can launch VICE itself. The default Binary Monitor address is `127.0.0.1:6502`. VICE starts or connects on first use by default. Set `VICE_PREWARM=1` to do that in the background during startup.

For managed launches, the bridge looks for `x64sc` or `x64` and tries to discover the resource directory.

Set `VICE_BINARY` and `VICE_DIRECTORY` (or `vice.exe` and `vice.directory` in JSON) when using a custom install. If an explicit executable cannot be found, managed startup reports an error.

Use `VICE_HOST` and `VICE_PORT` to select an existing monitor at another address. The Binary Monitor accepts one client at a time. [VICE Binary Monitor guide](data/vice/vice-binary-monitor-spec.md) · [Supported operations](doc/vice/support-matrix.md)

| Window mode | Environment settings |
| --- | --- |
| Desktop window | `VICE_VISIBLE=true`. Warp defaults to off. |
| Minimized desktop window | `VICE_VISIBLE=true` and `VICE_ARGS=-minimized`. Restore the window whenever you want to inspect it. |
| Headless | `VICE_VISIBLE=false`. On Linux, the managed launch uses Xvfb when available. Warp defaults to on. |

`VICE_WARP` overrides the default for any mode. On Linux, `FORCE_XVFB=1` forces Xvfb and `DISABLE_XVFB=1` disables the Xvfb fallback.

### Ultimate firmware support

Read `c64://platform/status` before relying on a native firmware endpoint. The server can probe `machine:input` safely. It can confirm `machine:menu_screen` while the Ultimate menu is visible.

- **Physical input** uses `machine:input` for keyboard matrix events, held-input state, release, and hardware joystick. It needs supporting C64U firmware or U64 firmware 3.15+. For ordinary text input on other firmware, use `c64_input` with `key` or `write_text`.
- **Menu capture** uses `machine:menu_screen` and needs supporting C64U firmware or U64/U2 firmware 3.15+. C64U/U64 `power_cycle` uses this endpoint to verify Tool Menu navigation. The U2 operation uses REST reboot, and VICE starts a fresh emulator session.
- **U2-family cartridges** expose the shared REST subset. The [MCP API reference](#mcp-api-reference) shows availability per operation. Physical input, debug registers, power-off, and streaming are unavailable on U2.

### Operation and file access

Set `C64BRIDGE_ACCESS` to control which operations a client can call.

- `full` (default) allows every operation.
- `no-destructive` allows regular writes and blocks destructive operations.
- `read-only` limits calls to read operations. Unknown values fall back to this mode.

The server checks each batch command and checks a background task’s operation when it starts. The active mode appears in `c64://platform/status`.

Host paths refer to files on the machine running C64 Bridge. Tools can use the server working directory (except the home or filesystem root), `~/.c64bridge`, the configured state directory, and the system temporary directory.

- Most reads are capped at 16 MiB, with 64 MiB for disk images.
- The server resolves symlinks, blocks hidden path components by default, and protects internal configuration and state files.
- Add roots with `C64BRIDGE_ALLOWED_DIRS`. Separate entries with `:` on Linux/macOS or `;` on Windows. A lone `*` disables the root restriction. [Hardening behavior](doc/hardening-behavior.md)

After `poweroff` on C64U/U64, restore power at the outlet. The machine starts automatically only if its power-restoration setting allows it.

## Protocol support, skills and tasks

The server speaks MCP 2026-07-28 and earlier revisions (2025-11-25 and older) on stdio and on the stateless HTTP transport. Each request is served according to the protocol version it carries. Pre-2026 clients receive the same tools, resources and results as before.

**Skills.** The packaged skills are served through the MCP Skills extension (`skills/list`, `skills/get`, `skill://<name>/SKILL.md`) and as the resources `c64://skills/<name>`, from one catalogue. Clients that do not implement the extension read the resources. Claude Code documents MCP skills; VS Code Copilot documents them as an experimental setting without naming the wire protocol; Codex CLI does not document them.

**Long operations.** A call to `c64_memory` (`wait_until`, `wait_for_text`), `c64_debug` (`wait_for_state`), `c64_sound` (`capture_samples`, `pipeline`), `c64_graphics` (`capture_frame`) or `c64_program` (`batch_run`, `bundle_run`) that does not finish within one second can run as a task.

- With native Tasks support (the `io.modelcontextprotocol/tasks` extension, which a client declares on each request), the server returns a task handle and the client polls `tasks/get` or cancels with `tasks/cancel`. Claude Code documents MCP 2026-07-28 and tasks; Codex CLI and VS Code Copilot do not document them.
- Any client can use the fallback: `c64_system` `start_task` with `operation: "c64_memory.wait_until"` (or another allowlisted `tool.op`) and `arguments`, then `task_result` with `waitMs` to collect the result.

Tasks are held in memory only. They are not resumed after a restart. See [hardening behavior](doc/hardening-behavior.md).

**Waiting for a condition.** `c64_memory` `wait_until` waits for a memory value, a screen text change or a VICE checkpoint, with a mandatory `timeoutMs`. Use it instead of polling `read` in a loop.

## HTTP invocation

Use the optional loopback HTTP transport for manual inspection. Start it with `npx -y c64bridge@latest --http 3000` or `npm start -- --http 3000` from a checkout.

The default HTTP port is 3000, and the bridge listens on `127.0.0.1` with loopback-only Host and Origin checks.

Set `C64BRIDGE_HTTP_TOKEN` and send `Authorization: Bearer <token>` to require authentication. Without a token, local processes that can reach the port can call the tools allowed by the access mode.

Send MCP JSON-RPC requests to `/mcp`. Pass the operation as `params.arguments.op` in a `tools/call` request. Responses arrive as server-sent events.

```bash
curl -s http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"c64_memory","arguments":{"op":"read_screen"}}}'
```

To discover tools, send `{"jsonrpc":"2.0","id":2,"method":"tools/list"}` with the same headers. Set `C64BRIDGE_VERBOSE_SCHEMA=1` to include the full per-operation schemas.

## Build and test

From a checkout with Bun 1.3 or later, use the build wrapper to install dependencies, compile, and run the test suite.

```bash
./build --skip-tests  # install and build
npm start             # launch the local stdio server
```

| Task | Command |
| --- | --- |
| Install, build, and run the full test matrix | `./build` |
| Run mock-backed tests | `./build test` |
| Run the VICE mock test leg | `./build test --platform vice --target mock` |
| Test against Ultimate hardware | `./build test --real --base-url http://c64u` |

See `./build --help` for coverage, RAG rebuilds, package checks, and release commands. To run a local npm installation, use `npx c64bridge` from the project where you installed it.

The checked-in [VS Code configuration](.vscode/mcp.json) and [Claude Code project configuration](.mcp.json) launch the source checkout. In VS Code, the [C64 custom agent](.github/agents/c64.agent.md) is available for the project’s C64 workflows. In Claude Code, approve the project server when prompted. To start a stdio session by hand, run `npm start` from the checkout or `npx -y c64bridge@latest` for the published package. It waits for MCP requests on stdin.

`npm run build` regenerates the contents list, the two reference sections below, and the static MCP interface. Commit updated generated files alongside MCP server changes. The package check in CI rebuilds and fails if the committed files are stale. [Developer guide](doc/developer.md)

## Documentation

### Setup and troubleshooting

- **First run** · Choose a target, connect your client, and run a greeting. [Hello World tour](#quick-start)
- **Startup and connection issues** · Check the session logs in `~/.c64bridge/diagnostics/`. Set `LOG_LEVEL=debug` for more detail. [Troubleshooting guide](doc/troubleshooting-mcp.md)

### Bundled manuals

Your agent can consult these manuals through MCP while it works. The links below are there for when you want to look up a detail yourself.

- **Game development** · [Reading plan by game type](data/gamedev/index.md) · [Frame timing and memory layout](data/gamedev/architecture.md) · [Toolchains](data/gamedev/toolchain.md)
- **SID composition** · [SIDWAVE format](data/sound/sidwave.md) · [SID registers](data/sound/sid-spec.md) · [Multi-SID layouts](data/ultimate/multisid.md)
- **Ultimate hardware** · [Turbo and board settings](data/ultimate/hardware.md) · [REU](data/ultimate/reu.md) · [UCI](data/ultimate/uci.md) · [UPIC](data/ultimate/upic.md)
- **VICE debugging** · [Binary Monitor](data/vice/vice-binary-monitor-spec.md)

### Integration and internals

- **Agent setup** · [Integration guide](AGENTS.md) · [Agent primer](data/context/bootstrap.md)
- **MCP interface** · [Interface files](mcp/) · [MCP manifest](mcp.json) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=c64bridge)
- **Ultimate REST APIs** · [C64U/U64 specification](doc/c64u/c64-openapi.yaml) · [U2 specification](doc/u2/u2-openapi.yaml)
- **Server architecture** · [DeepWiki overview](https://deepwiki.com/chrisgleissner/c64bridge)

## Runtime environment variable reference

<!-- AUTO-GENERATED:ENV-VARS-START -->

Every runtime environment variable documented in `mcp.json` can be set in your MCP client configuration, including `.vscode/mcp.json` under `servers.c64bridge.env`.

#### Server Runtime

| Variable | Default | JSON Config Key | Description |
| --- | --- | --- | --- |
| `C64_MODE` | auto | — | Pin the initial backend to c64u, u2, or vice. When unset, select from configuration or probe the default hardware endpoint |
| `C64_TASK_STATE_FILE` | auto | — | Override the path used to persist MCP background-task state |
| `C64BRIDGE_ACCESS` | full | — | Access mode limiting which operations may be called (full, no-destructive, read-only) |
| `C64BRIDGE_ALLOW_HIDDEN_PATHS` |  | — | Set to 1 to allow hidden host path components; protected configuration and task-state files remain inaccessible |
| `C64BRIDGE_ALLOWED_DIRS` |  | — | Additional directories allowed for host file paths in tool arguments, separated by the path delimiter; * disables the check |
| `C64BRIDGE_CONFIG` |  | config path | Explicit configuration JSON path. When unset, search the working directory, home directory, then package directory |
| `C64BRIDGE_DIAGNOSTICS_DIR` | ~/.c64bridge/diagnostics | — | Override the directory where persistent MCP diagnostics files are written |
| `C64BRIDGE_DIAGNOSTICS_KEEP` | 200 | — | Number of diagnostics files kept at startup; files older than 30 days are always removed |
| `C64BRIDGE_DISABLE_DIAGNOSTICS` | 0 | — | Set to 1 to disable persistent diagnostics logging |
| `C64BRIDGE_HTTP_TOKEN` |  | — | Bearer token required by the optional HTTP transport (--http) |
| `C64BRIDGE_POLL_INTERVAL_MS` | 200 | — | Interval between screen polls during program-output validation in normal runtime mode |
| `C64BRIDGE_POLL_MAX_MS` | 2000 | — | Maximum time to poll for program-output validation before timing out in normal runtime mode |
| `C64BRIDGE_POLL_STABILIZE_MS` | 100 | — | Extra settle time after a successful poll match before considering output stable |
| `C64BRIDGE_SKILLS_PAGE_SIZE` | 100 | — | Skills returned per skills/list page (integer, 1 or more) |
| `C64BRIDGE_STATE_DIR` | ~/.c64bridge | — | Root directory for task state, run artifacts and diagnostics |
| `C64BRIDGE_TASK_INLINE_MS` | 1000 | — | Time in ms a task-capable call waits for its result before it moves to the background (0-600000) |
| `C64BRIDGE_TASK_TTL_MS` | 600000 | — | Time in ms a finished task and its result are kept (0-86400000) |
| `C64BRIDGE_VERBOSE_SCHEMA` |  | — | Set to 1 to include full per-operation schemas in tools/list |
| `LOG_LEVEL` | info | — | Logger verbosity (debug, info, warn, error) |

#### C64 Ultimate

| Variable | Default | JSON Config Key | Description |
| --- | --- | --- | --- |
| `C64U_HOST` | c64u | c64u.host | Override the C64 Ultimate host name or IP address |
| `C64U_PASSWORD` |  | c64u.networkPassword | Override the C64 Ultimate network password sent as X-Password |
| `C64U_PORT` | 80 | c64u.port | Override the C64 Ultimate REST port |

#### U2-family

| Variable | Default | JSON Config Key | Description |
| --- | --- | --- | --- |
| `U2_HOST` |  | u2.host | Override the U2/U2+/U2+L host name or IP address |
| `U2_PASSWORD` |  | u2.networkPassword | Override the U2-family network password sent as X-Password |
| `U2_PORT` |  | u2.port | Override the U2-family REST port |

#### VICE Runtime

| Variable | Default | JSON Config Key | Description |
| --- | --- | --- | --- |
| `DISABLE_XVFB` | 0 | — | Set to 1 to disable Xvfb fallback and use the current display only |
| `FORCE_XVFB` | 0 | — | Set to 1 to force managed VICE launches to use Xvfb even when a graphical session is detected |
| `VICE_ARGS` |  | vice.args | Extra command-line arguments forwarded to managed VICE launches, such as -minimized for a visible window that starts iconified |
| `VICE_BINARY` | x64sc | vice.exe | VICE executable for managed sessions and audio capture. A missing executable at an explicit setting prevents a managed launch |
| `VICE_DIRECTORY` | auto-detect | vice.directory | Override the VICE resource directory used for ROM and UI asset discovery; automatic search is used only when this override is missing or invalid |
| `VICE_HOST` | 127.0.0.1 | vice.host | Override the VICE Binary Monitor host |
| `VICE_PORT` | 6502 | vice.port | Override the VICE Binary Monitor port |
| `VICE_PREWARM` | 0 | vice.prewarm | Set to 1 to start/connect VICE in the background during MCP startup; disabled by default so VICE starts lazily on first use |
| `VICE_VISIBLE` | true | vice.visible | Launch VICE as a desktop window when true; use headless/Xvfb managed launch when false |
| `VICE_WARP` | false when visible, true when headless | vice.warp | Enable warp mode for managed VICE sessions |
| `VICE_XVFB_DISPLAY` | :99 | — | Display number to use when managed VICE launches under Xvfb |

#### VICE Audio Capture

| Variable | Default | JSON Config Key | Description |
| --- | --- | --- | --- |
| `VICE_LIMIT_CYCLES` | 120000000 | — | Maximum CPU cycles to render when VICE generates audio |
| `VICE_MODE` | ntsc | — | Default video standard for VICE audio capture (ntsc\|pal) |
| `VICE_RUN_TIMEOUT_MS` | 10000 | — | Timeout for headless VICE runs in milliseconds |

#### SID Playback

| Variable | Default | JSON Config Key | Description |
| --- | --- | --- | --- |
| `SIDPLAY_BINARY` | sidplayfp | — | sidplayfp binary to launch when generating audio |
| `SIDPLAY_LIMIT_CYCLES` | 120000000 | — | Maximum CPU cycles to render when sidplayfp generates audio |
| `SIDPLAY_MODE` | ntsc | — | Default SID playback mode (ntsc\|pal) |
| `SIDPLAYFP_BINARY` |  | — | Legacy alias for SIDPLAY_BINARY (sidplayfp executable name) |

#### RAG

| Variable | Default | JSON Config Key | Description |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` |  | — | Personal access token used for optional RAG discovery against GitHub |
| `RAG_BUILD_ON_START` | 0 | — | Set to 1 to rebuild embeddings on server start |
| `RAG_DISCOVER_FORCE_REFRESH` | 0 | — | Set to 1 to ignore cached discovery results when fetching external docs |
| `RAG_DOC_FILES` |  | — | Comma-separated extra docs to include in RAG |
| `RAG_EMBEDDINGS_DIR` | data | — | Directory containing RAG embedding JSON files |
| `RAG_REINDEX_INTERVAL_MS` | 0 | — | Periodic reindex interval in ms (0 disables) |

#### Testing

| Variable | Default | JSON Config Key | Description |
| --- | --- | --- | --- |
| `C64_TEST_TARGET` |  | — | Overrides integration tests to hit mock or real hardware (mock\|real) |

<!-- AUTO-GENERATED:ENV-VARS-END -->

## MCP API Reference

<!-- AUTO-GENERATED:MCP-DOCS-START -->

This MCP server exposes **17 tools**, **53 resources**, and **11 prompts** for controlling your Commodore 64.

See the [hardening behavior guide](doc/hardening-behavior.md) for host path restrictions, argument limits, task retention, cancellation and verification semantics.

### Tools

_Address range convention: `address` + `length` means start address plus byte count; `startAddress` + `endAddress` means inclusive bounds._

#### c64_batch

Execute multiple c64bridge tool calls in a single request. Reduces latency for multi-step workflows.

_No operations defined._

#### c64_config

Grouped entry point for configuration reads/writes, diagnostics, and snapshots.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `batch_update` | Apply several configuration updates at once. Pass `updates` as {category: {item: value}}. | — | `updates` | ✅ | ✅ | ✅ |
| `diff` | Compare configuration with a snapshot. | `path` | — | ✅ | ✅ | ✅ |
| `get` | Read a configuration category or specific item. | `category` | `item`, `includeSecretValues=false` | ✅ | ✅ | ✅ |
| `info` | Retrieve Ultimate hardware information and status. | — | — | ✅ | ✅ | ✅ |
| `list` | List configuration categories reported by the firmware. | — | — | ✅ | ✅ | ✅ |
| `load_flash` | Load configuration from flash. | — | `category` | ✅ | ✅ |  |
| `read_debugreg` | Read the Ultimate debug register ($D7FF). | — | — | ✅ |  |  |
| `reset_defaults` | Reset configuration to factory defaults. | — | `category` | ✅ | ✅ |  |
| `restore` | Restore configuration from a snapshot file. Writes only items that differ from the device; if the device refuses a category (e.g. 403 for a wrong network password), the others are still restored and the error names the failed categories. | `path` | `applyToFlash=false` | ✅ | ✅ | ✅ |
| `save_flash` | Persist the configuration to flash. | — | `category` | ✅ | ✅ |  |
| `set` | Write a configuration value in the selected category. | `category`, `item`, `value` | — | ✅ | ✅ | ✅ |
| `shuffle` | Discover PRG/CRT files and run each, optionally capturing the screen. | — | `root="/"`, `extensions=["prg","crt"]`, `durationMs=5000`, `captureScreen=true`, `maxPrograms=10`, `outputPath`, `resetDelayMs=100` | ✅ | ✅ |  |
| `snapshot` | Snapshot configuration to disk. | `path` | — | ✅ | ✅ | ✅ |
| `version` | Fetch firmware version details. | — | — | ✅ | ✅ | ✅ |
| `write_debugreg` | Write a hex value to the Ultimate debug register ($D7FF). | `value` | — | ✅ |  |  |

#### c64_debug

Grouped entry point for VICE debugger operations (breakpoints, registers, stepping).

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `continue_execution` | Exit the Binary Monitor and resume CPU execution (BM 0xAA Exit). | — | — |  |  | ✅ |
| `create_checkpoint` | Create a new checkpoint (breakpoint) in VICE. | `address` | `endAddress`, `stopOnHit=true`, `enabled=true`, `temporary=false`, `label`, `operations`, `memspace` |  |  | ✅ |
| `delete_checkpoint` | Remove a checkpoint by id. | `id` | — |  |  | ✅ |
| `get_checkpoint` | Fetch a single checkpoint by id. | `id` | — |  |  | ✅ |
| `get_monitor_state` | Read CPU registers and return the current monitor state. | — | `memspace` |  |  | ✅ |
| `get_registers` | Read register values, optionally filtered by name or id. | — | `memspace`, `registers` |  |  | ✅ |
| `list_checkpoints` | List all active VICE checkpoints (breakpoints). | — | — |  |  | ✅ |
| `list_registers` | List available registers (metadata). | — | `memspace` |  |  | ✅ |
| `nuclear_reset` | Kill and restart the VICE process (managed instances only). | — | — |  |  | ✅ |
| `set_condition` | Attach a conditional expression to a checkpoint. | `id`, `expression` | — |  |  | ✅ |
| `set_registers` | Write register values. | `writes` | `memspace` |  |  | ✅ |
| `step` | Single-step CPU execution. | — | `count=1`, `mode` |  |  | ✅ |
| `step_return` | Continue execution until the current routine returns. | — | — |  |  | ✅ |
| `toggle_checkpoint` | Enable or disable a checkpoint by id. | `id`, `enabled` | — |  |  | ✅ |
| `wait_for_state` | Wait until the CPU is stopped (checkpoint hit or step) and, with expectedPC, PC equals it, or the timeout elapses. Without a debug session the registers are polled. | — | `expectedPC`, `timeoutMs=5000`, `pollMs=100` |  |  | ✅ |

#### c64_disk

Grouped entry point for disk mounts, listings, image creation, and program discovery.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `create_image` | Create a blank disk image of the specified format. An existing file at the path is not overwritten; the call fails and a different path (or deleting the file first) is needed. | `format`, `path` | `diskname`, `tracks` | ✅ | ✅ |  |
| `file_info` | Inspect a file on the Ultimate filesystem. | `path` | — | ✅ | ✅ |  |
| `find_and_run` | Search for a PRG/CRT by name substring and run the first match. | `nameContains` | `root="/"`, `extensions`, `caseInsensitive=true`, `sort="discovered"`, `waitMs=0`, `captureCandidates=10` | ✅ | ✅ |  |
| `find_paths` | Search Ultimate storage for paths containing a name substring, without running anything. | `nameContains` | `root="/"`, `extensions`, `maxResults=100`, `caseInsensitive=true` | ✅ | ✅ |  |
| `list_drives` | List drive slots and mounted images. | — | — | ✅ | ✅ | ✅ |
| `mount` | Mount a disk image with optional verification/retries. Supports verification. | `drive`, `image` | `type`, `attachmentMode`, `location`, `driveMode`, `verify=false`, `powerOnIfNeeded=true`, `resetAfterMount=true`, `maxRetries=2`, `retryDelayMs=500` | ✅ | ✅ | ✅ |
| `unmount` | Unmount the image from a drive slot. | `drive` | — | ✅ | ✅ |  |

#### c64_drive

Grouped entry point for drive power, mode, reset, and ROM operations.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `load_rom` | Temporarily load a custom ROM into an Ultimate drive slot. | `drive`, `path` | — | ✅ | ✅ |  |
| `power_off` | Power off a specific Ultimate drive slot. | `drive` | — | ✅ | ✅ | ✅ |
| `power_on` | Power on a specific Ultimate drive slot. | `drive` | — | ✅ | ✅ | ✅ |
| `reset` | Issue an IEC reset for the selected drive slot. | `drive` | — | ✅ | ✅ | ✅ |
| `set_mode` | Set the emulation mode for a drive slot (1541/1571/1581). | `drive`, `mode` | — | ✅ | ✅ | ✅ |

#### c64_extract

Grouped entry point for sprite/charset extraction, memory dumps, filesystem stats, and firmware health checks.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `charset` | Locate and extract 2KB character sets from RAM. | — | `address`, `scanRange="common"`, `outputPath`, `pauseDuringRead=true`, `minNonEmptyChars=32`, `minEntropy=0.3` | ✅ | ✅ | ✅ |
| `firmware_health` | Run firmware readiness checks and report status metrics. | — | — | ✅ | ✅ | ✅ |
| `fs_stats` | Per-extension size statistics for one directory (no recursion); the firmware returns at most one file per extension. | — | `root="/"`, `extensions`, `includeContainers=true`, `maxSamplesPerExtension=3` | ✅ | ✅ |  |
| `memory_dump` | Dump a RAM range to hex or binary files with manifest metadata. | `address`, `length`, `outputPath` | `format="hex"`, `chunkSize`, `pauseDuringRead=true`, `retries=1` | ✅ | ✅ | ✅ |
| `sprites` | Scan RAM for sprites and optionally export .spr files. | `address`, `length` | `stride=64`, `maxSprites=16`, `minNonZeroRows=4`, `minSetBits=12`, `includeBase64=false`, `includeRows=false`, `outputDir`, `pauseDuringRead=true` | ✅ | ✅ | ✅ |

#### c64_graphics

Grouped entry point for frame capture and graphics rendering workflows.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `capture_frame` | Capture one or more complete video frames from the active backend. | — | `count=1`, `includePixels=false`, `format`, `encoding="base64"` | ✅ |  | ✅ |
| `get_display_state` | Read VIC-II and CIA2 registers to determine the current graphics mode and memory layout. | — | — | ✅ | ✅ | ✅ |
| `render_bitmap` | Convert an image file to VIC-II bitmap memory, write it to RAM and display it. | `imagePath`, `format` | `bitmapAddress=8192`, `screenAddress=1024`, `borderColor=0`, `backgroundColor=0`, `preserveAspect=true` | ✅ | ✅ | ✅ |
| `render_petscii_art` | Create PETSCII art from a prompt, text or bitmap data, optionally displaying it. | — | `prompt`, `text`, `maxWidth`, `maxHeight`, `borderColor`, `backgroundColor`, `foregroundColor`, `dryRun=false`, `bitmap` | ✅ | ✅ | ✅ |
| `render_petscii_text` | Display PETSCII text with optional border and background colours. | `text` | `borderColor`, `backgroundColor` | ✅ | ✅ | ✅ |
| `render_sprite` | Display 63-byte sprite data at a position and colour by writing memory and VIC-II registers. | `sprite` | `index=0`, `x=100`, `y=100`, `color=1`, `multicolour=false`, `dataAddress` | ✅ | ✅ | ✅ |

#### c64_input

Cross-platform PETSCII typing plus native Ultimate keyboard and joystick events.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `joystick` | Simulate joystick input. On C64U/U64 this uses machine:input. On VICE it attaches the joyport simulation device, which also pulls CIA lines 5-7 low: port 1 produces phantom keys and port 2 reads $1E for up instead of $7E. Prefer port 2 on VICE and test bits 0-4. | `port`, `controls`, `action` | `durationMs=80` | ✅ |  | ✅ |
| `key` | Press one key one or more times, optionally with a delay. | `key` | `durationMs=0`, `count=1` | ✅ | ✅ | ✅ |
| `keyboard` | Send physical C64 keyboard matrix events through machine:input (needs firmware support; U64 3.15+). | `inputs`, `transition` | — | ✅ |  |  |
| `release_all` | Release every key and joystick control injected through machine:input. | — | — | ✅ |  |  |
| `state` | Read the keys and joystick controls held through machine:input. | — | — | ✅ |  |  |
| `write_text` | Send a text string to the keyboard buffer, with PETSCII token expansion. | `text` | `delayMs=0` | ✅ | ✅ | ✅ |

#### c64_memory

Grouped entry point for memory I/O, screen reads, and screen polling.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `compare_memory` | Compare two memory regions and report differences. | `address1`, `address2`, `length` | `maxDiffs=10`, `includeIo=false` | ✅ | ✅ | ✅ |
| `copy_memory` | Copy a RAM region to another address. | `source`, `dest`, `length` | `includeIo=false` | ✅ | ✅ | ✅ |
| `disassemble` | Disassemble memory into 6502/6510 instructions, with loaded labels. | `address` | `length=64`, `instructionCount` | ✅ | ✅ | ✅ |
| `fill_memory` | Fill a memory range with a repeating byte pattern. | `address`, `length`, `pattern` | — | ✅ | ✅ | ✅ |
| `list_basic` | List the BASIC program in memory as text. | — | — | ✅ | ✅ | ✅ |
| `read` | Read a range of bytes with address metadata. | `address` | `length=256`, `format="hex"`, `bank` | ✅ | ✅ | ✅ |
| `read_screen` | Return the 40x25 text screen as ASCII. | — | — | ✅ | ✅ | ✅ |
| `save_memory` | Dump a memory range to a local file (optional PRG header). | `startAddress`, `endAddress`, `filePath` | `asPrg=true`, `includeIo=false` | ✅ | ✅ | ✅ |
| `search_memory` | Search a memory range for a byte pattern. | `startAddress`, `endAddress`, `pattern` | `maxResults=10`, `includeIo=false` | ✅ | ✅ | ✅ |
| `wait_for_text` | Poll the screen for a substring or regex. | `pattern` | `isRegex=false`, `caseInsensitive=true`, `timeoutMs=3000`, `intervalMs=100` | ✅ | ✅ | ✅ |
| `wait_until` | Wait until a condition on memory, the screen or a VICE checkpoint holds. Timeout or maxIterations: success with met false. A failed read ends the wait with an error result (communication_failure) carrying the data so far. Addresses and backend are fixed at the start. | `condition`, `timeoutMs` | `pollIntervalMs=250`, `maxIterations=10000`, `includeIo=false` | ✅ | ✅ | ✅ |
| `write` | Write hex bytes into RAM. Supports verification. | `address`, `bytes` | `verify=false`, `expected`, `mask`, `abortOnMismatch=true` | ✅ | ✅ | ✅ |

#### c64_printer

Grouped entry point for Commodore and Epson printing helpers.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `define_chars` | Define custom printer characters (Commodore DLL mode). | `firstChar`, `chars` | `secondaryAddress` | ✅ | ✅ |  |
| `print_bitmap` | Print a bitmap row via Commodore (BIM) or Epson ESC/P workflows. | `printer="commodore"`, `columns` | `repeats`, `useSubRepeat`, `secondaryAddress`, `ensureMsb=true`, `mode`, `density`, `timesPerLine` | ✅ | ✅ |  |
| `print_text` | Generate BASIC that prints text to device 4. | `text` | `target="commodore"`, `secondaryAddress`, `formFeed=false` | ✅ | ✅ |  |

#### c64_program

Grouped entry point for program upload, execution, and batch workflows.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `batch_run` | Run multiple PRG/CRT programs with post-run assertions. | `programs` | `continueOnError=false`, `durationMs=2000`, `outputPath`, `resetDelayMs=100` | ✅ | ✅ | ✅ |
| `bundle_run` | Capture screen, memory and debug registers into a bundle. | `runId`, `outputPath` | `captureScreen=true`, `memoryRanges`, `captureDebugReg` | ✅ | ✅ | ✅ |
| `cross_platform_greeting` | Show a platform-specific greeting on configured backends, capture screenshots and verify. Supports verification. | — | `platforms`, `messageTemplate="HAVE A GREAT DAY, {PLATFORM}!"`, `verify=true`, `captureScreenshot=true`, `outputPath`, `restoreActiveBackend=true`, `timeoutMs=1500`, `pollIntervalMs=100` | ✅ | ✅ | ✅ |
| `load_prg` | Load a PRG into memory without running it (Ultimate path, host path on VICE, or location host). | `path` | `location`, `symbolsFile` | ✅ | ✅ | ✅ |
| `run_crt` | Run a CRT cartridge image from an Ultimate path, or upload a host file with location host (c64u/u2). | `path` | `location` | ✅ | ✅ |  |
| `run_prg` | Load and run a PRG: Ultimate path on c64u/u2 (location host uploads a host file), host path on VICE. | `path` | `location`, `symbolsFile` | ✅ | ✅ | ✅ |
| `upload_run_asm` | Assemble 6502/6510 source (ACME, ca65 and 64tass directive spellings; .include/.incbin read host files), upload and run it. Supports verification. | `program` | `verify=false` | ✅ | ✅ | ✅ |
| `upload_run_basic` | Tokenize BASIC v2 source, upload and run it; verify:true reports BASIC errors with their line. Supports verification. | `program` | `verify=false`, `autoFix=true` | ✅ | ✅ | ✅ |

#### c64_rag

Grouped entry point for BASIC, assembly and curated-docs RAG lookups.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `asm` | Retrieve 6502/6510 assembly references from the local knowledge base. | `q` | `k=3` | ✅ | ✅ | ✅ |
| `basic` | Retrieve BASIC references and snippets from the local knowledge base. | `q` | `k=3` | ✅ | ✅ | ✅ |
| `docs` | Search all curated docs (hardware, Ultimate features, game development, specs) with no BASIC/assembly filter. | `q` | `k=3` | ✅ | ✅ | ✅ |

#### c64_select_backend

Switch the active backend between C64U/U64 hardware, U2-family cartridges, and the VICE emulator at runtime.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `select` | Switch the active runtime backend without restarting the MCP server. | `backend` | — | ✅ | ✅ | ✅ |

#### c64_sound

SID control, playback, composition and audio analysis.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `analyze` | Analyze SID playback or a host WAV. | — | `wavPath`, `request="analyze the SID output"`, `durationSeconds`, `expectedSidwave` | ✅ | ✅ | ✅ |
| `capture_samples` | Capture Ultimate stereo PCM. | — | `count=256`, `encoding="base64"` | ✅ |  |  |
| `compile_play` | Compile and optionally play SIDWAVE. | — | `configure`, `sidwave`, `cpg`, `format`, `output="prg"`, `dryRun=false`, `outputPath` | ✅ | ✅ | ✅ |
| `generate` | Compose and play a seeded SIDWAVE PRG. Replaces the program in memory. | — | `includeScore`, `configure`, `root="C4"`, `pattern`, `steps`, `tempoMs`, `waveform`, `preset="classic"`, `system`, `style="chiptune"`, `seed=65` | ✅ | ✅ | ✅ |
| `note_off` | Release a SID voice. | `voice` | — | ✅ | ✅ | ✅ |
| `note_on` | Start a SID voice. | — | `voice=1`, `note`, `frequencyHz`, `system`, `waveform="pulse"`, `pulseWidth=2048`, `attack=1`, `decay=1`, `sustain=15`, `release=3` | ✅ | ✅ | ✅ |
| `pipeline` | Compile, play and analyze SIDWAVE. Supports verification. | — | `configure`, `sidwave`, `cpg`, `output="prg"`, `waitBeforeCaptureMs=500`, `analysisDurationSeconds=3`, `expectedSidwave`, `verifySilenceBefore=false`, `verifySilenceAfter=false`, `silenceDurationSeconds=1.5`, `silenceRmsThreshold=0.02`, `postSilenceWaitMs=200`, `silenceWaitMs=150` | ✅ | ✅ | ✅ |
| `play_mod_file` | Play an Ultimate MOD file. | `path` | — | ✅ | ✅ |  |
| `play_preset` | Compile and play a built-in SID preset. Supports verification. | — | `includeScore`, `configure`, `preset="chiptune_drive"`, `platforms`, `verify=false`, `analysisDurationSeconds=4`, `waitBeforeCaptureMs=400`, `restoreActiveBackend=true` | ✅ | ✅ | ✅ |
| `play_sid_file` | Play an Ultimate SID file. | `path` | `songnr` | ✅ | ✅ |  |
| `record_analyze` | Analyze a recording from the Ultimate stream or host microphone on other backends. | `durationSeconds` | `expectedSidwave` | ✅ | ✅ | ✅ |
| `reset` | Reset SID registers. | — | `hard=false` | ✅ | ✅ | ✅ |
| `sample_render` | Render a SIDWAVE sample to WAV. | — | `definition`, `rate=4000`, `outputDir` | ✅ | ✅ | ✅ |
| `set_volume` | Set SID volume ($D418). | `volume` | `filterMode` | ✅ | ✅ | ✅ |
| `silence_all` | Silence all SID voices. Supports verification. | — | `verify=false` | ✅ | ✅ | ✅ |

#### c64_stream

Grouped entry point for starting and stopping Ultimate streaming sessions.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `start` | Start an Ultimate streaming session. The device sends an unencrypted UDP stream to the target (IPv4 address or hostname, optional :port). | `stream`, `target` | — | ✅ |  |  |
| `stop` | Stop an active Ultimate streaming session. | `stream` | — | ✅ |  |  |

#### c64_system

Grouped entry point for power, reset, menu, and background task control.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `delete_task` | Delete a finished task and its artifacts; stop running tasks first. | `name` | — | ✅ | ✅ | ✅ |
| `list_tasks` | List background tasks with status. | — | — | ✅ | ✅ | ✅ |
| `menu` | Toggle the Ultimate menu button. | — | — | ✅ | ✅ |  |
| `pause` | Pause the machine until resumed. | — | — | ✅ | ✅ | ✅ |
| `performance_report` | Summarize diagnostics spans and tool latencies of the current or latest session. | — | `scope="current"`, `includeTimeline=true`, `maxEntries=25` | ✅ | ✅ | ✅ |
| `power_cycle` | Return the backend to a fresh state. C64U/U64 Tool Menu verification needs machine:menu_screen (U64 3.15+ or supporting C64U firmware); U2-family reboots through REST. | — | `waitForReady=false`, `readyTimeoutMs=15000` | ✅ | ✅ | ✅ |
| `poweroff` | Shut down C64U/U64 or quit VICE. U2-family hardware cannot power off. On C64U/U64 software cannot restart it: power must be restored at the outlet, and it starts by itself only if automatic startup on power restoration is enabled. | — | — | ✅ |  | ✅ |
| `read_menu_screen` | Read the active Ultimate menu's raw character and colour matrix through machine:menu_screen (needs firmware support; U64/U2 3.15+). | — | — | ✅ | ✅ |  |
| `reboot` | Trigger a firmware reboot to recover from faults. | — | `waitForReady=false`, `readyTimeoutMs=15000` | ✅ | ✅ | ✅ |
| `reset` | Issue a soft reset without cutting power. | — | `waitForReady=false`, `readyTimeoutMs=15000` | ✅ | ✅ | ✅ |
| `resume` | Resume CPU execution after a pause. | — | — | ✅ | ✅ | ✅ |
| `start_task` | Start a named interval or one-shot task. | `name`, `operation` | `arguments={}`, `intervalMs=1000`, `maxIterations` | ✅ | ✅ | ✅ |
| `stop_all_tasks` | Stop all running tasks and persist state. | — | — | ✅ | ✅ | ✅ |
| `stop_task` | Stop a background task. | `name` | — | ✅ | ✅ | ✅ |
| `task_result` | Status and result of a task. | `name` | `waitMs=0` | ✅ | ✅ | ✅ |

#### c64_vice

VICE resources, snapshots.

| Operation | Description | Required Inputs | Optional Inputs | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- |
| `resource_get` | Read a VICE configuration resource (safe prefixes only). | `name` | — |  |  | ✅ |
| `resource_set` | Write a VICE configuration resource (safe prefixes only). | `name`, `value` | — |  |  | ✅ |
| `snapshot_restore` | Restore snapshot. | `path` | — |  |  | ✅ |
| `snapshot_save` | Save snapshot. | `path` | — |  |  | ✅ |
| `version` | VICE version. | — | — |  |  | ✅ |

### Resources

| Name | Summary |
| --- | --- |
| `c64://guide/index` | Explains how to approach each knowledge bundle and when to consult it. |
| `c64://guide/bootstrap` | Step-by-step rules for safe automation, verification, and rollback on the C64. |
| `c64://guide/fast-paths` | Condensed routing guide for one-call demos, backend switching, and when to prefer orchestration over manual tool composition. |
| `c64://gamedev/index` | Target decision, reading plan by game type, resource table with sizes, and the c64bridge dev loop for games. |
| `c64://gamedev/architecture` | Frame-synchronous loop, state machine, frame and cycle budgets, memory-map templates for stock and REU-streaming games. |
| `c64://gamedev/techniques` | Compact 6502 recipes for the techniques most C64 games need, each with reference projects to study. |
| `c64://gamedev/toolchain` | Assembler and compiler choice, Makefile build, Exomizer packing, VICE and hardware test loop, .cfg and REU image for modern releases. |
| `c64://gamedev/references` | Modern Ultimate projects and classic C64 games mapped to techniques, with licence cautions for reuse. |
| `c64://ultimate/hardware` | Turbo, SID layout, video and palette, REU/UCI presence, model detection and config settings, with fallbacks for stock machines. |
| `c64://ultimate/uci` | UCI register protocol, command targets, file and REU loading, network, palette, safe use and detection. |
| `c64://ultimate/reu` | REU registers, tested level-load and detection routines, DMA behaviour, enabling and preloading an image, streaming levels, graphics and samples. |
| `c64://ultimate/upic` | Cycle-exact border-colour technique for 384x256 16-colour graphics, framebuffer, palette use and limits. |
| `c64://ultimate/multisid` | Verified control recipe per owner configuration (8 SIDs, or 10 with a chip in each socket), address map, range split and mirroring, mixer and pan, UCI LOAD_CONFIG setup and restore, ENV3 detection, sound differences. |
| `c64://ultimate/bench` | Benchmark programs, result block layout, decoding formulas and a step-by-step rerun recipe using only c64bridge tools. |
| `c64://vice/binary-monitor-spec` | Transport framing, single-client constraints, command semantics, and monitor side effects that shape all VICE-backed operations. |
| `c64://basic/spec` | Token definitions, syntax rules, and device I/O guidance for BASIC v2. |
| `c64://basic/pitfalls` | Quickref covering quotation handling, line length, tokenization, variable names, and other BASIC traps. |
| `c64://assembly/6510-spec` | Official opcode matrix, addressing modes, and zero-page strategy for the 6510 CPU. |
| `c64://sound/sid/spec` | Register map, waveform behaviour, and ADSR envelopes for expressive SID playback. |
| `c64://sound/sidwave/spec` | Defines the SIDWAVE interchange format used by the SID composer workflow. |
| `c64://sound/examples` | Music presets with annotated SIDWAVE scores. |
| `c64://sound/examples/chiptune_drive` | Chip arpeggios, gliding pulse lead and drum break |
| `c64://sound/examples/ambient_filter` | Slow pads, filtered bass and ring modulated bells |
| `c64://sound/examples/funk_bass` | Syncopated filter bass, chord chops and sync accents |
| `c64://sound/examples/acid_line` | Acid bass, resonance accents and slides over a four-on-the-floor kick |
| `c64://sound/examples/arp_ballad` | Minor ballad with chord arpeggios and a connected PWM lead |
| `c64://sound/examples/drum_and_bass` | Breakbeats and a pair of detuned Reese bass oscillators |
| `c64://sound/examples/digi_groove` | CIA2 volume digis with syncopated synth bass and arpeggios |
| `c64://sound/examples/metal_sync` | Hard sync, ring modulation, double kick and power chords |
| `c64://sound/examples/stereo_echo` | Two SIDs with stereo echo, ping-pong arpeggios and unison pads |
| `c64://sound/examples/chamber_waltz` | Three independent voices in 3/4 with no percussion |
| `c64://sound/examples/title_fanfare` | Short filtered brass fanfare with timpani and a held cadence |
| `c64://sound/examples/ultisid_orchestra` | Eight SIDs with divided strings, twin echo leads, arps and a drum kit |
| `c64://sound/examples/wall_of_sid` | Nine SIDs and a gradual build to a 27-voice finale |
| `c64://sound/examples/fuer_elise` | Legacy three-voice arrangement of Beethoven’s Bagatelle |
| `c64://sound/sid/file-format` | Explains PSID/RSID headers, metadata blocks, and compatibility notes for imported music. |
| `c64://sound/sid/best-practices` | Captures proven waveforms, ADSR presets, phrasing, and verification workflow for pleasant SID music. |
| `c64://graphics/vic/spec` | Covers raster timing, sprite control, colour RAM, and bitmap modes on the VIC-II. |
| `c64://graphics/character-set` | Character code table mapping PETSCII codes to screen codes, glyphs, and keyboard input. |
| `c64://graphics/petscii/style-guide` | Documents colour palette, readability presets, dithering patterns, and best practices for creating artistic and readable PETSCII displays. |
| `c64://graphics/sprite-charset/best-practices` | Documents sprite and charset workflows, memory layout, VIC-II configuration, common pitfalls, and proven techniques for hardware-accelerated graphics. |
| `c64://memory/map` | Page-by-page breakdown of the 64 KB address space with hardware, ROM, and RAM regions. |
| `c64://memory/zero-page-and-workspace` | Documents zero-page variables, BASIC pointers, and KERNAL workspace addresses. |
| `c64://basic/rom-routines` | Maps BASIC ROM landmarks, reusable interpreter routines, numeric helpers, string helpers, and C64-specific BASIC continuation entries. |
| `c64://kernal/rom-routines` | Maps KERNAL ROM vectors, jump table entries, internal routines, serial/tape/screen services, and reset handlers. |
| `c64://io/spec` | Covers VIC-II, SID, CIA, and system control registers with address ranges and usage notes. |
| `c64://io/cia/spec` | Details CIA 1/2 registers, timers, interrupts, and keyboard matrix layout. |
| `c64://printer/spec` | Covers device setup, control codes, and Ultimate 64 integration for printers. |
| `c64://printer/commodore/text` | Character sets, control codes, and formatting for Commodore MPS text output. |
| `c64://printer/commodore/bitmap` | Details bitmap modes, graphics commands, and data layout for MPS bitmap printing. |
| `c64://printer/epson/text` | Lists ESC/P control codes and formatting advice for Epson FX text output. |
| `c64://printer/epson/bitmap` | Explains bit-image modes, density options, and data packing for Epson bitmap jobs. |
| `c64://printer/prompt-guide` | Reusable prompt templates that drive complex printer jobs through the MCP server. |

### Prompts

| Name | Description |
| --- | --- |
| `assembly-program` | Route 6502/6510 routine requests to the canonical assembly skill. |
| `basic-program` | Route bespoke Commodore BASIC v2 requests to the canonical BASIC skill. |
| `cross-platform-demo` | Route quick visible demo requests to the cross-platform demo skill. |
| `drive-manager` | Route disk-image and drive-state requests to the canonical drive skill. |
| `game-development` | Route requests to write, port or extend a C64 game to the game development skill and the c64://gamedev/index reading plan. |
| `graphics-demo` | Route graphics requests to the canonical graphics skill. |
| `hello-world` | Route ultra-fast hello-world and smoke-test requests to the canonical greeting skill. |
| `memory-debug` | Route reversible memory inspection or patching work to the canonical memory skill. |
| `preset-music-demo` | Route quick recognizable tune requests to the SID music skill. |
| `printer-job` | Route printer work to the canonical printer skill. |
| `sid-music` | Route SID playback and composition work to the canonical SID skill. |

<!-- AUTO-GENERATED:MCP-DOCS-END -->
