# Continuation prompt, 2026-11-27: SIDWave work after c64bridge 1.5.0

Written 2026-11-27, after the release. Give this file to a new session with "continue from this prompt".

## Summary

c64bridge 1.5.0 is released and depends on the published `sidwave` 0.9.0 and `6502-toolkit` 0.9.0. On the user's instruction of 2026-11-27, the release shipped the low-hanging fruit that was ready, and the higher-hanging, less important tasks are recorded here. Nothing below blocks the release. Section 1 lists housekeeping that needs attention first. Section 3 lists the deferred work in priority order.

## Released state

| Package | Version | Reference |
|---|---|---|
| `6502-toolkit` | 0.9.0 | tag `6502-toolkit@0.9.0`, `sidwave` repository commit 623f1ac9 |
| `sidwave` | 0.9.0 | tag `sidwave@0.9.0`, same commit; PRs up to #36 merged |
| `c64bridge` | 1.5.0 | tag `1.5.0`, commit f9987243; PRs #200 and #201; release assets and notes on GitHub |

Verified after publishing: `npm install c64bridge@1.5.0` in an empty directory installs `sidwave` 0.9.0 and `6502-toolkit` 0.9.0, the MCP server starts, `c64_sound` lists the new operations, and `formats` answers.

## 1. Housekeeping (do first)

1. **User action:** delete the npm access token created for the first publish, then remove the secret: `gh secret delete NPM_TOKEN -R chrisgleissner/sidwave`. The token expires 7 days after 2026-11-27.
2. Configure npm trusted publishing for `sidwave` and `6502-toolkit` (the packages now exist), and remove `NODE_AUTH_TOKEN` from `sidwave/.github/workflows/release.yaml`, as c64bridge does. npm staged the token-based publishes and is restricting such tokens.
3. **User action:** listen to the release clips and watch the video. Nobody has listened to them.
4. Release headline: "Hear it on a real C64 or in VICE". Hardware verification covers an Ultimate 64 Elite only; a C64 Ultimate and a U2 cartridge are unverified. Either verify them or adjust the sentence.
5. Fix two flaky tests: `sidwave` "the trace operations scale about linearly" (failed one publish run and one main CI run) and c64bridge `background.test.mjs` "R-05 ... no temporary files remain" (failed once in CI, passed on rerun).

## 2. Where everything is

- Plan, decisions, state, ledger: `/home/chris/dev/c64/c64bridge-wt/sidwave-standalone/` (branch `wip/sidwave-orchestration`): `doc/plans/sidwave-standalone/{prompt.md,STATE.md,release-1.5.0-plan.md,research/}`, `evidence/ledger.jsonl`. Push with `git push origin HEAD:wip/sidwave-orchestration`.
- Briefs, PR bodies, helper scripts: `~/.c64bridge/sidwave-standalone/briefs/` (`run-codex.sh`, `watch-merge2.sh`, `rebase-union.sh`, `union.py`).
- Showcase clips, video and release body: `~/.c64bridge/sidwave-standalone/showcase/`.
- Research inputs (GPL material, never commit): `~/.c64bridge/sidwave-standalone/research-src/`.
- `sidwave` main clone `/home/chris/dev/c64/sidwave`; worktrees `/home/chris/dev/c64/c64bridge-wt/sidwave-*` and `release-150`. Merged worktrees can be removed after checking `git status`.

## 3. Deferred work, in priority order

### 3.1 SID Factory II excellence (SF2 phase 2; user priority)

Brief: `briefs/brief-sf2-excellent.md`, Phase 2. All shipped drivers (11.x with multi-SID, 12 to 16, NP20), per-driver targets (gate median at least 0.95, note median at least 0.9), export to every writable driver with auxiliary data preserved, import of SF2-packed `.sid` files, CheeseCutter 2.9.0 and 2.10 with a ct2util oracle, stereo `.ct`. Driver frequency tables through `tuning.registers`.

Known state after phase 1 (PR 33): medians against the original driver over 54 songs are import gate 0.957 and note 0.709, export gate 0.979 and note 0.756. Weakest songs: Cracked Down (0.17 import), Scotch Koczka (0.11 export). Rows of 7 or 8 frames can be exported as 3 (cause of the low CheeseCutter voice in dustandrust). Legato effect changes are inaudible.

### 3.2 Reconstruction and verification

- Exact reconstruction: 0 of 24 development tunes strict or register-state exact. Open items are in the description of `sidwave` PR #35. The committed development report predates the last review fixes of that PR.
- The single held-out run over the 6 reserved tunes, once reconstruction work is finished. Never inspect those tunes before it.
- A1 v2: the frozen A1 v1 rules accept too many wrong cases; design, calibrate on development cases, freeze, evaluate on newly drawn held-out cases (`STATE.md`, "Backlog").

### 3.3 Formats and conversion

LilyPond export (section 3 of `briefs/codex-w18text.md`), DefleMask, Sidplayer `.mus`, XM and IT, SID-Wizard chords, vibrato and loop, instrument exchange (W16: `.ins`, `.swi`, SF2 instruments), JCH wave-table dwell and row timing (pitch agreement 0.00 to 0.97 on 10 HVSC tunes), MOD pitch limits (strong sub-octave layers and some four-cycle pulse-width loops import an octave low; no broad test on real modules), MOD CPU budget headroom, ABC `&` overlays and `P:` part order.

### 3.4 Product quality

- W19 ease of use: consistent `--song` base, progress output, quick starts per stakeholder, help examples tested, error fix hints.
- W21 quality and performance gates; W22 multi-SID and hardware profiles.
- Effects-only game build; KickAssembler output verification (needs `KickAss.jar`); native PSID playback on VICE (needs an own relocatable driver stub); `x64sc` save-to-sound latency 2.2 s against a 1.5 s target.
- MCP: import files are re-read by the library after the confinement check; some library errors name command-line flags; `tools/list` has about 150 bytes left under its 76,000 byte test budget; decide whether a VICE started by c64bridge plays sound by default for music operations (silent today, user has not decided).
- U64 checks not done: four of the six cookbook prompts, `sidwave play --target u64`, audio capture, game sound effects, NTSC, physical SID chips.
- S8 audio transcription.

### 3.5 Closing the original brief (beyond 1.5.0)

Three end-to-end workflows on VICE and the U64, offline proof, independent consumer, API freeze and `bench --verify`, `sidwave` 1.0.0, final report on use cases UC01 to UC24 (`research/stakeholder-usecase-audit.md`).

## 4. Working rules (user directives)

- Quality, speed and ease of use are "extremely important"; cover every developer, musician and stakeholder use case; SID Factory II support must be excellent.
- Minimal token use. Sonnet drives; Opus only for hard research, specifications and important reviews; codex `gpt-6-luna` at high reasoning effort for narrow, fully specified tasks (it delivered stubs or broken parsers on broad ones). At most three implementers.
- Every pull request gets an adversarial review by an agent that did not write it, and findings are fixed. Merge only on green CI of the pinned head, rebased onto main; record merges in the ledger.
- Test at milestones: build and changed tests locally; full suites, Bun and coverage in PR CI.
- Publishing to npm and tagging need the user's approval for each release.
- Never contact the C64U (192.168.1.146), never switch a power outlet, never use "Mickey". The U64 (192.168.1.13) is shared: get an all-clear from peer sessions first.
- VICE: own instances only, monitor ports 6520 to 6529, Xvfb :120 to :129. Never play audio on the host speakers from tests or scripts.
- Do not touch `/home/chris/dev/c64/c64bridge`, `c64bridge-wt/modern-mcp`, or the files that work owns (`src/mcp-server.ts`, `src/mcp/`, `src/tools/meta/background.ts`, `src/taskStateLock.ts`, `src/tools/access.ts`, the MCP SDK dependency) without asking.
- Never commit GPL drivers, players, songs or signature files. No process-name matching, no sleep polling, no `git stash`.
