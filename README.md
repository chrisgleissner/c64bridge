# C64 Bridge

![Logo](./doc/img/logo.png)

Your AI Command Bridge for the Commodore 64.

[![npm](https://img.shields.io/npm/v/c64bridge.svg)](https://www.npmjs.com/package/c64bridge)
[![Build](https://img.shields.io/github/actions/workflow/status/chrisgleissner/c64bridge/ci.yaml)](https://github.com/chrisgleissner/c64bridge/actions/workflows/ci.yaml)
[![codecov](https://codecov.io/github/chrisgleissner/c64bridge/graph/badge.svg?token=AS9D41Y5EG)](https://codecov.io/github/chrisgleissner/c64bridge)
[![License: GPL v2](https://img.shields.io/badge/License-GPL%20v2-blue.svg)](https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-forestgreen)](doc/developer.md)

[![Install in VS Code](https://img.shields.io/badge/Install_in-VS_Code-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=io.github.chrisgleissner%2Fc64bridge&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22c64bridge%22%5D%2C%22env%22%3A%7B%22C64_MODE%22%3A%22c64u%22%2C%22C64U_HOST%22%3A%22c64u%22%2C%22VICE_BINARY%22%3A%22%2Fusr%2Flocal%2Fbin%2Fx64sc%22%2C%22VICE_DIRECTORY%22%3A%22%2Fusr%2Flocal%2Fshare%2Fvice%22%2C%22VICE_VISIBLE%22%3A%22true%22%2C%22VICE_WARP%22%3A%22false%22%7D%7D)
[![Install in VS Code Insiders](https://img.shields.io/badge/Install_in-VS_Code_Insiders-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=io.github.chrisgleissner%2Fc64bridge&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22c64bridge%22%5D%2C%22env%22%3A%7B%22C64_MODE%22%3A%22c64u%22%2C%22C64U_HOST%22%3A%22c64u%22%2C%22VICE_BINARY%22%3A%22%2Fusr%2Flocal%2Fbin%2Fx64sc%22%2C%22VICE_DIRECTORY%22%3A%22%2Fusr%2Flocal%2Fshare%2Fvice%22%2C%22VICE_VISIBLE%22%3A%22true%22%2C%22VICE_WARP%22%3A%22false%22%7D%7D&quality=insiders)
[![Install in Visual Studio](https://img.shields.io/badge/Install_in-Visual_Studio-C16FDE?style=flat-square&logo=visualstudio&logoColor=white)](https://vs-open.link/mcp-install?%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22c64bridge%22%5D%2C%22env%22%3A%7B%22C64_MODE%22%3A%22c64u%22%2C%22C64U_HOST%22%3A%22c64u%22%2C%22VICE_BINARY%22%3A%22%2Fusr%2Flocal%2Fbin%2Fx64sc%22%2C%22VICE_DIRECTORY%22%3A%22%2Fusr%2Flocal%2Fshare%2Fvice%22%2C%22VICE_VISIBLE%22%3A%22true%22%2C%22VICE_WARP%22%3A%22false%22%7D%7D)
[![Install in Cursor](https://img.shields.io/badge/Install_in-Cursor-000000?style=flat-square&logoColor=white)](https://cursor.com/en/install-mcp?name=io.github.chrisgleissner%2Fc64bridge&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImM2NGJyaWRnZSJdLCJlbnYiOnsiQzY0X01PREUiOiJjNjR1IiwiQzY0VV9IT1NUIjoiYzY0dSIsIlZJQ0VfQklOQVJZIjoiL3Vzci9sb2NhbC9iaW4veDY0c2MiLCJWSUNFX0RJUkVDVE9SWSI6Ii91c3IvbG9jYWwvc2hhcmUvdmljZSIsIlZJQ0VfVklTSUJMRSI6InRydWUiLCJWSUNFX1dBUlAiOiJmYWxzZSJ9fQ==)
[![Use with Claude Code](https://img.shields.io/badge/Use_with-Claude_Code-D97757?style=flat-square&logo=anthropic&logoColor=white)](#claude-code)

C64 Bridge is an MCP server for controlling and working with a Commodore 64 from an AI client.

It lets you run programs, read and write memory, render graphics, and play sound on a real [Commodore 64 Ultimate](https://www.commodore.net/) or [Ultimate 64](https://ultimate64.com/). You can also switch to a [VICE](https://vice-emu.sourceforge.io/) emulator session at any time, so the same MCP conversation works with both hardware and emulator.

It is built on the official TypeScript `@modelcontextprotocol/sdk` and supports both `stdio` for local AI integration and an optional HTTP bridge for manual inspection.

C64 Bridge is listed in the [Official MCP Registry](https://registry.modelcontextprotocol.io/?q=c64bridge).

## Contents

- [C64 Bridge](#c64-bridge)
  - [Contents](#contents)
  - [Overview](#overview)
  - [Features](#features)
  - [Quick Start](#quick-start)
    - [1. Install Node.js 24+ and npm](#1-install-nodejs-24-and-npm)
    - [2. Start the Server](#2-start-the-server)
    - [3. Add Backend Configuration](#3-add-backend-configuration)
    - [4. Connect from an MCP Client](#4-connect-from-an-mcp-client)
  - [Configuration](#configuration)
    - [Configuration File Order](#configuration-file-order)
    - [Configuration Merge Rules](#configuration-merge-rules)
    - [Backend Configuration: C64 Ultimate](#backend-configuration-c64-ultimate)
    - [Backend Configuration: VICE](#backend-configuration-vice)
    - [Runtime Backend Switching](#runtime-backend-switching)
  - [VS Code MCP Setup](#vs-code-mcp-setup)
    - [Enable the C64 Agent](#enable-the-c64-agent)
    - [Optional Overrides](#optional-overrides)
    - [Environment Variables in MCP Client Configs](#environment-variables-in-mcp-client-configs)
    - [Runtime Environment Variable Reference](#runtime-environment-variable-reference)
      - [Server Runtime](#server-runtime)
      - [C64 Ultimate](#c64-ultimate)
      - [VICE Runtime](#vice-runtime)
      - [VICE Audio Capture](#vice-audio-capture)
      - [SID Playback](#sid-playback)
      - [RAG](#rag)
      - [Testing](#testing)
  - [Claude Code](#claude-code)
  - [Example Workflow](#example-workflow)
  - [HTTP Invocation](#http-invocation)
  - [Build and Test](#build-and-test)
  - [Documentation](#documentation)
  - [Static MCP Interface](#static-mcp-interface)
  - [MCP API Reference](#mcp-api-reference)
    - [Tools](#tools)
      - [c64\_config](#c64_config)
      - [c64\_debug](#c64_debug)
      - [c64\_disk](#c64_disk)
      - [c64\_drive](#c64_drive)
      - [c64\_extract](#c64_extract)
      - [c64\_graphics](#c64_graphics)
      - [c64\_memory](#c64_memory)
      - [c64\_printer](#c64_printer)
      - [c64\_program](#c64_program)
      - [c64\_rag](#c64_rag)
      - [c64\_select\_backend](#c64_select_backend)
      - [c64\_sound](#c64_sound)
      - [c64\_stream](#c64_stream)
      - [c64\_system](#c64_system)
      - [c64\_vice](#c64_vice)
    - [Resources](#resources)
    - [Prompts](#prompts)

## Overview

C64 Bridge gives an AI agent one place to drive program execution, memory access, graphics, sound, storage, printer workflows, and knowledge retrieval for a Commodore 64 environment.

The core workflow is simple:

1. Start the MCP server.
2. Point it at C64 Ultimate hardware, VICE, or both.
3. Let the client call grouped MCP tools such as `c64_program`, `c64_memory`, `c64_graphics`, and `c64_sound`.
4. Switch backends at runtime with `c64_select_backend` when both are configured.

## Features

- Program runners for BASIC, 6510 assembly, and PRG or CRT execution
- Full memory access, including raw reads and writes plus screen polling
- System integration for drives, files, printers, and task orchestration
- SID music tools for playback, composition, generation, and verification
- Built-in knowledge resources and prompts for safer LLM workflows
- Mixed runtime support for hardware `c64u` and emulator `vice`

## Quick Start

If you want the shortest path, do these four things:

1. Install Node.js 24+ and npm.
2. Start the server.
3. Add backend configuration for C64 Ultimate, VICE, or both.
4. Connect from VS Code or another MCP client.

### 1. Install Node.js 24+ and npm

Linux (Ubuntu or Debian):

Recommended:

```bash
sudo apt update
sudo apt install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

Fallback:

```bash
sudo apt install -y nodejs npm
```

macOS:

```bash
brew install node@24
brew link --overwrite node@24
```

Windows:

```powershell
# winget
winget install OpenJS.NodeJS.LTS
# or Chocolatey
choco install nodejs-lts -y
```

Verify the installation:

```bash
node --version
```

Expected result: `v24.x`

### 2. Start the Server

Use one of the following entry points.

Run from `npx` with zero setup:

```bash
npx -y c64bridge@latest
```

Run from a local npm install:

```bash
mkdir -p ~/c64bridge && cd ~/c64bridge
npm init -y
npm install c64bridge
node ./node_modules/c64bridge/dist/index.js
```

Run from source for development or testing:

```bash
git clone https://github.com/chrisgleissner/c64bridge.git
cd c64bridge
./build install
npm start
```

On startup, the server probes the selected target, performs connectivity checks, and then announces that it is running on stdio.

### 3. Add Backend Configuration

The server can run against:

- only C64 Ultimate hardware
- only VICE
- both backends in one session, with runtime switching

The detailed lookup order, merge rules, backend examples, and override model are in the [Configuration](#configuration) section below.

### 4. Connect from an MCP Client

C64 Bridge ships a single canonical `stdio` entry point that every MCP client uses:

- **VS Code (GitHub Copilot)** — see [VS Code MCP Setup](#vs-code-mcp-setup).
- **Claude Code (CLI and VS Code plugin)** — see [Claude Code](#claude-code).
- **Cursor, Visual Studio, VS Code Insiders** — use the install badges at the top of this README.
- **Any other MCP client** — point it at the same `stdio` server, with the environment variables documented in [Runtime Environment Variable Reference](#runtime-environment-variable-reference) and the registry manifest in [mcp.json](./mcp.json).

The startup command is the same across clients: `npx -y c64bridge@latest` for the published package, or `node scripts/start.mjs` from a local checkout. Backend selection (`c64u` vs `vice`) and credentials live in the shared [Configuration](#configuration) files and environment variables — clients only need to know the command.

## Configuration

### Configuration File Order

The server reads configuration in this order:

1. `C64BRIDGE_CONFIG`, if it points to a config file
2. `.c64bridge.json` in the project root
3. `~/.c64bridge.json` in the home directory

### Configuration Merge Rules

Configuration is merged per backend section while scanning those files in order.

- The first file that contains a `c64u` section supplies the C64 Ultimate configuration.
- The first file that contains a `vice` section supplies the VICE configuration.
- This allows a project-local `.c64bridge.json` to define `c64u` while `~/.c64bridge.json` defines `vice`, with both backends available at runtime.

### Backend Configuration: C64 Ultimate

Use this for a C64 Ultimate or Ultimate 64:

```json
{
  "c64u": {
    "host": "c64u",
    "port": 80,
    "networkPassword": "secret"
  }
}
```

- If no file is found, the default target is `c64u:80` with no network password.
- `networkPassword` is only needed when you enabled a password in the C64 Ultimate network settings.
- `C64U_HOST`, `C64U_PORT`, and `C64U_PASSWORD` override the configured host, port, and network password.

### Backend Configuration: VICE

Use this for managed VICE launches:

```json
{
  "vice": {
    "exe": "/usr/bin/x64sc",
    "directory": "/usr/local/share/vice"
  }
}
```

- `directory` is optional. When omitted, or when the configured path is invalid, C64 Bridge auto-detects a VICE resource directory by looking for the standard C64 ROM set near the selected emulator binary and in common system locations.
- `VICE_BINARY`, `VICE_DIRECTORY`, `VICE_HOST`, `VICE_PORT`, `VICE_VISIBLE`, `VICE_WARP`, and `VICE_ARGS` override managed VICE startup without editing config files. Valid explicit `VICE_BINARY` and `VICE_DIRECTORY` values are used as-is; automatic search only fills in missing or invalid values.
- If no explicit binary is configured, the runtime prefers `/usr/local/bin/x64sc` when present, then falls back to `x64sc` or `x64` on `PATH` so the same setup remains portable across operating systems.

> [!NOTE]
> VICE supports only the operations marked with a VICE checkmark in the [MCP API Reference](#mcp-api-reference). Unsupported operations return `unsupported_platform`.

### Runtime Backend Switching

When both `c64u` and `vice` are configured, C64 Bridge starts with one active backend and keeps the other available for runtime switching.

- `C64_MODE` chooses the initial backend: `c64u` or `vice`
- `c64_select_backend` switches backends without restarting the MCP server
- `c64://platform/status` reports the active backend and the full configured backend set
- In prompts, say things like `use vice`, `vice: run this program`, `use c64u`, or `run this on the real machine`
- In VS Code, include the backend preference in the same prompt when you want to force emulator versus hardware execution

Prompt illustration (issued via Copilot in VS Code, using GPT 5.4 Medium):

```text
c64u: write a small BASIC program that clears the screen and prints HELLO C64U
vice: write a small BASIC program that clears the screen and prints HELLO VICE
```

The screenshots below were captured from actual backend bitmap responses after those prompts ran, using the same `c64_graphics` `capture_frame` MCP tool on both backends. The C64U implementation captures streamed video frames, while the VICE implementation captures and normalizes the emulator display frame. Both images were then verified optically against the expected text with the C64 character generator, and both matched exactly.

| Backend | Screenshot |
| --- | --- |
| C64 Ultimate | ![C64 Ultimate backend switch example](doc/img/backend-switch/hello-c64u.png) |
| VICE | ![VICE backend switch example](doc/img/backend-switch/hello-vice.png) |

## VS Code MCP Setup

This section covers the GitHub Copilot integration that ships with VS Code. For the Claude Code VS Code plugin, see [Claude Code](#claude-code) — it reads `.mcp.json`, not `.vscode/mcp.json`.

If this repository is checked out locally, open the prepared [.vscode/mcp.json](./.vscode/mcp.json).

Otherwise, put the following into your own `.vscode/mcp.json`:

```json
{
  "servers": {
    "c64bridge": {
      "command": "npx",
      "args": [
        "-y",
        "c64bridge@latest"
      ]
    }
  }
}
```

Then click the start button shown above the `c64bridge` entry.

Your MCP server should now be running:

![VS Code Started MCP server](./doc/img/vscode/vscode-started-mcp-server.png)

For more details, see the official [VS Code MCP Server documentation](https://code.visualstudio.com/docs/copilot/customization/mcp-servers).

### Enable the C64 Agent

After the server is running, switch to the `C64` agent in VS Code.

This agent is preconfigured for Commodore 64 work. It steers Copilot toward `c64bridge` workflows for BASIC, 6502 assembly, SID audio, VIC-II graphics, memory inspection, disk operations, printing, streaming, and device control.

![VS Code C64 agent](./doc/img/vscode/vscode-copilot-c64-agent.png)

### Optional Overrides

You can add `env` entries in `.vscode/mcp.json` to select a config file, override C64 Ultimate connection details, or force an initial backend:

```json
{
  "servers": {
    "c64bridge": {
      "command": "npx",
      "args": [
        "-y",
        "c64bridge@latest"
      ],
      "env": {
        "C64BRIDGE_CONFIG": "/home/you/.c64bridge.json",
        "C64U_HOST": "192.168.1.99",
        "C64U_PORT": "80",
        "C64U_PASSWORD": "secret",
        "C64_MODE": "c64u",
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

- `C64BRIDGE_CONFIG` points to a specific config file
- `C64U_HOST`, `C64U_PORT`, and `C64U_PASSWORD` override the C64 Ultimate connection without editing config files
- `C64_MODE` forces the initial backend to `c64u` or `vice`
- `LOG_LEVEL=debug` enables verbose logging

### Environment Variables in MCP Client Configs

Every runtime environment variable documented in the root [mcp.json](./mcp.json) can be supplied by your MCP client configuration, including `.vscode/mcp.json` under `servers.c64bridge.env`.

When an environment variable maps to a JSON config field, the override order is always:

1. the explicit environment variable from your MCP client config or shell
2. the merged JSON config section loaded from `C64BRIDGE_CONFIG`, the repo `.c64bridge.json`, then `~/.c64bridge.json`
3. the built-in default compiled into the server

When an environment variable has no JSON config equivalent, the order is:

1. the explicit environment variable from your MCP client config or shell
2. the built-in default

That rule applies uniformly across the documented runtime environment variables below.

Example: visible VICE with a specific ROM or resource directory, plus a hardware fallback that can still be selected instantly at runtime:

```json
{
  "servers": {
    "c64bridge": {
      "command": "node",
      "args": ["${workspaceFolder}/scripts/start.mjs"],
      "type": "stdio",
      "env": {
        "C64_MODE": "vice",
        "C64U_HOST": "c64u",
        "C64U_PORT": "80",
        "VICE_BINARY": "/usr/local/bin/x64sc",
        "VICE_DIRECTORY": "/usr/local/share/vice",
        "VICE_VISIBLE": "true",
        "VICE_WARP": "false"
      }
    }
  }
}
```

Example: keep JSON config files for backend endpoints, but override diagnostics, polling, and RAG behavior from VS Code:

```json
{
  "servers": {
    "c64bridge": {
      "command": "node",
      "args": ["${workspaceFolder}/scripts/start.mjs"],
      "type": "stdio",
      "env": {
        "C64BRIDGE_CONFIG": "/home/you/.c64bridge.json",
        "LOG_LEVEL": "debug",
        "C64BRIDGE_POLL_MAX_MS": "8000",
        "C64BRIDGE_POLL_INTERVAL_MS": "200",
        "RAG_BUILD_ON_START": "1",
        "RAG_EMBEDDINGS_DIR": "/home/you/c64bridge-data"
      }
    }
  }
}
```

### Runtime Environment Variable Reference

<!-- AUTO-GENERATED:ENV-VARS-START -->

Every runtime environment variable documented in `mcp.json` can be set in your MCP client configuration, including `.vscode/mcp.json` under `servers.c64bridge.env`.

#### Server Runtime

| Variable | Default | JSON Config Key | Description |
| --- | --- | --- | --- |
| `C64_MODE` | c64u | — | Select active backend (c64u for Ultimate hardware, vice for emulator) |
| `C64_TASK_STATE_FILE` | auto | — | Override the path used to persist MCP background-task state |
| `C64BRIDGE_CONFIG` | ~/.c64bridge.json | config path | Path to configuration JSON |
| `C64BRIDGE_DIAGNOSTICS_DIR` | ~/.c64bridge/diagnostics | — | Override the directory where persistent MCP diagnostics files are written |
| `C64BRIDGE_DISABLE_DIAGNOSTICS` | 0 | — | Set to 1 to disable persistent diagnostics logging |
| `C64BRIDGE_POLL_INTERVAL_MS` | 200 | — | Interval between screen polls during program-output validation in normal runtime mode |
| `C64BRIDGE_POLL_MAX_MS` | 2000 | — | Maximum time to poll for program-output validation before timing out in normal runtime mode |
| `C64BRIDGE_POLL_STABILIZE_MS` | 100 | — | Extra settle time after a successful poll match before considering output stable |
| `LOG_LEVEL` | info | — | Logger verbosity (debug, info, warn, error) |

#### C64 Ultimate

| Variable | Default | JSON Config Key | Description |
| --- | --- | --- | --- |
| `C64U_HOST` | c64u | c64u.host | Override the C64 Ultimate host name or IP address |
| `C64U_PASSWORD` |  | c64u.networkPassword | Override the C64 Ultimate network password sent as X-Password |
| `C64U_PORT` | 80 | c64u.port | Override the C64 Ultimate REST port |

#### VICE Runtime

| Variable | Default | JSON Config Key | Description |
| --- | --- | --- | --- |
| `DISABLE_XVFB` | 0 | — | Set to 1 to disable Xvfb fallback and use the current display only |
| `FORCE_XVFB` | 0 | — | Set to 1 to force managed VICE launches to run under Xvfb |
| `VICE_ARGS` |  | vice.args | Extra command-line arguments forwarded to managed VICE launches |
| `VICE_BINARY` | x64sc | vice.exe | VICE binary to launch for managed emulator sessions and audio capture; automatic search is used only when this override is missing or invalid |
| `VICE_DIRECTORY` | auto-detect | vice.directory | Override the VICE resource directory used for ROM and UI asset discovery; automatic search is used only when this override is missing or invalid |
| `VICE_HOST` | 127.0.0.1 | vice.host | Override the VICE Binary Monitor host |
| `VICE_PORT` | 6502 | vice.port | Override the VICE Binary Monitor port |
| `VICE_VISIBLE` | true | vice.visible | Launch VICE visibly on the desktop instead of headless/Xvfb when possible |
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

## Claude Code

[Claude Code](https://docs.claude.com/en/docs/claude-code/mcp) is supported as a first-class MCP client. It uses the same canonical start command and the same backend [Configuration](#configuration) files and environment variables as every other client — only the discovery file differs.

**Claude Code CLI** — register the published server in one command:

```bash
claude mcp add c64bridge -- npx -y c64bridge@latest
```

Use `--scope user` to make it available across all your projects, or `--scope project` to write a `.mcp.json` next to the current repo. Backend selection (`c64u` vs `vice`), host, port, and password come from the same files documented in [Configuration](#configuration); per-shell overrides come from the variables in [Runtime Environment Variable Reference](#runtime-environment-variable-reference).

**Project-scoped discovery** — this repository ships a checked-in [.mcp.json](./.mcp.json) that points Claude Code at the local source via `node scripts/start.mjs`. When you open the repo with `claude` (CLI or VS Code plugin), Claude Code prompts to enable the project-scoped server on first run. Approve it once and the `c64_*` tools become discoverable in that workspace.

**Claude Code VS Code plugin** — the plugin reads the same `.mcp.json` and the same user-scope `claude mcp add` registrations as the CLI. No extra setup is required beyond installing the plugin and approving the project server prompt. The existing [.vscode/mcp.json](./.vscode/mcp.json) is read by GitHub Copilot, not by Claude Code; the two files coexist without conflict because they target different clients with different config schemas.

**Verify it works** — after registration, run `claude mcp list` (CLI) or open the MCP panel (plugin) and look for `c64bridge`. Then ask Claude Code something like *“use vice: write a small BASIC program that clears the screen and prints HELLO CLAUDE”* — it should call `c64_select_backend` and `c64_program` directly. If tools do not appear, confirm Node 24+ is on `PATH`, that the server was approved at the requested scope, and that the backend is reachable per the [Configuration](#configuration) section.

## Example Workflow

Compose a children’s song with ChatGPT and VS Code:

![duck song](./doc/img/prompts/duck_song.png)

Then render PETSCII art for it:

![duck petscii](./doc/img/prompts/duck_petscii.png)

This is representative of the intended workflow:

1. Ask the MCP client to generate or refine C64-oriented content.
2. Use grouped tools such as `c64_program`, `c64_graphics`, and `c64_sound` to execute it.
3. Verify the result via screen reads, frame capture, memory inspection, or audio analysis.

## HTTP Invocation

- Preferred transport is `stdio`.
- The HTTP bridge is disabled by default and is intended only for manual testing.
- The following curl commands are illustrative so you can see what grouped MCP calls look like over HTTP.

```bash
# Upload and run BASIC
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"op":"upload_run_basic","program":"10 PRINT \"HELLO\"\n20 GOTO 10"}' \
  http://localhost:8000/tools/c64_program | jq

# Read current screen (PETSCII→ASCII)
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"op":"read_screen"}' \
  http://localhost:8000/tools/c64_memory | jq

# Reset the machine
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"op":"reset"}' \
  http://localhost:8000/tools/c64_system
```

## Build and Test

The [`./build`](./build) script at the project root wraps all development tasks behind a single, self-documented interface:

```bash
./build --help                                       # full command reference
./build                                              # install + build + test matrix (full CI run)
./build --skip-tests                                 # install + build only
./build build                                        # TypeScript compile + doc generation
./build test                                         # integration tests (mock backend)
./build test --real                                  # test against real hardware
./build test --platform vice --target mock           # single test leg
./build test:vice:mock                               # curated VICE mock matrix (feature-matrix coverage)
./build test:vice:device                             # curated real-VICE validation (device backend + smoke, headless/Xvfb by default)
./build test:matrix                                  # full matrix (c64u/mock · vice/mock · vice/device)
./build coverage                                     # merged coverage report
./build coverage:single --platform c64u --target mock
npm run vice:smoke                                   # direct VICE binary-monitor smoke test
npm run vice:smoke:visible                           # human-visible VICE boot + HELLO demo (keeps window open)
./build check                                        # build + test matrix (no install)
./build rag:rebuild                                  # rebuild RAG embeddings
./build release --version 1.2.3                      # prepare a release
```

The visible smoke demo accepts `true`/`false`, `on`/`off`, and `1`/`0` for `VICE_VISIBLE`, `VICE_WARP`, and `VICE_KEEP_OPEN`. `npm run vice:smoke:visible` forces a visible, warp-off session, waits for a stable `READY.` screen, then injects `HELLO` and keeps the window open for inspection.

Automation note: `npm run test:vice:device` and `./build` force the real-VICE validation leg into headless/Xvfb mode so the CI-style matrix does not open a confusing local emulator window.

> **Starting the MCP server** is not managed by `./build`. Use `npm start` (from source) or `npx -y c64bridge@latest` (published package) as shown in the [Quick Start](#quick-start) section above.

## Documentation

- [doc/developer.md](doc/developer.md) — development workflow and RAG details
- [data/context/bootstrap.md](data/context/bootstrap.md) — primer injected ahead of prompts
- [doc/c64u/c64-openapi.yaml](doc/c64u/c64-openapi.yaml) — REST surface (OpenAPI 3.1)
- [AGENTS.md](AGENTS.md) — LLM-facing quick setup, usage, and personas

## Static MCP Interface

The repository contains an auto-generated static mirror of the MCP server interface in the [./mcp](./mcp) folder.

This allows agents to inspect the available tools, resources, prompts, and schemas without connecting to the server.

## MCP API Reference

<!-- AUTO-GENERATED:MCP-DOCS-START -->

This MCP server exposes **15 tools**, **26 resources**, and **10 prompts** for controlling your Commodore 64.

### Tools

#### c64_config

Grouped entry point for configuration reads/writes, diagnostics, and snapshots.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `batch_update` | Apply multiple configuration updates in a single request. | — | — | ✅ | ✅ |
| `diff` | Compare the current configuration with a snapshot. | — | — | ✅ | ✅ |
| `get` | Read a configuration category or specific item. | — | — | ✅ | ✅ |
| `info` | Retrieve Ultimate hardware information and status. | — | — | ✅ | ✅ |
| `list` | List configuration categories reported by the firmware. | — | — | ✅ | ✅ |
| `load_flash` | Load configuration from flash storage. | — | — | ✅ |  |
| `read_debugreg` | Read the Ultimate debug register ($D7FF). | — | — | ✅ |  |
| `reset_defaults` | Reset firmware configuration to factory defaults. | — | — | ✅ |  |
| `restore` | Restore configuration from a snapshot file. | — | — | ✅ | ✅ |
| `save_flash` | Persist the current configuration to flash storage. | — | — | ✅ |  |
| `set` | Write a configuration value in the selected category. | — | — | ✅ | ✅ |
| `shuffle` | Discover PRG/CRT files and run each with optional screen capture. | — | — | ✅ |  |
| `snapshot` | Snapshot configuration to disk for later restore or diff. | — | — | ✅ | ✅ |
| `version` | Fetch firmware version details. | — | — | ✅ | ✅ |
| `write_debugreg` | Write a hex value to the Ultimate debug register ($D7FF). | — | — | ✅ |  |

#### c64_debug

Grouped entry point for VICE debugger operations (breakpoints, registers, stepping).

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `create_checkpoint` | Create a new checkpoint (breakpoint) in VICE. | — | — |  | ✅ |
| `delete_checkpoint` | Remove a checkpoint by id. | — | — |  | ✅ |
| `get_checkpoint` | Fetch a single checkpoint by id. | — | — |  | ✅ |
| `get_registers` | Read register values, optionally filtered by name or id. | — | — |  | ✅ |
| `list_checkpoints` | List all active VICE checkpoints (breakpoints). | — | — |  | ✅ |
| `list_registers` | List available registers (metadata). | — | — |  | ✅ |
| `set_condition` | Attach a conditional expression to a checkpoint. | — | — |  | ✅ |
| `set_registers` | Write register values. | — | — |  | ✅ |
| `step` | Single-step CPU execution. | — | — |  | ✅ |
| `step_return` | Continue execution until the current routine returns. | — | — |  | ✅ |
| `toggle_checkpoint` | Enable or disable a checkpoint by id. | — | — |  | ✅ |

#### c64_disk

Grouped entry point for disk mounts, listings, image creation, and program discovery.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `create_image` | Create a blank disk image of the specified format. | — | supports verify | ✅ |  |
| `file_info` | Inspect metadata for a file on the Ultimate filesystem. | — | supports verify | ✅ |  |
| `find_and_run` | Search for a PRG/CRT by name substring and run the first match. | — | supports verify | ✅ |  |
| `list_drives` | List Ultimate drive slots and their mounted images. | — | supports verify | ✅ | ✅ |
| `mount` | Mount a disk image with optional verification and retries. | — | supports verify | ✅ | ✅ |
| `unmount` | Remove the mounted image from an Ultimate drive slot. | — | supports verify | ✅ | ✅ |

#### c64_drive

Grouped entry point for drive power, mode, reset, and ROM operations.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `load_rom` | Temporarily load a custom ROM into an Ultimate drive slot. | — | — | ✅ |  |
| `power_off` | Power off a specific Ultimate drive slot. | — | — | ✅ | ✅ |
| `power_on` | Power on a specific Ultimate drive slot. | — | — | ✅ | ✅ |
| `reset` | Issue an IEC reset for the selected drive slot. | — | — | ✅ | ✅ |
| `set_mode` | Set the emulation mode for a drive slot (1541/1571/1581). | — | — | ✅ | ✅ |

#### c64_extract

Grouped entry point for sprite/charset extraction, memory dumps, filesystem stats, and firmware health checks.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `charset` | Locate and extract 2KB character sets from RAM. | — | — | ✅ |  |
| `firmware_health` | Run firmware readiness checks and report status metrics. | — | — | ✅ |  |
| `fs_stats` | Walk the filesystem and aggregate counts/bytes by extension. | — | — | ✅ |  |
| `memory_dump` | Dump a RAM range to hex or binary files with manifest metadata. | — | — | ✅ |  |
| `sprites` | Scan RAM for sprites and optionally export .spr files. | — | — | ✅ |  |

#### c64_graphics

Grouped entry point for frame capture and graphics rendering workflows.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `capture_frame` | Capture one or more complete video frames from the active backend. | — | — | ✅ | ✅ |
| `render_bitmap` | Import an image file, convert it to VIC-II bitmap memory, write it into RAM, and display it. | — | — | ✅ | ✅ |
| `render_petscii_art` | Create PETSCII art from prompts, text, or explicit bitmap data, and optionally display it on the C64. | — | — | ✅ | ✅ |
| `render_petscii_text` | Display PETSCII text with optional border and background colours. | — | — | ✅ | ✅ |
| `render_sprite` | Display supplied 63-byte sprite data at the requested position and colour by writing memory and patching VIC-II registers directly. | — | — | ✅ | ✅ |

#### c64_memory

Grouped entry point for memory I/O, screen reads, and screen polling.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `read` | Read a range of bytes and return a hex dump with address metadata. | — | supports verify | ✅ | ✅ |
| `read_screen` | Return the current 40x25 text screen converted to ASCII. | — | supports verify | ✅ | ✅ |
| `wait_for_text` | Poll the screen until a substring or regex appears, or timeout elapses. | — | supports verify | ✅ | ✅ |
| `write` | Write a hexadecimal byte sequence into RAM. | — | supports verify | ✅ | ✅ |

#### c64_printer

Grouped entry point for Commodore and Epson printing helpers.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `define_chars` | Define custom printer characters (Commodore DLL mode). | — | — | ✅ |  |
| `print_bitmap` | Print a bitmap row via Commodore (BIM) or Epson ESC/P workflows. | — | — | ✅ |  |
| `print_text` | Generate BASIC that prints text to device 4. | — | — | ✅ |  |

#### c64_program

Grouped entry point for program upload, execution, and batch workflows.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `batch_run` | Run multiple PRG/CRT programs with post-run assertions. | — | supports verify | ✅ | ✅ |
| `bundle_run` | Capture screen, memory, and debug registers into an artifact bundle. | — | supports verify | ✅ |  |
| `cross_platform_greeting` | Show a platform-customized greeting on one or more configured backends, capture screenshots, and verify the results. | — | supports verify | ✅ | ✅ |
| `load_prg` | Load a PRG from Ultimate storage without executing it. | — | supports verify | ✅ |  |
| `run_crt` | Mount and run a CRT cartridge image. | — | supports verify | ✅ |  |
| `run_prg` | Load and execute a PRG from Ultimate-visible storage on c64u or a host-local path on VICE. | — | supports verify | ✅ | ✅ |
| `upload_run_asm` | Assemble 6502/6510 source, upload the PRG, and execute it. | — | supports verify | ✅ | ✅ |
| `upload_run_basic` | Upload Commodore BASIC v2 source and execute it immediately. | — | supports verify | ✅ | ✅ |

#### c64_rag

Grouped entry point for BASIC and assembly RAG lookups.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `asm` | Retrieve 6502/6510 assembly references from the local knowledge base. | — | — | ✅ | ✅ |
| `basic` | Retrieve BASIC references and snippets from the local knowledge base. | — | — | ✅ | ✅ |

#### c64_select_backend

Switch the active backend between C64U hardware and the VICE emulator at runtime.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `select` | Switch the active runtime backend without restarting the MCP server. | — | — | ✅ | ✅ |

#### c64_sound

Grouped entry point for SID control, playback, composition, and analysis workflows.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `analyze` | Automatically analyze SID playback when verification is requested. | — | supports verify | ✅ |  |
| `capture_samples` | Capture raw stereo PCM samples from the C64 Ultimate audio UDP stream. | — | supports verify | ✅ |  |
| `compile_play` | Compile SIDWAVE or CPG source and optionally play it immediately. | — | supports verify | ✅ | ✅ |
| `generate` | Generate a lightweight SID arpeggio playback sequence. | — | supports verify | ✅ | ✅ |
| `note_off` | Release a SID voice by clearing its gate bit. | — | supports verify | ✅ | ✅ |
| `note_on` | Trigger a SID voice with configurable waveform, ADSR, and pitch. | — | supports verify | ✅ | ✅ |
| `pipeline` | Compile a SIDWAVE score, play it, and analyze the recording. | — | supports verify | ✅ |  |
| `play_mod_file` | Play a MOD tracker module via the Ultimate SID player. | — | supports verify | ✅ |  |
| `play_preset` | Compile and play a built-in SID preset such as Für Elise by Beethoven. | — | supports verify | ✅ | ✅ |
| `play_sid_file` | Play a SID file stored on the Ultimate filesystem. | — | supports verify | ✅ |  |
| `record_analyze` | Record audio for a fixed duration and return SID analysis metrics. | — | supports verify | ✅ |  |
| `reset` | Soft or hard reset of SID registers to clear glitches. | — | supports verify | ✅ | ✅ |
| `set_volume` | Set the SID master volume register at $D418 (0-15). | — | supports verify | ✅ | ✅ |
| `silence_all` | Silence all SID voices with optional audio verification. | — | supports verify | ✅ | ✅ |

#### c64_stream

Grouped entry point for starting and stopping Ultimate streaming sessions.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `start` | Start an Ultimate streaming session toward a host:port target. | — | — | ✅ |  |
| `stop` | Stop an active Ultimate streaming session. | — | — | ✅ |  |

#### c64_system

Grouped entry point for power, reset, menu, and background task control.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `list_tasks` | List known background tasks with status metadata. | — | — | ✅ | ✅ |
| `menu` | Toggle the Ultimate menu button for navigation. | — | — | ✅ |  |
| `pause` | Pause the machine until resumed. | — | — | ✅ |  |
| `performance_report` | Summarize diagnostics spans and tool latencies from the current or latest MCP session. | — | — | ✅ | ✅ |
| `poweroff` | Request a controlled shutdown via the Ultimate firmware. | — | — | ✅ | ✅ |
| `reboot` | Trigger a firmware reboot to recover from faults. | — | — | ✅ | ✅ |
| `reset` | Issue a soft reset without cutting power. | — | — | ✅ | ✅ |
| `resume` | Resume CPU execution after a pause. | — | — | ✅ |  |
| `start_task` | Start a named background task that runs on an interval. | — | — | ✅ | ✅ |
| `stop_all_tasks` | Stop every running background task and persist state. | — | — | ✅ | ✅ |
| `stop_task` | Stop a specific background task and clear its timer. | — | — | ✅ | ✅ |

#### c64_vice

Grouped entry point for reading and updating selected VICE resources.

| Operation | Description | Required Inputs | Notes | C64U | VICE |
| --- | --- | --- | --- | --- | --- |
| `resource_get` | Read a VICE configuration resource (safe prefixes only). | — | — |  | ✅ |
| `resource_set` | Write a VICE configuration resource (safe prefixes only). | — | — |  | ✅ |

### Resources

| Name | Summary |
| --- | --- |
| `c64://guide/index` | Explains how to approach each knowledge bundle and when to consult it. |
| `c64://guide/bootstrap` | Step-by-step rules for safe automation, verification, and rollback on the C64. |
| `c64://guide/fast-paths` | Condensed routing guide for one-call demos, backend switching, and when to prefer orchestration over manual tool composition. |
| `c64://vice/binary-monitor-spec` | Transport framing, single-client constraints, command semantics, and monitor side effects that shape all VICE-backed operations. |
| `c64://basic/spec` | Token definitions, syntax rules, and device I/O guidance for BASIC v2. |
| `c64://basic/pitfalls` | Quickref covering quotation handling, line length, tokenization, variable names, and other BASIC traps. |
| `c64://assembly/6510-spec` | Official opcode matrix, addressing modes, and zero-page strategy for the 6510 CPU. |
| `c64://sound/sid/spec` | Register map, waveform behaviour, and ADSR envelopes for expressive SID playback. |
| `c64://sound/sidwave/spec` | Defines the SIDWAVE interchange format used by the SID composer workflow. |
| `c64://sound/sid/file-format` | Explains PSID/RSID headers, metadata blocks, and compatibility notes for imported music. |
| `c64://sound/sid/best-practices` | Captures proven waveforms, ADSR presets, phrasing, and verification workflow for pleasant SID music. |
| `c64://graphics/vic/spec` | Covers raster timing, sprite control, colour RAM, and bitmap modes on the VIC-II. |
| `c64://graphics/character-set` | Character code table mapping PETSCII codes to screen codes, glyphs, and keyboard input. |
| `c64://graphics/petscii/style-guide` | Documents colour palette, readability presets, dithering patterns, and best practices for creating artistic and readable PETSCII displays. |
| `c64://graphics/sprite-charset/best-practices` | Documents sprite and charset workflows, memory layout, VIC-II configuration, common pitfalls, and proven techniques for hardware-accelerated graphics. |
| `c64://memory/map` | Page-by-page breakdown of the 64 KB address space with hardware, ROM, and RAM regions. |
| `c64://memory/zero-page-and-workspace` | Documents zero-page variables, BASIC pointers, and KERNAL workspace addresses. |
| `c64://kernal/rom-routines` | Lists KERNAL ROM vectors and service routines for OS-level functionality. |
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
| `graphics-demo` | Route graphics requests to the canonical graphics skill. |
| `hello-world` | Route ultra-fast hello-world and smoke-test requests to the canonical greeting skill. |
| `memory-debug` | Route reversible memory inspection or patching work to the canonical memory skill. |
| `preset-music-demo` | Route quick recognizable tune requests to the SID music skill. |
| `printer-job` | Route printer work to the canonical printer skill. |
| `sid-music` | Route SID playback and composition work to the canonical SID skill. |

<!-- AUTO-GENERATED:MCP-DOCS-END -->
