# VICE Support Matrix

This document is the source of truth for VICE support in the public MCP surface.

## Decision Rules

- `supported`: part of the public VICE contract, enforced at runtime, documented in generated compatibility tables, and covered by regression tests.
- `mock-only experimental`: may exist in test scaffolding or backend experiments, but must not appear as supported in public MCP metadata or README compatibility tables.
- `unsupported`: blocked at runtime on VICE with `unsupported_platform`.

## Phase-One Decisions

- Resource-backed VICE drive operations are supported in phase one: `list_drives`, `mount`, `unmount`, `reset`, `power_on`, `power_off`, and `set_mode`.
- Grouped operations already declared c64u-only remain c64u-only on VICE and must be blocked at runtime.
- Mock-only behavior must not appear in public compatibility tables before it is intentionally promoted to supported status.
- For this phase, there are no public `mock-only experimental` operations in the grouped MCP contract. Any such behavior remains internal to tests or backend experiments until explicitly reclassified here.

## Public VICE Contract

### Supported

| Tool | Operations |
| --- | --- |
| `c64_program` | `load_prg`, `run_prg`, `upload_run_basic`, `upload_run_asm`, `batch_run`, `bundle_run`, `cross_platform_greeting` |
| `c64_memory` | `read`, `write`, `read_screen`, `wait_for_text`, `list_basic`, `disassemble`, `copy_memory`, `fill_memory`, `search_memory`, `compare_memory`, `save_memory` |
| `c64_system` | `pause`, `resume`, `reset`, `reboot`, `poweroff`, `power_cycle`, `start_task`, `stop_task`, `stop_all_tasks`, `list_tasks`, `performance_report` |
| `c64_graphics` | `capture_frame`, `render_petscii_art`, `render_bitmap`, `render_sprite`, `render_petscii_text`, `get_display_state` |
| `c64_rag` | `basic`, `asm` |
| `c64_disk` | `list_drives`, `mount` |
| `c64_drive` | `reset`, `power_on`, `power_off`, `set_mode` |
| `c64_config` | `list`, `get`, `set`, `batch_update`, `info`, `version`, `snapshot`, `restore`, `diff` |
| `c64_sound` | `set_volume`, `reset`, `note_on`, `note_off`, `silence_all`, `generate`, `compile_play`, `play_preset`, `pipeline`, `analyze`, `record_analyze` |
| `c64_input` | `write_text`, `key`, `joystick` |
| `c64_extract` | `sprites`, `charset`, `memory_dump`, `firmware_health` |
| `c64_select_backend` | `select` |
| `c64_debug` | all operations |
| `c64_vice` | all operations |

### Unsupported

| Tool | Operations |
| --- | --- |
| `c64_program` | `run_crt` |
| `c64_disk` | `unmount`, `file_info`, `create_image`, `find_and_run`, `find_paths` |
| `c64_drive` | `load_rom` |
| `c64_sound` | `capture_samples`, `play_sid_file`, `play_mod_file` |
| `c64_config` | `load_flash`, `save_flash`, `reset_defaults`, `read_debugreg`, `write_debugreg`, `shuffle` |
| `c64_system` | `menu`, `read_menu_screen` |
| `c64_input` | `keyboard`, `release_all`, `state` |
| `c64_extract` | `fs_stats` |
| `c64_stream` | all operations |
| `c64_printer` | all operations |

The per-operation support is declared in `src/tools/registry/*.ts` (`operationPlatforms` and `supportedPlatforms`); the generated tables in `README.md` and `mcp/*.json` reflect it. If this file and the registry differ, the registry is correct.

## Notes

- `supported` means supported on the public grouped MCP surface. It does not imply parity with Ultimate firmware internals.
- VICE still has platform limits such as `no-rest-api`, `no-firmware-filesystem`, `no-flash-config`, and `limited-sid`.
- When this matrix changes, update runtime enforcement, tests, README-generated compatibility tables, and generated `mcp/*.json` artifacts together.
