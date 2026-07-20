# Hardening 01 — handover: finish the poll-truthfulness fix, then adversarially review and land the branch

Repository: `/home/chris/dev/c64/c64bridge`
Branch: `fix/hardening` (already pushed once as PR #143, previously brought to a green/merge-ready state)
This file: `doc/reviews/hardening/01-fable/prompt-handover.md`

This is a handover from a session that (1) got PR #143 to a fully green, merge-ready state addressing five Kilo Code review comments and raising patch coverage to ~96%, then (2) at the user's request, ran **real physical hardware tests** (C64U, Ultimate 64, Ultimate II+L) against the live MCP server, and (3) found a genuine, reproducible false-success bug during that testing. A fix is in progress but not finished, verified, or committed. You are picking this up cold — there is no prior conversation for you to recall.

Do not consider this session's work "done" until Part 3's exit criteria are met. Do not claim completion while any part below remains unresolved.

## Part 0 — Orient yourself first

1. Read `AGENTS.md` in full.
2. Read `doc/reviews/hardening/01-fable/review.md` and `doc/reviews/hardening/01-fable/prompt.md` for the original 35-finding hardening context (HARD01-001..035) — this branch already implements all of them, plus five follow-up fixes from a Kilo Code automated review round, plus coverage work. That prior work is committed (`git log --oneline` back to `cfb7e4a`). Nothing in that history needs redoing.
3. Run `git status` and `git diff --stat` to see the exact uncommitted state you're inheriting (summarized precisely in Part 1 below — but verify it yourself, the working tree may have drifted).
4. Check `gh pr view 143 --repo chrisgleissner/c64bridge` and `gh pr checks 143 --repo chrisgleissner/c64bridge` for the PR's current state. As of this handover, PR #143 is green and all prior review threads are resolved — the uncommitted work described below is a **new, additional** round on top of that.

## Background: what real-hardware testing found

The session tested the live MCP server against three genuinely separate physical devices (confirmed via distinct firmware `unique_id`s):

- **C64U** — hostname `c64u`, product "C64 Ultimate", firmware 1.2.0.
- **Ultimate 64 Elite** — hostname `u64`, firmware 3.15. Fully independent hardware (its own board), but uses the same `c64u` backend profile/config key as C64U (same REST API family). The c64bridge config format has exactly one `c64u` slot, and the running server caches whichever host was resolved into it the first time that backend is constructed in a process — editing `.c64bridge.json` and re-selecting the backend does **not** retarget an already-constructed facade. To test C64U and U64 as genuinely separate live connections, the session registered a second temporary MCP server entry, `c64bridge-u64`, in `.mcp.json`, pointed at a separate config file (`C64BRIDGE_CONFIG` env var) with `c64u.host = "u64"`. That second server entry is a legitimate, intentional part of the current uncommitted `.mcp.json` diff — keep it (or ask the user before removing it) rather than reverting it as accidental drift.
- **Ultimate II+L (U2)** — hostname `u2`, firmware 3.15. Physically a cartridge plugged into the back of the C64U unit — separately networked (own IP), but shares the same underlying simulated C64 bus/CPU/screen as the C64U it's plugged into. **Never drive `c64u` and `u2` operations concurrently** — they are electrically the same target machine. U64 is fully independent and safe to run alongside either.

Targeted verification (firmware `errors[]` truthfulness, drive-list shape, real ASM execution, `power_cycle` honesty) passed cleanly on **C64U and U64**. On **U2**, `upload_run_basic` / `upload_run_asm` reported `success: true, verified: true` while the program **never actually executed** — confirmed independently by bypassing the MCP client entirely and sending raw HTTP `POST /v1/runners:run_prg` requests directly to the device in both `application/octet-stream` and `multipart/form-data` encodings (matching the OpenAPI spec exactly). The U2 firmware returns `200 {"errors": []}` but memory at `$0801` never changes and the screen never advances past the boot banner. This was cross-checked against the *same* physical machine via the C64U side (which genuinely does execute, visible through the shared screen) — so it is a real gap in the U2 cartridge's own firmware implementation of the upload-and-run REST feature, **not** a client-side bug. That part needs no further code change; it's a hardware/firmware limitation to document, not fix.

**What is a fixable bug**, independent of the U2 firmware issue: `pollBasicOutcome()` / `pollAsmOutcome()` in `src/tools/pollValidator.ts` were blindly reporting success whenever the literal text "RUN" or "ERROR" never appeared on screen within the poll window. Since `upload_run_basic` / `upload_run_asm` execute via the native REST `run_prg` endpoint (or a typed `SYS<entry>` command for ASM) rather than a user visibly typing `RUN`, this fallback was structurally unable to provide a real signal — it happened to look correct on C64U/U64 only because execution there also happens to produce visible screen text (a KERNAL LOAD/RUN echo) for unrelated reasons. On U2, where nothing executes at all, the same fallback silently laundered a real failure into a false `verified: true`. This is exactly the class of bug the original 35 HARD01 findings targeted, just not one of them by number — a natural HARD01-036 in spirit, though nothing in code should assume that ID is registered anywhere; use it only as a descriptive tag if useful (as already done in the new tests, see below).

## Part 1 — Finish the in-progress fix (do this first)

### 1a. Fix already applied to `src/tools/pollValidator.ts` — verify, don't redo

- `pollBasicOutcome`: previously always fell through to `return { status: "ok", type: "BASIC" }` after the poll window if no BASIC error text was ever seen, regardless of whether `runDetected` was ever set. Now, if `runDetected` is still `false` after the full poll window, it returns `{ status: "error", type: "BASIC", message: "No execution activity detected: the firmware reported success, but the program does not appear to have run." }` instead.
- `pollAsmOutcome`: previously returned `{ status: "ok", type: "ASM" }` immediately if `runDetected` was never set, **skipping** the hardware liveness check (screen-RAM CRC comparison) entirely. That early return is removed — execution now always falls through to the liveness check regardless of whether "RUN"/"ERROR" text was ever seen. Only the two log lines and a comment changed around this; the liveness-check logic itself (already correct, from the original HARD01-019/020 work) is untouched.

Confirm this is still exactly what's in the working tree (`git diff src/tools/pollValidator.ts`) before proceeding — do not re-derive it from scratch, but do sanity-check it against the description above.

### 1b. Test updates already applied — verify, don't redo

`test/pollValidator.test.mjs`:
- Two tests that previously *encoded the bug as correct behavior* — `"pollForProgramOutcome BASIC returns ok if RUN not detected"` and `"pollForProgramOutcome ASM returns ok if RUN not detected"` (both used a mock whose `readScreen()` always returns `"READY.\n"` forever, and asserted `status: "ok"`) — were renamed and fixed to assert the corrected behavior: `"HARD01-036 pollForProgramOutcome BASIC reports an error instead of blind success when RUN is never detected"` (asserts `status: "error"`, message matches `/does not appear to have run/i`) and `"HARD01-036 pollForProgramOutcome ASM reports crashed instead of blind success when RUN is never detected"` (asserts `status: "crashed"`, `reason: "no program-visible screen progression within window"`).
- A new positive-case test was added, `"HARD01-036 pollForProgramOutcome ASM still detects real liveness even when RUN text never appears"`, confirming the fix doesn't regress the case where RUN/ERROR text never shows but screen RAM genuinely changes (must still report `ok`).

`test/programRunnersModule.test.mjs`:
- `"upload_run_basic verify true annotates metadata"`: mock's `readScreen()` previously always returned `"READY.\n"`; now returns `"READY.\n"` on the first call (the tool's own pre-poll screen check) and `"RUN\n"` thereafter (matching how a real backend's LOAD/RUN echo actually behaves), so the poll genuinely observes execution instead of relying on the old blind-success fallback.
- `"upload_run_basic verify tolerates repeated screen read failures"`: mock's `readScreen()` previously threw on *every* call, and the test asserted success. That was itself an instance of the bug (permanent failure ≠ "tolerated" success). Now the mock throws only on the first 3 calls, then returns `"RUN\n"` — genuinely testing transient-failure tolerance, not permanent-failure-as-success.
- `"upload_run_asm returns structured content on success"`: the mock previously had no `readScreen`/`readMemoryRaw` at all (relying on the old shortcut to skip verification entirely, even though `executeUploadRunAsm` calls `pollForProgramOutcome` unconditionally regardless of the `verify` flag). Now includes a minimal `readScreen` (`"RUN\n"`) and `readMemoryRaw` (returns a changing byte pattern) so the now-mandatory liveness check has something real to observe.
- `"upload_run_asm verify treats repeated screen read failures as instant execution"` — this test's *name* literally described the bug as a feature. Renamed to `"upload_run_asm verify tolerates transient screen read failures and still verifies via liveness"` and its mock changed from permanent to transient (3) failures followed by success, mirroring the BASIC fix above.

Confirm `test/pollValidator.test.mjs` and `test/programRunnersModule.test.mjs` diffs match this description; run `timeout 120 node scripts/run-tests.mjs test/pollValidator.test.mjs test/programRunnersModule.test.mjs test/groupedToolsShims.test.mjs` and confirm all green (96/96 in the second file, 22/22 in the first, as of last check).

### 1c. Leftover test artifacts already cleaned up — verify, don't redo

The hardware-testing session had left two untracked scratch files in the repo root — `.c64bridge.json` (containing `{"u2": {"host": "u2", "port": 80}}`) and `.c64bridge.u64.json`. These were interfering with `test/device.test.mjs`'s `"falls back to vice or c64u when no config"` test via `config.ts`'s "legacy package-adjacent config" fallback candidate (`dirname(import.meta.url of config.ts)/../.c64bridge.json`), which resolves relative to the *source file location*, not `process.cwd()` — so it bypasses that test's directory-isolation helper (`withConfigScenario`) entirely. Both files have already been deleted. Run `git status --porcelain` and confirm neither file is present; if either has reappeared (e.g. from a stray tool run), delete it again before running the full suite — it will cause spurious, hard-to-diagnose failures in `device.test.mjs` and possibly elsewhere.

### 1d. NOT yet fixed — this is the actual remaining work

`scripts/mockC64Server.mjs` was modified to make the C64U mock server's simulated `injectKeyboardQueue` path (used by `upload_run_asm`'s typed `SYS<entry>` trigger) produce *some* observable screen-RAM change, since the mock runs no real 6502 code and the now-mandatory liveness check in `pollAsmOutcome` needs something to observe. The current approach: `simulateKeyboardDrain()` (which already existed, to drain the KERNAL NDX counter) now also detects when the queued/typed text matches `/SYS\s*\d+/i` and, if so, starts a `setInterval` "heartbeat" that increments `state.memory[0x0400]` every 20ms for up to 50 ticks (~1 second), simulating an alive, still-running program.

**This introduced a real regression**: the heartbeat is a background timer with no cleanup tied to test boundaries. Because `test/c64Client.test.mjs` shares one mock server/client instance across many sequential `t.test()` subtests (no `resetState()`/reset call between them), an *earlier* subtest in that file — `"HARD01-018 uploadAndRunAsm loads the assembled PRG..."` (around line 456) or `"HARD01-018 uploadAndRunAsm keeps a non-$0801 origin intact..."` (around line 475), both of which trigger a `SYS...` pattern — leaves a heartbeat ticking for up to a second. A *later*, unrelated subtest a few lines down, `"readMemory returns hex string with prefix"` (around line 506), which expects to read back the exact bytes (`$AA55`) written by the immediately-preceding `"writeMemory writes bytes to mock memory"` subtest, instead observes `$AB55` — the first byte has been incremented by exactly 1 by the still-running heartbeat from the earlier subtest. Confirmed via direct code inspection; not yet re-confirmed by test run after the last edit (the fix attempt was mid-flight when this handover was written — you may find it still fails, or fails intermittently depending on timing).

**Fix this properly before doing anything else.** Suggested directions, roughly in order of robustness (pick one, don't feel obligated to preserve the current heartbeat mechanism if a cleaner design fits better):

1. **Time-computed overlay instead of a live timer (recommended).** Instead of a `setInterval` that mutates `state.memory` in the background, record `state.heartbeat = { startedAt: Date.now(), durationMs, baseValue }` when a `SYS` command is detected, and have the `machine:readmem` handler (or wherever `$0400` reads are served) compute a *synthetic* byte value on read — e.g. `baseValue + Math.floor((Date.now() - startedAt) / 20) & 0xff` — only while `Date.now() - startedAt < durationMs`, otherwise return the real stored byte. This eliminates all background timers and the cross-test leakage entirely: nothing mutates `state.memory` asynchronously, so an unrelated `writeMemory`/`readMemory` pair immediately after a `SYS`-triggering subtest is unaffected (the overlay only applies to reads of that specific address, and only while a window is "active" for a specific triggering event — consider whether the overlay should apply narrowly enough that a real write to `$0400` by a later subtest correctly overrides/disables it, e.g. by clearing `state.heartbeat` on any explicit write to that address).
2. **Track and clear timers explicitly.** Keep the `setInterval` approach, but store the active heartbeat handle in `state` (e.g. `state.activeHeartbeat`), clear any previous one before starting a new one, and clear it in `resetState()`. This only fully solves leakage across resets — it does **not** solve leakage between sequential subtests in the *same* file that never call reset (the actual failure mode observed), so this alone is likely insufficient without also auditing whether `t.test()` sequences in shared-client test files should call `mock.reset()` between subtests (check `test/c64Client.test.mjs`'s setup/teardown and `test/helpers/mcpTestHarness.mjs`'s `withSharedMcpClient` for whether that's feasible without breaking other assumptions).
3. **Shrink the blast radius.** If you keep a live timer, drastically shorten its duration (a handful of ticks over ~40-60ms) so it's very unlikely to outlive the specific subtest that triggered it, while remaining long enough to intersect the poll windows used by tests that override `C64BRIDGE_POLL_MAX_MS`/`C64BRIDGE_POLL_INTERVAL_MS` (values as low as `maxMs: 50, intervalMs: 10` appear in the test suite — check the *smallest* configured poll window across all callers before picking a duration, not just the ones you happen to be looking at). This is the least robust option and only worth using if 1 and 2 both prove impractical.

Whichever approach you take, the fix must satisfy **all** of:
- `test/suites/mcpServerCallToolSuite.mjs`'s `"c64_program upload_run_asm assembles source and runs program"` test passes reliably (run it standalone at least 10 times in a loop to rule out flakiness, not just once).
- `test/c64Client.test.mjs` passes with no cross-subtest interference (run the whole file standalone, and also as part of the full suite — the earlier failure only manifested in the full-suite/whole-file run, not a single-test run, so isolated single-test passes are not sufficient evidence).
- No new timer/interval leaks the Node/Bun process past test completion (check for "open handle" warnings if your test runner surfaces them).
- The underlying simulation stays scoped to the `SYS`-command pattern specifically — `injectKeyboardQueue` is also used by `src/tools/input.ts` for general `key`/`write_text` operations, and those must not trigger this heartbeat/overlay behavior.

After fixing, `timeout 300 npm test` must show **0 failures** across the entire suite (as of last check before the mock-server regression, the count was 792 tests / 788 pass / 2 skip / 0 fail with the pollValidator fix alone, before the mock-server change was introduced — use that as your target, adjusting only for whatever new tests you may have added).

### 1e. Full validation gate for Part 1

Once the full suite is green, run the complete validation gate used earlier in this branch's history (see recent commits `ad93c5d`, `417ec89` for the pattern):

```
npx tsc -p tsconfig.json --noEmit
npm test
npm run test:vice:mock
npm run build
npm run check:package
git diff --check
```

All must pass cleanly. `npm run build` regenerates `mcp/*.json` and `README.md` from source/schema — if those come out changed, that's expected only if you touched schemas; otherwise investigate rather than blindly committing a diff you don't understand.

Also reconsider **patch coverage**: this branch has an established pattern (see commit `ad93c5d`'s message and `.mcp.json`-adjacent `codecov.yml`) of keeping patch coverage above ~94% by, among other things, moving standalone explanatory comments onto the code line they document as trailing comments (since this project's bun-based coverage tooling counts every comment/blank line in a diff hunk as an uncovered patch line). Apply the same discipline to your new diff if it introduces many multi-line comments in changed regions — it's cheap and keeps the codecov gate comfortably clear.

## Part 2 — Adversarial review of the current branch

Once Part 1 is fully green and validated (but not yet committed — or committed as a checkpoint if you prefer smaller commits, your call), perform a genuinely adversarial review of the **entire branch diff against `main`** (i.e. `git diff main...HEAD` plus your uncommitted changes) — not just the new pollValidator/mock-server work. This branch has already been through one automated review round (Kilo Code, five findings, all fixed) and one round of real-hardware testing (which is what surfaced the bug you just fixed) — the goal now is to find what *those* rounds missed, not to re-litigate what they already caught.

Use whichever of these fits best; you have access to the same skills this session had available:
- `/codex challenge` — adversarial mode specifically designed to try to break the code. Well-suited to this task by name; consider using it as a first pass.
- `/review` or `/code-review` — structural pre-landing review (SQL safety, trust-boundary violations, conditional side effects, simplification opportunities).
- Manual review, if you prefer full control or the automated tools are unavailable in your environment.

Focus areas, in rough priority order:

1. **The same bug class elsewhere.** The pollValidator bug was "assume success when a specific text signal never appears, without checking whether that signal was ever achievable for this code path." Grep the codebase for similar patterns — any other poller, verifier, or "wait for X then assume success" loop that has a fallback branch reachable when X structurally cannot occur for some valid code path. `src/tools/programRunners.ts`, `src/c64Client.ts`, and `src/device.ts` are the highest-yield places to look, given they're where the original HARD01-011/018/019/020/021 truthfulness fixes lived.
2. **The mock-server fidelity gap you just fixed, generalized.** If `scripts/mockC64Server.mjs` didn't simulate keyboard-queue-triggered execution at all before your fix, ask whether other mock behaviors (in this file or `src/vice/mockServer.ts`) are similarly "accepts the request, does nothing, returns success" in ways that could mask a real truthfulness bug the same way the U2 firmware gap did. You don't need to fix speculative gaps, but flag anything concrete you find.
3. **Standard security review**: command injection, path traversal (especially around `src/tools/meta/filesystem.ts`, `src/tools/storage.ts`, and anywhere device filesystem paths are constructed — HARD01-010's fix should already cover segment encoding, but re-verify it holds against the newest code), credential/secret handling (HARD01-024's redaction — re-verify it's applied everywhere new logging was added, if any), and any newly-introduced regex (the `SYS_COMMAND_PATTERN` you may still be touching in Part 1) for ReDoS risk given it's small and simple but worth a two-second glance.
4. **Test-suite integrity**: any other test in the suite that, like the two `programRunnersModule.test.mjs` tests you fixed, encodes a *bug* as expected behavior rather than a genuine requirement. This is a real, demonstrated pattern in this codebase now (found twice in one session) — worth a deliberate second pass rather than assuming it was fully exhausted.
5. **The `.mcp.json` `c64bridge-u64` addition**: confirm it doesn't leak the hardware hostname `u64` or any credentials into anything that shouldn't have it (it shouldn't — no password was configured for these devices — but verify), and that it's harmless if a reader without access to that hardware tries to use this repo (the server entry will simply fail to connect, not error out the whole MCP client setup — confirm this assumption is actually true rather than taking it on faith).

## Part 3 — Fix all findings, then land the branch

Fix everything Part 2 surfaces, following the same discipline as the rest of this branch: minimal, root-cause fixes; a regression test for anything that was a real bug; no speculative refactors. Re-run the full Part 1e validation gate after every batch of fixes.

**Exit criteria — do not stop before all of these are true:**

1. `git status` is clean except for intentional, understood changes.
2. Full validation gate (Part 1e) passes with zero failures.
3. Changes are committed with a clear message (follow this branch's existing commit style — see `git log --oneline` — imperative, `fix:`/`test:`-prefixed, explaining *why* not just *what*).
4. Commits are pushed to `fix/hardening` on the `chrisgleissner/c64bridge` remote.
5. `gh pr checks 143 --repo chrisgleissner/c64bridge` shows every check green, including `codecov/patch` and `codecov/project`.
6. If your adversarial review or the push triggers new automated review comments (Kilo Code or otherwise) on PR #143, address every one — reply explaining the fix (or the reasoning if not applicable) and resolve the thread via the GitHub API, exactly as was done for the five Kilo Code findings earlier in this PR's history (see commit `ad93c5d` and its PR comment replies for the established pattern: reply via `gh api repos/chrisgleissner/c64bridge/pulls/143/comments/{id}/replies`, resolve via the GraphQL `resolveReviewThread` mutation).
7. No unresolved review threads remain on PR #143.

Only once all seven are true is this work complete. Report back with: a summary of what the mock-server fix ended up being, what the adversarial review found (if anything) and how it was fixed, confirmation of the exit criteria, and the final CI/PR status.
