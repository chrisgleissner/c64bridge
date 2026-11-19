# Hardening 05 - work log

Branch: `feat/hardening-5` (stacked on `feat/hardening-4` at `38fb7071`). Findings and decisions D1 to D6: `review.md`. Knowledge fact check: `ultimate-fact-check.md`.
A Sonnet agent implemented HARD05-001 to 009 from per-finding briefs. The lead reviewed each fix against the reproduction from the bug hunt, made the corrections listed below, fixed HARD05-011 and 012, and ran the verification.
"Fails when reverted" means: the production files of the finding commit were restored from that commit's parent, the finding's test was run under `node --import tsx/esm --test` and failed, and then the files were restored from HEAD.

| Finding | Status | Commits | Test | Fails when reverted |
| --- | --- | --- | --- | --- |
| HARD05-001 | done | `d93277c1` | `test/hard05VideoPacketBounds.test.mjs` | yes (3 of 4 fail) |
| HARD05-002 | done | `47bffd26` | `test/hard05RestLimits.test.mjs` | yes (the 16 MiB default and total-deadline tests fail; the deadline test hangs until the runner ends the file). The first test sets `maxContentLength` itself and passes either way. |
| HARD05-003 | done | `1a0a85b5` | `test/hard05DevicePaths.test.mjs` | yes (3 of 4 fail) |
| HARD05-004 | done | `dac447e4`, correction `6049da93` | `test/hard05PetsciiScreenText.test.mjs` | yes (4 of 4 fail; the correction's NUL test fails without the correction) |
| HARD05-005 | done | `94d8f507`, correction `61fdb80b` | `test/hard05LabelLifetime.test.mjs` | yes (8 of 12 fail; the 4 correction cases fail without the correction) |
| HARD05-006 | done | `20f178e9` | `test/hard05ViceFrameLimit.test.mjs` | yes (1 of 3 fails) |
| HARD05-007 | done | `01b65957` | `test/hard05ProtoLabel.test.mjs` | yes |
| HARD05-008 | done | `7b0b2ace` | `test/hard05MemoryReadLength.test.mjs` | yes (2 of 3 fail) |
| HARD05-009 | done | `0147e1f1` | `test/hard05BareHexDocument.test.mjs` | not re-checked (documentation) |
| HARD05-010 | done | eight `docs(ultimate)` commits, `f68d1275`, rebuild `1c1d236f` | knowledge and package tests | n/a |
| HARD05-011 | done | `165529a1` | `test/hard05CaptureSessionBounds.test.mjs` | yes (2 of 2 fail: 5,096 and 8,192 packets retained) |
| HARD05-012 | done | `64703f71` | `test/hard05IgnoredPacketDiagnostics.test.mjs` | yes (1,000 records for 1,000 ignored datagrams) |
| docs | - | `4e22e47a` | `doc/hardening-behavior.md` section "Untrusted device data and routes" | n/a |

## Review of the fixes

The bug-hunt reproductions were re-run in bounded form against the fixes.

- 001: the 129 header-only packets, a 512-wide header-only packet, palette packets (encoding 1), 8 bits per pixel and line 510+4 are all rejected. A 384 x 272 frame still assembles. None of the three capture `message` handlers (one-shot video, reusable session, audio) can throw: packet parsing is caught, frame evaluation in the session handler is caught, and the audio handler catches its own errors.
- 002: the endless body is rejected after 86 ms at 16 MiB, and the idle timeout still applies. The queue wraps `instance.request`, so the total deadline starts after the queue wait. Uploads are request bodies and are not limited. The only per-call timeout, the 2 s input probe, is unaffected.
- 003: every place where a tool argument becomes a REST path segment was checked: configs (get, set, flash and reset with a category), files (info and the create calls, through `encodeDevicePath` at the backend, so `find_paths` and `find_and_run` roots are covered too), drives (ids come from the device's own list), runners (the file goes in the query string), and streams (the stream name is an enum). `..`, `%2E%2e`, `%2e.` and `.%2E` are rejected. The accepted item `a/../b` is sent as `a%2F..%2Fb` inside one segment and does not change the route. Double encoding (`%252e`) stays literal.
- 004: a fuzz of 3,000 random ASCII texts left no token outside a string literal in any line. All lines stay under 80 bytes. Very long text is rejected at line number 64000. The review found a NUL hole, fixed in `6049da93`: a NUL byte inside a string ended the tokenised line, and the interpreter then read the following bytes as a link, a line number and statements. NUL plus two characters plus the raw SYS token byte ran SYS.
- 005: labels were still not cleared by `find_and_run`, `program_shuffle`, `batch_run_with_assertions`, the compile/run/verify cycle and `nuclear_reset`. Fixed in `61fdb80b`, clearing only after a successful start.
- 006: frames are reassembled from a chunk list (no quadratic copy). A frame above 4 MiB ends the session.
- 007: the `symbols` object is built with `Object.fromEntries`.
- 008: the length check sits in `readMemoryRaw` for every backend and in the C64U backend. Ranges are validated before the read, so reads that end at `$FFFF` and the clamped `disassemble` read keep exact lengths. The VICE backend returns the requested length.

## Design choices

- HARD05-011: the session keeps the last 4,096 packets, about 60 frames at the firmware geometry and 8 frames of one-line packets. `packetBase` counts the packets dropped from the front, so a waiter's `startIndex` stays absolute. A waiter whose first packets were dropped still completes on newer frames. Per-packet frame evaluation is bounded by the same cap.
- HARD05-012: at most one `capture_video_packet_ignored` record per 10 s per client. It carries the latest reason and `ignoredPackets`, the number ignored since the previous record. Datagrams ignored after the last record of a capture are not reported.
- Test count (verification step): the implementer reported 1,617 Node tests for the c64u run, while round 4 reported 1,749. Both numbers are correct, but they count different things. 1,617 is the first Node batch only. Round 4's 1,749 is the sum of all eight Node batches. A per-file JUnit comparison of the first batch at `38fb7071` and at this branch shows identical counts in every file. The only differences are the nine new `hard05*` files (31 tests). No test file stopped loading.

## Verification (final head)

- `npm run build`: no generated drift. `npm run rag:rebuild` is deterministic (a second rebuild gives identical files).
- `npm run test -- --platform=c64u --target=mock`: Node runner 1,789 tests (all eight batches), 1,785 pass, 0 fail, 4 skipped. Bun runner 88 pass, 0 fail.
- `npm run test:vice:mock`: 353 tests, 338 pass, 0 fail, 15 skipped.
- `npm run check:package`: passed.
- New tests pass under both `bun test` and `node --import tsx/esm --test`.

## Not verified on hardware

- That the firmware accepts no route through percent-decoding beyond what D3 rejects. The B3 question, whether `%3A` is decoded before routing, is no longer reachable from tools.
- That the firmware never answers `readmem` with fewer bytes than requested (for example in `$D000-$DFFF`). Such a read is now an error.
- That the firmware sends nothing but encoding 0 and 1 packets, and frames up to 384 x 272.
- The knowledge items marked "(unverified)" or device-measured in `data/ultimate/` (D6).

## Noticed, not fixed

- `compile_run_verify_cycle` (in `src/tools/meta/compilation.ts`) is not reachable from the grouped tools. Its SIDWAVE branch calls `musicCompileAndPlay`, which no client implements.
