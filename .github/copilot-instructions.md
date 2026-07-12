# Copilot Instructions for c64bridge

This repository contains a Model Context Protocol (MCP) server that drives Commodore 64 Ultimate hardware (C64 Ultimate, Ultimate 64) over its REST API. Keep these guidelines in mind for any changes.

## Project Snapshot

- Language & runtime: TypeScript (ESM) targeting Node.js 18+, with Bun 1.3.1+ for build and test tooling.
- Entry points:
  - Development: `npm start` (runs via Node for MCP stdio server compatibility, loads `src/mcp-server.ts`).
  - Published CLI: `c64bridge` (imports `dist/index.js`).
- Build pipeline: `npm run build` invokes TypeScript compiler and Bun scripts to emit JavaScript into `dist/`, normalize the layout, and refresh README tool/resource tables. No client manifest is required for MCP; `mcp.json` is human-maintained metadata used by packaging.
- Test pipeline: `npm run test:matrix` runs the full mock and VICE suites via Bun. Use `npm run coverage` for coverage reports.
- Key domains:
  - C64 hardware control (BASIC/ASM upload, screen & memory access, SID, VIC-II).
  - Local RAG over `data/` with embeddings.
  - Only transport is MCP over stdio.
- Documentation sources: `README.md`, `doc/` (including SID/BASIC references), `AGENTS.md`, `CLAUDE.md`, `.github/prompts/*.prompt.md`, and `data/context/*.md`.

## Coding Standards

- **Test-Driven Development**: write or update tests in `test/` alongside feature work. When fixing bugs, add regression coverage first.
- **Test Matrix**: run `npm run test:matrix` after each change to exercise all supported targets before sending updates.
- **Code Coverage**: maintain or improve overall coverage (check `npm run coverage`) which must be at least 90%, but aim for 95%+.
- **KISS & DRY**: keep implementations simple, avoid duplication, and refactor shared logic into helpers when needed.
- **Maintainability**: prefer readable, well-structured code; limit cleverness; include succinct comments only where the intent is not obvious.
- **TypeScript**: use strict typing (strict mode enabled). Leverage type definitions and avoid `any` unless absolutely required.
- **Build Output**: ensure compiled files stay under `dist/` only; never commit generated artifacts outside `dist/` or `documents`.
- **Security**: never commit secrets or credentials; validate all inputs; follow principle of least privilege.

## Commit Messages & Releases

- Follow Conventional Commits strictly (`type(scope?): concise subject`). Examples: `feat: add SID triangle-wave example`, `fix(rag): handle missing embeddings`, `docs: clarify health checks`.
- Breaking changes must append `!` (e.g., `feat!: remove legacy tool endpoint`).
- These conventions drive automated changelog generation during `npm run release:prepare`, so keep subjects tight and precise.

## Workflow Essentials

- Use `npm run release:prepare -- <semver>` to bump versions in `package.json` / `mcp.json`, regenerate the MCP manifest, and prepend changelog notes distilled from commit history.
- Run `npm run test:matrix` locally before pushing to ensure CI will pass the comprehensive suite.
- GitHub Actions release workflow publishes on semantic tags (`X.Y.Z`) and runs a post-publish smoke test via npm.
- npm publication is expected to use npm trusted publishing via GitHub OIDC, not a long-lived `NPM_TOKEN`.
- Provide documentation updates (`doc/`, `README.md`, `CHANGELOG.md`) with user-facing changes.

## Prompts & Personas

- Agent context layers: `data/context/bootstrap.md` → `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` → `.github/prompts/*.prompt.md` → `.github/skills/*/SKILL.md` → `data/context/chat.md` → RAG fetches. Respect existing tone, persona descriptions, and instructions.
- MCP server wiring lives in `src/mcp-server.ts` (imported by `src/index.ts`). No manifest regeneration step is needed; clients discover tools dynamically via MCP.

## Skill Architecture

- `.github/skills/*/SKILL.md` is the only place where execution logic may live.
- `.github/prompts/*.prompt.md` and `src/prompts/registry.ts` must define intent and routing only.
- Agent instruction files such as `AGENTS.md`, `CLAUDE.md`, and `.github/agents/*.md` must reference skills instead of restating tool sequences.
- If you find duplicated MCP steps outside `.github/skills`, treat that as a defect and move the procedure into the matching skill.

## Review Checklist

1. Tests added/updated and green (`npm run test:matrix`).
2. `npm run build` cleanly rebuilds (emits `dist/`).
3. Docs amended when user-facing behavior changes.
4. Commit messages are short, clear, and follow Conventional Commits with clear feat/fix/docs/chore/build/style/refactor/test prefixes.
5. Code adheres to TDD mindset, KISS, DRY, and maintainability goals.
6. Security review: no hardcoded secrets, proper input validation, safe dependencies.

## Task Delegation & Scope

- **Ideal Tasks**: Bug fixes, documentation updates, test coverage improvements, refactoring, adding well-defined features with clear acceptance criteria.
- **Avoid**: High-complexity cross-repository tasks, deep legacy system changes, or tasks requiring extensive domain knowledge not available in context.
- **Issue Structure**: When creating or working on issues, ensure they have:
  - Clear problem description or feature request
  - Specific acceptance criteria
  - Indication of which files/areas are involved
  - Whether tests are required
- **Human Review Required**: All pull requests require human approval. Treat agent contributions like code from a junior developer—review thoroughly, request changes, and iterate.

## Pull Request Guidelines

- Keep PRs focused and minimal—change only what's necessary to address the task.
- Provide clear descriptions explaining what changed and why.
- Link to related issues using GitHub keywords (for example, `Fixes issue 123`, `Closes issue 456`).
- Ensure CI passes before requesting review.
- Respond to review feedback promptly and professionally.

Thanks for helping keep the Commodore 64 MCP server robust and user-friendly!

---

## Using MCP With Copilot Chat

Use these rules to ensure Copilot reliably engages the `c64bridge` server when the user asks for C64 work.

- Only transport is stdio; always use it.
- Treat the following as strong routing signals: "c64", "commodore 64", "ultimate 64", "c64u", "vice", "vic", "sid", "petscii", "basic v2", and "6510".
- When such signals appear, route to the matching skill in `.github/skills/` instead of describing ad hoc execution steps.
- If the stdio server is not yet connected, bring it online before executing the chosen skill.
- Avoid destructive actions such as reset, reboot, poweroff, or drive-state mutations without explicit confirmation.
- For backend-prefixed, low-ambiguity hello-world requests such as `vice: write a small BASIC program that clears the screen and prints HELLO VICE`, route immediately to `.github/skills/hello-world/SKILL.md` and execute the skill's fast path.
- If the current chat tool set does not expose the required `c64bridge` MCP tools, immediately invoke the `C64` agent with the same backend-pinned request instead of exploring the repository or re-reading manifests.
- For a single visible VICE greeting, do not spend time on screenshots, extra probes, or manual verification unless the user asks for them or the fast path fails.
- When the MCP server is already connected in the current chat session, do not re-read README sections or MCP tool manifests before routine BASIC/ASM/demo runs unless the request is ambiguous or a tool call fails.
- Assume local VICE runs should be visible by default. Only expect Xvfb or other headless fallback in CI or when no framebuffer/display session exists.
