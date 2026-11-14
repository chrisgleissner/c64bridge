# Hardening 03 - implementation brief

Repository: `/home/chris/dev/c64/c64bridge` (C64 Bridge MCP server, version 1.2.0)
Baseline commit: `6756495` on `main`
This file: `doc/reviews/hardening/03-fable/prompt.md`
Findings: `doc/reviews/hardening/03-fable/review.md` (HARD03-001 to HARD03-046)

## Summary

You are the lead engineer for the third hardening round of the C64 Bridge MCP server. The review at
`6756495` confirmed 46 defects (3 P1, 21 P2, 22 P3). `review.md` gives, for each one, the location,
the evidence, a trigger, the fix and the test that must fail before the fix. This brief adds the
rules, the design decisions that are already made, and a wave plan partitioned by file. Your job is
to land every finding on one branch, `fix/hardening-3`, as one pull request with one commit per
finding.

Two earlier rounds exist (`01-fable`, `02-fable`). Nothing from them needs redoing. Several
findings here are siblings of earlier fixes; `review.md` names the earlier item, and you must read
its history before changing that code.

Nothing in this brief authorises contact with real hardware, a release, a version bump, a tag, a
merge to `main` or an npm publish. Items that need the owner's decision or a hardware check are
listed in `review.md` ("Decisions for the owner", "Needs hardware confirmation"); do not implement
or attempt them.

## Team and effort

- The lead plans, decides designs where this brief leaves a choice, reviews every diff line by
  line, proves each test can fail, integrates, and does the final adversarial pass.
- Supervisors (Sonnet, at most three at once, one per worker group below) brief the implementers
  and check their output.
- Implementers (Haiku subagents, or `codex exec -m gpt-6-luna -C <worktree> -s workspace-write
  "<task>" < /dev/null`) do the edits and tests.
- Each group works in its own worktree and branch
  (`git worktree add ../c64bridge-wt/<group> -b h3/<group> fix/hardening-3`). Two groups never
  edit the same file at the same time.
- An implementer starts with no context. Each brief contains: the finding IDs with their full
  text from `review.md`, the files it may edit, the files it must not edit, the test pattern to
  copy, the commands to run, the hard rules below, and the report format (diff summary, test names
  added, tail of the command output, anything not done).
- A report is a claim. Check the diff and run the tests before integrating.

## Hard rules

1. **No real hardware.** Do not call any `mcp__c64bridge__*` tool. Do not send requests to `c64u`,
   `u64`, `u2` or any device address. Do not switch any power outlet. The client's default host is
   the real device `c64u` and `~/.c64bridge.json` may name real hardware, so every script and test
   passes an explicit `http://127.0.0.1:<mock port>` base URL and sets `C64BRIDGE_CONFIG` to an
   empty JSON file. Put this rule in every brief.
2. **VICE only headless** and only through the existing npm scripts (`npm run test:vice:mock`;
   `npm run test:vice:device` if `x64sc` is installed). Always `VICE_VISIBLE=false`.
3. **Git.** Branch `fix/hardening-3` from `main`. One commit per finding, the finding ID in the
   body, no attribution lines. No `git stash`, no history rewrite, no merge to `main`. When all
   exit criteria hold, push the branch and open one pull request; do not merge it. The description
   opens with a summary of the whole change including open items, and states previous behaviour,
   defect, change, verification and rejected alternatives per batch.
4. **No version bump, no `CHANGELOG.md` edit, no tag, no publish.**
5. **Backward compatibility.** Tool, operation and parameter names keep working. New parameters
   are optional. A behaviour change is allowed only where `review.md` or this brief states one.
6. **Minimal change.** Fix the finding; do not refactor, rename or reformat neighbouring code. No
   new runtime dependency.
7. **Archaeology before deletion.** Before removing or loosening a guard, run `git log -S` on it
   and read the commit that introduced it.
8. **Do the hermetic-test item first (HARD03-046).** Until it lands, every test run writes into
   the developer's real `~/.c64bridge`.
9. No `rm -rf` on variable paths, no `git reset --hard`, no `git clean`. Remove worktrees with
   `git worktree remove`. Poll GitHub at most once every five minutes.
10. If a finding does not hold at the baseline, record the evidence and skip it. Do not invent a
    change.

## Orientation (lead, first)

1. Read `AGENTS.md`, `doc/developer.md`, `review.md` in full, and the "Baseline facts" and
   "Design decisions" sections of `doc/reviews/hardening/02-fable/prompt.md`; they still describe
   the test conventions, the mock servers, the generated files (`README.md` tool tables,
   `mcp/*.json`: never hand-merge, rebuild after each integration) and decisions D1 to D6 that
   this round extends.
2. Land HARD03-046, then record the baseline: `npm run build`,
   `npm run test -- --platform=c64u --target=mock`, `npm run test:vice:mock` (pass counts and
   `tools/list` size).

## Design decisions already made

- **E1 - Host paths (003, 002).** `resolveHostPath` rejects, for read and write, the configuration
  candidates and the task state file by real path, and any path with a component starting with `.`
  below an allowed root. Opt-out: `C64BRIDGE_ALLOW_HIDDEN_PATHS=1`. Image input goes through
  `readHostFile` and `Jimp.fromBuffer`; `Jimp.read` with a path or URL is not used anywhere.
  Overwrite policy for existing files is not part of this round.
- **E2 - VICE resource names (001).** Matching is case-insensitive on both tool paths, and the
  monitor mock becomes case-insensitive. Add a test that walks a list of host-file resources of
  VICE 3.10 in several spellings.
- **E3 - I/O range (004, 035, 039).** One exported helper that tells whether an address range
  overlaps `$D000-$DFFF`, used by the bitmap layout, the assembler gap fill and the charset scan.
- **E4 - Cancellation (012).** `ToolExecutionContext.signal?: AbortSignal`, set in the CallTool
  handler and passed through `c64_batch`. Waits check it at step boundaries and run their existing
  cleanup. `power_cycle` checks it only before the menu opens.
- **E5 - Event loop (008, 009, 010).** No tool argument may keep the event loop busy for more than
  about one second. For screen patterns choose a terminable worker or a stricter static budget on
  runtimes without the vm timeout; state the choice in the commit.
- **E6 - Redaction (006, 007).** Required properties are listed under HARD03-007. Configuration
  write values are always redacted in logs and diagnostics.
- **E7 - State root (014, 015, 046).** `C64BRIDGE_STATE_DIR` (default `~/.c64bridge`) is the
  parent of task state, default run directories (`runs/`) and diagnostics. The existing overrides
  keep precedence. Tasks carry an owner (pid and session id).
- **E8 - Truthful results.** A tool never reports success for a step whose result it did not
  check. Where the outcome is unknown, the result says so (`stopped: false`, `loadCheck:
  "skipped"`, `audible: false`) and is not an error unless `verify` was requested.

## Wave plan

Each group lists finding IDs and the files it owns. `src/c64Client.ts` and `src/device.ts` are
shared: brief each group on the functions it may touch and integrate in the order given.

### Wave 0 - lead

- 046 (test runners, state root variable; E7 groundwork).

### Wave 1 - boundary and stability (three groups)

- **A - host paths and images:** 003, 002, 004, 039. Files: `src/hostPaths.ts`,
  `src/vicBitmap.ts`, `src/tools/graphics.ts`, `src/tools/meta/graphics.ts` (also the 024 parser
  in that file), new I/O range helper.
- **B - VICE:** 001, 013, 018, 019, 020, 029, 030, and the 024 parser in `src/tools/debug.ts`.
  Files: `src/vice/*`, `ViceBackend` in `src/device.ts`, the `vice*` methods and
  `injectKeyboardQueue` in `src/c64Client.ts`, `src/tools/debug.ts`, `src/tools/vice.ts`.
- **C - dispatch:** 005, 006, 007, 011, 012. Files: `src/tools/access.ts`,
  `src/tools/registry/{system,config,batch,index}.ts`, `src/tools/types.ts`, `src/redact.ts`,
  `src/mcp/callToolResult.ts`, `src/loggingHttpClient.ts`, the CallTool handler in
  `src/mcp-server.ts`.

### Wave 2 - result correctness (three groups)

- **D - program and memory:** 008, 021, 022, 023, 024 (`src/tools/meta/memory.ts`), 025, 034, 035,
  036, 037. Files: `src/tools/meta/screen.ts`, `src/tools/pollValidator.ts`,
  `src/tools/meta/artifacts.ts`, `src/tools/meta/program.ts`, `src/tools/meta/memory.ts`,
  `src/tools/memory.ts`, `src/tools/translation/assembler.ts`, `src/tools/printer.ts`,
  `printerTextExpression` in `src/c64Client.ts`.
- **E - graphics and audio:** 016, 028, 038, 009, 026, 027, 033. Files: `displaySprite` and the
  capture functions in `src/c64Client.ts`, `src/tools/registry/graphics.ts`, `src/sidwave.ts`,
  `src/sidwaveCompiler.ts`, `src/tools/audio.ts`, `src/tools/meta/audio.ts`,
  `src/tools/streaming.ts`.
- **F - Ultimate files and input:** 017, 031, 032. Files: `src/tools/meta/filesystem.ts`,
  `src/tools/input.ts`, `scripts/mockC64Server.mjs`. The `shuffle` part of 017 and 023 lives in
  `src/tools/meta/program.ts`; group D makes that edit from F's specification.

### Wave 3 - state, launch and release (two groups)

- **G - state:** 014, 015. Files: `src/tools/meta/background.ts`, default directories in
  `src/tools/meta/program.ts` and `src/tools/meta/compilation.ts`, `src/diagnostics.ts`.
- **H - launch, package, CI, documentation:** 010, 040, 041, 042, 043, 044, 045. Files:
  `src/tools/rag.ts`, `src/rag/*`, `scripts/start.mjs`, `scripts/cli.js`,
  `scripts/invoke-bun.mjs`, `package.json`, `.github/workflows/release.yaml`, `AGENTS.md`,
  `doc/vice/support-matrix.md`, `README.md` through its generator source, `server.json` for new
  variables, and the affected `.github/skills/*/SKILL.md`. This group runs last and documents
  every new variable (`C64BRIDGE_ALLOW_HIDDEN_PATHS`, `C64BRIDGE_STATE_DIR`) and every behaviour
  change of the round.

## Definition of done per finding

1. The change is limited to the finding.
2. A test exists that fails without the fix. The lead verifies this: revert the production change
   for that finding in a throwaway worktree, run the new test, see it fail, restore. Record "fails
   when reverted: yes".
3. `npm run build` leaves no uncommitted generated changes.
4. `npm run test -- --platform=c64u --target=mock` and `npm run test:vice:mock` pass.
5. One commit, finding ID in the body.

## Exit criteria

- Every finding is done, or skipped with recorded evidence, or blocked with a recorded reason.
- Both mock runs pass twice in a row on the final head; `npm run coverage` passes if `x64sc` is
  available; `npm run check:package` passes.
- A test run leaves the real `~/.c64bridge` untouched.
- Final adversarial pass by the lead over `main..fix/hardening-3`. Look for the pattern this round
  was about: a guard added on one path and missing on a sibling. Check every host path sink
  against E1 (search for `Jimp.read`, `readFile`, `writeFile`, `createWriteStream`, `mkdir`,
  `fetch`), every resource name path against E2, every memory write or read range against E3,
  every wait against E4, and every result path against E8. One fresh reviewer may read the diff
  without the lead's conclusions.
- The pull request is open, checks are green, and it is not merged.

## Final report (pull request description and last message)

1. Summary of the whole change, including open items.
2. Table: finding ID, status, commit, test name, "fails when reverted".
3. Behaviour changes a user will notice (hidden paths and configuration files rejected, image
   input confined, stricter resource names, new argument maxima, new access classifications,
   single-directory file search, redaction changes, state directory layout).
4. Needs hardware confirmation: the table from `review.md`, with anything learned.
5. Anything found that is not in `review.md`, as a list for the owner; do not fix it.
