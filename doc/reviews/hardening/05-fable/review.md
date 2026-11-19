# Hardening 05 - adversarial review and Ultimate firmware fact check

Baseline: `38fb7071` on `feat/hardening-4` (PR #170). Date: 2026-11-19.
Sources: an adversarial bug hunt (reproduction scripts and outputs in `/tmp/h5-review/` at review
time; every peer was a loopback mock) and a fact check of the Ultimate knowledge against
GideonZ/1541ultimate at `700c7f2fab0b7d52da418d21f0c2e65e99725805` (2026-11-13), recorded in
`ultimate-fact-check.md`. No hardware and no real VICE were used. Triage and decisions by the
product owner / principal architect.

## Decisions

- D1 - Untrusted peers. The device, the emulator and their network path are untrusted input. No
  peer input may allocate memory without a bound, block the event loop, or end the process.
- D2 - Bounds. Video frames: width at most 512, height at most 512, 4 bits per pixel, packet
  encoding field 0 only (the firmware sends 384 x 272 or 384 x 240; encoding 1 is the palette
  packet). REST response bodies: at most 16 MiB by default, and a total deadline per request in
  addition to the idle timeout (default 120 s; a call that already sets a longer timeout keeps
  it). VICE monitor frames: at most 4 MiB.
- D3 - Device paths. No tool argument may change the REST route. Path segments built from
  arguments reject empty, `.` and `..` segments (also percent-encoded) and control characters;
  configuration category and item names also reject `/` and `\`.
- D4 - Text is data. A tool argument documented as text never becomes BASIC statements.
- D5 - Labels belong to one program on one backend. They are cleared on every program start
  except `load_prg`, on reset, reboot, power cycle and power off, and on a backend switch.
- D6 - Knowledge sources. A statement in `data/ultimate/` is one of: confirmed by public
  firmware source (cite the commit once per document), confirmed by the official documentation,
  device-measured (say so), or "(unverified)". The public source has no U64 / C64 Ultimate FPGA
  core, so core register behaviour stays device-measured or unverified.

## Findings (code)

Each needs a test that fails before the fix. IDs B1 to B8 refer to the bug hunt.

| ID | Sev | Finding | Fix |
|---|---|---|---|
| HARD05-001 (B1) | P1 | `src/streamCapture.ts:111-178`: frame dimensions come from packet headers without a bound and a frame counts as complete from line coverage alone. 129 header-only packets (1.5 KB) claim 24000 x 32895; `capture_frame format:"png"` is OOM-killed. Palette packets (encoding field, bytes 10-11, = 1) would be taken for video line 239. | D2 bounds in `parseVideoPacket`; reject a packet whose payload is shorter than `ceil(width*bpp/8)*linesPerPacket`; ignore packets with encoding other than 0; a line counts only when its payload arrived. The `message` handlers of capture sessions must not throw. |
| HARD05-002 (B2) | P1 | `src/device.ts:398-401` and the readmem paths: REST responses are buffered without a size limit and the 10 s timeout is an idle timeout, so an endless body ends in an OOM kill. | D2: `maxContentLength` / `maxBodyLength` and a total deadline (`AbortSignal.timeout`), with a per-call override where a legitimate call needs more. |
| HARD05-003 (B3) | P1 | `src/device.ts:607-608`, `:1852-1854`, `src/tools/developer.ts:56-97`, `src/tools/access.ts:85-101`: `c64_config set` with `category: ".."` sends `PUT /v1/machine%3Apoweroff` and passes the `no-destructive` access check. Device file paths have the same dot-segment gap. | D3 in the encoders (defence at the request) and as validation errors in the tools, before the access check result is trusted. |
| HARD05-004 (B4) | P2 | `src/c64Client.ts:3105-3108` (`buildPetsciiScreenBasic`): `text` goes into `PRINT "..."` unescaped; a quote runs the rest as BASIC. Newlines print as `\N`. | D4: build the PRINT expression as `printerTextExpression` does (CHR$ for quote and other unsafe characters, real line breaks for newlines), keeping lines within the BASIC line limit. |
| HARD05-005 (B5) | P3 | `symbolRegistry.ts` is global and cleared only by `upload_run_asm`, `run_prg`; labels resolve to stale addresses after other program starts, resets and backend switches. | D5. |
| HARD05-006 (B6) | P3 | `src/vice/viceClient.ts:222-235`: no cap on the frame length, `Buffer.concat` per chunk (quadratic), growth on an idle connection. | D2: cap, close the session above it, chunk list instead of re-concatenation. |
| HARD05-007 (B7) | P3 | `src/tools/programRunners.ts:641-644`: a label named `__proto__` is dropped from the `symbols` result. | Build the object so that every name is an own property. |
| HARD05-008 (B8) | P3 | `readMemoryRaw` (`src/c64Client.ts:2565-2593`, `src/device.ts:473-485`) returns whatever arrives; `copy_memory` writes past `dest+length`, short reads report success, a JSON error body reads as an empty success. | A length mismatch and a JSON body without data are errors. Keep the documented clamp at `$FFFF`. |
| HARD05-009 | P3 | `doc/hardening-behavior.md` says `0400` means `$0400`; `c64_memory` and `c64_debug` reject bare hex as ambiguous. | Correct the document to the implemented behaviour. |

## Findings (knowledge, HARD05-010)

All items U1 to U28, M1 to M8 and the stream notes B1/B2 of `ultimate-fact-check.md` are accepted
under D6. The ones that change what a game does:

- HTTPS through the UCI HTTP target is not supported by the public firmware (clear text on 443).
- UCI Control `08`/`09` load and save the configured `REU Preload Image` at run time; the
  "avoid" note is outdated.
- UCI moves to `$DE1C` for EasyFlash cartridges, and each cartridge type disables the Ultimate
  I/O devices that collide with it.
- `$21` (PUSH + IRQ), not `$20`, enables the completion IRQ.
- One rejected value makes UCI LOAD_CONFIG apply nothing; the file-browser sidecar path applies
  the valid lines. Sidecar `.cfg` rules per start path, including REST `run_prg`/`load_prg`.
- The Ultimate Audio sampler register map (`$DF20 + 32*n`, 7 voices reachable).
- Status codes per UCI target; LOAD_REU byte order and limits; `System Mode` hybrids;
  data stream defaults, wired-Ethernet requirement and the palette option.

## Not accepted / out of scope

- A `palette` argument for `c64_stream` (new feature; the capture now ignores palette packets).
- `machine:heap` and `machine:measure` (unused).
- Owner decisions and hardware checks of round 03 remain open. New hardware checks: whether the
  firmware decodes `%3A` before routing (HARD05-003 is fixed on our side regardless), and the
  host-upload path of HARD04-001.
