# Hardening 04 - architecture review

Baseline: `ecea4fa3` on `fix/hardening-3` (PR #169, not merged). Reviewer: Fable 5.2, 2026-11-19.
Focus: security, performance, and usefulness for C64 development, especially games in C and assembly.
Method: code reading plus direct checks under Node 24 / Bun; no hardware, no real VICE.

## Summary

Security and performance hold up after round 3: every host path sink goes through the resolver,
waits are bounded or abort-aware, and the HTTP transport checks Host, Origin and token. The
largest remaining gap is usefulness for externally built programs. A game built with cc65,
Oscar64, llvm-mos, KickAssembler, 64tass or ACME produces a PRG and a label file on the host;
the server can neither run that PRG on Ultimate hardware nor read most of those label files, and
labels cannot be used as addresses. 6 findings: 1 P1, 2 P2, 3 P3.

## Findings

### HARD04-001 (P1, usefulness) - a host-built PRG cannot be run on Ultimate hardware

- Where: `src/tools/programRunners.ts` (`prgFileArgsSchema`, `executeRunPrg`, load_prg handler),
  `src/device.ts:433-450`.
- Evidence: on `c64u`/`u2`, `run_prg` and `load_prg` pass `path` to the firmware as a device
  path (`runnersRunPrgUpdate(":run_prg", { file })`). The backend already has the upload calls
  `runPrg(bytes)` and `loadPrg(bytes)` (`POST :run_prg` / `:load_prg`, octet-stream), but no tool
  reaches them with a host file. `data/gamedev/toolchain.md` section 6 therefore says "run_prg
  from device storage", which needs a manual copy to USB or FTP for every build.
- Fix: optional argument `location: "auto" | "host" | "device"` (default `auto` = current
  behaviour: device path on Ultimate, host path on VICE). `location: "host"` on Ultimate reads
  the file with `readHostFile` (E1 confinement; limit 65,538 bytes: 2-byte load address plus
  64 KiB) and uploads the bytes. `location: "device"` on VICE is a validation error. The result
  reports `location` and the load address (first two bytes) for host files.
- Test (must fail before the fix): against the mock server, `run_prg` and `load_prg` with
  `location: "host"` send the file bytes as the request body; a path outside the roots and a
  file above the limit are rejected before any request.

### HARD04-002 (P2, usefulness / truthful results) - label files of 64tass, KickAssembler and ACME load zero symbols without a message

- Where: `src/tools/translation/symbolRegistry.ts:39-54`, `executeRunPrg` and the load_prg
  handler in `src/tools/programRunners.ts`, `src/tools/memory.ts:627`.
- Evidence: `parseViceSymbolFile` accepts only `al [C:]addr .name`. Checked: VICE format 2 of 2
  symbols; 64tass `-l` (`main = $0810`) 0; KickAssembler `.sym` (`.label main=$0810`) 0; ACME
  `-l` 0. `toolchain.md` section 2 tells the user to pass exactly the Kick and 64tass files. The
  result then omits `symbolsLoaded` and reads as success. `symbolsFile` is also ignored without
  a message on every backend other than VICE, and disassembly uses symbols only on VICE.
- Fix: one parser that accepts VICE `al`, `name = $addr` / `name = addr` (64tass, ACME) and
  `.label name=$addr` (KickAssembler; ignore namespace braces). Load symbols on every backend
  and use them in `disassemble` on every backend. When `symbolsFile` was given, the result always
  carries `symbolsLoaded`; 0 adds a warning that names the accepted formats (E8).
- Test: each format parses; a file with no recognisable line returns `symbolsLoaded: 0` and the
  warning; disassembly on the c64u mock shows a label.

### HARD04-003 (P2, usefulness) - labels cannot be used as addresses, and `upload_run_asm` does not return them

- Where: `src/tools/debug.ts:773` (`parseAddress`), `src/tools/memory.ts:657`
  (`parseAddressArg`), `executeUploadRunAsm` result.
- Evidence: the assembler returns `asmResult.symbols`, registered only on VICE and never
  returned, so a client cannot learn where `score` or `game_loop` landed. Address arguments
  accept only numeric literals, so a breakpoint on a label needs a manual lookup in the label
  file on every rebuild.
- Fix: (a) `upload_run_asm` returns `symbols` (name to `$XXXX`, sorted by address, at most 256,
  with `symbolsTruncated` when cut) and registers them on every backend. (b) Address arguments of
  `c64_debug` (checkpoint start and end, `wait_for_state` PC) and `c64_memory` `read`, `write`,
  `disassemble` accept a registered symbol name when the value is not a numeric literal. Numeric
  parsing keeps precedence; an unknown name is a validation error that says no such symbol is
  loaded. Results echo the resolved address.
- Test: after `upload_run_asm` with a label, `read` by label name returns that address; an
  unknown name is rejected; `$0400`, `1024` and `0400` behave as before.

### HARD04-004 (P3, performance) - `upload_run_asm` assembles the source twice

- Where: `executeUploadRunAsm` (`assemblyToPrgDetailed(parsed.program)`), then
  `ctx.client.uploadAndRunAsm(parsed.program)` assembles again (`src/c64Client.ts`).
- Fix: assemble once and hand the assembled result to the client, if the client API allows it
  without changing behaviour. If it does not, record why and skip.
- Test: a counter or spy shows one assembly per call.

### HARD04-005 (P3, security) - the HTTP transport starts without a token and prints no warning

- Where: `src/mcp-server.ts:606-643`.
- Evidence: without `C64BRIDGE_HTTP_TOKEN`, every local process (and every local user on a shared
  host) can call every tool, including power and flash operations. This is documented in
  `AGENTS.md` but the server says nothing at startup.
- Fix: one stderr line at startup in HTTP mode without a token, naming the variable.
- Test: starting `--http` without the variable prints the warning; with it, no warning.

### HARD04-006 (P3, documentation) - no C workflow in the game-development guidance

- Where: `data/gamedev/toolchain.md` sections 2 and 6, `.github/skills/game-development/SKILL.md`.
- Evidence: the documents name cc65, Oscar64 and llvm-mos but give no label-file step for C
  builds, and section 6 predates 001 to 003.
- Fix (after 001 to 003): document the loop "build on the host, `run_prg` with
  `location: "host"` and `symbolsFile`, break and read by label". Name the label options per
  tool (cc65: `-Ln <file>` writes VICE labels; others marked "(unverified)" unless confirmed from
  the tool's documentation). Rebuild the RAG embeddings and generated files with the normal
  build.

## Reviewed and found sound

- Host path sinks (E1) including the I15/I16 trees; HTTP Host/Origin/token checks and loopback
  bind; access check placement; cancellation at wait boundaries; capture socket cleanup.
- Memory read sizes (4096 per call), raw output caps, `tools/list` budget.

## Not in scope

- Compiling C in the server (no bundled compiler; the host toolchain stays the user's choice).
- The owner decisions and hardware checks listed in `03-fable/review.md`.
