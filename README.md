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

It lets you run programs, read and write memory, render graphics, and play sound on a [C64 Ultimate](https://www.commodore.net/), [Ultimate 64](https://ultimate64.com/), or U2-family cartridge. You can also switch to a [VICE](https://vice-emu.sourceforge.io/) emulator session, so one MCP conversation can span hardware and emulation.

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
    - [Backend Configuration: U2-family](#backend-configuration-u2-family)
    - [Backend Configuration: VICE](#backend-configuration-vice)
      - [VICE Window Modes](#vice-window-modes)
      - [Recommended VICE Configurations](#recommended-vice-configurations)
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
      - [c64\_batch](#c64_batch)
      - [c64\_config](#c64_config)
      - [c64\_debug](#c64_debug)
      - [c64\_disk](#c64_disk)
      - [c64\_drive](#c64_drive)
      - [c64\_extract](#c64_extract)
      - [c64\_graphics](#c64_graphics)
      - [c64\_input](#c64_input)
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
2. Point it at C64U/U64 hardware, a U2-family cartridge, VICE, or any configured combination.
3. Let the client call grouped MCP tools such as `c64_program`, `c64_memory`, `c64_graphics`, and `c64_sound`.
4. Switch backends at runtime with `c64_select_backend` when both are configured.

## Features

- Program runners for BASIC, 6510 assembly, and PRG or CRT execution
- Full memory access, including raw reads and writes plus screen polling
- System integration for drives, files, printers, and task orchestration
- SID music tools for playback, composition, generation, and verification
- Built-in knowledge resources and prompts for safer LLM workflows
- Mixed runtime support for `c64u` (C64U/U64), `u2` (U2/U2+/U2+L), and `vice`

## Quick Start

If you want the shortest path, do these four things:

1. Install Node.js 24+ and npm.
2. Start the server.
3. Add backend configuration for C64U/U64, U2-family, VICE, or any combination.
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

The server can run against one or more of:

- C64U/U64 hardware (`c64u`)
- U2, U2+, or U2+L (`u2`)
- VICE (`vice`)

The detailed lookup order, merge rules, backend examples, and override model are in the [Configuration](#configuration) section below.

### 4. Connect from an MCP Client

C64 Bridge ships a single canonical `stdio` entry point that every MCP client uses:

- **VS Code (GitHub Copilot)** — see [VS Code MCP Setup](#vs-code-mcp-setup).
- **Claude Code (CLI and VS Code plugin)** — see [Claude Code](#claude-code).
- **Cursor, Visual Studio, VS Code Insiders** — use the install badges at the top of this README.
- **Any other MCP client** — point it at the same `stdio` server, with the environment variables documented in [Runtime Environment Variable Reference](#runtime-environment-variable-reference) and the registry manifest in [mcp.json](./mcp.json).

The startup command is the same across clients: `npx -y c64bridge@latest` for the published package, or `node scripts/start.mjs` from a local checkout. Select `c64u`, `u2`, or `vice` in the shared [Configuration](#configuration); clients only need the command.

## Configuration

### Configuration File Order

The server reads configuration in this order:

1. `C64BRIDGE_CONFIG`, if it points to a config file
2. `.c64bridge.json` in the project root
3. `~/.c64bridge.json` in the home directory

### Configuration Merge Rules

Configuration is merged per backend section while scanning those files in order.

- The first file that contains each backend section (`c64u`, `u2`, or `vice`) supplies that backend's configuration.
- This allows a project-local `.c64bridge.json` to define `c64u` while `~/.c64bridge.json` defines `u2` or `vice`.

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

### Backend Configuration: U2-family

Use this profile for U2, U2+, and U2+L cartridges:

```json
{
  "u2": {
    "host": "u2",
    "port": 80,
    "networkPassword": "secret"
  }
}
```

Set `C64_MODE=u2` to make this the initial backend. `U2_HOST`, `U2_PORT`, and `U2_PASSWORD` override this profile. U2-family firmware exposes the shared REST subset; it does not provide machine input, debug-register access, power-off, or streaming.

### Backend Configuration: VICE

C64 Bridge can either connect to an already running VICE Binary Monitor or manage a local VICE process for you. The usual managed setup only needs the emulator binary and, when auto-detection cannot find it, the VICE resource directory:

```json
{
  "vice": {
    "exe": "/usr/bin/x64sc",
    "directory": "/usr/local/share/vice"
  }
}
```

- `exe` is optional when `x64sc` or `x64` is on `PATH`. If no explicit binary is configured, the runtime prefers `/usr/local/bin/x64sc` when present, then falls back to `x64sc` or `x64` on `PATH`.
- `directory` is optional. When omitted, C64 Bridge auto-detects a VICE resource directory by looking for the standard C64 ROM set near the emulator binary and in common system locations.
- `host` and `port` are optional and default to `127.0.0.1:6502`, the Binary Monitor endpoint C64 Bridge starts for managed local sessions. On local endpoints, C64 Bridge first tries to reuse an already running monitor before starting its own process.
- `visible`, `warp`, and `args` are optional runtime controls. They can live in JSON config, but most users set their environment-variable equivalents from the MCP client because they are per-session preferences.
- By default, VICE is started lazily on first access. When setting the environment variable `VICE_PREWARM=1`, C64 Bridge starts or connects VICE in the background during MCP startup.
- `VICE_BINARY`, `VICE_DIRECTORY`, `VICE_HOST`, `VICE_PORT`, `VICE_VISIBLE`, `VICE_WARP`, `VICE_ARGS`, and `VICE_PREWARM` override the JSON values without editing config files.

#### VICE Window Modes

Choose the window mode based on where the MCP server runs:

| Mode | Configuration | What happens | Use when |
| --- | --- | --- | --- |
| Visible | `VICE_VISIBLE=true` | VICE opens a normal desktop window. Warp defaults to off. | You are developing locally and want to watch or interact with the emulator. |
| Minimized | `VICE_VISIBLE=true`, `VICE_ARGS="-minimized"` | VICE still runs as a normal desktop app, but its window starts iconified. Binary Monitor operations, screen reads, frame capture, and keyboard input continue to work. | You are using an agent locally and do not want the emulator stealing focus, but still want the option to restore the window. |
| Headless/Xvfb | `VICE_VISIBLE=false` | C64 Bridge launches VICE without a user-facing desktop window, using Xvfb unless disabled. Warp defaults to on. | CI, unattended tests, servers, or any session where no one needs to inspect the emulator window. |

Minimized and headless are not the same thing. Minimized is still a visible desktop session with a real VICE window; it is simply hidden by the window manager at startup. Headless/Xvfb has no user-facing window, so it is better for automation but less convenient when you need to debug by looking at the emulator.

For normal local MCP use, prefer minimized VICE. It avoids focus stealing while preserving the ability to restore the window for visual inspection. Prefer headless/Xvfb for CI and remote or display-less environments.

`FORCE_XVFB=1` forces the Xvfb path even if a graphical session is available. `DISABLE_XVFB=1` disables that fallback and uses the current display, which is mainly useful for troubleshooting display detection.

#### Recommended VICE Configurations

Local agent session, VICE starts minimized:

```json
{
  "servers": {
    "c64bridge": {
      "command": "npx",
      "args": ["-y", "c64bridge@latest"],
      "env": {
        "C64_MODE": "vice",
        "VICE_VISIBLE": "true",
        "VICE_ARGS": "-minimized",
        "VICE_WARP": "false"
      }
    }
  }
}
```

Headless automation, VICE runs without a visible desktop window:

```json
{
  "servers": {
    "c64bridge": {
      "command": "npx",
      "args": ["-y", "c64bridge@latest"],
      "env": {
        "C64_MODE": "vice",
        "VICE_VISIBLE": "false",
        "VICE_WARP": "true"
      }
    }
  }
}
```

If VICE is installed outside the usual search paths, add `VICE_BINARY` and, if ROM/resource auto-detection fails, `VICE_DIRECTORY` to either example.

> [!NOTE]
> VICE supports only the operations marked with a VICE checkmark in the [MCP API Reference](#mcp-api-reference). Unsupported operations return `unsupported_platform`.

### Runtime Backend Switching

Configure any combination of `c64u`, `u2`, and `vice`. C64 Bridge starts on `C64_MODE` (default `c64u`) and keeps every configured backend ready for `c64_select_backend`.

| Profile | Targets | Key limits |
| --- | --- | --- |
| `c64u` | C64 Ultimate, Ultimate 64 | Full Ultimate REST surface, including machine input and streaming. |
| `u2` | U2, U2+, U2+L | Shared REST subset; no machine input, debug registers, power-off, or streaming. |
| `vice` | VICE emulator | Binary Monitor-backed emulator controls; no Ultimate REST API. |

Use `c64://platform/status` to inspect the active backend and available tools. State the target in the same prompt, for example `u2: list drives`, `c64u: run this PRG`, or `vice: write HELLO`. On U2-family cartridges, `c64_system` `power_cycle` uses REST reboot; C64U/U64 uses verified Tool Menu navigation, and VICE starts fresh.

Prompt illustration (issued via Copilot in VS Code, using GPT 5.4 Medium):

```text
c64u: write a small BASIC program that clears the screen and prints HELLO C64U
```

```text
vice: write a small BASIC program that clears the screen and prints HELLO VICE
```

The screenshots below are available for the two backends that provide frame capture. C64U uses streamed video frames; VICE captures and normalizes its display. U2-family cartridges do not provide firmware streaming, so they intentionally have no screenshot row.

| Backend | Screenshot |
| --- | --- |
| C64 Ultimate | ![C64 Ultimate backend switch example](doc/img/backend-switch/hello-c64u.png) |
| U2-family | Frame capture unavailable (no firmware streaming). |
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
- `C64_MODE` forces the initial backend to `c64u`, `u2`, or `vice`; `U2_HOST`, `U2_PORT`, and `U2_PASSWORD` override the selected U2 profile.
- `LOG_LEVEL=debug` enables verbose logging

For VICE-specific overrides such as `VICE_ARGS=-minimized`, `VICE_VISIBLE=false`, or custom VICE paths, use the patterns in [Backend Configuration: VICE](#backend-configuration-vice).

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

Example: start on minimized VICE with a specific ROM or resource directory, plus a hardware fallback that can still be selected instantly at runtime:

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
        "VICE_ARGS": "-minimized",
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
| `C64_MODE` | c64u | — | Select active backend (c64u/U64 hardware, u2/U2-family cartridge, or vice emulator) |
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

#### U2-family

| Variable | Default | JSON Config Key | Description |
| --- | --- | --- | --- |
| `U2_HOST` |  | u2.host | Override the U2/U2+/U2+L host name or IP address when C64_MODE=u2 |
| `U2_PASSWORD` |  | u2.networkPassword | Override the U2-family network password sent as X-Password when C64_MODE=u2 |
| `U2_PORT` |  | u2.port | Override the U2-family REST port when C64_MODE=u2 |

#### VICE Runtime

| Variable | Default | JSON Config Key | Description |
| --- | --- | --- | --- |
| `DISABLE_XVFB` | 0 | — | Set to 1 to disable Xvfb fallback and use the current display only |
| `FORCE_XVFB` | 0 | — | Set to 1 to force managed VICE launches to use Xvfb even when a graphical session is detected |
| `VICE_ARGS` |  | vice.args | Extra command-line arguments forwarded to managed VICE launches, such as -minimized for a visible window that starts iconified |
| `VICE_BINARY` | x64sc | vice.exe | VICE binary to launch for managed emulator sessions and audio capture; automatic search is used only when this override is missing or invalid |
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

## Claude Code

[Claude Code](https://docs.claude.com/en/docs/claude-code/mcp) is supported as a first-class MCP client. It uses the same canonical start command and the same backend [Configuration](#configuration) files and environment variables as every other client — only the discovery file differs.

**Claude Code CLI** — register the published server in one command:

```bash
claude mcp add c64bridge -- npx -y c64bridge@latest
```

Use `--scope user` to make it available across all your projects, or `--scope project` to write a `.mcp.json` next to the current repo. Backend selection (`c64u`, `u2`, or `vice`), host, port, and password come from the same files documented in [Configuration](#configuration); per-shell overrides come from the variables in [Runtime Environment Variable Reference](#runtime-environment-variable-reference).

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
./build test:matrix                                  # full matrix (c64u/mock · vice/mock · vice/device)
./build coverage                                     # merged coverage report
./build coverage:single --platform c64u --target mock
./build check                                        # build + test matrix (no install)
./build rag:rebuild                                  # rebuild RAG embeddings
./build release --version 1.2.3                      # prepare a release
```

> **Starting the MCP server** is not managed by `./build`. Use `npm start` (from source) or `npx -y c64bridge@latest` (published package) as shown in the [Quick Start](#quick-start) section above.

## Documentation

- [DeepWiki](https://deepwiki.com/chrisgleissner/c64bridge) - architecture and implementation overview
- [doc/developer.md](doc/developer.md) - development workflow and RAG details
- [data/context/bootstrap.md](data/context/bootstrap.md) - primer injected ahead of prompts
- [doc/c64u/c64-openapi.yaml](doc/c64u/c64-openapi.yaml) - REST surface (OpenAPI 3.1)
- [AGENTS.md](AGENTS.md) - LLM-facing quick setup, usage, and personas

## Static MCP Interface

The repository contains an auto-generated static mirror of the MCP server interface in the [./mcp](./mcp) folder.

This allows agents to inspect the available tools, resources, prompts, and schemas without connecting to the server.

## MCP API Reference

<!-- AUTO-GENERATED:MCP-DOCS-START -->

This MCP server exposes **17 tools**, **27 resources**, and **10 prompts** for controlling your Commodore 64.

### Tools

_Address range convention: `address` + `length` means start address plus byte count; `startAddress` + `endAddress` means inclusive bounds._

#### c64_batch

Execute multiple c64bridge tool calls in a single request. Reduces latency for multi-step workflows.

_No operations defined._

#### c64_config

Grouped entry point for configuration reads/writes, diagnostics, and snapshots.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `batch_update` | Apply multiple configuration updates in a single request. | — | — | — | ✅ | ✅ | ✅ |
| `diff` | Compare the current configuration with a snapshot. | `path` | — | — | ✅ | ✅ | ✅ |
| `get` | Read a configuration category or specific item. | `category` | `item` | — | ✅ | ✅ | ✅ |
| `info` | Retrieve Ultimate hardware information and status. | — | — | — | ✅ | ✅ | ✅ |
| `list` | List configuration categories reported by the firmware. | — | — | — | ✅ | ✅ | ✅ |
| `load_flash` | Load configuration from flash storage. | — | — | — | ✅ | ✅ |  |
| `read_debugreg` | Read the Ultimate debug register ($D7FF). | — | — | — | ✅ |  |  |
| `reset_defaults` | Reset firmware configuration to factory defaults. | — | — | — | ✅ | ✅ |  |
| `restore` | Restore configuration from a snapshot file. | `path` | `applyToFlash=false` | — | ✅ | ✅ | ✅ |
| `save_flash` | Persist the current configuration to flash storage. | — | — | — | ✅ | ✅ |  |
| `set` | Write a configuration value in the selected category. | `category`, `item`, `value` | — | — | ✅ | ✅ | ✅ |
| `shuffle` | Discover PRG/CRT files and run each with optional screen capture. | — | `root="/"`, `extensions=["prg","crt"]`, `durationMs=5000`, `captureScreen=true`, `maxPrograms=10`, `outputPath`, `resetDelayMs=100` | — | ✅ | ✅ |  |
| `snapshot` | Snapshot configuration to disk for later restore or diff. | `path` | — | — | ✅ | ✅ | ✅ |
| `version` | Fetch firmware version details. | — | — | — | ✅ | ✅ | ✅ |
| `write_debugreg` | Write a hex value to the Ultimate debug register ($D7FF). | `value` | — | — | ✅ |  |  |

#### c64_debug

Grouped entry point for VICE debugger operations (breakpoints, registers, stepping).

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `continue_execution` | Exit the Binary Monitor and resume CPU execution (BM 0xAA Exit). | — | — | — |  |  | ✅ |
| `create_checkpoint` | Create a new checkpoint (breakpoint) in VICE. | `address` | `endAddress`, `stopOnHit=true`, `enabled=true`, `temporary=false`, `label`, `operations`, `memspace` | — |  |  | ✅ |
| `delete_checkpoint` | Remove a checkpoint by id. | `id` | — | — |  |  | ✅ |
| `get_checkpoint` | Fetch a single checkpoint by id. | `id` | — | — |  |  | ✅ |
| `get_monitor_state` | Read CPU registers and return the current monitor state. | — | `memspace` | — |  |  | ✅ |
| `get_registers` | Read register values, optionally filtered by name or id. | — | `memspace`, `registers` | — |  |  | ✅ |
| `list_checkpoints` | List all active VICE checkpoints (breakpoints). | — | — | — |  |  | ✅ |
| `list_registers` | List available registers (metadata). | — | `memspace` | — |  |  | ✅ |
| `nuclear_reset` | Kill and restart the VICE process (managed instances only). | — | — | — |  |  | ✅ |
| `set_condition` | Attach a conditional expression to a checkpoint. | `id`, `expression` | — | — |  |  | ✅ |
| `set_registers` | Write register values. | `writes` | `memspace` | — |  |  | ✅ |
| `step` | Single-step CPU execution. | — | `count=1`, `mode` | — |  |  | ✅ |
| `step_return` | Continue execution until the current routine returns. | — | — | — |  |  | ✅ |
| `toggle_checkpoint` | Enable or disable a checkpoint by id. | `id`, `enabled` | — | — |  |  | ✅ |
| `wait_for_state` | Poll CPU registers until PC equals expectedPC or timeout elapses. | — | `expectedPC`, `timeoutMs=5000`, `pollMs=100` | — |  |  | ✅ |

#### c64_disk

Grouped entry point for disk mounts, listings, image creation, and program discovery.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `create_image` | Create a blank disk image of the specified format. | `format`, `path` | `diskname`, `tracks` | — | ✅ | ✅ |  |
| `file_info` | Inspect metadata for a file on the Ultimate filesystem. | `path` | — | — | ✅ | ✅ |  |
| `find_and_run` | Search for a PRG/CRT by name substring and run the first match. | `nameContains` | `root="/"`, `extensions`, `caseInsensitive=true`, `sort="discovered"`, `waitMs=0`, `captureCandidates=10` | — | ✅ | ✅ |  |
| `list_drives` | List Ultimate drive slots and their mounted images. | — | — | — | ✅ | ✅ | ✅ |
| `mount` | Mount a disk image with optional verification and retries. | `drive`, `image` | `type`, `attachmentMode`, `driveMode`, `verify=false`, `powerOnIfNeeded=true`, `resetAfterMount=true`, `maxRetries=2`, `retryDelayMs=500` | supports verify | ✅ | ✅ | ✅ |
| `unmount` | Remove the mounted image from an Ultimate drive slot. | `drive` | — | — | ✅ | ✅ | ✅ |

#### c64_drive

Grouped entry point for drive power, mode, reset, and ROM operations.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `load_rom` | Temporarily load a custom ROM into an Ultimate drive slot. | `drive`, `path` | — | — | ✅ | ✅ |  |
| `power_off` | Power off a specific Ultimate drive slot. | `drive` | — | — | ✅ | ✅ | ✅ |
| `power_on` | Power on a specific Ultimate drive slot. | `drive` | — | — | ✅ | ✅ | ✅ |
| `reset` | Issue an IEC reset for the selected drive slot. | `drive` | — | — | ✅ | ✅ | ✅ |
| `set_mode` | Set the emulation mode for a drive slot (1541/1571/1581). | `drive`, `mode` | — | — | ✅ | ✅ | ✅ |

#### c64_extract

Grouped entry point for sprite/charset extraction, memory dumps, filesystem stats, and firmware health checks.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `charset` | Locate and extract 2KB character sets from RAM. | — | `address`, `scanRange="common"`, `outputPath`, `pauseDuringRead=true`, `minNonEmptyChars=32`, `minEntropy=0.3` | — | ✅ |  |  |
| `firmware_health` | Run firmware readiness checks and report status metrics. | — | — | — | ✅ |  |  |
| `fs_stats` | Walk the filesystem and aggregate counts/bytes by extension. | — | `root="/"`, `extensions`, `includeContainers=true`, `maxSamplesPerExtension=3` | — | ✅ |  |  |
| `memory_dump` | Dump a RAM range to hex or binary files with manifest metadata. | `address`, `length`, `outputPath` | `format="hex"`, `chunkSize=512`, `pauseDuringRead=true`, `retries=1` | — | ✅ |  |  |
| `sprites` | Scan RAM for sprites and optionally export .spr files. | `address`, `length` | `stride=64`, `maxSprites=16`, `minNonZeroRows=4`, `minSetBits=12`, `includeBase64=true`, `outputDir`, `pauseDuringRead=true` | — | ✅ |  |  |

#### c64_graphics

Grouped entry point for frame capture and graphics rendering workflows.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `capture_frame` | Capture one or more complete video frames from the active backend. | — | `count=1`, `includePixels=true`, `encoding="base64"` | — | ✅ | ✅ | ✅ |
| `get_display_state` | Read VIC-II and CIA2 registers to determine the current graphics mode and memory layout. The same shared-memory path is used on C64U/U64, U2-family hardware, and VICE, so the response shape is identical. | — | — | — | ✅ | ✅ | ✅ |
| `render_bitmap` | Import an image file, convert it to VIC-II bitmap memory, write it into RAM, and display it. | `imagePath`, `format` | `bitmapAddress=8192`, `screenAddress=1024`, `borderColor=0`, `backgroundColor=0`, `preserveAspect=true` | — | ✅ | ✅ | ✅ |
| `render_petscii_art` | Create PETSCII art from prompts, text, or explicit bitmap data, and optionally display it on the C64. | — | `prompt`, `text`, `maxWidth`, `maxHeight`, `borderColor`, `backgroundColor`, `foregroundColor`, `dryRun=false`, `bitmap` | — | ✅ | ✅ | ✅ |
| `render_petscii_text` | Display PETSCII text with optional border and background colours. | `text` | `borderColor`, `backgroundColor` | — | ✅ | ✅ | ✅ |
| `render_sprite` | Display supplied 63-byte sprite data at the requested position and colour by writing memory and patching VIC-II registers directly. | `sprite` | `index=0`, `x=100`, `y=100`, `color=1`, `multicolour=false` | — | ✅ | ✅ | ✅ |

#### c64_input

Cross-platform PETSCII typing plus native Ultimate keyboard and joystick events.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `joystick` | Simulate joystick input by writing directly to CIA1 Port A/B registers. | `port`, `controls`, `action` | `durationMs=80` | — | ✅ |  | ✅ |
| `key` | Tap a single key or hold it for a duration. | `key` | `durationMs=0`, `count=1` | — | ✅ | ✅ | ✅ |
| `keyboard` | Send physical C64 keyboard matrix events through Ultimate REST input. | `inputs`, `transition` | — | — | ✅ |  |  |
| `release_all` | Release every key and joystick control injected through Ultimate REST input. | — | — | — | ✅ |  |  |
| `state` | Read the keys and joystick controls currently held through Ultimate REST input. | — | — | — | ✅ |  |  |
| `write_text` | Send a text string to the keyboard buffer, with PETSCII token expansion. | `text` | `delayMs=0` | — | ✅ | ✅ | ✅ |

#### c64_memory

Grouped entry point for memory I/O, screen reads, and screen polling.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `compare_memory` | Compare two memory regions byte-by-byte and report differences. | `address1`, `address2`, `length` | `maxDiffs=10` | — | ✅ | ✅ | ✅ |
| `copy_memory` | Copy a RAM region to another address. | `source`, `dest`, `length` | — | — | ✅ | ✅ | ✅ |
| `disassemble` | Disassemble a memory region into annotated 6502/6510 instructions, including undocumented opcodes with canonical names. Symbol annotations from `.vs` files are applied when available. Works on C64U/U64, U2-family hardware, and VICE. | `address` | `length=64`, `instructionCount` | — | ✅ | ✅ | ✅ |
| `fill_memory` | Fill a memory range with a repeating byte pattern. | `address`, `length`, `pattern` | — | — | ✅ | ✅ | ✅ |
| `read` | Read a range of bytes and return a hex dump with address metadata. | `address` | `length=256` | — | ✅ | ✅ | ✅ |
| `read_screen` | Return the current 40x25 text screen converted to ASCII. | — | — | — | ✅ | ✅ | ✅ |
| `save_memory` | Dump a memory range to a local file, with an optional PRG load-address header. | `startAddress`, `endAddress`, `filePath` | `asPrg=true` | — | ✅ | ✅ | ✅ |
| `search_memory` | Search for a byte pattern within a memory range and return matching addresses. | `startAddress`, `endAddress`, `pattern` | `maxResults=10` | — | ✅ | ✅ | ✅ |
| `wait_for_text` | Poll the screen until a substring or regex appears, or timeout elapses. | `pattern` | `isRegex=false`, `caseInsensitive=true`, `timeoutMs=3000`, `intervalMs=100` | — | ✅ | ✅ | ✅ |
| `write` | Write a hexadecimal byte sequence into RAM. | `address`, `bytes` | `verify=false`, `expected`, `mask`, `abortOnMismatch=true` | supports verify | ✅ | ✅ | ✅ |

#### c64_printer

Grouped entry point for Commodore and Epson printing helpers.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `define_chars` | Define custom printer characters (Commodore DLL mode). | `firstChar`, `chars` | `secondaryAddress` | — | ✅ |  |  |
| `print_bitmap` | Print a bitmap row via Commodore (BIM) or Epson ESC/P workflows. | `printer="commodore"`, `columns` | `repeats`, `useSubRepeat`, `secondaryAddress`, `ensureMsb=true`, `mode`, `density`, `timesPerLine` | — | ✅ |  |  |
| `print_text` | Generate BASIC that prints text to device 4. | `text` | `target="commodore"`, `secondaryAddress`, `formFeed=false` | — | ✅ |  |  |

#### c64_program

Grouped entry point for program upload, execution, and batch workflows.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `batch_run` | Run multiple PRG/CRT programs with post-run assertions. | `programs` | `continueOnError=false`, `durationMs=2000`, `outputPath`, `resetDelayMs=100` | — | ✅ | ✅ | ✅ |
| `bundle_run` | Capture screen, memory, and debug registers into an artifact bundle. | `runId`, `outputPath` | `captureScreen=true`, `memoryRanges`, `captureDebugReg=true` | — | ✅ | ✅ |  |
| `cross_platform_greeting` | Show a platform-customized greeting on one or more configured backends, capture screenshots, and verify the results. | — | `platforms=["vice","c64u"]`, `messageTemplate="HAVE A GREAT DAY, {PLATFORM}!"`, `verify=true`, `captureScreenshot=true`, `outputPath`, `restoreActiveBackend=true`, `timeoutMs=1500`, `pollIntervalMs=100` | supports verify | ✅ | ✅ | ✅ |
| `load_prg` | Load a PRG from Ultimate storage without executing it. | `path` | `symbolsFile` | — | ✅ | ✅ |  |
| `run_crt` | Mount and run a CRT cartridge image. | `path` | — | — | ✅ | ✅ |  |
| `run_prg` | Load and execute a PRG from Ultimate-visible storage on C64U/U64 or U2-family hardware, or from a host-local path on VICE. | `path` | `symbolsFile` | — | ✅ | ✅ | ✅ |
| `upload_run_asm` | Assemble 6502/6510 source, upload the PRG, and execute it. | `program` | `verify=false` | supports verify | ✅ | ✅ | ✅ |
| `upload_run_basic` | Upload Commodore BASIC v2 source and execute it immediately. | `program` | `verify=false` | supports verify | ✅ | ✅ | ✅ |

#### c64_rag

Grouped entry point for BASIC and assembly RAG lookups.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `asm` | Retrieve 6502/6510 assembly references from the local knowledge base. | `q` | `k=3` | — | ✅ | ✅ | ✅ |
| `basic` | Retrieve BASIC references and snippets from the local knowledge base. | `q` | `k=3` | — | ✅ | ✅ | ✅ |

#### c64_select_backend

Switch the active backend between C64U/U64 hardware, U2-family cartridges, and the VICE emulator at runtime.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `select` | Switch the active runtime backend without restarting the MCP server. | `backend` | — | — | ✅ | ✅ | ✅ |

#### c64_sound

Grouped entry point for SID control, playback, composition, and analysis workflows.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `analyze` | Automatically analyze SID playback when verification is requested. | `request` | `durationSeconds`, `expectedSidwave` | — | ✅ |  |  |
| `capture_samples` | Capture raw stereo PCM samples from the C64 Ultimate audio UDP stream. | — | `count=256`, `encoding="base64"` | — | ✅ |  |  |
| `compile_play` | Compile SIDWAVE or CPG source and optionally play it immediately. | — | `sidwave`, `cpg`, `format`, `output="prg"`, `dryRun=false` | — | ✅ | ✅ | ✅ |
| `generate` | Generate a lightweight SID arpeggio playback sequence. | — | `root="C4"`, `pattern="0,4,7"`, `steps=16`, `tempoMs=120`, `waveform="tri"`, `preset="classic"` | — | ✅ | ✅ | ✅ |
| `note_off` | Release a SID voice by clearing its gate bit. | `voice` | — | — | ✅ | ✅ | ✅ |
| `note_on` | Trigger a SID voice with configurable waveform, ADSR, and pitch. | — | `voice=1`, `note`, `frequencyHz`, `system="PAL"`, `waveform="pulse"`, `pulseWidth=2048`, `attack=1`, `decay=1`, `sustain=15`, `release=3` | — | ✅ | ✅ | ✅ |
| `pipeline` | Compile a SIDWAVE score, play it, and analyze the recording. | — | `sidwave`, `cpg`, `output="prg"`, `waitBeforeCaptureMs=500`, `analysisDurationSeconds=3`, `expectedSidwave`, `verifySilenceBefore=true`, `verifySilenceAfter=true`, `silenceDurationSeconds=1.5`, `silenceRmsThreshold=0.02`, `postSilenceWaitMs=200`, `silenceWaitMs=150` | supports verify | ✅ | ✅ |  |
| `play_mod_file` | Play a MOD tracker module via the Ultimate SID player. | `path` | — | — | ✅ | ✅ |  |
| `play_preset` | Compile and play a built-in SID preset such as Für Elise by Beethoven. | — | `preset="fuer_elise"`, `platforms`, `verify=true`, `analysisDurationSeconds=4`, `waitBeforeCaptureMs=400`, `restoreActiveBackend=true` | supports verify | ✅ | ✅ | ✅ |
| `play_sid_file` | Play a SID file stored on the Ultimate filesystem. | `path` | `songnr` | — | ✅ | ✅ |  |
| `record_analyze` | Record audio for a fixed duration and return SID analysis metrics. | `durationSeconds` | `expectedSidwave` | — | ✅ |  |  |
| `reset` | Soft or hard reset of SID registers to clear glitches. | — | `hard=false` | — | ✅ | ✅ | ✅ |
| `set_volume` | Set the SID master volume register at $D418 (0-15). | `volume` | — | — | ✅ | ✅ | ✅ |
| `silence_all` | Silence all SID voices with optional audio verification. | — | `verify=false` | supports verify | ✅ | ✅ | ✅ |

#### c64_stream

Grouped entry point for starting and stopping Ultimate streaming sessions.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `start` | Start an Ultimate streaming session toward a host:port target. | `stream`, `target` | — | — | ✅ |  |  |
| `stop` | Stop an active Ultimate streaming session. | `stream` | — | — | ✅ |  |  |

#### c64_system

Grouped entry point for power, reset, menu, and background task control.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `list_tasks` | List known background tasks with status metadata. | — | — | — | ✅ | ✅ | ✅ |
| `menu` | Toggle the Ultimate menu button for navigation. | — | — | — | ✅ | ✅ |  |
| `pause` | Pause the machine until resumed. | — | — | — | ✅ | ✅ |  |
| `performance_report` | Summarize diagnostics spans and tool latencies from the current or latest MCP session. | — | `scope="current"`, `includeTimeline=true`, `maxEntries=25` | — | ✅ | ✅ | ✅ |
| `power_cycle` | Return the active C64U/U64, U2-family cartridge, or VICE backend to a fresh state. | — | — | — | ✅ | ✅ | ✅ |
| `poweroff` | Request a controlled shutdown via the Ultimate firmware. | — | — | — | ✅ | ✅ | ✅ |
| `read_menu_screen` | Read the active Ultimate menu's raw character and colour matrix. | — | — | — | ✅ | ✅ |  |
| `reboot` | Trigger a firmware reboot to recover from faults. | — | — | — | ✅ | ✅ | ✅ |
| `reset` | Issue a soft reset without cutting power. | — | — | — | ✅ | ✅ | ✅ |
| `resume` | Resume CPU execution after a pause. | — | — | — | ✅ | ✅ |  |
| `start_task` | Start a named background task that runs on an interval. | `name`, `operation` | `arguments={}`, `intervalMs=1000`, `maxIterations` | — | ✅ | ✅ | ✅ |
| `stop_all_tasks` | Stop every running background task and persist state. | — | — | — | ✅ | ✅ | ✅ |
| `stop_task` | Stop a specific background task and clear its timer. | `name` | — | — | ✅ | ✅ | ✅ |

#### c64_vice

Grouped entry point for reading and updating selected VICE resources.

| Operation | Description | Required Inputs | Optional Inputs | Notes | C64U | U2 | VICE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `resource_get` | Read a VICE configuration resource (safe prefixes only). | `name` | — | — |  |  | ✅ |
| `resource_set` | Write a VICE configuration resource (safe prefixes only). | `name`, `value` | — | — |  |  | ✅ |

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
| `graphics-demo` | Route graphics requests to the canonical graphics skill. |
| `hello-world` | Route ultra-fast hello-world and smoke-test requests to the canonical greeting skill. |
| `memory-debug` | Route reversible memory inspection or patching work to the canonical memory skill. |
| `preset-music-demo` | Route quick recognizable tune requests to the SID music skill. |
| `printer-job` | Route printer work to the canonical printer skill. |
| `sid-music` | Route SID playback and composition work to the canonical SID skill. |

<!-- AUTO-GENERATED:MCP-DOCS-END -->
