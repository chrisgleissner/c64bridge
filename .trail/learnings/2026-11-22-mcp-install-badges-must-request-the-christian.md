---
title: MCP install badges must request the latest npm release
author: Christian
date: 2026-11-22
branch: main
id: l-1a0a16a8
scope: repo
status: active
src: agent
touches:
  - README.md
---

## Decided

The install badges and manual quick-start examples use `npx --prefer-online -y c64bridge@latest`. The explicit tag selects the registry release even if the launch directory already has an older dependency. The online preference makes npm revalidate the cached registry metadata before resolving the tag.

## Tried and ruled out

In the code: the earlier README badge payloads used bare `npx -y c64bridge`. With c64bridge 1.3.2 installed in the launch directory, MCP reported 1.3.2. The revised launch reported 1.3.3 and read the Ultimate screen with both an empty npm cache and the old installation present.

## Watch out

Package resolution and replacing a client registration are different tests. VS Code stable and Insiders offered Install for a changed payload under the same server name and replaced the registered args. The badge supplies its own target defaults, so preserve a custom environment by editing only the existing command and args. Claude Code rejected a duplicate entry in the same scope. Removing and re-adding that scoped entry with the same environment connected successfully. Visual Studio's installer generator expects a flat JSON payload with a name and transport type.
