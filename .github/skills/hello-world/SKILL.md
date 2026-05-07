---
name: hello-world
description: Run the fastest greeting or smoke-test path across VICE and C64U.
---

## Intent

Use this skill when the user wants the shortest hello-world, greeting, or smoke-test workflow.

## Inputs

- Target backends: `vice`, `c64u`, or both.
- Optional greeting text or message template. Treat explicitly requested on-screen text such as `HELLO WORLD` as literal output to preserve.

## Execution

0. Grouped MCP tools always require `op`. Do not call `c64_program` without it.
1. If `c64_program` is exposed in the current tool set, execute it immediately with `op: "cross_platform_greeting"`.
2. If the current tool set does not expose `c64_program`, immediately delegate the same request to the `C64` agent instead of inspecting repository files, README sections, or MCP manifests.
3. Pass `platforms` only when the user pins a backend or wants a subset of the configured backends.
4. For a single visible VICE greeting, prefer the no-probe fast path: do not request screenshots or monitor-based verification unless the user explicitly asks for them.
5. Pass `messageTemplate` whenever the user specifies the exact text that should appear on screen, including simple phrases such as `HELLO WORLD`. Do not substitute the workflow's default greeting when the prompt implies literal output.
6. On local machines with a graphical session, assume VICE should render in a real visible emulator window. Only expect Xvfb or other headless behavior in CI or when no framebuffer/display session exists.
7. Do not re-read README sections, MCP manifests, or BASIC references before executing unless the request is ambiguous or the workflow fails.
8. Fall back to `.github/skills/basic-program/SKILL.md` only when the user needs custom BASIC logic beyond a static greeting.

## Validation

1. Trust the workflow's structured verification first.
2. For local visible VICE runs, treat the emulator window as the primary confirmation and summarize any reported text matches or screenshot artifacts.
3. Fall back to manual `read_screen` checks only when the user asks for explicit verification or the workflow fails.

## Safety

- Warn if a running session may be overwritten by the demo.
- Do not add manual reset steps unless the workflow fails and the user confirms recovery actions.
