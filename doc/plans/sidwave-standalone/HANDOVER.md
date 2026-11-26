# Handover prompt: SIDWAVE standalone, remaining work (from 2026-11-26)

Paste the block below into a new session started in `/home/chris/dev/c64/c64bridge-wt/sidwave-standalone`.

---

You continue the SIDWAVE extraction and toolkit described in `doc/plans/sidwave-standalone/prompt.md` (the brief; it stays authoritative). Before anything else, read in this order: `doc/plans/sidwave-standalone/STATE.md` (decisions D1-D10, user additions, cost rule, hardware agreement, in-flight branches), the last 15 lines of `evidence/ledger.jsonl`, and this file. Do not repeat recorded work. Update STATE.md and the ledger after every completed step and before you stop.

## Team and token rules (user instruction: minimal tokens, high engineering quality)

- You orchestrate: decide, integrate, accept. Write little code yourself; read diffs and summaries, not whole files. Check quota with `llm-usage` at the start and every hour; when the Claude 5-hour window drops below 20 %, finish the current step, update STATE.md and pause new work.
- Implementation: `codex exec -m gpt-6-luna -C <worktree> -s workspace-write "<brief>"` with the brief written to a file in the scratchpad (objective, paths, applicable decisions, write scope, acceptance tests, report of at most 250 words). Codex cannot finish long test suites in its sandbox and Node fails there on stream-fd permissions: always rerun the tests yourself outside the sandbox (`timeout 600 bun test packages/sidwave/test`, `node --import tsx --test packages/sidwave/test/*.test.mjs`). If codex stops at a partial version, start a fresh `codex exec` with the original brief plus a STATUS paragraph; do not use `codex exec resume --last` (it may pick another session).
- Haiku subagents: mechanical edits, test runs, log triage, evidence entries.
- Sonnet subagents: only to supervise a package that needs judgement (for example S5 reconstruction) and for independent reviews. A reviewer never reviews code it or its delegates wrote.
- Top tier (Opus): only the A1 calibration design and the final review before release.
- At most three workers at a time, one worktree per worker (`/home/chris/dev/c64/c64bridge-wt/sidwave-*`), one writer per file, never two dependency installs at once. Use `npm ci`/`npm install` (bun install fails here on `segfault-handler`). Long outputs go to `~/.c64bridge/sidwave-standalone/`; pass only tails and counts into any context.
- CI polling: `gh run watch <id> --interval 300 --exit-status`; merge only in the same command after the watch succeeds.

## Hardware and other sessions

- U64 at 192.168.1.13 is time-shared with the modern-mcp session (peer name `c64bridge-64`, check `ListAgents`): message it and wait for its all-clear before each use, release it afterwards. Never contact the C64U (192.168.1.146; the Farwater session uses it) and never switch a power outlet.
- VICE: monitor ports 6520-6529, Xvfb displays :120-:129 (`VICE_XVFB_DISPLAY=:121`); attach only to own instances. Local render: `env -u DISPLAY CI=1 C64BRIDGE_VICE_ROM_DIR=~/.c64bridge/sidwave-standalone/open-roms node scripts/render-sidwave-examples.mjs --out-dir <dir> --jobs 3`.
- Never touch `/home/chris/dev/c64/c64bridge`, `c64bridge-wt/modern-mcp`, or files it owns (brief section 2).

## State at handover

- PR 1: https://github.com/chrisgleissner/c64bridge/pull/193 (draft), branch `feat/sidwave-standalone`. Contains S0 baseline, S1 packages, S2 CLI, standalone root files, split script and proof, consumer checks, docs drafts. Last push fixed the CI package duplicate check (`scripts/verify-package.mjs` skips bundled `node_modules`); its CI result was pending at handover.
- Gate evidence already recorded: baseline identical after the move; package coverage asm6502 98.43 %, sidwave 98.28 %; example render green with VICE playback of digi_groove; U64 playback/capture PASS; split output at `/home/chris/dev/c64/sidwave` (150 commits, history and authorship kept); clean consumer install on Node and Bun byte-identical to the baseline.
- Local feature branches waiting for the sidwave repository (decision D8): `feat/sidwave-sidfile` (SID file module, 4c00c5c1), `feat/sidwave-engine` (libsidplayfp-wasm engine 95fb8378, verify T0/T1/A0 481dd4fe), `feat/sidwave-format` (formatter/diff/merge f1a97cd0, transforms ace10ef3). They were written against the c64bridge workspace layout `packages/sidwave/...`; in the sidwave repo the same files live at `sidwave/...`.

## Remaining work, in order

1. **Finish PR 1.**
   - Make CI green on #193 and investigate each failure. Rerun any failing test that is a known pre-existing flake (sidplayfp onset test; load-sensitive VICE timing tests) and record it.
   - Get an independent review from a Sonnet reviewer with the diff only, then fix the confirmed findings. Points to check: the split proof retries test steps up to three times (every attempt must be recorded and reported, never hidden); `repository.url` in the package manifests; the "GPL v2.0 or later" headers versus GPL-2.0-only in package.json (do not relicense; list it for the user); and the c64bridge tarball size budget.
   - Rebase on `origin/main`, regenerate generated files (`npm run build`), and update the PR body. Follow the PR rules in `~/.claude/CLAUDE.md`, with the summary first.
   - Mark the PR ready, then merge with `gh run watch <id> --interval 300 --exit-status && gh pr merge 193 --squash` (or rebase-merge to keep the per-step commits). Record the merge in the ledger.
2. **Create `chrisgleissner/sidwave`** (D8, authorised).
   - Rerun `scripts/split-sidwave-repo.sh` on the merged `main` and check the proof JSON.
   - Create the public repo with `gh repo create chrisgleissner/sidwave --public`, push the split history, and wait for its CI (`.github/workflows/ci.yaml`) to go green.
   - Do not publish to npm and do not tag.
   - From then on the sidwave repo is where SIDWAVE is developed. c64bridge keeps its bundled copy frozen until S9.
   - User requirement: a great README. The README is informative, clear, concise and appealing to musicians and developers, and the repository structure is similar to c64bridge and sidflow. Polish `README.md` there and check every command in it.
3. **Port the three feature branches** to the sidwave repo as one PR per capability group, with paths moved from `packages/sidwave/` to `sidwave/`. For each PR:
   - Thicken the tests where the ledger notes they are thin: transforms (one test today) and diff classes.
   - Get an independent review, get CI green, then merge.
   - The libsidplayfp-wasm optional dependency must not enter the c64bridge tarball; check this at S9.
4. **Complete S3** (brief section 7):
   - `sidwave verify` CLI and API parity: machine-readable output, stable error categories, exit codes, cancellation, progress and budgets.
   - Mutation corpus and A1 calibration, with the design by Opus at high effort and the implementation by codex. Freeze the decision rules before evaluating held-out cases, and report false-accept and false-reject rates.
   - Record SID file and engine evidence.
   - `sidwave bench --verify`, which recomputes the ledger claims.
5. **S4 remainder:**
   - Game integration: relocatable player, separate player and data, PSID startPage/pageLength, symbols, measured worst-case cycles, sound effects with priorities and voice stealing, and two example programs.
   - Retargeting and resource optimisation.
   - Asset libraries.
   - Example scores for human authors.
   - Every language extension must follow the rule in brief section 6. Language 1.4 starts here.
6. **S5 reconstruction, analysis and preservation**, supervised by Sonnet: 30-tune HVSC corpus manifest frozen before tuning, a per-tune verdict, and held-out results recorded once.
7. **S6 interchange**: MIDI, MusicXML, WAV and stems, the GoatTracker `.sng` importer verified against `gt2reloc`, and Furnace `.fur`. Tracker demo songs are not redistributable, so use them as local inputs only.
8. **S7 composition** and **S8 transcription** (optional; measure the back ends, or mark the capability approximate or blocked).
9. **S9 integration and release**, exactly as brief section 7 describes:
   - `c64_sound` operations and the sid-music skill.
   - Three end-to-end workflows.
   - Documentation and the offline proof.
   - An independent consumer.
   - API freeze.
   - Publish `c64-asm6502` and then `sidwave` 1.0.0, with one tag in sidwave.
   - Switch c64bridge to the registry dependencies and remove `packages/`.
   - c64bridge minor release with one tag, following `project_1_1_1_progress.md`.
   - Final report per brief section 9, with a status for UC01-UC24 and for every gate, including the open user decision on the player runtime licence exception.

## Already decided by the user (do not ask again)

- The assembler package name stays `c64-asm6502` (D9).
- Create the sidwave repo right after PR 1 merges (D8).
- Merges of your own PRs, pushes, repository creation, the npm publishes and the release are authorised as stated in brief section 2.

If something cannot be finished, report the best verified state and the exact unmet requirement. Never claim completion that the evidence does not support.
