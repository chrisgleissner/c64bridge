# Commodore MPS Printing (Text) — PETSCII + MPS Protocol

**Device:** `4`  | **Secondary address (sa):** `0`=upper/graphics (default), `7`=lower/upper.  
**Open/Print/Close:** `OPEN ch,4[,sa]` → `PRINT#ch, ...` → `CLOSE ch` (or `CMD ch` to route `PRINT`/`LIST`).
Codes are from the MPS-801 manual (the MPS-803 uses the same set). Rows marked *Ultimate* are not in those manuals but are handled by the Ultimate printer emulation (an MPS-1230).

## Controls (concise)

| Feature | Code (send via `PRINT#`) | Notes |
|:--|:--|:--|
| Standard width | `CHR$(15)` | Also exits Bit Image Mode |
| Double width | `CHR$(14)` | Affects subsequent text |
| Reverse video ON/OFF | `CHR$(18)` / `CHR$(146)` | Invert foreground/background |
| Cursor mode local (graphic/business) | `CHR$(145)` / `CHR$(17)` | Real MPS: until the next CR; the Ultimate emulation keeps it after CR |
| Carriage return / line feed / form feed | `CHR$(13)` / `CHR$(10)` / `CHR$(12)` | CR and LF each end the line and advance one line (Ultimate), so CR+LF leaves a blank line; form feed: *Ultimate* |
| Horizontal tab | `CHR$(9)` | *Ultimate*: next tab stop |
| Position by columns | `CHR$(16);"nn"` | two ASCII digits, column 00–79 (e.g. `CHR$(16);"08"`) |
| Position by dots | `CHR$(27);CHR$(16);HP;LP` | Dot address = `(HP<<8)|LP` (0–479) |
| Bit Image Mode (enter/exit) | `CHR$(8)` / `CHR$(15)` | See bitmap doc for data rules |

### Quick examples

```basic
10 OPEN1,4,7
20 PRINT#1,CHR$(27);"-";CHR$(1);"UNDERLINED";CHR$(27);"-";CHR$(0): REM UNDERLINE: ULTIMATE (MPS-1230) ONLY
30 PRINT#1,CHR$(16);"20";"COL 20":PRINT#1,CHR$(12):CLOSE1
```

**See also:** `printer-commodore-bitmap.md` for images and repetition (`CHR$(26)`), and `printer-spec.md` for routing & differences.
