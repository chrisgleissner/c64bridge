---
name: printer-job
description: Use when the user wants to print text or bitmaps, or define custom characters, on a Commodore (MPS) or Epson printer from a C64U or U2.
---

## Intent

Use this skill for printer text output, bitmap output, and custom character definition.

## Inputs

- Printer family: Commodore or Epson.
- Backend: `c64_printer` is available on `c64u` and `u2` only, not on `vice`.
- Desired output type: text, bitmap row, or custom character definition.
- Any device or secondary-address requirements.

## Execution

1. Use `c64_printer` with `op: "print_text"` for text workflows.
2. Use `c64_printer` with `op: "print_bitmap"` for bitmap row workflows.
3. Use `c64_printer` with `op: "define_chars"` for custom character definitions.
4. Surface any generated BASIC or payload details the user must keep or reuse.

## Validation

1. Confirm which printer family and operation ran.
2. Summarize any generated program text or printer control assumptions.

## Safety

- Confirm printer family before issuing printer-specific control sequences.
