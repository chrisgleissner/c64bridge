# Hardening 06 - handover

State at 2026-11-20. The fix wave was interrupted by an account spend limit, not by a defect.
Everything below is pushed to `origin`. Nothing of round 6 is merged or in a pull request yet.

## Branch stack

| Branch | Base | State |
|---|---|---|
| `fix/hardening-3` | `main` | PR #169, CI green, not merged |
| `feat/hardening-4` | `fix/hardening-3` | PR #170, CI green, not merged |
| `feat/hardening-5` | `feat/hardening-4` | PR #171, CI green, not merged |
| `feat/hardening-6` | `feat/hardening-5` | review record only (`review.md`, this file); integration target |
| `h6/A` ... `h6/K` | `feat/hardening-6` | one branch per work package, see below |
| `h6/repro` | `feat/hardening-6` | reviewers' reproduction scripts under `doc/reviews/hardening/06-fable/repro/<area>/`; reference only, never merge |

`review.md` holds the binding decisions D1 to D10 and the accepted findings per work package.
`fact-check.md` (on `h6/K`) holds every knowledge verdict with its source.

## Work packages

Each branch has one commit per finding with a test that failed without the fix, unless noted.
None of the branches has been reviewed by a second agent except where stated. None has run the
full suites: agents ran single test files only.

| Branch | Package | Author | State | Left to do |
|---|---|---|---|---|
| `h6/A` | core client (`src/c64Client.ts`, `src/streamCapture.ts`) | Opus | 12 commits, interrupted at the end | Confirm CLIENT-8 (VICE keyboard timeout text and delivered count) and DEVICE-8 (frame completeness) are covered; the last VICE capture tests were not proven to fail without the fix; no final report. |
| `h6/B` | Ultimate backend, config | Opus | complete | Wave 2 wiring of `runCrt(bytes)` and `driveMountImage(drive, bytes, {type, mode})`. |
| `h6/V` | VICE backend (`src/device.ts` VICE part, `src/vice/`) | Sonnet | 14 commits, interrupted during the final test run | Run the VICE test files; Opus review. VICE-10 is client side only. |
| `h6/C` | programming tools | Opus | 13 commits plus one WIP commit | VICE-12 is the WIP commit `6abc67ec` (unfinished, untested). Open: PROGMEM-13 (cache register metadata), PROGMEM-15 (remove the `SidEngine` example unless sourced), WORKFLOW-11 (stale parameter descriptions). |
| `h6/D` | MCP layer | Opus | 14 commits, interrupted | Verify MCP-4 (`prompts/get` size) and MCP-12 (skip redaction without secrets) are done; tests for `resources/templates/list`, fragment links and the lazy HTTP import were being written. |
| `h6/E` | meta tools | Sonnet | complete | META-16: change the `c64_extract fs_stats` description in `src/tools/registry/extract.ts` to "Per-extension size statistics for one directory (no recursion); the firmware returns at most one file per extension." META-17 unsure, untouched. |
| `h6/F` | assembler, BASIC, PETSCII | Sonnet | 2 commits, NOT accepted | Opus review, see "Branch F" below. |
| `h6/G1` | media tools | Sonnet | complete | C64 facts were cited from memory; covered by the fact check list below. |
| `h6/G2` | sound | Sonnet | complete | Wave 2 call sites for `cancelGeneratedSidPlayback`. |
| `h6/H` | retrieval | Sonnet | complete, embeddings rebuilt | Held-out check of ranking with queries the author did not write; rebuild again after knowledge changes. |
| `h6/I` | packaging, README, CI | Sonnet | complete | `bun.lock` was edited by hand; the new CI budget step has never run; `claude mcp add --env` snippet is marked unverified. |
| `h6/K` | knowledge corrections | Opus | only `fact-check.md` written | Apply every CONFIRMED-ERROR and IMPRECISE row of `fact-check.md` to the documents; then the code fact checks below. |

### Branch F - required review (decisions D5, D6)

1. A mistyped mnemonic alone on a line (`rts2`) is silently taken as a label. Required: no silent
   loss of an instruction (error when an unreferenced colon-less label stands alone; at least a
   warning when it precedes an instruction).
2. ACME spellings must have ACME semantics, checked against the ACME documentation: `!text` was
   made PETSCII-converting but is raw in ACME; check `!pet` and `!scr` case mapping; `!align`
   takes and-value, equal-value, optional fill, and its default fill was written from memory.
   A spelling that cannot be sourced is removed and reported as an unsupported directive.
3. Same for the ca65 / 64tass spellings; the dialect comment must say whose semantics each follows.
4. Differential check: all 151 legal opcodes plus at least 40 snippets in ACME, 64tass, ca65 and
   KickAssembler style; each gives exactly the documented bytes or a clear error.
5. BASIC: list-then-tokenise byte-exact; every `{name}` used in `.github/skills` and `data/`
   examples is accepted.

### C64 facts in code still to verify against `fact-check.md` sources (mist64/c64ref)

- `h6/F` `src/petscii.ts`: every control-code name and value; the PETSCII to screen-code rule.
- `h6/G1`: multicolour pixel aspect 2:1; colour RAM `$D800`, cell 999 at `$07E7`/`$DBE7`; cursor
  colour `$0286`; read-back of unused bits in `$D016/$D018/$D020/$D021`; raster bit in `$D011`.
- `h6/E`: screen base from `$DD00` and `$D018`; character block `(($D018 >> 1) & 7) * $800`;
  character ROM image in VIC banks 0 and 2 at `$1000-$1FFF`; sprite pointer = address in bank / 64.
- `h6/C`: the KERNAL names added to the shared address parser (`src/knowledge.ts`).
- `h6/G2`: `$02A6` is 1 for PAL, 0 for NTSC.
- Base tree: every name to address pair in `src/knowledge.ts`.

## Integration

Merge order into `feat/hardening-6` (least to most overlap): I, H, K, E, G2, G1, F, B, V, D, C, A.
Expected overlaps: `src/device.ts` (B and V, different classes), `src/c64Client.ts` (A; F touched
`printerTextExpression` there), `src/tools/registry/` (D; G1 touched `registry/graphics.ts`),
tests changed by several packages. Branch I committed a `node_modules` link once; commit
`3cb79f44` removes it again.

After merging: `npm ci`, `npm run rag:rebuild`, `npm run build` (commit regenerated README, `mcp/`,
embeddings), then `npm run test -- --platform=c64u --target=mock`, `npm run test:vice:mock`,
`npm run check:package`. The `tools/list` tripwire is 71,000 bytes in
`test/suites/mcpServerToolsSuite.mjs`; `test/generateMcpInterface.test.mjs` fails until the
`mcp/*.json` snapshot is regenerated.

## Wave 2 (after integration)

1. DEVICE-6: `location: "host"` for `run_crt` and disk `mount` on Ultimate (client wrappers in
   `src/c64Client.ts`, schemas and handlers in `src/tools/`, `readHostFile` with a size limit,
   image type from the extension, mock routes).
2. VICE-10 tools: bank selection for memory reads, snapshot save and restore, VICE version.
3. Assembler wiring: `.include`/`.incbin` resolvers through `readHostFile`; surface
   `AssemblyResult.warnings` and tokenizer `replacedLines` in `upload_run_asm`/`upload_run_basic`;
   `operandLabel` in `disassemble`; `src/tools/input.ts` imports the shared control-code table;
   tool descriptions mention the dialect.
4. Sound wiring: `run_prg`, `load_prg`, `reset`, `reboot`, `power_cycle` call
   `cancelGeneratedSidPlayback`; `recordAndAnalyzeAudio` passes its abort signal; default the SID
   `system` from the device.
5. Client option from A for `render_sprite` data address exposed in the tool schema; progress
   hook from D used by the long loops in other packages.
6. Knowledge gaps, each fact sourced as in `fact-check.md`: cc65, Oscar64 and llvm-mos specifics
   (zero page use, calling convention, linker configuration, startup), stable raster and open
   border recipes, bitmap and multicolour setup, 8/16-bit multiply and divide, a safe zero page
   map. Not yet fact-checked: `data/gamedev/references.md`, `sidwave.md`, printer documents.
7. `doc/hardening-behavior.md` and `AGENTS.md`: user-visible changes of round 6 (collect them from
   the commit bodies of each branch), including: a missing `C64BRIDGE_CONFIG` file is an error;
   `U2_HOST` never receives the C64U password; redirects are not followed; `play_preset` and the
   sound pipeline no longer verify by default; `read_screen` shows graphics characters as a
   placeholder; range memory operations skip `$D000-$DFFF` on Ultimate unless `includeIo`.
8. Final check: repeat the end-to-end client sessions of the workflow review (`repro/workflow/`)
   on the integrated branch; then one pull request `feat/hardening-6` with base `feat/hardening-5`.

## Not done by design

- Owner decisions: PACKAGE-7 (Jimp, `naudiodon`), PACKAGE-13 and 14 (digest and SHA pinning), and
  the open decisions and hardware checks of rounds 3 to 5.
- No hardware and no real VICE were used in any round.
