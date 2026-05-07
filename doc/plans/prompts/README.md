# Prompt Taxonomy and Context Plan

This document captures the design work for **Phase 5 / Step 4.1** of the MCP migration: defining the prompt
families, required context, and reusable prompt segments. These notes do **not** contain the final prompt
strings; they specify the structure so that `promptRegistry` can assemble concrete prompts and the test
suite can assert expectations in upcoming steps.

---

## 1. Prompt Families & Goals

| Family ID | Mission | Primary Users | Core Outputs |
| --- | --- | --- | --- |
| `basic-program` | Generate, run, and verify Commodore BASIC programs. | BASIC Agent / general workflows | Tokenised BASIC source, post-run verification steps, tool invocation hints. |
| `assembly-program` | Author 6502/6510 assembly for VIC/SID/CIA tasks with safety checks. | ASM Agent / low-level workflows | Assembly source blocks, load/execute instructions, IRQ or memory safety reminders. |
| `sid-music` | Compose SID music with expressive timing and iterative audio checks. | SID Composer | Melody plans, SID register recipes, guidance to analyse playback. |
| `graphics-demo` | Produce graphics routines (sprites, PETSCII art, bitmap/raster effects). | VIC Painter | Mode setup instructions, colour guidance, verification routines. |
| `printer-job` | Send formatted output to Commodore or Epson printers safely. | Printer Operator | Device selection, character-set notes, print/eject workflow. |
| `memory-debug` | Inspect or patch memory without destabilising the system. | Memory Debugger | Safe read/write plans, freeze/resume advice, logging expectations. |
| `drive-manager` | Mount/create disk images and manage drives carefully. | Drive Manager | Pre-flight checks, mount/remove sequences, follow-up validation. |

> These families mirror the MCP tool domains so that prompt guidance matches available capabilities.

---

## 2. Required Resource Context per Family

| Family | Baseline Resources (URIs) | Rationale |
| --- | --- | --- |
| `basic-program` | `c64://basic/spec`, `c64://guide/bootstrap`, `c64://guide/index` | Reinforce BASIC token rules, PETSCII gotchas, workflow expectations. |
| `assembly-program` | `c64://assembly/6510-spec`, `c64://guide/bootstrap`, `c64://graphics/vic/spec`, `c64://sound/sid/spec` | Provide opcode tables, IRQ setup, VIC/SID register references. |
| `sid-music` | `c64://sound/sid/spec`, `c64://sound/sidwave/spec`, `c64://sound/sid/file-format` | Supply register map, SIDWAVE format, SID file metadata. |
| `graphics-demo` | `c64://graphics/vic/spec`, `c64://guide/bootstrap` | Cover VIC mode bits, raster constraints, general workflow guidance. |
| `printer-job` | `c64://printer/spec`, `c64://printer/commodore/text`, `c64://printer/prompt-guide` | Document PETSCII vs ESC/P workflows, sample templates, and safety checks. |
| `memory-debug` | `c64://guide/bootstrap`, `c64://assembly/6510-spec`, `c64://guide/index` | Highlight addressing safeguards, workflow rules, and knowledge map summaries. |
| `drive-manager` | `c64://guide/bootstrap` | Ensure awareness of system-wide safety rules before altering drives. |

Notes:

- Resource URIs reflect existing knowledge catalog entries; verify actual IDs during prompt implementation.
- `drive-manager` currently relies on orientation material only; plan to author a dedicated storage/drive guide resource.
- Additional resources (memory map, VIC character set, SID best practices) remain desirable—tracked in follow-ups below.

---

## 3. Default Tool Suggestions per Family

| Family | Must-Suggest Tools | Optional Tools | Warnings |
| --- | --- | --- | --- |
| `basic-program` | `c64_program`, `c64_memory` | `c64_system` (ops `reset`, `start_task`) | Remind to reset only if user confirms; highlight PETSCII newline handling. |
| `assembly-program` | `c64_program`, `c64_memory` | `c64_system` (ops `reset`, `pause`, `resume`) | Require IRQ acknowledgement steps for raster code; caution on zero-page writes. |
| `sid-music` | `c64_sound` (ops `generate`, `note_on`, `analyze`) | `c64_sound` (ops `compile_play`, `play_sid_file`, `set_volume`) | Warn about volume resets (`$D418`) and making backups before overwriting SID memory. |
| `graphics-demo` | `c64_program`, `c64_memory`, `c64_graphics` | `c64_system` (op `pause`), `c64_memory` (op `read`) | Emphasise safe colour RAM usage; mention border side-effects for raster tricks. |
| `printer-job` | `c64_printer` (ops `print_text`, `print_bitmap`) | `c64_printer` (op `define_chars`), `c64_memory` | Remind users to send `CHR$(12)` before closing; confirm `printer` argument (`commodore` vs `epson`) before printing. |
| `memory-debug` | `c64_memory`, `c64_system` (ops `pause`, `resume`) | `c64_system` (op `reset`) | Advise capturing snapshots before writes; include address validation heuristics. |
| `drive-manager` | `c64_disk` (ops `list_drives`, `mount`, `unmount`) | `c64_disk` (ops `file_info`, `create_image`, `find_and_run`), `c64_drive` (ops `reset`, `power_on`, `power_off`, `load_rom`, `set_mode`), `c64_system` (op `resume`) | Highlight risk of interrupting running programs; recommend verifying mounts after actions. |

---

## 4. Reusable Prompt Segments (`promptSegments`)

| Segment ID | Purpose | Content Summary |
| --- | --- | --- |
| `intro/core` | Universal introduction | Remind user the MCP runs against Ultimate 64 REST, mention tool invocation expectation. |
| `safety/reset` | Caution about disruptive actions | Ask for confirmation before resets/writes that halt the machine. |
| `workflow/basic-verify` | Post-run checklist for BASIC | Suggest `c64_memory` (op `read_screen`) capture, optional `c64_memory` (op `read`) for program area, note PETSCII output quirks. |
| `workflow/asm-irq` | IRQ safety guidance | Outline `SEI`, vector setup, `$D01A` mask, `$D019` acknowledge, `CLI`. |
| `workflow/sid-iterate` | Audio feedback loop | Steps: compose → play → run `analyze_audio` → adjust ADSR/frequency. |
| `workflow/graphics-verify` | Visual validation | Encourage screenshot via `c64_memory` (op `read_screen`), mention border/background toggles. |
| `workflow/printer` | Print job completion | Ensure `CHR$(12)` for page eject, close channel, suggest checking printer status. |
| `workflow/memory-snapshot` | Safe memory editing | Recommend pausing, using `c64_memory` reads before writes, and resuming afterwards. |
| `workflow/drive` | Drive changes | Pre-check currently mounted images, confirm after action, note potential interference with running programs. |

Segments should be composable so prompts can include `intro/core` + family-specific workflow + optional `safety/reset` depending on requested action.

---

## 5. Arguments & Variations (Preliminary)

- `assembly-program` may accept a `hardware` argument (`sid`, `vic`, `cia`, `multi`) to pull in targeted resource snippets.
- `graphics-demo` may accept `mode` (`text`, `multicolour`, `bitmap`, `sprite`) to tailor register setup.
- `printer-job` may accept `printerType` (`commodore`, `epson`) to adjust command examples and character-set notes.
- Future prompts should validate arguments and provide descriptive errors if unsupported values are provided.

Argument handling will be implemented in `promptRegistry.resolve` during Step 4.3; this section informs schema design.

---

## 6. Open Questions & Follow-Ups

- Extend the knowledge index with dedicated memory-map, drive-management, and character-set resources so prompts can cite them directly.
- Add SID best-practices material (triangle wave workflow) to the knowledge catalog or link from prompts explicitly.
- Adjust `storageModule.prompts` to include `drive-manager` once the prompt is authored, keeping tool metadata consistent.
- Ensure prompt tests assert for resource/tool mentions and safety callouts per family.

Document owner: Prompts migration effort (Phase 5).
