# Hardening 06 - exhaustive review (security, correctness, performance, helpfulness)

Baseline: `44822528` on `feat/hardening-5` (PR #171). Date: 2026-11-19.
Method: twelve concurrent reviewers, one per area (five Opus: core client, device backend, MCP
layer, programming tools, end-to-end sessions as an MCP client; seven Sonnet: media tools, meta
tools, translators, VICE, knowledge and RAG, sound, packaging), each applying four lenses. Only
reproduced or directly evidenced findings count; reproduction scripts lived in `/tmp/h6/<area>/`
at review time. Peers were loopback mocks only. An independent fact check against primary sources
gates every change to a knowledge document (`fact-check.md`, written when it completes). Triage and
decisions by the principal engineer. Finding IDs are `<AREA>-n` as reported.

## Decisions (binding)

- D1 Speed. No tool waits on a fixed window when it can observe the outcome. `verify: false`
  means no polling. Related register writes go out as one block write. A probe that succeeded is
  not repeated before every operation.
- D2 Results. The text block of a result is self-sufficient: it carries the facts the next call
  needs (error line and type, addresses in `$HHHH`, labels, the screen on a timeout). Structured
  content stays. A large payload is sent once, and size caps count the bytes actually sent.
- D3 Truth. A result never claims more than was observed; a silent fallback (other config file,
  other emulator binary, restarted emulator, dropped text) is an error or a stated notice.
- D4 Secrets and access. A credential is only ever sent to the host it was configured for; no
  redirect is followed. An operation that can do what a blocked operation does is blocked too
  (`c64_config restore` with network items).
- D5 Assembler dialect. The built-in assembler accepts the common spellings an LLM writes: ACME
  (`!byte !word !text !pet !scr !fill !align`), ca65/64tass (`.byte .word .text .scr/.screen
  .fill .res n,v`), labels without a colon in column 0, `.if/.else/.endif`, `.macro/.endmacro`,
  `.repeat/.endrepeat`. An unsupported directive is named in the error with the supported list.
  No input assembles to silently wrong bytes.
- D6 BASIC text. `{name}` and `{$xx}` control codes are one shared table for the tokenizer, the
  keyboard tools and listings; an unknown `{...}` is an error; listing then tokenising is
  byte-exact.
- D7 Discovery. `initialize` returns instructions. Skills are readable as `c64://skills/<name>`
  resources. Prompts carry their steps, not internal tool descriptors.
- D8 Knowledge. A fact is changed or added only with a primary source recorded in
  `fact-check.md`; what cannot be sourced is marked "(unverified)" or removed.
- D9 Dead code is deleted: `silence_and_verify`, `verify_and_write_memory`,
  `compile_run_verify_cycle`, unused runners.
- D10 Tool annotations follow the MCP meaning: `destructiveHint` is false only for tools whose
  operations are all reads or purely additive.

## Accepted findings by work package

Severity in brackets. Duplicates across reviewers are listed once.

### A - core client (`src/c64Client.ts`, `src/streamCapture.ts`)
- CLIENT-1 [P1] multi-frame video capture regroups all packets on every datagram; count >= 8 times out.
- CLIENT-2 [P2] keyboard injection overwrites a non-empty queue; concurrent calls interleave.
- CLIENT-3 [P2] greeting writer turns punctuation into spaces and cuts at 40 columns.
- CLIENT-4 / MEDIA-6 / MEDIA-7 [P2] printer bitmap programs exceed 255-character strings; Epson hidden `timesPerLine` 4.
- CLIENT-5 / SOUND-11 [P2] audio capture timeout is 125 times the nominal duration.
- CLIENT-6 / MEDIA-8 / WORKFLOW-13 [P2] sprite, bitmap and SID reset send one request per register.
- CLIENT-7 [P3] screen read can mix backends during a switch.
- CLIENT-8 [P3] VICE keyboard timeout message and delivered count are wrong.
- CLIENT-9 / SOUND-14 [P3] `sidSetVolume` clears filter bits without saying so.
- MEDIA-5 / SOUND-10 [P2] `sidNoteOff` clears the waveform with the gate.
- WORKFLOW-8 [P2] `render_sprite` overwrites `$2000+` and forces text mode in bank 0.
- DEVICE-8 [P3] a frame counts as complete from lines outside its height.
- VICE-6 [P2] VICE frame crop depends on content; VICE-8 [P2] capture retry hides a lost session.

### B - Ultimate backend and configuration (`src/device.ts` C64U part, `src/config.ts`, `src/loggingHttpClient.ts`)
- DEVICE-1 [P2] the C64U network password is sent to a separately configured U2 host.
- DEVICE-2 [P2] a missing explicit `C64BRIDGE_CONFIG` file falls back to another configuration.
- DEVICE-5 [P2] firmware error text (`errors` array) never reaches the message.
- DEVICE-7 [P3] redirects are followed and `X-Password` forwarded.
- DEVICE-6 [P2, wave 2] host-built `.d64`/`.crt` cannot be mounted or run on Ultimate (`location: "host"`).

### V - VICE backend (`src/device.ts` VICE part, `src/vice/`)
- VICE-1 [P2] reset deletes breakpoints silently. VICE-2 / DEVICE-3 / PROGMEM-2 [P2] external VICE is probed before every operation.
- VICE-3 [P2] ping on a wedged VICE takes about 85 s. VICE-4 [P2] a restarted VICE is not reported.
- VICE-5 [P2] `run_prg` of a PRG not at `$0801` rewrites BASIC pointers and types RUN.
- PROGMEM-4 [P2] `load_prg` on VICE resets and leaves BASIC pointers at boot values.
- DEVICE-4 [P2] `write_text` can hold the monitor for 77 s.
- VICE-7 [P2] redundant cold-start reset and fixed 1 s sleep (no warp change).
- VICE-9 [P2] raw monitor error codes. VICE-11, 13, 14, 15, 16, 17 [P3]. VICE-18 [P3] mock lacks `setNoDelay`; mock departures from the spec.
- VICE-10 [P2, wave 2] bank selection, snapshots, VICE version.

### C - programming tools (`src/tools/programRunners.ts`, `memory.ts`, `debug.ts`, `pollValidator.ts`, `machineControl.ts`, `vice.ts`)
- PROGMEM-1 [P2] a breakpoint at the entry makes `upload_run_asm` fail and lose labels.
- PROGMEM-3 [P2] reset with `waitForReady` takes a fixed 3 s.
- PROGMEM-5 / WORKFLOW-5 [P2] `upload_run_asm` polls 2 to 4 s without `verify`.
- PROGMEM-6 [P2] `upload_run_basic` reads the screen before the program ran.
- PROGMEM-7 [P2] debugger results omit PC, registers, stop state, checkpoint id.
- PROGMEM-8, 9, 10, 11, 12, 13 [P3]; PROGMEM-14 [P3] range operations read `$D000-$DFFF`.
- PROGMEM-15 [P3] `SidEngine` example: removed unless sourced.
- WORKFLOW-7 [P2] bare 404 for a host path without `location`. WORKFLOW-11, 12 [P3] descriptions, `label+n`.
- VICE-12 [P3] `resource_set` sends the type the caller wrote.

### D - MCP layer (`src/mcp-server.ts`, `src/mcp/`, `src/tools/registry/`, `responses.ts`, `errors.ts`, `access.ts`, `diagnostics.ts`, `src/prompts/`)
- MCP-1 / META-2 [P2] `c64_config restore` bypasses the network-write block.
- MCP-2 / PACKAGE-1 [P2] startup launches VICE despite the documented lazy start.
- MCP-3 / WORKFLOW-6 / PACKAGE-5 [P2] prompts point at unreadable skill files; no `instructions`.
- MCP-4 / WORKFLOW-14 [P2] `prompts/get` carries 82 KB of internal descriptors.
- MCP-5 / MEDIA-10 [P2] payloads duplicated two to four times; caps count once.
- MCP-6 [P2] no progress notifications for calls longer than 60 s.
- WORKFLOW-1 [P2] `c64_select_backend` omits `c64_input` and `c64_batch`.
- WORKFLOW-3 [P2] text blocks omit what the next call needs.
- WORKFLOW-9 [P2] pattern errors do not state the expected format.
- MCP-7, 8, 9, 10, 11, 12, 13, 15 [P3]; MCP-14 `resources/templates/list` only.
- WORKFLOW-10 [P3] RAG links with a fragment cannot be read. WORKFLOW-16 [P3] read-only blocks backend selection.
- PACKAGE-8 [P3] lazy HTTP transport import, compile cache, unused eager prompt registry.

### E - meta tools (`src/tools/meta/`)
- META-1 [P2] `intervalMs` overflow floods the device. META-3 [P2] snapshot hides failed reads.
- META-4 [P2] same-PID zombie task. META-5 [P2] unhandled rejection in the task timer.
- META-6 [P2] vacuous `screen_contains`. META-7 [P2] run results only on host files.
- META-8 [P2] regexes without `m`. META-9 [P2] unbounded `extensions`.
- META-10 [P3] dead tools (D9). META-11 to 16, 18, 19, 20 [P3]. SOUND-4, SOUND-15, SOUND-16 (meta audio).

### F - translators (`src/tools/translation/`, `src/petscii.ts`)
- TRANSLATE-1, 2 / MEDIA-9 [P2] control names written as literal text; listing round trip broken (D6).
- TRANSLATE-3 [P2] `\0` and `\xNN` escapes give wrong bytes. TRANSLATE-4, 5 [P2] dialect gaps (D5).
- TRANSLATE-6, 7 [P2] expression parsing in operands and data. TRANSLATE-8 to 16 [P3]. MEDIA-17 [P3].

### G1 - media tools (`src/tools/graphics.ts`, `input.ts`, `printer.ts`, `storage.ts`, `developer.ts`, `src/vicBitmap.ts`, `petsciiArt.ts`, `chargen.ts`)
- MEDIA-1 [P2] `render_bitmap` fails for 8 of 16 background colours. MEDIA-2 [P2] multicolour aspect.
- MEDIA-3 [P2] image dimensions checked after decoding. WORKFLOW-2 [P2] spaces drawn as "?".
- MEDIA-12, 13, 14, 15, 16, 18 [P3].

### G2 - sound (`src/tools/audio.ts`, `src/audio/`, `src/sidwave*.ts`)
- MEDIA-4 [P2] `$02A6` polarity stated backwards (1 = PAL). SOUND-1, 2, 3, 5, 6, 7, 8, 9 [P2]. SOUND-12, 13, 17 [P3].

### H - retrieval (`src/rag/`, `src/tools/rag.ts`)
- KNOWLEDGE-1 / WORKFLOW-4 [P2] `asm`/`basic` scopes rank without the lexical boost.
- KNOWLEDGE-2 [P2] wrong top hits; KNOWLEDGE-3, 4, 5 [P3]; MEDIA-11 [P2] snippets mangled in text.
- A golden set of query-to-document expectations becomes a test.

### I - packaging and documentation (`package.json`, `scripts/`, `README.md`, `AGENTS.md`, `doc/developer.md`, workflows)
- PACKAGE-2 [P2] README HTTP section is wrong. PACKAGE-3 [P2] launcher drops `--http`.
- PACKAGE-4 [P2] no CI budget for startup, `tools/list`, package content. PACKAGE-6, 9, 10, 11, 12 [P3].

### K - knowledge content (wave 2, gated by the fact check)
- KNOWLEDGE-6 to 14, WORKFLOW-15, the unsure list, and the gaps: cc65 / Oscar64 / llvm-mos
  specifics, raster recipes, mode setup, safe zero page map.

## Not accepted or deferred

- KNOWLEDGE-9 as reported (`$01 = $31` does expose the character ROM); the fact check decides the wording.
- PACKAGE-7 (replace Jimp, make `naudiodon` opt-in), PACKAGE-13 and 14 (digest and SHA pinning): owner decisions.
- MCP-14 unknown tool as protocol error: the `isError` result is more useful to a model.
- VICE-7 warp mode during boot: needs a real VICE.
- Unary `<`/`>` scope and operator precedence in the assembler: unsure, needs the assemblers' manuals.
