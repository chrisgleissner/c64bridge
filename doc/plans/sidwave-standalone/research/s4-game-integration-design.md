# S4 game and demo integration: design

Status: design (orchestrator, 2026-11-27), from the player layout facts gathered the same day (compiler `sidwave/src/sidwaveCompiler.ts`, abbreviated C). Language changes follow brief section 6; each extension below states the need, why existing constructs cannot express it, the design and one rejected alternative.

## Summary

Game integration is delivered in four steps. S4a adds a "game build" output that needs no language change: the player assembled at a caller-chosen origin, with no BASIC stub, no IRQ installation and no KERNAL use, with player and music data as separate binaries, configurable zero page, assembler symbol files, a documented register contract, PSID relocation fields and measured worst-case cycles. S4b adds subtunes (language 1.4 `songs`). S4c adds sound effects with priorities, voice stealing and restoration (language 1.4 `effects`). S4d adds two example programs that play music and effects next to raster activity, verified in the bundled emulator and once in VICE.

## Facts this design relies on

- The whole player is one symbolic assembly source (C:2909-3226) assembled by 6502-toolkit at `* = $0801`; only the BASIC stub, `SYS2061` text and the three vectors at $080D/$0810/$0813 are fixed (C:31-34, 234-236). Changing the origin reassembles everything else correctly; page alignment is by `.align`, self-modifying code patches labels.
- Player code is generated per tune (features omitted or patched; per-tune constants such as `cia_lo/hi`, `fenv_*`, instrument columns are baked in). Streams come last and start at `stream0`.
- Zero page: `ptr` $FB/$FC, `sid_io` $FD/$FE (multi-SID only), both labels, saved and restored; `$01` set to $36 during play and restored; `$2B-$32` written only by the PRG installer.
- PRG installer (`do_install`) sets the CIA1 timer and `$0314`, exits IRQs through `jmp $EA31`. PSID init does not touch the IRQ. Cycle cost is an analytical upper bound checked against emulator measurements in tests (C:1877, test sidwave12Player:501).

## S4a: game build (compiler option, no language change)

API: `compileSidwave(doc, { target: "game", origin, dataOrigin?, zeroPage?, symbols?: ("acme"|"kickass"|"ca65"|"vice"|"json")[] })` returning `{ player: Uint8Array, data: Uint8Array | undefined, combined: Uint8Array, symbols, contract, cycles }`. CLI: `sidwave compile --target game --origin 0x1000 [--data-origin 0x2000] [--zp 0xF0] [--symbols acme,vice]`.

- Origin: any address from $0200 to $CFFF where player and data fit below $D000 (or below $FFFA when the caller declares the KERNAL banked out; out of scope for now: report as unsupported). Entry points at fixed offsets from the origin: `origin+0 init` (A = subtune index, 0-based), `origin+3 play`, `origin+6 stop` (silences all voices, leaves the IRQ alone), `origin+9 sfx` (S4c; until then a `rts` stub, so the table layout never changes).
- No BASIC stub, no IRQ or CIA setup, no `$0314`, no `$EA31`, no `$2B-$32` writes. PAL/NTSC: the caller passes the clock in X to `init` (0 PAL, 1 NTSC, $FF = read $02A6) so games that bank out the KERNAL still work.
- Separate data: when `dataOrigin` is given, the streams, tables that are pure data (wave, pulse, filter, arp, frequency, instrument columns, samples) go into `data` at `dataOrigin`; code and RAM variables stay in `player`. Both are produced by one compile and belong together; the contract records a content hash of the data that the player expects, and `init` does not verify it (no runtime cost). Rejected alternative: a generic player that reads any data block at runtime through a header: the per-tune feature selection (C:2911-3145) is what keeps the player small and fast, and a generic player would cost cycles and bytes in every game.
- Zero page: `zeroPage` base moves `ptr` (and `sid_io` for multi-SID) to base..base+1 (base+2..base+3); default $FB. Validated: not $00/$01, within $02-$FE.
- Multispeed: the contract states `playCallsPerFrame`; the game calls `play` that many times per frame at even spacing (documented with a raster-split example). The PRG installer behaviour is unchanged.
- Contract (JSON and in the symbol files as comments): entry points, A/X/Y clobbered, `$01` saved and restored, zero page used, SID registers written, RAM range of player variables, no interrupts used, max stack depth, measured cycles.
- Measured cycles: run every subtune for its full length plus one loop on the bundled 6502 emulator, record per-call cycles; report `cycles: { worst, average, estimatedWorst, measuredOverSeconds }` with `worst` marked measured and `estimatedWorst` marked estimated; fail the build when measured exceeds estimated (that would be a compiler defect).
- PSID relocation fields: for `--format sid`, set `startPage`/`pageLength` to the largest free page range in $0400-$CFFF not used by the tune (spec v2NG), or 0 when none of at least 1 page exists.
- Symbol files: ACME (`name = $xxxx`), KickAssembler (`.label name=$xxxx`), ca65 (`name = $xxxx` with `.export` comments), VICE monitor (`al C:xxxx .name`), JSON. Only the public entry points and contract labels are exported by default; `--symbols-all` exports every label.
- Tests: the same score assembled at three origins (including one not page-aligned and one where `.align` padding changes) produces register traces identical (T0) to the PRG build on the emulator; data split produces identical traces; zero-page relocation leaves $FB/$FC untouched (emulator memory watch); contract RAM range is the only RAM written (emulator write watch over a full song); every symbol format parses in its assembler where the assembler is available locally (64tass/acme/ca65 if installed, else format tests only, reported as such).

## S4b: subtunes (language 1.4)

- Need: games and demos ship several songs (title, in-game, game over) in one binary sharing one player and instruments. Today one score is one song; compiling several scores duplicates the player and instruments and gives several binaries.
- Existing constructs: `sections`/`timeline` describe one song; no construct selects between alternative timelines at init.
- Design: optional top-level `songs:` list, each `{ name, timeline, loop?, tempo?, speed? }`; when absent, the document is one song exactly as in 1.3 (identical bytes). Instruments, patterns and sections are shared. `init` takes A = song index. PSID header `songs` and `startSong` set accordingly; per-song speed bits. Lint: unused patterns, songs with no timeline.
- Rejected alternative: multiple documents in one YAML stream (`---`): duplicates instruments and makes shared edits error-prone.
- Older versions: a 1.3 document that contains `songs` is rejected by name.

## S4c: sound effects (language 1.4)

- Need: games trigger short sounds over the music. No current construct expresses an event-triggered sequence independent of the timeline.
- Design: top-level `effects:` map; each effect `{ priority: 0-15, voices: [1,2,3] (allowed), steps: [...] }` where a step is a frame with optional `freq` (note or exact Hz), `wave`, `pulse`, `adsr`, `gate`, `filter: off|keep`, and `wait` frames. Runtime entry `sfx` (origin+9): A = effect index, Y = requested voice or $FF for automatic; returns carry clear on start, carry set when rejected.
- Voice allocation: automatic choice takes an allowed voice that is free of effects, else the allowed voice whose current effect has the lowest priority strictly lower than the new one; equal priority restarts the same effect on the same voice; otherwise rejected.
- Music voice handling: while an effect owns a voice, the music for that voice keeps running and writes into a 7-byte shadow instead of the SID; when the effect ends, the shadow is copied to the SID in the same play call (gate state included), so the music resumes at its current position. Filter routing bit of the voice is cleared for `filter: off` and restored at the end.
- Latency: an effect starts at the next `play` call; the bound is one play period, measured in tests.
- Rejected alternative: effects as subtunes: starting a subtune stops the music.
- Tests (adversarial): trigger every frame for 10 s, triggers on all voices at once, priority inversions, a trigger in the same call as a song loop, effects during multispeed, effect running when `stop` is called, effect longer than the song; each checks: music voices not owned by an effect keep T0-identical writes to the plain music trace; after an effect ends the owned voice's writes match the plain music trace from the next note onward; no write to an owned voice comes from the music; measured worst-case cycles with effects reported.

## S4d: example programs

Two programs in `sidwave/examples/game/`, each a SIDWave score plus a small 6502 program assembled with 6502-toolkit: (1) raster bars with music and an effect on joystick fire; (2) a sprite moving with effects on screen-edge collision. Verified in the emulator test harness (cycles per frame below the raster budget, effects triggered by scripted input) and once in VICE with a capture (ledger).

## Order and status

S4a first (no language change, unblocks integration), then S4b, S4c, S4d. Retargeting (PAL/NTSC, 6581/8580, SID count) and resource optimisation, asset libraries and example scores for human authors follow as separate packages.
