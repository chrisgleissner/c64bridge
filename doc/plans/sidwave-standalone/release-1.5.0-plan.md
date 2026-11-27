# Release plan: c64bridge 1.5.0 with SIDWave

Written 2026-11-27. This plan replaces the work queue in `STATE.md` until c64bridge 1.5.0 is released. The user approved the scope on 2026-11-27 ("ok great. now do all of that").

## Summary

c64bridge 1.5.0 ships the SIDWave work as one coherent story: ask an AI for C64 music, hear it on a real C64 or in VICE, and ship it in a game.

- **Land** the three unfinished `sidwave` changes (SID Factory II and CheeseCutter phase 1, play and watch, exact-reconstruction part 4), then freeze `sidwave` features.
- **Expose** the headline features through MCP: play any file in one call, assembler includes, WAV render with stems, instrument extraction, voice isolation, HVSC tools and preservation bundles.
- **Make it consistent:** tool list size, background tasks, cancellation, descriptions, honest labels for approximate features.
- **Show it:** a prompt cookbook, a showcase game built through prompts, audio clips, a short video and new release notes.
- **Release:** publish `6502-toolkit` and `sidwave` 0.9.0, switch the dependency, release c64bridge 1.5.0.

Open before release, and only the user can resolve them:

1. Explicit approval to publish to npm and to tag. The earlier rule "no publish or tag before S9" is still in force until the user lifts it. Publishing cannot be undone.
2. An `NPM_TOKEN` secret in `chrisgleissner/sidwave` that may publish new packages. Only `CODECOV_TOKEN` exists today.
3. The user listens to the audio clips. Tests cannot judge how music sounds.

## State on 2026-11-27

| Item | Branch (worktree under `c64bridge-wt/`) | State |
|---|---|---|
| sidwave main | | PRs up to #33 merged (play and watch #32, SF2 and CheeseCutter phase 1 #33) |
| S5d part 4 | `feat/reconstruct-exact` (`sidwave-s5d4`) | CPU comparison; then review, PR, merge |
| WP1 MCP features | `feat/sidwave-mcp` (`sidwave-mcp`, c64bridge repo) | WP1, WP2 and WP3b done and WP2 reviewed at `bfff10ad`; cookbook `doc/sidwave-cookbook.md` (six prompts pass on VICE), release notes `doc/plans/sidwave-standalone/release-notes-1.5.0.md` with placeholders. Native PSID playback on VICE not built (not small). MCP refuses SF2 and CheeseCutter export (no driver argument) |
| WP3a showcase | `feat/sidwave-showcase` (`sidwave-showcase`, c64bridge repo) | done at `b15a8578`; needs review and the user's ear (clips and video in `~/.c64bridge/sidwave-standalone/showcase/`, sent to the user). Library worktree `sidwave-showcase-lib`. MOD loop-length bug found: fix on `fix/mod-loop-pitch` (`brief-modloop.md`) |

## Work packages, in order

### WP0: land the in-flight work (sidwave)

Review, rebase, PR, CI, squash merge for each of the three items. After that, `sidwave` accepts only fixes that WP1 to WP3 need. If S5d part 4 or W15 would delay the release by more than a day, release without it.

Acceptance: merged on green CI; ledger entry per merge.

### WP1: MCP headline features (c64bridge `feat/sidwave-mcp`)

Rebuild the package tarballs from current `sidwave` main (`scripts/sidwave-dependency.mjs tarballs`) at the start and again after WP0. Operations wrap library functions and add no logic. Group related actions under one operation with a sub-mode, because the tool list is nearly full.

1. **Play any file** (headline): one call that detects the format (SIDWave, MIDI, MusicXML, MOD, JCH, SF2, CheeseCutter, GoatTracker, Furnace, SID-Wizard, ABC, PRG, SID), converts, runs it on the active backend, and returns the loss report. Reuse the existing deploy operations.
2. **`compile` for game developers:** assembler include output (64tass, ACME, KickAssembler, ca65), `64tass` symbols, relocation table, `maxCycles`.
3. **`render`:** WAV of the full mix, stems, solo and mute.
4. **`extract_instruments`** and voice **isolation**.
5. **HVSC:** Songlengths lookup and write, STIL query, SID header edit, player identification.
6. **Preservation** bundle.

Acceptance: unit tests per operation with effect level and host path confinement; one VICE end-to-end test for "play any file"; existing operation names, result fields and resource URIs unchanged.

### WP2: consistency (same branch, after WP1)

1. Tool list within the test budget (76 KB) and the package limit (80 KB): shorten descriptions before adding schema text.
2. `convert`, `reconstruct`, `compare`, `analyze_music` and `render` run as background tasks (`src/tasks/allowlist.ts`). If this needs a file in the ownership list below, stop and ask the user.
3. Cancellation for `compose`, `complete` and `retarget`.
4. Descriptions that separate the old `analyze` from `analyze_music`. No renames of existing operations.
5. Repair the loosened schema hints of `generate` and `note_on`.
6. Approximate importers and features (JCH, SID reconstruction, ABC) are labelled as such in `formats` output and reports.
7. SID count of the connected device is applied by `forDevice`, or the documentation says that it is not.
8. Skills, README tool table and `AGENTS.md` capabilities line regenerated.

### WP3: showcase (c64bridge repo, branch `feat/sidwave-showcase`, based on `feat/sidwave-mcp`)

3a, can start now:

1. A small showcase game with original music and sound effects, built with the SIDWave game target, shipped as source and PRG, tested in VICE.
2. Original demo tunes in at least two styles, plus public-domain material for the conversion demo (MIDI and one tracker format authored here). No third-party music, players or drivers.
3. WAV or MP3 clips rendered by a script, with before/after pairs for conversions.
4. A video of about 60 seconds recorded from VICE with sound.

3b, after WP1:

5. **Prompt cookbook:** six prompts, each ending in something audible, covering musician, game developer and general retro use. Every printed prompt is run once end to end on VICE; the headline prompts also on the U64.
6. Skills for three walkthroughs: musician, game developer, archivist.
7. README top section and release notes: three headlines, clips and video first, then the cookbook, then the operation list, then limits.

Claims to keep or avoid:

- SID reconstruction is "experimental: an approximate score with a verdict". No real development tune matched exactly at the last merge; check the S5d part 4 report before writing.
- SID Factory II support means driver 11, and playback fidelity is partial. Medians against the original driver over 54 example songs (PR 33): import gate 0.957, note 0.709; export gate 0.979, note 0.756. Say "import and export", never "exact". Weakest songs: Cracked Down (0.17 import), Scotch Koczka (0.11 export). Showcase material for the release must be checked by ear.
- JCH import is approximate. Do not name KickAssembler as verified.
- Every conversion reports what it lost, with counts.

### WP4: release

1. Run the showcase script on VICE and the U64. U64 (192.168.1.13) is shared: get an all-clear from the peer sessions first.
2. Clean install of the packed c64bridge package in a fresh directory.
3. User listens to the clips and approves publishing.
4. In `sidwave`: set versions to 0.9.0, move changelog entries, merge, tag `6502-toolkit@0.9.0`, then `sidwave@0.9.0`.
5. In c64bridge: `scripts/sidwave-dependency.mjs` to the registry versions, CI green, review, merge, release 1.5.0 with the existing release workflow and one tag.
6. Report on use cases UC01 to UC24: delivered, partial, deferred.

## Deferred until after 1.5.0

SF2 phase 2, instrument exchange (W16), LilyPond, DefleMask, Sidplayer `.mus`, XM/IT, SID-Wizard chords and vibrato, remaining W19, W21 and W22 work, audio transcription (S8), A1 v2, the held-out reconstruction run, `sidwave` 1.0.0.

## If credits run low

Finish in this order and stop adding scope at the first point where quota will not cover the rest: WP0 (SF2 first), WP1 items 1 to 3, WP2 items 1, 6 and 8, WP3 items 5 and 7 and 1, WP4. Cut first: WP1 items 6, 5, 4; the video; demo tunes beyond one.

## How to resume

1. Read this plan, then the end of `STATE.md`, then `evidence/ledger.jsonl`.
2. For each worktree above: `git log --oneline -3`, `git status`, `gh pr list -R chrisgleissner/sidwave`. Agents stop when a session ends; uncommitted work stays in the worktree.
3. Briefs, PR bodies and helpers are in `~/.c64bridge/sidwave-standalone/briefs/`: `run-codex.sh <name> <worktree> <spec>` (high reasoning effort), `watch-merge2.sh <pr> <branch> <sha>` (merges only if green and not behind main), `rebase-union.sh` (resolves Markdown conflicts by keeping both sides).
4. At most three implementers at once. Every change gets a reviewer that did not write it. Codex for narrow, fully specified fixes; Sonnet for features and reviews. Check `llm-usage` before starting a package.
5. Record each merge in `evidence/ledger.jsonl`, commit and push with `git push origin HEAD:wip/sidwave-orchestration`.

## Constraints

- Never contact the C64U (192.168.1.146). Never switch a power outlet. Never use "Mickey".
- VICE: own instances only, monitor ports 6520 to 6529, Xvfb displays :120 to :129. Never let a test or script play audio on the host speakers.
- Do not edit `src/mcp-server.ts`, `src/mcp/`, `src/tools/meta/background.ts`, `src/taskStateLock.ts`, `src/tools/access.ts` or the MCP SDK dependency. Do not touch `/home/chris/dev/c64/c64bridge` or `c64bridge-wt/modern-mcp`.
- Never run or inspect the six held-out tunes.
- Never commit GPL drivers, players, songs or signature files.
- No process-name matching (`pkill`, `pgrep`, `ps | grep`), no sleep polling, no `git stash`, never push `main` directly.
- Test at milestones: build and changed tests locally; full suites, Bun and coverage in pull request CI.

## Remaining steps (2026-11-27 19:30)

1. Merge S5d part 4 (independent review running on `feat/reconstruct-exact`; or release without it) and the MOD loop fix (PR 34, CI).
2. (running, `brief-integrate.md`) Integrate `feat/sidwave-showcase` into `feat/sidwave-mcp`, fill the README and release-note placeholders, rebuild the tarballs, update figures in the release notes.
3. Independent review of the whole MCP branch including the WP3b documents.
4. U64 runs of the headline cookbook prompts and native SID playback (all-clear from peer sessions first).
5. User: listen to clips and video; decide whether managed VICE plays sound by default (silent today); approve publishing; add `NPM_TOKEN`.
6. WP4 release.


## User directive (2026-11-27 19:35)

"Continue and do not stop until fully done. Also, review any PR adversarially and fix any findings". Every open and future PR gets an adversarial review, with fixes, before it merges. The final c64bridge release branch gets an adversarial review by Opus. That review may also add the SF2 and CheeseCutter export driver argument to `convert` if small. Publishing and tagging still need explicit approval and the `NPM_TOKEN` secret. The VICE sound default stays unchanged until the user answers.

- 2026-11-27 ~19:40: peer 1541ultimate-a6 announced JTAG red/green work on the u64 (possibly c64u) in the following hours. This session told it "none" and that it will ask for an all-clear before any u64 use. Do not touch the u64 without that all-clear.

- 2026-11-27: the user added `NPM_TOKEN` to `chrisgleissner/sidwave` (7-day expiry, delete after the first publish and switch to trusted publishing). Explicit publish approval is still outstanding.
- 2026-11-27: showcase integrated; Opus adversarial review of `feat/sidwave-mcp` done and fixed, head `c37c7384` (`convert` gained `driverPath` and MOD `sids`; tool list about 75,850 of 76,000 bytes). Still to do on that branch: tarball rebuild after the last sidwave merge, then the VICE end-to-end test and showcase scripts. Low findings left open: import files are re-read by the library after the confinement check; some library errors name command-line flags.

## User directive (2026-11-27 20:10): release only

"i changed my mind. i now just want you to proceed to the point where we have a release 1.5.0 of c64bridge which correctly pulls in the sidwave release. the subsequent tasks must then be written into a markdown continuation prompt in the c64bridge-workspace folder, clearly dated so I can easily find it. now carry on."

This approves publishing `6502-toolkit` and `sidwave` 0.9.0 and the c64bridge 1.5.0 release, including the tags. It replaces "continue into the deferred items". Listening to the clips and the U64 run no longer block the release; if the U64 run does not happen, the release notes keep saying that hardware is unverified. Continuation prompt: `/home/chris/dev/c64/c64bridge-workspace/prompts/2026-11-27-sidwave-continuation-after-c64bridge-1.5.0.md`.

- User reminder (2026-11-27): once the npm release exists, change the "status: pre-release" badge on https://github.com/chrisgleissner/sidwave. Also update the README sentences that say nothing is published (install section, comparison table "Last npm release", status and roadmap).

## 2026-11-27 20:55: waiting for the user's staged-publish approval

`6502-toolkit@0.9.0` was tagged and its release workflow succeeded on the second attempt (run 46063487341; the first failed on the timing flake "trace operations scale about linearly"). npm holds the version as a staged publish: the registry shows only the placeholder `0.0.0-stage`. The user must approve it with 2FA (npmjs.com "Staged Packages", or `npm stage list` and `npm stage approve <stage-id>`). Then: tag `sidwave@0.9.0` on 623f1ac9, ask the user to approve that stage too, switch c64bridge with `scripts/sidwave-dependency.mjs registry --sidwave 0.9.0 --toolkit 0.9.0`, PR, CI, merge, release 1.5.0. The U64 verification is done (Ultimate 64 Elite, firmware 3.15a, `feat/sidwave-mcp` at ef2c5660).

## 2026-11-27 21:30

Both packages are live on npm at 0.9.0 (provenance; each went through a short staged state). c64bridge PR 200 (`feat/sidwave-mcp`, b0e1c568, registry dependencies) is open: CI watch and an adversarial review of the delta are running. Next: merge on green, release 1.5.0 by the repository process, upload the assets in `showcase/release-assets.txt`, paste the curated notes, then finalise the continuation prompt and remind the user to delete the npm token.
