# Changelog

## Unreleased

### Added

- Standalone repository for SIDWAVE, extracted from c64bridge with the history of the moved files.
- npm package `sidwave` (language, parser, lint, compiler to PRG and PSID, generator, examples) and `c64-asm6502` (the 6502 assembler used by the compiler). Neither is published yet.
- Documentation drafts: repository README, package READMEs, licensing notes.

### Compatibility

- Language versions 1.0 to 1.3 are carried over unchanged; compiled output for existing scores is expected to be byte-identical to c64bridge 1.3.3. This is to be confirmed by the extraction gate.
