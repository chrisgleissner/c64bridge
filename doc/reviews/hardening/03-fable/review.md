# Hardening 03 - Adversarial review of the C64 Bridge MCP server

## Summary

This is the third hardening review of the C64 Bridge MCP server. It was run against version 1.2.0
(`6756495` on `main`) after two earlier rounds (`01-fable`, 35 findings; `02-fable`, 55 work items)
had been fixed and released. The review found **46 confirmed defects: 3 P1, 21 P2 and 22 P3**. None
needs real hardware to demonstrate, and none has been fixed yet. This document lists each defect
with its evidence and the proposed fix. The implementation brief is `prompt.md` in this directory.

The three P1 findings:

- **HARD03-001.** The VICE resource allowlist compares names case-sensitively while VICE resolves
  them case-insensitively. `SoundRecordDeviceARG` passes the check, so a tool call can make VICE
  create or truncate any file the user can write.
- **HARD03-002.** `c64_graphics render_bitmap` passes `imagePath` straight to `Jimp.read`, which
  reads any host file and, when the path does not exist, fetches it as a URL. Host path confinement
  does not apply and the server can be made to issue arbitrary HTTP GET requests.
- **HARD03-016.** `c64_graphics render_sprite` never writes the sprite pointer at `$07F8+n` and
  clears the screen, while reporting success and the pointer value it did not write.

The main patterns across all findings:

1. **Guards added in round 2 have unguarded siblings.** Host path confinement misses the image
   reader (002) and allows writes over the server's own configuration file (003). The resource
   allowlist misses letter case (001). The shared address parser was not applied to three local
   copies (024). The capture size caps do not hold inside `c64_batch` (011). The breakpoint-stop fix
   of 1.2.0 misses the disk autoload wait (020).
2. **False success remains in less-used operations.** `find_paths`, `find_and_run`, `fs_stats` and
   `shuffle` parse a response shape the firmware never sends (017). Step, reset, mount, bundle,
   batch and audio operations report success without checking the result they received (018, 019,
   022, 023, 026, 031).
3. **Tool arguments can block or crash the process.** A screen regex blocks the event loop for
   minutes under Bun (008), an unbounded `length_bars` or RAG query does the same on any runtime
   (009, 010), a missing `Xvfb` binary terminates the server (013), and MCP cancellation is ignored
   (012).
4. **Process-level assumptions do not hold.** The launcher changes the working directory depending
   on whether Bun is installed (040), two server processes share one task state file (015), state
   directories grow without limit (014) and the test suite writes into the developer's real state
   directory (046).

Open items that need a decision by the owner or a check on real hardware are listed at the end
("Needs hardware confirmation", "Decisions for the owner").

## Baseline

- Review date: 2026-11-14
- Version: 1.2.0
- Commit: `6756495c52dd1511dff62b2572e2b894b14e894c` on `main`, working tree clean
- Review mode: review only. No production code was changed.
- Hardware: none contacted. No `mcp__c64bridge__*` tool was called, no request was sent to a device
  host and no outlet was switched.
- Artifacts: `doc/reviews/hardening/03-fable/review.md` (this file) and `prompt.md`

## Method

The server was split into six areas. Five were each reviewed by an independent reviewer (Opus 5.5)
that received the same brief: hard rules, the two earlier rounds as context, and a report format
that requires a trigger, quoted evidence and a statement of how the finding was verified. The
sixth area (dispatch, access mode, host paths, transports, redaction, diagnostics, background
tasks) was reviewed by the lead (Fable 5.2). The lead then checked every reported finding against
the source at `6756495` before accepting it. Findings that could not be confirmed are in "Leads
not proven".

Reproductions were small Bun or Node scripts that imported the sources directly and used stub
clients, the REST mock (`scripts/mockC64Server.mjs`) or the Binary Monitor mock
(`src/vice/mockServer.ts`) on loopback. HARD03-001 was additionally run against one headless
`x64sc` 3.10 under Xvfb on a loopback port. The scripts lived in a session scratch directory and
are not part of the repository; each finding describes the reproduction in enough detail to
rebuild it as a test.

"Verified" values used below:

- **reproduced**: a script showed the wrong outcome.
- **read**: confirmed by reading the code path from tool input to outcome; the remaining
  uncertainty is stated.

Firmware behaviour is cited from the public `1541ultimate` sources and VICE behaviour from the
VICE 3.10 sources.

## Findings count

| Severity | Count | Meaning |
|---|---:|---|
| P1 | 3 | Security or safety boundary broken, or a systematically wrong result |
| P2 | 21 | Wrong result, crash or wedge in a realistic scenario |
| P3 | 22 | Minor or edge case, or a documentation contract |
| Total | 46 | |

| Area | Count |
|---|---:|
| Security and safety boundary (001-007) | 7 |
| Resource use, lifecycle and process state (008-015) | 8 |
| Result correctness (016-039) | 24 |
| Launch, packaging, CI, documentation and tests (040-046) | 7 |

## Findings index

| ID | Title | Sev | Verified |
|---|---|---|---|
| HARD03-001 | VICE resource allowlist is bypassed by letter case; a tool can create or truncate any host file | P1 | reproduced (real x64sc) |
| HARD03-002 | `render_bitmap` reads any host file or URL, outside host path confinement | P1 | reproduced |
| HARD03-003 | Host path confinement allows writes over the server configuration and hidden files in the working directory | P2 | reproduced |
| HARD03-004 | `render_bitmap` accepts bitmap or screen memory over `$D000-$DFFF` | P2 | reproduced (layout), read (effect) |
| HARD03-005 | Access mode gaps: read-only can start but not stop tasks; network configuration and `nuclear_reset` are under-classified | P3 | reproduced / read |
| HARD03-006 | New credential values reach the diagnostics file and the debug log | P3 | reproduced / read |
| HARD03-007 | Secret redaction replaces substrings in every tool result and corrupts data when the password is short | P3 | reproduced |
| HARD03-008 | Under Bun, one `wait_for_text` regex blocks the whole server for minutes | P2 | reproduced |
| HARD03-009 | SIDWAVE `length_bars` and `bars` are unbounded; one call uses seconds of CPU and gigabytes of memory | P2 | reproduced |
| HARD03-010 | `c64_rag` accepts a query of any length; a long `docs` query blocks the event loop | P2 | reproduced |
| HARD03-011 | `c64_batch` bypasses the 2 MiB raw-pixel cap and the 4-image cap of `capture_frame` | P2 | reproduced |
| HARD03-012 | MCP cancellation is ignored and several waits have no upper bound | P2 | read |
| HARD03-013 | The server process exits when `Xvfb` is not installed | P2 | reproduced |
| HARD03-014 | Output directories and the task registry under `~/.c64bridge` grow without limit | P3 | read, observed |
| HARD03-015 | Two server processes share one background task state file | P3 | read |
| HARD03-016 | `render_sprite` never writes the sprite pointer and clears the screen | P1 | reproduced |
| HARD03-017 | `find_paths`, `find_and_run`, `fs_stats` and `shuffle` never match on real firmware | P2 | reproduced (firmware shape), read (firmware) |
| HARD03-018 | `step` and `step_return` report success when the CPU did not stop | P2 | reproduced |
| HARD03-019 | `nuclear_reset` reports a restart that failed or is unsupported | P2 | reproduced |
| HARD03-020 | Mounting a disk on VICE runs the CPU past a breakpoint hit during autoload | P2 | reproduced |
| HARD03-021 | `upload_run_basic verify:true` reports "verified" when nothing ran and the old screen contains "RUN" | P2 | reproduced |
| HARD03-022 | `bundle_run` writes empty memory files and reports success when a read fails | P2 | reproduced |
| HARD03-023 | `batch_run` and `shuffle` skip paths that are not `.prg` or `.crt` and report a pass | P2 | reproduced |
| HARD03-024 | Three address parsers still read `0400` as decimal 400 | P2 | reproduced |
| HARD03-025 | `upload_run_asm` reports "not loaded" for a program whose lowest block lies under ROM | P2 | read |
| HARD03-026 | `analyze` reports accurate music on silence; `pipeline` reports success when nothing played | P2 | reproduced / read |
| HARD03-027 | `play_preset` with the default `verify:true` reports an error after the music started on VICE and U2 | P2 | reproduced |
| HARD03-028 | `get_display_state` reports the wrong bitmap address in bitmap mode | P2 | reproduced |
| HARD03-029 | `write_text`, `key` and `upload_run_asm` ignore the VICE keyboard-feed status | P3 | read |
| HARD03-030 | `wait_for_state` without `expectedPC` reports a match at once when no debug session exists | P3 | read |
| HARD03-031 | `c64_disk mount verify:true` reports success when the verification failed | P3 | read |
| HARD03-032 | `c64_input joystick` `tap` ignores `durationMs` on C64U | P3 | read |
| HARD03-033 | Frame and audio capture replace and then stop a stream the user started | P3 | read |
| HARD03-034 | The assembler encodes the invalid `(zp),x` as `(zp,x)` | P3 | reproduced |
| HARD03-035 | The assembler zero-fills gaps between blocks, including over `$D000-$DFFF` | P3 | reproduced (output), read (effect) |
| HARD03-036 | `c64_memory write verify:true` ignores `mask` in the post-write check and always fails on I/O registers | P3 | reproduced |
| HARD03-037 | Printer text turns `<return>`, `:cr:` and `{home}` into control codes; success is reported without a check | P3 | reproduced |
| HARD03-038 | The published `render_sprite` examples fail validation | P3 | reproduced |
| HARD03-039 | The default `c64_extract charset` scan reads `$D800-$DFFF` on hardware | P3 | read |
| HARD03-040 | `scripts/start.mjs` moves the working directory to the checkout when it starts Bun from Node | P2 | reproduced |
| HARD03-041 | Developer-only agent prompts ship in the package and are returned as RAG references | P3 | reproduced |
| HARD03-042 | `c64://guide/index` names tools that do not exist; `docs` is missing from the published contract | P3 | reproduced / read |
| HARD03-043 | The `bin` launcher builds a file URL by concatenation; an install path with `#` or `%` fails | P3 | reproduced |
| HARD03-044 | `scripts/invoke-bun.mjs` does not forward signals to the server | P3 | read |
| HARD03-045 | The release job runs unpinned and unlocked code while it holds `id-token: write` | P3 | read |
| HARD03-046 | The test suite writes into the developer's real `~/.c64bridge` | P3 | observed |

## Detailed findings

Each finding states: where the defect is, the evidence, a concrete trigger, how it was verified,
the proposed fix, and the test that must fail before the fix. Line numbers are from `6756495`;
locate by symbol if they have moved.

### Security and safety boundary

#### HARD03-001 - VICE resource allowlist is bypassed by letter case; a tool can create or truncate any host file

- **Severity:** P1
- **Where:** `src/vice/resourcePolicy.ts:22` (`HOST_FILE_RESOURCE_PATTERN`) and `:37` (prefix
  check). Used by `src/tools/vice.ts` (`c64_vice`) and by `assertAllowedViceResource` in
  `src/device.ts` (`c64_config` `get`, `set` and `batch_update` on VICE).
- **Evidence:** The pattern that refuses resources naming host files is case-sensitive:
  `/(File|Image|Dir|Directory|Path|Arg|Name)\d*$/`. VICE looks resources up case-insensitively
  (`vice-3.10/src/resources.c`: the hash key uses `tolower`, and the lookup compares with
  `util_strcasecmp`). `SoundRecordDeviceARG` and `SoundRecordDeviceNAME` therefore pass the `Sound`
  prefix check, miss the host-file pattern, and are applied by VICE as `SoundRecordDeviceArg` and
  `SoundRecordDeviceName`. Setting the name to `wav` makes VICE open the path in the argument for
  writing. The same bypass works for `SoundDeviceARG`/`SoundDeviceNAME`, `VICIIPaletteFILE` and
  `JoyMapFILE`. `C64_256Kfilename` passes with its real spelling because the pattern does not
  cover a lower-case `filename` suffix. The mock monitor compares names case-sensitively, which
  hides the defect in tests.
- **Trigger:** `c64_vice {op:"resource_set", name:"SoundRecordDeviceARG", value:"/home/u/.bashrc"}`
  followed by `{op:"resource_set", name:"SoundRecordDeviceNAME", value:"wav"}`. The same works
  through `c64_config set`. VICE creates or truncates the file, outside every allowed host root.
  Both calls should be validation errors.
- **Verified:** reproduced against headless `x64sc` 3.10: the policy allowed the name, reading the
  canonical `SoundRecordDeviceArg` back returned the path, and the file existed afterwards (a path
  inside the scratch directory was used).
- **Related:** sibling of S-04 (round 2), which introduced the shared policy.
- **Fix:** Compare case-insensitively: lower-case the name for the prefix test and for the
  host-file pattern, and extend the pattern to `filename`, `file`, `image`, `dir`, `directory`,
  `path`, `arg`, `name`, `log`, `command`, `cmd` and `dev` suffixes as needed after checking them
  against the VICE resource list. Prefer an explicit allowlist of canonical names over a pattern
  where the set is small, and send the canonical spelling to VICE. Make the mock monitor
  case-insensitive. `WarpMode`, `SidEngine` and the names in `VICE_CONFIG_INVENTORY` must keep
  working.
- **Test:** `resourceNameProblem("SoundRecordDeviceARG")`, `("VICIIPaletteFILE")`,
  `("JoyMapFILE")` and `("C64_256Kfilename")` return a problem; the same names are rejected through
  `c64_vice` and through `c64_config` on VICE.

#### HARD03-002 - `render_bitmap` reads any host file or URL, outside host path confinement

- **Severity:** P1
- **Where:** `src/vicBitmap.ts:91` (`importImageAsVicBitmap`), called from
  `executeGenerateBitmap` in `src/tools/graphics.ts`.
- **Evidence:** `const image = await Jimp.read(options.imagePath);` receives the raw tool argument.
  Neither file calls `resolveHostPath`. `Jimp.read` in jimp 1.x does
  `existsSync(url) ? readFile(url) : fetch(url)`. Three consequences:
  1. Any readable host image is decoded and shown on the C64, where `capture_frame` returns it.
  2. Any `http(s)://` value is fetched with GET and the whole body is buffered (server-side
     request forgery, no size cap).
  3. There is no regular-file check, byte cap or dimension cap, so `/dev/zero` or a decompression
     bomb exhausts memory.
- **Trigger:** `c64_graphics {op:"render_bitmap", imagePath:"/usr/share/icons/x.png",
  format:"hires"}` succeeds although `resolveHostPath` rejects the same path. With
  `imagePath:"http://127.0.0.1:<port>/internal/secret.png?token=x"` the server issues that request.
- **Verified:** reproduced with a stub client and a loopback HTTP listener: the file outside the
  roots was displayed and the listener received the GET.
- **Related:** sibling of S-01 (round 2). `Jimp.read` was not in the list of sinks that round
  searched for.
- **Fix:** In `executeGenerateBitmap`, read the file with `readHostFile(imagePath)` (regular file,
  16 MiB cap, confinement) and decode with `Jimp.fromBuffer`, so `fetch` cannot be reached. Reject
  images whose decoded size exceeds a fixed limit (for example 4096 x 4096), and check the header
  dimensions before decoding where the format makes that cheap (PNG `IHDR`). Tests that use
  temporary files keep working because the temp directory is an allowed root.
- **Test:** `render_bitmap` with a path outside the roots and with an `http://127.0.0.1` URL
  returns a validation error and the listener sees no request.

#### HARD03-003 - Host path confinement allows writes over the server configuration and hidden files in the working directory

- **Severity:** P2
- **Where:** `src/hostPaths.ts:72-87` (`allowedHostRoots`) and `:118-147` (`resolveHostPath`); the
  write sinks call plain `fs.writeFile` (for example `src/tools/memory.ts:894`,
  `src/tools/meta/memory.ts:265`). Configuration is read from `./.c64bridge.json`
  (`src/config.ts:50`).
- **Evidence:** The working directory is an allowed root and every path inside it is accepted for
  reading and for writing, including existing files and hidden files. `c64_memory save_memory`
  with `asPrg:false` writes bytes the caller first placed in C64 memory, so the content is fully
  controlled. `resolveHostPath("./.c64bridge.json", {purpose:"write"})`, `.git/hooks/pre-commit`,
  `.claude/settings.json`, `.env` and `package.json` are all accepted. `./.c64bridge.json` is the
  first configuration file the server reads at its next start. It selects the device host (and so
  where the `X-Password` header is sent), the VICE executable (`vice.exe`) and extra VICE
  arguments (`vice.args`, for example `-remotemonitor -remotemonitoraddress 0.0.0.0:6510` or
  `-logfile <path>`). In the other direction, `load_prg` and `run_prg` on VICE read any regular
  file in the roots into emulator memory, where `c64_memory read` returns it; this includes
  `.c64bridge.json` with the network password in clear text and `.env`.
- **Trigger:** text on a C64 screen or in a disk directory instructs the agent to write memory and
  call `c64_memory {op:"save_memory", address:"$C000", length:120, asPrg:false,
  outputPath:"./.c64bridge.json"}`. The next server start in that directory uses the planted
  configuration.
- **Verified:** reproduced: `resolveHostPath` accepted all five paths for writing in a directory
  that contained them. The consequence for the next start follows from `loadConfig`.
- **Related:** design decision D1 of round 2; the "Deferred" list of round 2 mentions that
  `./.c64bridge.json` can name the VICE executable, without the write path that makes it reachable
  from a tool.
- **Fix:** In `resolveHostPath`, for both purposes:
  1. Reject the configuration candidates (`C64BRIDGE_CONFIG`, `<cwd>/.c64bridge.json`,
     `~/.c64bridge.json`, the package-adjacent file) and the task state file by real path.
  2. Reject a path that has a component starting with `.` below the allowed root. The
     `~/.c64bridge` root itself stays allowed; a hidden component below it does not.
  3. Provide an operator opt-out (`C64BRIDGE_ALLOW_HIDDEN_PATHS=1`) and name it in the error.
  Whether a write may replace an existing file that the server did not create is a decision for
  the owner (see the end of this document).
- **Test:** table-driven cases for the five paths above (read and write), for the opt-out, and for
  `~/.c64bridge/x.bin` still being accepted; one tool-level test showing `save_memory` to
  `./.c64bridge.json` is rejected and writes nothing.

#### HARD03-004 - `render_bitmap` accepts bitmap or screen memory over `$D000-$DFFF`

- **Severity:** P2
- **Where:** `src/vicBitmap.ts:142-190` (`resolveVicBitmapMemoryLayout`); the writes happen in
  `C64Client` (`displayBitmap`, around `src/c64Client.ts:750`).
- **Evidence:** The layout check enforces bank, alignment and the character ROM shadow of banks 0
  and 2, and nothing about the I/O area. It accepts `bitmap $C000 / screen $E000`,
  `bitmap $E000 / screen $D000` and `screen $DC00`. Writing 8000 bytes at `$C000` covers
  `$D000-$DF3F`: VIC, SID, both CIAs (`$DD00` selects the VIC bank and drives the serial bus) and
  the cartridge I/O area `$DE00-$DF3F`, where the REU and the Ultimate Command Interface registers
  are on Ultimate hardware.
- **Trigger:** `render_bitmap {imagePath, format:"hires", bitmapAddress:"$C000",
  screenAddress:"$E000"}`.
- **Verified:** the acceptance of the three layouts was reproduced. That a REST or monitor write
  in this range reaches the I/O registers was not run; it is the same access path as HARD01-020.
  Needs hardware confirmation.
- **Fix:** Reject bitmap or screen ranges that overlap `$D000-$DFFF`. Bank 3 with the bitmap at
  `$E000` and the screen at `$C000-$CC00` stays valid. Put the range test in one shared helper and
  use it for HARD03-035 and HARD03-039 as well.
- **Test:** the layout function throws for the three pairs and still accepts
  `bitmap $E000 / screen $CC00`.

#### HARD03-005 - Access mode gaps

- **Severity:** P3
- **Where:** `src/tools/registry/system.ts:164-169`, `src/tools/registry/config.ts:271-277`,
  `src/tools/debug.ts:633-638`.
- **Evidence and triggers:**
  1. With `C64BRIDGE_ACCESS=read-only`, `c64_system start_task` with a read operation has effect
     `read` (the override in `effectOf`), while `stop_task` and `stop_all_tasks` have effect
     `write`. A task that the mode allowed to start cannot be stopped until `maxIterations` or a
     restart. Reproduced: `effectOf` returns `read`, `write`, `write` for the three calls.
  2. `c64_config set` and `batch_update` have effect `write` for every category. The firmware's
     network category holds `Network Password`, `Web Remote Control Service`, `Use DHCP` and
     `Static IP` (`1541ultimate/software/network/network_config.cc`). Changing these can cut the
     bridge off from the device, which matches the definition of `destructive` ("interrupts
     availability"). `no-destructive` mode allows it. Read only; when the firmware applies these
     items needs hardware confirmation.
  3. `c64_debug nuclear_reset` (stops and restarts the VICE process) has effect `write`, while the
     equivalent `c64_system power_cycle` is `destructive`.
- **Fix:** Classify `stop_task` and `stop_all_tasks` as `read` (they only reduce activity).
  Classify `nuclear_reset` as `destructive`. Add an `effectOf` rule that makes `set` and
  `batch_update` destructive when the category is a network category (match case-insensitively on
  `network`, `wifi`, `wi-fi`, `ethernet`, `modem`), and treat a wildcard category the same way.
- **Test:** `test/accessMode.test.mjs` cases for each rule in each mode.

#### HARD03-006 - New credential values reach the diagnostics file and the debug log

- **Severity:** P3
- **Where:** `src/mcp-server.ts:456-459` (`mcp_call_tool_start` records the arguments);
  `src/loggingHttpClient.ts:54-68` (`redactConfigParams`, `redactConfigPath`).
- **Evidence:**
  1. Every tool call writes its arguments to the diagnostics file
     (`~/.c64bridge/diagnostics/*.ndjson`, kept for up to 30 days) at every log level.
     `sanitize` replaces only registered secrets and credential header names. The value in
     `c64_config {op:"set", category:"Network settings", item:"Network Password", value:"..."}` is
     neither, so the new password is stored in clear text. `c64_system performance_report` with
     `includeTimeline` returns those records to the client. Read.
  2. The debug log redacts the `value` query parameter only when the item name matches the
     credential pattern. The firmware matches category and item names with wildcards and without
     regard to case (`pattern_match` in `1541ultimate/software/api/route_configs.cc`), so the item
     `Network P?ssword` writes the password while the name does not match the pattern, and the
     value is logged. Reproduced against the REST mock with a debug logger.
- **Related:** 1.2.0 "keep configuration passwords out of debug logs".
- **Fix:** Redact the value of every configuration write in logs and diagnostics: in the HTTP
  logging layer, replace the `value` parameter and body of every `PUT /v1/configs/...`; in the
  CallTool handler, replace `value` and the leaf values of `updates` for `c64_config` `set` and
  `batch_update` before the arguments are recorded. Item names stay visible.
- **Test:** the wildcard item case through the response interceptor, and a CallTool-level test
  that the diagnostics record for a `set` call does not contain the value.

#### HARD03-007 - Secret redaction replaces substrings in every tool result and corrupts data when the password is short

- **Severity:** P3
- **Where:** `src/mcp/callToolResult.ts:34-42` (`redactValue` on content, structured content and
  metadata); `src/redact.ts:16` (`MIN_SECRET_LENGTH = 1`) and `:35-44` (`redactText`).
- **Evidence:** Every registered secret (network password, HTTP token) is replaced wherever it
  occurs as a substring of any string in any result, including hex dumps, base64 image data and
  the JSON text content. The firmware accepts network passwords from 3 characters
  (`network_config.cc`: minimum 3, maximum 31). With the password `1234`, a result
  `{address: 1234, hex: "A9123400"}` becomes text `{"address":***,"hex":"A9***00"}`, which is not
  valid JSON, while `structuredContent` keeps the number and loses the hex digits. A PNG image
  block containing the characters is corrupted. For a 3-character password, a 130 KB base64 image
  contains it by chance in roughly four of ten captures.
- **Trigger:** device password `1234`; `c64_memory read` of memory containing `12 34`, or any
  `capture_frame` with `format:"png"`.
- **Verified:** reproduced with `registerSecret("1234")` and `toCallToolResult`.
- **Fix:** Required properties, whichever design is chosen: image block data is never altered; the
  text content of a JSON result stays valid JSON and equal to the structured content; hex and
  base64 payload fields are unchanged; error messages and log lines still never contain a
  registered secret. One workable design: in successful results redact only string leaves, and
  there only matches delimited by non-alphanumeric characters or string ends; regenerate the JSON
  text from the redacted structured value; keep substring redaction for error results and logs.
  Warn once at startup when a configured secret is shorter than 8 characters.
- **Test:** the reproduction above (valid JSON, unchanged hex, unchanged image data) and a test
  that an error message containing the password is still redacted.

### Resource use, lifecycle and process state

#### HARD03-008 - Under Bun, one `wait_for_text` regex blocks the whole server for minutes

- **Severity:** P2
- **Where:** `src/tools/meta/screen.ts:22` (`MAX_UNBOUNDED_REPEATS = 3`), `:26`
  (`runtimeEnforcesPatternTimeout`), `:76-142` (`assertSafeScreenPattern`), `createScreenMatcher`.
  Launch path: `scripts/start.mjs` starts Bun whenever `src/index.ts` exists.
- **Evidence:** Bun does not interrupt a regex with the vm timeout, so the static check is the
  only bound there. It allows three unbounded repeats, and it does not count bounded repeats such
  as `{0,999}` at all. `[\s\S]` and negated classes cross the line breaks of the 25-line screen
  text. Measured under Bun: `[^!]*[^!]*[^!]*!` took 165 s on a full screen;
  `[\s\S]*[\s\S]*[\s\S]*Z` took 114 s; six `[^!]{0,999}` followed by `!` took 80 s on 100
  characters. The validation error "took longer than 250 ms" appears only after the match has
  finished. During that time no other request, timer or stdin event is handled. Under Node the vm
  timeout stops the same patterns at 250 ms. `npm start`, `node scripts/start.mjs`, `.mcp.json`,
  `.vscode/mcp.json` and the Docker `CMD` all run Bun from a checkout; only the npm package
  (`dist` under Node) is unaffected.
- **Trigger:** `c64_memory {op:"wait_for_text", isRegex:true, pattern:"[^!]*[^!]*[^!]*!"}`.
- **Verified:** reproduced under Bun and, for contrast, under Node.
- **Related:** T-16 (round 2) and the 1.2.0 change "run screen patterns under a vm timeout on
  Node".
- **Fix:** Bound the evaluation on every runtime. Either evaluate the pattern in a worker thread
  that is terminated at the timeout, or, where the timeout is not enforced, count every
  quantifier (bounded or not) toward a budget of one and reject classes that match a line break
  under a repeat. Plain substring mode and patterns such as `READY.` and `.*READY.*` must keep
  working.
- **Test:** under Bun, the three patterns above are rejected or finish within 1 s on a
  1000-character screen.

#### HARD03-009 - SIDWAVE `length_bars` and `bars` are unbounded

- **Severity:** P2
- **Where:** `src/sidwave.ts:183` and `:373` (`{ min: 1, integer: true }`, no maximum);
  `src/sidwaveCompiler.ts:282` (section loop). The 50 KB program size check runs after the whole
  arrangement was built.
- **Trigger:** `c64_sound {op:"compile_play", dryRun:true, sidwave:{tempo:120,
  voices:[{id:1, patterns:{A:{groove:["C4"]}}}], timeline:[{bars:1, layers:{v1:"A"}}],
  length_bars:1000000}}`. `pipeline`, `play_preset` and `compile_play` with `output:"sid"` reach
  the same code.
- **Verified:** reproduced: the call ran synchronously for 15.6 s and reached 2.2 GB resident
  memory before failing with the size error.
- **Fix:** Reject before arranging when `length_bars` or the sum of section `bars` exceeds a limit
  that a valid song cannot reach (for example 4096 bars, or a frame count limit derived from the
  50 KB program limit).
- **Test:** `length_bars: 1e6` returns a validation error within 100 ms.

#### HARD03-010 - `c64_rag` accepts a query of any length

- **Severity:** P2
- **Where:** `src/tools/rag.ts:20-24` (`q` has `minLength: 3` and no `maxLength`);
  `src/rag/retriever.ts:148-170` (`applyLexicalBoost`, used by the unfiltered `docs` operation).
- **Evidence:** The lexical boost is synchronous and its cost is distinct terms x candidates x
  snippet length. A 150 KB query of distinct words took 14 s, during which a timer scheduled every
  100 ms fired zero times. 1 000 terms take 0.7 s, 10 000 terms 5.9 s.
- **Trigger:** an agent passes a screen dump or a disk directory as `q` to
  `c64_rag {op:"docs"}`.
- **Verified:** reproduced through `toolRegistry.invoke`.
- **Fix:** `maxLength` 500 on `q` in the shared schema, and at most 32 distinct terms in
  `applyLexicalBoost`.
- **Test:** a 600-character `q` is a validation error; a 40-term query finishes within 200 ms.

#### HARD03-011 - `c64_batch` bypasses the capture size caps

- **Severity:** P2
- **Where:** `src/tools/registry/batch.ts:160-163`; the caps exist only per call in
  `src/tools/registry/graphics.ts:203-221`.
- **Evidence:** The batch appends each command's payload and image blocks with no running total.
  Sixteen `capture_frame` commands with `count:15, includePixels:true` returned 31.9 MiB of text
  and the same again as structured content without an error. Sixty-four commands with `count:4,
  format:"png"` returned 256 image blocks. A single call above either cap is rejected.
- **Verified:** reproduced with a stub client.
- **Related:** F-07 (round 2) and the later image pass-through in `c64_batch`.
- **Fix:** Keep running totals of encoded result bytes and image blocks in the batch. The command
  that crosses the per-call limit (2 MiB, 4 images) fails with the same validation message; with
  `stopOnError` the batch stops there.
- **Test:** two commands whose combined size exceeds 2 MiB (error on the second) and two commands
  with four PNG frames each (error on the second).

#### HARD03-012 - MCP cancellation is ignored and several waits have no upper bound

- **Severity:** P2
- **Where:** `src/mcp-server.ts:452-474` (the CallTool handler does not use the request's
  `signal`); `ToolExecutionContext` in `src/tools/types.ts` has no cancellation member. Unbounded
  arguments: `durationMs` of `batch_run` (`src/tools/meta/program.ts:281`, minimum 1, no maximum),
  `durationMs` of `shuffle`, `retries` of `memory_dump` (`src/tools/meta/memory.ts:80`).
- **Evidence:** No tool observes `notifications/cancelled`. When a client gives up on a call
  (timeout or user interrupt), the server keeps running it: `wait_for_text` and `waitForReady` up
  to 120 s, `wait_for_state`, `shuffle` (programs x `durationMs`, each followed by a reset),
  `batch_run`, a 64-command `c64_batch`, audio recording, and the `power_cycle` menu sequence. The
  agent then issues new calls that interleave with the abandoned one on the same machine. With
  `durationMs: 86400000` a `batch_run` holds the machine for a day.
- **Verified:** read (no use of the request signal anywhere under `src/`).
- **Fix:** Add `signal?: AbortSignal` to `ToolExecutionContext`, set from the CallTool request.
  Check it at step boundaries in the waits listed above and between `c64_batch` commands; on
  abort, run the existing cleanup (resume, menu close, stream stop) and return an error result
  that says the call was cancelled. `power_cycle` must not abort between menu steps; it checks
  only before it opens the menu. Add maxima: `durationMs` 600000 for `batch_run` and `shuffle`,
  `retries` 10.
- **Test:** a `wait_for_text` call whose signal is aborted returns within one poll interval and
  performs no further device reads; a `c64_batch` stops before the next command; the new maxima
  are validation errors.

#### HARD03-013 - The server process exits when `Xvfb` is not installed

- **Severity:** P2
- **Where:** `src/vice/process.ts:273` (`startViceProcess`).
- **Evidence:** `spawn("Xvfb", ...)` gets `stdout`, `stderr` and `exit` listeners and no `error`
  listener. A spawn failure (`ENOENT`) is therefore an unhandled `error` event, which terminates
  the process; `src/diagnostics.ts` installs only `uncaughtExceptionMonitor`, which does not
  prevent that. Xvfb is used whenever no display is available or `VICE_VISIBLE=false`.
  `waitForXvfb` and the following delay are outside the `try` block, so a timeout there also
  leaves the Xvfb process running.
- **Trigger:** the VICE backend on a host without Xvfb and without a display (SSH session,
  container, CI); any VICE tool call.
- **Verified:** reproduced with Node against `dist/vice/process.js` and an empty `PATH`: the
  process exited with `Error: spawn Xvfb ENOENT` and the caller's `catch` never ran.
- **Fix:** Add `xvfb.once("error", ...)` and reject the start with a message that names the
  missing binary and the alternatives (install Xvfb, set `DISPLAY`). Move the wait inside the
  `try` so a failed wait stops Xvfb.
- **Test:** `startViceProcess` with `FORCE_XVFB=1` and an empty `PATH` rejects and the test
  process survives.

#### HARD03-014 - Output directories and the task registry under `~/.c64bridge` grow without limit

- **Severity:** P3
- **Where:** `src/tools/meta/program.ts:662` (`shuffle_<ms>`), `:754` (`batch_<ms>`),
  `src/tools/meta/compilation.ts:56` (`cycle_<ms>`); `src/tools/meta/background.ts` (`TASKS`,
  `persistTasks`, `ensureResultAndLog`).
- **Evidence:**
  1. `batch_run` and `shuffle` without `outputPath` create a new directory directly under
     `~/.c64bridge` on every call. Nothing removes them, and two calls in the same millisecond
     share one directory. The reviewer's machine holds 6 656 `batch_*` and 2 701 `shuffle_*`
     directories (129 MB in total), most of them from test runs (HARD03-046).
  2. The task registry never removes a task. Every distinct name stays in memory and in
     `tasks.json` across restarts, with up to 4 KB of last result each, and `list_tasks` returns
     all of them. There is no operation to delete a task.
  3. Every task iteration rewrites the whole `tasks.json`, the task's `task.json` and its log;
     sixteen tasks at 100 ms produce several hundred file writes per second.
  4. `result.json` is written once at start (`status: "running"`, `iterations: 0`) and never
     updated, although `task.json` points to it as the result.
- **Fix:** Put default output directories under `~/.c64bridge/runs/` with a name that cannot
  collide (timestamp plus a counter or random suffix) and prune them at startup like the
  diagnostics files (keep the newest 200, at most 30 days). Keep at most 200 finished tasks in the
  registry (drop the oldest finished ones on start and when the limit is passed) and add
  `c64_system delete_task`. Persist on status changes and at most once per second per task for
  iteration counts. Either update `result.json` with the last result or stop creating it.
- **Test:** pruning against a temporary directory; registry limit; `result.json` content after two
  iterations.

#### HARD03-015 - Two server processes share one background task state file

- **Severity:** P3
- **Where:** `src/tools/meta/background.ts:139-151` (state path), `:187-223` (`loadTasks`),
  `:303-323` (`persistTasks`).
- **Evidence:** Every server process uses `~/.c64bridge/tasks.json` and
  `~/.c64bridge/tasks/background/<id>`. On first use a process loads the file and marks every
  task it finds as `running` as stopped with "Interrupted by MCP server restart", although the
  other process is still running it. Each process then rewrites the whole file from its own
  memory, so the last writer removes the other's tasks. Task ids are numbered per process, so two
  processes also share task folders.
- **Trigger:** two MCP clients on one machine (for example an editor and a terminal agent), each
  with its own server process, both using `start_task`.
- **Verified:** read.
- **Fix:** Record the owning process in each task (`pid` and a per-process session id). On load,
  mark a `running` task as interrupted only when its owner is not alive. On persist, merge: read
  the file, replace only the tasks this process owns, and write back under an exclusive lock file.
  Include the session id in new task folder names.
- **Test:** two registries (two module instances with different session ids) against one
  temporary state file: both tasks survive and neither is reported as interrupted.

### Result correctness

#### HARD03-016 - `render_sprite` never writes the sprite pointer and clears the screen

- **Severity:** P1
- **Where:** `src/c64Client.ts:675-676` and `:696` (`displaySprite`).
- **Evidence:** `const screenRam = new Uint8Array(TEXT_SCREEN_SIZE)` is 1000 bytes long.
  `screenRam[0x03F8 + index] = pointerValue` writes index 1016 to 1023, which a typed array
  ignores. The following write covers `$0400-$07E7` with spaces. The pointer at `$07F8+index` is
  never written, so the VIC shows whatever block the old pointer selects, not the data the tool
  wrote at `$2000 + index * 64`. The 1000-byte write also clears the user's screen and colour RAM
  on every call. The result reports success and `pointerValue: 128`.
- **Trigger:** `c64_graphics {op:"render_sprite", sprite:<63 bytes>, index:0}` on any backend.
- **Verified:** reproduced with a recording stub facade: no write covered `$07F8`; the only screen
  write was `$0400-$07E7`.
- **Fix:** Write the pointer byte on its own (`$07F8 + index`). Do not write screen or colour RAM;
  that also preserves the pointers of the other sprites.
- **Test:** a stub facade asserts one write of `128 + index` at `$07F8 + index` and no write to
  `$0400-$07E7`.

#### HARD03-017 - `find_paths`, `find_and_run`, `fs_stats` and `shuffle` never match on real firmware

- **Severity:** P2
- **Where:** `src/tools/meta/filesystem.ts:368-372` (`buildSearchPattern`), `:398-420`
  (`find_paths` accepts an array or `{paths:[...]}`), `:89-111` (`extractPaths` reads `.path`,
  `.paths`, `.entries`), `fs_stats` at `:454`; `src/tools/meta/program.ts:640-650` (`shuffle`,
  exposed as `c64_config shuffle`); mock route `scripts/mockC64Server.mjs:1054-1057`.
- **Evidence:** All four send one `GET /v1/files/<root>/**/*<name>*.<ext>:info` and expect a list
  of paths. The firmware route (`1541ultimate/software/api/route_files.cc`) calls `fstat` on the
  path and returns information about one file:
  `{"files": {"path", "filename", "size", "extension"}, "errors": []}`, or 404 when nothing
  matches. The repository's own `doc/c64u/c64-openapi.yaml` (`FileInfoResponse`) documents that
  shape. No parser in the four tools reads `files`, so a match yields an empty result with
  success, and a miss yields an error. The firmware resolves a wildcard per path element and stops
  at the first match, so `**` does not recurse. The mock returns `{path, size, type}` and the
  tests stub `filesInfo` with arrays, so the defect is not visible in tests.
- **Trigger:** on `c64u` or `u2`, `c64_disk {op:"find_paths", root:"/Usb0", nameContains:"giana",
  extensions:["prg"]}` returns `{results: [], truncated: false}` although `/Usb0/GIANA.PRG`
  exists.
- **Verified:** reproduced with a stub that returns the documented firmware shape; firmware
  behaviour read from the public source. The exact wildcard behaviour needs hardware confirmation.
- **Related:** F-04 (round 2) exposed `find_paths` and validated it against the mock only.
- **Fix:** The REST API has no directory listing, so recursive search cannot be built on this
  route. Parse `{files:{filename}}` as a single match (path = directory of the pattern plus
  `filename`), send patterns without `**`, and state in the descriptions that the search matches
  one file in one directory. Return an error, not an empty success, when the response has an
  unknown shape. Make the mock route return the firmware shape and 404 on a miss. If a single
  match is not useful enough for `fs_stats` and `shuffle`, mark those two unsupported on `c64u`
  and `u2` and say so in the result (decision for the owner).
- **Test:** mock route with the firmware shape: `find_paths` reports the one match; a miss is
  reported as "not found"; an unknown shape is an error.

#### HARD03-018 - `step` and `step_return` report success when the CPU did not stop

- **Severity:** P2
- **Where:** `src/c64Client.ts:2686-2692` (`viceStepInstructions`, `viceStepReturn`);
  `executeAndWait` in `src/vice/viceClient.ts` returns `false` on timeout; `leaveStopped` and
  `settle` in `src/device.ts`.
- **Evidence:** The boolean from `stepInstructions(..., { waitForStopMs: 2000 })` is discarded.
  `leaveStopped` records the CPU as stopped, `settle` then stops it wherever it happens to be, and
  the tool replies "Stepped 1 instruction." or "Continued execution until current routine
  return." with success.
- **Trigger:** `c64_debug step_return` inside a routine that runs longer than 2 s, or
  `step {mode:"over"}` over a `JSR` that blocks.
- **Verified:** reproduced on the monitor mock with the step events delayed by 3 s: success was
  returned after 2 s.
- **Related:** the 1.2.0 change "wait for the stop after step and step_return".
- **Fix:** Return the boolean. When it is false, report `stopped: false`, the PC read after the
  forced stop, and a message that the tool stopped the CPU because the step did not finish within
  the wait.
- **Test:** on the mock with delayed step events, `step` does not return success with "Stepped".

#### HARD03-019 - `nuclear_reset` reports a restart that failed or is unsupported

- **Severity:** P2
- **Where:** `src/c64Client.ts:2629-2632` (`viceNuclearReset` ignores the result);
  `ViceBackend.nuclearReset` in `src/device.ts:1535-1557`.
- **Evidence:** `nuclearReset` returns `{success:false, code:"UNSUPPORTED"}` for a VICE the server
  does not manage and `{success:false}` when the power-off or the restart fails. The tool clears
  the checkpoint labels and returns "VICE process stopped and restarted." in every case.
- **Verified:** reproduced on the mock (an unmanaged backend).
- **Fix:** Return the result and raise an execution error with its details when it is not
  successful. Clear the labels only on success.
- **Test:** on an unmanaged mock backend, `nuclear_reset` returns an error result.

#### HARD03-020 - Mounting a disk on VICE runs the CPU past a breakpoint hit during autoload

- **Severity:** P2
- **Where:** `src/device.ts:1832-1866` (`waitForAutoloadFinished`), called from `driveMount`.
- **Evidence:** The loop calls `client.exitMonitor()` on every iteration and never checks the
  session's stop events. A checkpoint hit during the autoload is recorded and then resumed by the
  next iteration; `settle` later stops the CPU at an arbitrary PC. `feedKeyboard` and
  `resetAndWaitForBasic` received a stop check in 1.2.0; this loop did not.
- **Trigger:** `c64_debug create_checkpoint` on a KERNAL load address, then `c64_disk mount` of a
  `.d64` on drive 8. The mount reports success and the hit is lost.
- **Verified:** reproduced on the mock (autoload delayed to 800 ms, hit at 100 ms): the CPU was
  running after the hit.
- **Fix:** Pass the same stop predicate that the reset path uses. On a stop, end the wait without
  `exitMonitor` and return the mount result with `stopped: true` and the PC.
- **Test:** the reproduction as a session test; the mock's CPU stays stopped after the hit.

#### HARD03-021 - `upload_run_basic verify:true` reports "verified" when nothing ran

- **Severity:** P2
- **Where:** `src/tools/pollValidator.ts:240`.
- **Evidence:** `runDetected` becomes true when the screen contains "RUN" or "ERROR", whether or
  not the screen differs from the baseline taken before the upload. A screen left by an earlier
  run contains "RUN" and ends in `READY.`, so the poll returns success although nothing was
  loaded. The assembly path gained a load readback in round 2 (T-01); the BASIC path has none.
- **Trigger:** a backend whose `run_prg` answers success without running the program (the U2 case
  described in HARD01-036), after any earlier run.
- **Verified:** reproduced with a stub client.
- **Fix:** Read the tokenised bytes back from `$0801` and compare them with the uploaded program,
  as the assembly path does; a mismatch is "program was not loaded". Where a baseline exists, do
  not treat text that was already on the baseline screen as evidence of a run.
- **Test:** the stub scenario returns an error result.

#### HARD03-022 - `bundle_run` writes empty memory files and reports success when a read fails

- **Severity:** P2
- **Where:** `src/tools/meta/artifacts.ts:82-84`.
- **Evidence:** The `{success:false}` result of `readMemory` is not checked and
  `result.data ?? ""` is written. `length` has no maximum. A bare-hex address (`C000`), a range
  past `$FFFF` and a transient read error all produce an empty `range_N.hex` listed as an artifact
  in a successful result.
- **Verified:** reproduced with a stub client.
- **Fix:** Validate address and length with the shared parser and range check before any file is
  written; raise an execution error when a read fails.
- **Test:** a stub whose `readMemory` fails makes `bundle_run` return an error and write no range
  file.

#### HARD03-023 - `batch_run` and `shuffle` skip paths that are not `.prg` or `.crt` and report a pass

- **Severity:** P2
- **Where:** `src/tools/meta/program.ts:767-774` (`batch_run`), `:675-677` (`shuffle`).
- **Evidence:** The extension switch has no `else`. For any other path nothing is run, the
  assertions are evaluated against whatever is on the screen, and the machine is reset.
  `programs:[{path:"/USB0/elite.d64", assertions:[{type:"screen_contains",
  pattern:"READY."}]}, {path:"/USB0/demo"}]` returns `passed: 2`.
- **Verified:** reproduced: the stub recorded one screen read and two resets, and no run.
- **Fix:** Validate the extension before the first program runs; an unsupported type is a
  validation error naming the path.
- **Test:** the scenario above returns a validation error and issues no reset.

#### HARD03-024 - Three address parsers still read `0400` as decimal 400

- **Severity:** P2
- **Where:** `src/tools/meta/memory.ts:46` (`parseAddressNumeric`, used by
  `c64_extract memory_dump`); `src/tools/meta/graphics.ts:27` (sprite and charset extraction);
  `src/tools/debug.ts:728` (`parseAddress`, used for checkpoints and `expectedPC`).
- **Evidence:** Round 2 (T-15) introduced `parseNumericLiteral` in `src/numericArg.ts`, which
  rejects a decimal with a leading zero as ambiguous and bare hex with a hint. These three local
  parsers were not replaced. `c64_extract {op:"memory_dump", address:"0400", ...}` dumps `$0190`,
  while `c64_memory read` rejects the same input.
- **Verified:** reproduced for `memory_dump`; the other two read.
- **Fix:** Replace all three with the shared parser and range check, keeping each error path
  label.
- **Test:** `"0400"` and `"C000"` are validation errors in `memory_dump`, `sprites`, `charset`,
  `create_checkpoint` and `wait_for_state`.

#### HARD03-025 - `upload_run_asm` reports "not loaded" for a program whose lowest block lies under ROM

- **Severity:** P2
- **Where:** `checkProgramLoaded` in `src/tools/pollValidator.ts:296-316`; `memGet` in
  `src/vice/viceClient.ts` reads the CPU view; the VICE load writes RAM under ROM.
- **Evidence:** For a source with data at `$A000` and code at `$C000`, the PRG loads at `$A000`
  and the program runs through `SYS 49152`. The readback of the first 16 bytes at the load address
  returns BASIC ROM, so the result is `status: "not_loaded"` with an error.
- **Trigger:** VICE, `upload_run_asm` whose lowest emitted block is in `$A000-$BFFF` or at `$E000`
  and above.
- **Verified:** read. What the Ultimate `machine:readmem` returns under ROM needs hardware
  confirmation.
- **Fix:** Compare a window that lies in RAM the CPU sees (`$0002-$9FFF`, `$C000-$CFFF`): use the
  first emitted block in that range. When there is none, report `loadCheck: "skipped"` and do not
  report an error.
- **Test:** monitor mock with ROM bytes at `$A000`; a program with data at `$A000` and code at
  `$C000` is not reported as not loaded.

#### HARD03-026 - `analyze` reports accurate music on silence; `pipeline` reports success when nothing played

- **Severity:** P2
- **Where:** `generateAudioFeedback` in `src/tools/audio.ts:491-492`; `music_compile_play_analyze`
  in `src/tools/meta/audio.ts:448-459`; `music_play_preset` at `:389-404`.
- **Evidence:** `Math.abs((average_pitch_deviation as number) ?? 0)` turns `null` (no note
  detected) into 0, which passes the `< 20` test: "The music sounds accurate with good pitch
  stability." The pipeline does not check the captured level after playback and marks success
  whatever the analysis shows.
- **Trigger:** `c64_sound {op:"analyze", request:"does the music sound right?"}` while the SID is
  silent or the capture is empty.
- **Verified:** reproduced for a silent buffer and for an empty capture; the pipeline part read.
- **Fix:** Give a verdict only when the deviation is a number and at least one note was detected;
  otherwise say that no audio was detected. In the pipeline and the preset player, report
  `audible: false` and an error when the captured maximum level is at or below the silence
  threshold.
- **Test:** a silent PCM buffer through the analyzer gives no positive verdict and a non-success
  pipeline result.

#### HARD03-027 - `play_preset` with the default `verify:true` reports an error after the music started on VICE and U2

- **Severity:** P2
- **Where:** `src/tools/meta/audio.ts:385-392` and the catch at `:437-442`;
  `C64Client.recordAndAnalyzeAudio` imports the optional `naudiodon` on backends without an audio
  stream.
- **Evidence:** The program is started first; the analyzer then throws "Audio backend not
  available" where `naudiodon` is not installed, and the whole tool returns an error without the
  per-backend results. An agent is likely to retry, restarting the music. With
  `platforms:["vice","c64u"]` the second backend never runs.
- **Verified:** reproduced with a stub (after checking that `naudiodon` does not resolve, so no
  recording could start).
- **Fix:** Catch analyzer errors per backend and record them as `verification: {error}` with
  playback reported as started. Do not attempt verification on a backend that has no audio source.
- **Test:** an analyzer that throws on VICE yields a non-error result with the playback entry and
  the verification error.

#### HARD03-028 - `get_display_state` reports the wrong bitmap address in bitmap mode

- **Severity:** P2
- **Where:** `parseVicState` in `src/tools/registry/graphics.ts:144`.
- **Evidence:** `((d018 >> 1) & 0x07) * 0x0800` is the character set formula and is also applied
  in bitmap mode, where only bit 3 of `$D018` selects `$0000` or `$2000` within the bank. The
  usual `POKE 53272, PEEK(53272) OR 8` gives `$1D`, which is reported as `$3000` while the VIC
  reads the bitmap from `$2000`.
- **Verified:** reproduced.
- **Fix:** In bitmap mode use `bankBase + ((d018 & 0x08) ? 0x2000 : 0)`.
- **Test:** `$D011 = $3B`, `$D018 = $1D` reports `$2000`.

#### HARD03-029 - `write_text`, `key` and `upload_run_asm` ignore the VICE keyboard-feed status

- **Severity:** P3
- **Where:** `injectKeyboardQueue` in `src/c64Client.ts:2519-2525` handles only
  `status === "timeout"`.
- **Evidence:** `"stopped"` (a checkpoint hit while typing) and `"queued"` (a pause is held) both
  become `{ delivered }` and the tool says "Sent N character(s)". Nothing reports `stoppedAt` or
  `pending`. VICE also drops a whole feed silently when more than 16 384 bytes are pending
  (`kbdbuf.c`), while the monitor still answers OK.
- **Verified:** read.
- **Fix:** Pass `status`, `pending` and `stoppedAt` through to the tool result text and structured
  content. Refuse a feed while paused when the pending total would exceed the VICE limit.
- **Test:** a checkpoint hit during the feed on the mock surfaces `status: "stopped"`.

#### HARD03-030 - `wait_for_state` without `expectedPC` reports a match at once when no debug session exists

- **Severity:** P3
- **Where:** `src/tools/debug.ts:556-558`.
- **Evidence:** `settled = targetPC === undefined ? (!wait.session || wait.stopped) : ...`. With no
  session the result is `matched: true, timedOut: false` while the CPU runs. The description says
  the operation waits until the CPU is stopped.
- **Verified:** read.
- **Fix:** Return `matched: false` with the reason "no debug session; nothing can stop the CPU".
- **Test:** a stub client with no session and no `expectedPC` does not return `matched: true`.

#### HARD03-031 - `c64_disk mount verify:true` reports success when the verification failed

- **Severity:** P3
- **Where:** `src/tools/meta/filesystem.ts:834-852` and the result at `:866-873`.
- **Evidence:** When `imageMatches` is false the code logs a warning and still returns
  `mounted: true` with success. `findListedDrive` also does not map `softiec` to the listing id
  "IEC Drive", so a verified mount on that drive fails with "Drive softiec not found" (read, not
  run).
- **Verified:** read.
- **Fix:** Raise an execution error when `imageMatches` is false, with the expected and actual
  image. Map `softiec` in `findListedDrive`.
- **Test:** a drive listing that shows another image makes the verified mount return an error.

#### HARD03-032 - `c64_input joystick` `tap` ignores `durationMs` on C64U

- **Severity:** P3
- **Where:** `src/tools/input.ts:270` (description) and `:383-394`.
- **Evidence:** The schema says "tap = press then release after durationMs". On `c64u` the call is
  forwarded as `transition: "tap"` without a duration, and the firmware holds a tap for a fixed
  two frames (`1541ultimate/software/api/route_input.cc`).
- **Verified:** read. Needs hardware confirmation of the hold time.
- **Fix:** On `c64u`, send a press, wait `durationMs`, and send a release (releasing in `finally`).
- **Test:** the stub records press, a delay of at least `durationMs`, and release.

#### HARD03-033 - Frame and audio capture replace and then stop a stream the user started

- **Severity:** P3
- **Where:** `src/c64Client.ts:1777-1821` (video), `:2078-2136` (audio), and the capture session
  stop.
- **Evidence:** Each capture starts the device stream toward its own socket, which replaces a
  target set by `c64_stream start`, and always stops the stream afterwards. Nothing records an
  active user stream and no result mentions it. Concurrent captures (`capture_frame`,
  `capture_samples`, `record_analyze`) are not excluded from each other either.
- **Verified:** read.
- **Fix:** Remember the target per stream when `c64_stream start` succeeds and clear it on `stop`.
  After a capture, restart the user's stream toward the remembered target and say so in the
  result. Serialise captures per stream.
- **Test:** `c64_stream start`, then `capture_frame`: the stub records a second `start` with the
  user's target after the capture.

#### HARD03-034 - The assembler encodes the invalid `(zp),x` as `(zp,x)`

- **Severity:** P3
- **Where:** `parseOperand` in `src/tools/translation/assembler.ts:854-864`.
- **Evidence:** After the closing parenthesis, `,X` returns the same node as `(zp,x)`.
  `lda ($10),x` assembles to `A1 10` without an error.
- **Verified:** reproduced.
- **Fix:** After the closing parenthesis accept only `Y`; reject `X` with a message that names the
  two valid indirect modes.
- **Test:** `lda ($10),x` raises an error naming the line.

#### HARD03-035 - The assembler zero-fills gaps between blocks, including over `$D000-$DFFF`

- **Severity:** P3
- **Where:** `buildPrg` in `src/tools/translation/assembler.ts:1106`.
- **Evidence:** The PRG is one contiguous image from the lowest to the highest emitted byte.
  `*=$c000 rts` followed by `*=$e000 .byte 1` yields an 8 195-byte PRG. Loading it writes zeros to
  the VIC, SID and CIA registers and to colour RAM, which blanks the screen and stops the CIA
  timers. No warning is given.
- **Verified:** the output was reproduced; the effect on I/O is read (same access path as
  HARD03-004).
- **Fix:** Reject a filled gap that crosses `$D000-$DFFF` and state the alternative (assemble the
  blocks separately). Adjacent blocks and `.res` keep their behaviour.
- **Test:** the two-block source above raises an error; two blocks at `$C000` and `$C800` still
  assemble.

#### HARD03-036 - `c64_memory write verify:true` ignores `mask` in the post-write check

- **Severity:** P3
- **Where:** `src/tools/memory.ts:496`; the same comparison in `verify_and_write_memory`
  (`src/tools/meta/memory.ts`).
- **Evidence:** The schema says "only bits set in the mask are compared", and the pre-write check
  applies the mask. The post-write check is `after !== expected`. `write $D020 bytes:"01"
  verify:true mask:"0F"` fails because the register reads back `$F1`.
- **Verified:** reproduced.
- **Fix:** Apply the mask to the post-write comparison.
- **Test:** the `$D020` case with a stub that returns `$F1` succeeds; a mismatch inside the mask
  still fails.

#### HARD03-037 - Printer text turns `<return>`, `:cr:` and `{home}` into control codes

- **Severity:** P3
- **Where:** `printerTextExpression` in `src/c64Client.ts:3044-3063`; name expansion in
  `src/petscii.ts:222-227`; the success message in `src/tools/printer.ts:357`.
- **Evidence:** Literal printer text is placed in a BASIC string that the tokenizer scans for
  control-code names. `print_text text:"PRESS <RETURN> TO GO"` prints "PRESS", a carriage return
  and " TO GO". The tool reports "completed successfully" as soon as the program starts, without
  looking for `?DEVICE NOT PRESENT`.
- **Verified:** reproduced (generated BASIC).
- **Fix:** Emit `{`, `<` and `:` in printer text through `CHR$()` so no name can be recognised, or
  tokenize generated strings with name expansion disabled. Poll the screen once after the run and
  report a device error as a failure.
- **Test:** the generated program for the text above contains no `{$0D}`; a stub screen with
  `?DEVICE NOT PRESENT ERROR` yields an error result.

#### HARD03-038 - The published `render_sprite` examples fail validation

- **Severity:** P3
- **Where:** `src/tools/registry/graphics.ts:387` and `src/tools/graphics.ts:673`.
- **Evidence:** The example value is 118 `A` characters, which is neither 63 bytes of base64 (84
  characters) nor 126 hex digits. Calling the tool with its own example returns "Sprite hex string
  must contain exactly 126 hex characters".
- **Verified:** reproduced.
- **Fix:** Use 84 `A` characters. Extend the example test of round 2 so that every published
  example runs through the runtime parser of its operation, not only the JSON schema.
- **Test:** the extended example test.

#### HARD03-039 - The default `c64_extract charset` scan reads `$D800-$DFFF` on hardware

- **Severity:** P3
- **Where:** `src/tools/meta/graphics.ts:340-346` (`commonLocations` contains `$D000` and
  `$D800`) and `:366-367`.
- **Evidence:** The default `scanRange: "common"` reads 2 KB at `$D800`, which includes `$DC0D`
  and `$DD0D`. Reading the CIA interrupt registers clears pending interrupt flags; pausing the
  machine does not prevent that. The comment calls the two locations "Character ROM", but a
  memory read there returns the I/O view on hardware, so they cannot yield the ROM character set.
- **Verified:** read; same inference as HARD01-020.
- **Fix:** Remove `$D000` and `$D800` from the defaults and skip `$D000-$DFFF` in
  `scanRange: "full"`, using the helper from HARD03-004.
- **Test:** a recording stub sees no read in `$D000-$DFFF` for either scan range.

### Launch, packaging, CI, documentation and tests

#### HARD03-040 - `scripts/start.mjs` moves the working directory to the checkout when it starts Bun from Node

- **Severity:** P2
- **Where:** `scripts/start.mjs:70` and `:75` (`cwd: projectRoot` in `runWithBun`).
- **Evidence:** Started with Node from a checkout where Bun is installed, the launcher spawns Bun
  with the checkout as working directory. Started with Bun, or with Node when Bun is missing, the
  server keeps the caller's directory. The working directory decides which `./.c64bridge.json` is
  read (`src/config.ts:50`) and which directory is an allowed host root
  (`src/hostPaths.ts:74-76`). A project that pins a backend or a device in its own
  `.c64bridge.json` is ignored on the first path, and tool calls can reach a different machine,
  including real hardware. `AGENTS.md` documents `./.c64bridge.json`.
- **Verified:** reproduced with a copy of the launcher and a fake package: the child's working
  directory was the package directory.
- **Related:** HARD01-006 made configuration resolve from the working directory.
- **Fix:** Spawn with the caller's working directory. Confirm that Bun finds `tsconfig.json` and
  `bunfig.toml` through the absolute entry path; pass their location explicitly if it does not.
- **Test:** start the launcher from a temporary directory and assert that the server reports that
  directory.

#### HARD03-041 - Developer-only agent prompts ship in the package and are returned as RAG references

- **Severity:** P3
- **Where:** `src/rag/indexer.ts:28` and `:635-639` (indexes every `.github/prompts/*.prompt.md`);
  `package.json` `files` (`.github/prompts/**`, `.github/skills/**`).
- **Evidence:** `steer.prompt.md`, `pr-converge.prompt.md` and `.github/skills/pr-converge` are in
  the tarball and in the embeddings. `steer.prompt.md` instructs an agent to append a TODO to
  `PLANS.md` and execute it. `c64_rag {op:"docs", q:"steer plan todo"}` returns it as the first
  hit, and a BASIC query that mentions "continue the plan" ranks it second. A user's agent
  receives repository-maintenance instructions as C64 reference material.
- **Verified:** reproduced through the tool.
- **Fix:** Exclude the two prompts and the skill from the index input and from `files` (move them
  to a directory that is neither indexed nor packed, or filter by name in both places), and
  rebuild the embeddings.
- **Test:** no indexed record's origin starts with `.github/prompts/steer` or `pr-converge`;
  `npm pack --dry-run` does not list them.

#### HARD03-042 - `c64://guide/index` names tools that do not exist; `docs` is missing from the published contract

- **Severity:** P3
- **Where:** the `tools` arrays in `src/rag/knowledgeIndex.ts` (for example `:141`, `:527`);
  `AGENTS.md` and `doc/vice/support-matrix.md` list `c64_rag` with `basic` and `asm` only;
  `src/mcp-server.ts:316` throws a plain `Error` for an unknown resource URI.
- **Evidence:** `verify_and_write_memory`, `debugreg_read`, `debugreg_write`, `printer_guide`,
  `printer_commodore_text`, `printer_epson_text`, `printer_commodore_bitmap`,
  `printer_epson_bitmap`, `printer_prompts`, `music_generate` and `music_play_preset` are neither
  tools nor operations at `6756495`, yet the index presents them as the tools to call. An unknown
  resource URI yields JSON-RPC error -32603 instead of the resource-not-found error -32002.
- **Verified:** the name check was reproduced against `toolRegistry.list()`; the error code read.
- **Fix:** Replace the names with tool and operation pairs (for example `c64_memory write`,
  `c64_config read_debugreg`, `c64_sound generate`). Add `docs` to `AGENTS.md` and the support
  matrix. Throw `McpError` with -32002 for an unknown URI.
- **Test:** every name in each resource's `metadata.tools` resolves to a registered tool or
  operation.

#### HARD03-043 - The `bin` launcher builds a file URL by concatenation

- **Severity:** P3
- **Where:** `scripts/cli.js:59` (``new URL(`file://${entry}`)``).
- **Evidence:** `#` starts a URL fragment and `%` starts an escape, so an install path such as
  `/home/u/C#proj/...` resolves to `/home/u/C` and `npx c64bridge` fails with
  `ERR_MODULE_NOT_FOUND`. `scripts/start.mjs` already uses `pathToFileURL`.
- **Verified:** reproduced in a directory named `C#proj`.
- **Fix:** `await import(pathToFileURL(entry).href)`.
- **Test:** run the launcher from a directory whose name contains `#`.

#### HARD03-044 - `scripts/invoke-bun.mjs` does not forward signals to the server

- **Severity:** P3
- **Where:** `scripts/invoke-bun.mjs:90-103`.
- **Evidence:** There is no signal handler. A `SIGTERM` to the Node wrapper (`npm run mcp`,
  documented in `doc/developer.md`) ends the wrapper and leaves the Bun server running until its
  stdin closes. R-03 (round 2) fixed the same defect in `start.mjs` only.
- **Verified:** read.
- **Fix:** Copy the forwarding block from `start.mjs`.
- **Test:** the R-03 test pattern applied to `invoke-bun.mjs`.

#### HARD03-045 - The release job runs unpinned and unlocked code while it holds `id-token: write`

- **Severity:** P3
- **Where:** `.github/workflows/release.yaml:32` (job-level `id-token: write`), `:231`
  (`npm install --omit=dev` in the unpacked tarball, which has no lockfile), `:243` (downloads
  `mcp-publisher` from `releases/latest` without a version or checksum).
- **Evidence:** Every step of the job can request the OIDC token that npm trusted publishing
  accepts for this package. The dependency install resolves version ranges at release time and
  runs install scripts; the publisher binary is whatever the latest upstream release is.
- **Verified:** read. This is separate from the deferred item "pin actions by SHA".
- **Fix:** Split the job. A validation job without `id-token` packs, installs with
  `--ignore-scripts`, tests and uploads the tarball. A publish job with `id-token` downloads the
  artifact, checks its SHA-256, and runs only `npm publish` and a version-pinned `mcp-publisher`
  whose checksum is verified.
- **Test:** the workflow file parses; a dry run on a release candidate tag.

#### HARD03-046 - The test suite writes into the developer's real `~/.c64bridge`

- **Severity:** P3
- **Where:** `scripts/run-tests.ts` and `scripts/run-tests.mjs` set no state directory; the tests
  that exercise `start_task`, `batch_run` and `shuffle` use the defaults.
- **Evidence:** On the reviewer's machine `~/.c64bridge/tasks/background` holds folders named
  after test cases (`0014_pinned-writer`, `0013_duplicate-check`), `tasks.json` was rewritten by
  the last test run, and thousands of `batch_*` and `shuffle_*` directories carry the timestamps
  of test runs. A test run therefore also overwrites the task state of a server the developer has
  running (HARD03-015).
- **Verified:** observed in the state directory; the absence of an override was read.
- **Fix:** Add one state root variable (`C64BRIDGE_STATE_DIR`, default `~/.c64bridge`) that the
  task state, the default output directories and the diagnostics directory derive from, keeping
  `C64_TASK_STATE_FILE` and `C64BRIDGE_DIAGNOSTICS_DIR` as overrides. Both test runners set it to
  a fresh temporary directory and remove it afterwards.
- **Test:** a test run leaves the modification time and the entry count of the real state
  directory unchanged (checked by the runner when `C64BRIDGE_TEST_ASSERT_HERMETIC=1`).

## Leads not proven

These were reported or noticed during the review and not confirmed. They are not work items.

- `src/device.ts:1532-1534`: `powerCycle` on an unmanaged VICE ends the session (deleting
  stop-on-hit checkpoints and the explicit pause) before `nuclearReset` reports "unsupported".
- `src/tools/registry/platform.ts:99-116`: switching away from VICE leaves a held pause or
  debugger stop in place and the result does not mention it.
- `src/vice/viceClient.ts:233-235`: a frame length up to 4 GB is buffered without a cap; only the
  configured VICE peer can send one.
- `src/device.ts:1166`: `run_prg` during an explicit pause loads and types `RUN`, the CPU is
  stopped again, and the result is success. This may be the intended pause behaviour.
- `src/device.ts:395`: the 10 s REST timeout may be shorter than `create_dnp` with 255 tracks on
  slow storage; the tool would report a failure although the image was created.
- `src/c64Client.ts:1450`: a transport error on the final RETURN of `power_cycle` takes the
  failure path and sends the menu-button cleanup, possibly while the power cycle is running.
- `src/c64Client.ts:1280-1286`: a failed resume sets the explicit-pause flag; if the device did
  resume, later tools skip their own pause until `c64_system resume`.
- `src/c64Client.ts:1822-1882`: two concurrent video capture sessions can each create a socket;
  the first is leaked. The UDP socket is not closed when binding fails (`:1843`, `:2134`).
- `src/config.ts:93-101`: with `C64_MODE=c64u` and a configuration that has only a `u2` section,
  the client base URL is the U2 host while the C64U backend uses the default host.
- `src/streamCapture.ts:111-116` and `:152-153`: frame dimensions come from the packet header
  without a bound, and frames are ordered by a 16-bit frame number that wraps about every 22
  minutes.
- `src/c64Client.ts:2087-2091`: silence verification accepts a partial capture of about 43 ms as
  verified silence when 1.5 s was requested.
- `src/c64Client.ts:2373-2431`: VICE frame cropping treats palette index 0 as off-screen, so
  frames with a black border change size.
- `src/tools/translation/basicTokenizer.ts:21-23`: tokenised lines longer than about 250 bytes are
  accepted; the ROM relink would corrupt them after an edit or a disk load.
- `src/tools/programRunners.ts:121`: `?... ERROR IN 0` is not recognised as a runtime error.
- `src/tools/translation/assembler.ts` (`runPass`): the local-label scope is not reset before the
  second pass.
- `src/tools/pollValidator.ts`: the load check reads back after `SYS`, so a program that
  overwrites its first 16 bytes is reported as not loaded.
- `src/petscii.ts` (`asciiToPetscii`): characters outside PETSCII raise a generic error, not a
  validation error.
- `.github/workflows/docker-build.yaml`: `workflow_dispatch` can push the builder image; whether
  the repository's default token allows that from an unreviewed branch was not checked.
- `src/rag/retriever.ts:84`: an embeddings directory with another vector dimension makes every
  retrieval throw; a missing file gives empty results without a message.
- Diagnostics: one file per session with no size limit; a session that runs many background tasks
  for days was not measured.

## Reviewed and found sound

- Access check placement: one check in `toolRegistry.invoke`, per command in `c64_batch`, and at
  task start; an operation without a declared effect is treated as destructive; prototype keys in
  arguments do not change which operation is checked.
- HTTP transport: host, origin and bearer token checks; stateless server per request.
- REST request queue (order, release on error, probes on the same queue) and pause ownership
  across reset, reboot, power-off and concurrent calls.
- Configuration snapshot and restore: prototype-key guard, credential redaction, partial
  categories, the `applyToFlash` effect.
- VICE monitor client: request timeout closes the socket, request ids, event dispatch, connect
  timeout, keyboard feed chunking, full 64 KB reads, register masking, checkpoint accounting,
  session end on restart and shutdown.
- Host path use in `driveMount`, `runPrgFile`, `loadPrgFile`, `symbolsFile`, sprite and charset
  export, `save_memory`, `bundle_run` run ids.
- Opcode table (all 256 entries), branch range limits, operator precedence, overlap detection,
  output past `$FFFF`, `.fill` and `.align` bounds, BASIC tokenizer keyword handling and size
  limit, detokenizer bounds, disassembler tail handling.
- SID frequency, pulse width, ADSR and voice offsets; PSID header; VIC colour mapping and register
  values; per-call capture caps; audio capture cleanup.
- Resource reads match exact URIs; every packaged knowledge file exists; RAG makes no network
  call and writes nothing at runtime; skills and prompts reference only registered operations;
  stdout is reserved for the protocol; CI workflows have read-only default permissions and do not
  interpolate event data into shell commands.
- Spot-checked knowledge content: UCI registers, REU registers, KERNAL jump table addresses,
  raster interrupt setup, `$D018` and `$DD00` descriptions.

## Needs hardware confirmation

Nothing below was tried on a device. Each item states what to check.

| Finding | Check |
|---|---|
| HARD03-004, 035, 039 | That REST `writemem` and `readmem` in `$D000-$DFFF` reach the I/O registers (expected from HARD01-020). |
| HARD03-005 | When the firmware applies changes to `Network Password`, `Web Remote Control Service`, `Use DHCP` and `Static IP` set through REST (at once, or after save and reboot). |
| HARD03-017 | How `GET /v1/files/<pattern>:info` treats `*` and `**` on C64U and U2 firmware, and the response for no match. |
| HARD03-025 | What `machine:readmem` returns for `$A000-$BFFF` and `$E000-$FFFF` while ROM is banked in. |
| HARD03-032 | The hold time of a firmware joystick `tap`. |

## Decisions for the owner

- **Overwriting existing host files (HARD03-003).** Whether a tool write may replace a file the
  server did not create in the current session. Refusing by default (with an `overwrite: true`
  argument) closes the remaining part of the write risk and changes behaviour for repeated
  exports to the same path.
- **The temp directory as an allowed root.** It is world-writable; a local user can plant
  symbolic links between the path check and the write. Narrowing it to a per-user subdirectory
  changes the documented roots.
- **File search on Ultimate hardware (HARD03-017).** Keep `fs_stats` and `shuffle` as
  single-directory operations, or mark them unsupported.
- **Microphone recording under the `read` effect.** `analyze` and `record_analyze` record from the
  host's default input on backends without an audio stream and are allowed in `read-only` mode.
- Items deferred in round 2 and not re-examined here remain open: result payload shape, marking
  device text as untrusted, public stream targets, pinning actions by SHA.

## Suggested fix batches

- **Batch A - boundary:** 001, 002, 003, 004, 039, 035 (shared I/O range helper), 005, 006, 007.
- **Batch B - process stability:** 008, 009, 010, 011, 012, 013.
- **Batch C - VICE result truthfulness:** 018, 019, 020, 029, 030, 025.
- **Batch D - tool result truthfulness:** 016, 017, 021, 022, 023, 024, 026, 027, 028, 031, 032,
  033, 034, 036, 037, 038.
- **Batch E - state, launch and release:** 014, 015, 046, 040, 041, 042, 043, 044, 045.

`prompt.md` turns these batches into a wave plan partitioned by file.
