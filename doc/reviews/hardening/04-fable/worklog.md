# Hardening 04 - work log

Branch: `feat/hardening-4` (stacked on `fix/hardening-3`, baseline `a0241b8d`). Findings: `review.md`.
Implementation by a Sonnet agent from per-finding briefs; review, corrections and verification by the lead.
"Fails when reverted": the pre-fix production files were restored from the finding commit's parent, the new test was run and failed, and the files were restored from HEAD.

| Finding | Status | Commits | Test | Fails when reverted |
| --- | --- | --- | --- | --- |
| HARD04-001 | done | `fdeb719a` | `test/hard04PrgLocation.test.mjs` | yes (3 of 4 fail) |
| HARD04-002 | done | `30919fb9`, correction `c669bb45` | `test/hard04SymbolFormats.test.mjs`; `test/memory.test.mjs` "disassemble annotates with registered symbols on every backend" | yes (4 of 5 fail with runners and memory reverted; all fail with the registry reverted) |
| HARD04-003 | done | `dac52706`, correction `360934bc` | `test/hard04LabelAddresses.test.mjs` | yes (the correction's bare-hex test fails without it) |
| HARD04-004 | done | `8c8f842e` | `test/hard04AssembleOnce.test.mjs` | yes (1 of 2 fails) |
| HARD04-005 | done | `2d3c23b3` | `test/mcpServerHttp.test.mjs` (two HARD04-005 tests) | yes (the warning test fails) |
| HARD04-006 | done | `3f6f3975`, correction `a216cb24` | docs only | n/a |
| generated | - | `45457b3f` | README, `mcp/tools.json`, `mcp/schemas/c64_program.schema.json` (from 001 and 002) | n/a |

## Review decisions

- Address resolution order (003): numeric literal, then the ambiguous bare-hex rejection, then loaded labels, then documented names (`screen`, `sid`, ...). A loaded program label is what a game developer means, and results echo the resolved address, so the precedence over a documented name is visible. The bare-hex rejection now runs before label lookup, so a label such as `beef` cannot replace the "hexadecimal needs a prefix" error.
- Stale labels (002): `run_prg` without `symbolsFile` now clears the table on every backend, not only VICE, because labels are now registered everywhere. `load_prg` keeps them, since it may add data to a running program.
- `read`/`write` now pass the resolved `$XXXX` to the client. The client resolves the same documented names to the same address, so documented names behave as before; only the fallback label in the text changes from `$screen` to `$0400` when the backend reports no address.
- 004 needed no behaviour change: `uploadAndRunAsm` takes an optional pre-assembled result; one-argument callers are unchanged.
- `tools/list` tripwire unchanged at 71,000 bytes.

## Verification (final head)

- `npm run build`: no generated drift.
- `npm run test -- --platform=c64u --target=mock`: node runner 1,749 tests, 1,745 pass, 0 fail, 4 skipped; bun runner 88 pass, 0 fail.
- `npm run test:vice:mock`: 353 tests, 338 pass, 0 fail, 15 skipped.
- `npm run check:package`: passed.
- New HARD04 tests pass under both `bun test` and `node --import tsx/esm --test`.
