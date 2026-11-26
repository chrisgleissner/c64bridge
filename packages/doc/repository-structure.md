# Repository structure

| Path | Contents |
| --- | --- |
| `README.md` | Overview for musicians and developers, status and roadmap. |
| `CHANGELOG.md` | Changes by release. |
| `sidwave/` | npm package `sidwave`: language, parser, lint, compiler, generator, examples, CLI `sidwave`. |
| `sidwave/doc/` | Package documentation, including `licensing.md`. |
| `asm6502/` | npm package `c64-asm6502`: the 6502 assembler used by the compiler. |
| `doc/` | Repository-level documentation (this file). |

The repository was produced from the `packages/` directory of c64bridge with `git filter-repo`, so the history of the moved files is preserved. Device control, MCP tools and hardware capture scripts stay in c64bridge.
