---
name: cross-platform-demo
description: Use when the user wants a quick visible greeting or smoke test on VICE and/or C64U with screenshot or text verification.
---

## Intent

Use this skill for quick greetings, smoke tests, and visible confirmation that one or more backends are responding.

## Inputs

- Target backends: `vice`, `c64u`, or both.
- Optional message template when the default greeting is not sufficient.

## Execution

0. Grouped MCP tools always require `op`. Do not call `c64_program` without it.
1. Execute `c64_program` with `op: "cross_platform_greeting"`.
2. Pass `platforms` only when the user wants a subset of the configured backends.
3. Pass `messageTemplate` only when the user explicitly wants custom text.
4. On local machines with a graphical session, assume VICE should render in a real visible emulator window by default. Only expect Xvfb or other headless behavior in CI or when no framebuffer/display session exists.

## Validation

1. Trust the workflow's structured verification first.
2. Summarize the reported text match results and screenshot paths.
3. Fall back to `.github/skills/basic-program/SKILL.md` only when the user needs custom program flow beyond a simple greeting, not merely because they want to see VICE render live.

## Safety

- Warn if a running session may be overwritten by the demo.
- Do not add manual reset steps unless the workflow fails and the user confirms recovery actions.
