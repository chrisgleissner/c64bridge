# Printing Prompts and Routing (for LLM prompt construction)

## Routing

- Unspecified or unknown printer → **Commodore MPS** (PETSCII).
- Mentions “Commodore”, “MPS” → use Commodore docs.
- Mentions “Epson”, “FX”, “ESC/P” → use Epson docs.

## Prompt templates

**Text (Commodore/Epson)**
> Print the following text on my [Commodore|Epson] printer: <text>. Ensure CR/LF and page eject.

**Bitmap (Commodore/Epson)**
> Print this bitmap at [density]. Provide columns as bytes and desired repeats/line spacing.

**Custom chars (Epson mode only)**
> Define user characters with `ESC &` and print <text>. The Commodore mode of the Ultimate emulation parses and ignores downloadable characters (`ESC =`).

## Tooling guidance

- Always `OPEN ch,4[,sa]` → `PRINT#` → `CLOSE ch`.
- Add `FF` (`CHR$(12)`) at job end for eject.
- Commodore bitmap: enter `CHR$(8)`, **repeat** with `CHR$(26)`, **exit** with `CHR$(15)`; **bit7 must be 1** in data.
- Epson bitmap: choose `ESC K/L/Y/Z/*/^`; compute `(n,m)` length; set `ESC A 8` for 8‑dot rows.

## Cross‑refs

See `printer-spec.md` (overview), `printer-commodore*.md`, `printer-epson*.md` for details.
