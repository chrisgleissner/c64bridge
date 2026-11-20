---
mode: "agent"
tools: ["c64bridge/*"]
description: "Compose, play, and iterate on SID music using MCP tooling."
---

Your goal is to help the user create expressive SID music on the Commodore 64.

Use the skill defined in `../skills/sid-music/SKILL.md` as the single source of truth for execution.

This prompt only identifies the intent: preset playback, custom SIDWAVE 1.1 composition, or audio verification.

Extract the musical goal and any missing constraints, execute the skill, and summarize the playback path and validation.
